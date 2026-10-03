import type { BotConfig } from "./config.js";
import type { SellResult } from "./execution.js";
import { logError } from "./logger.js";
import type { CloseReason, Position } from "./types.js";

/**
 * Variation de valeur en pourcentage : ((current - entry) / entry) * 100.
 * Pur, testable. entry nulle -> 0 (pas de division par zéro).
 */
export function priceChangePct(entryValue: bigint, currentValue: bigint): number {
  if (entryValue === 0n) return 0;
  const diffBps = Number(((currentValue - entryValue) * 10_000n) / entryValue);
  return diffBps / 100;
}

/** Surface du SwapExecutor consommée par le gestionnaire de positions. */
export interface PositionExecutor {
  quoteSell(
    token: `0x${string}`,
    fee: number,
    baseToken: "WETH" | "USDC",
    amountTokens: bigint,
  ): Promise<bigint>;
  sell(position: Position, reason: CloseReason): Promise<SellResult>;
}

/**
 * Gestion des positions ouvertes : take-profit / stop-loss, avec repli
 * d'urgence après 3 échecs de quotage consécutifs (pool en train de mourir).
 * Une vente échouée laisse la position ouverte pour retry au tick suivant.
 */
export class PositionManager {
  private readonly positions: Position[] = [];

  constructor(
    private readonly cfg: BotConfig,
    private readonly executor: PositionExecutor,
    private readonly callbacks: { onClosed?: (p: Position) => Promise<void> | void } = {},
  ) {}

  open(position: Position): void {
    this.positions.push(position);
  }

  openCount(): number {
    return this.positions.filter((p) => p.status === "open").length;
  }

  snapshot(): readonly Position[] {
    return [...this.positions];
  }

  /** Un cycle de surveillance : appelé périodiquement par l'orchestrateur. */
  async tick(): Promise<void> {
    for (const position of this.positions) {
      if (position.status !== "open") continue;

      let currentValue: bigint;
      try {
        currentValue = await this.executor.quoteSell(
          position.token,
          position.fee,
          position.baseToken,
          position.tokenAmount,
        );
      } catch {
        position.consecutiveQuoteFailures += 1;
        if (position.consecutiveQuoteFailures >= 3) {
          await this.closePosition(position, "emergency");
        }
        continue;
      }

      position.consecutiveQuoteFailures = 0;
      const pct = priceChangePct(position.entryValueWeth, currentValue);

      if (pct >= this.cfg.takeProfitPct) {
        await this.closePosition(position, "take-profit");
      } else if (pct <= -this.cfg.stopLossPct) {
        await this.closePosition(position, "stop-loss");
      }
    }
  }

  private async closePosition(position: Position, reason: CloseReason): Promise<void> {
    const result = await this.executor.sell(position, reason);
    if (!result.ok) {
      logError("vente_echouee", {
        token: position.token,
        raison: reason,
        erreur: result.error,
      });
      return;
    }
    position.status = "closed";
    position.close = {
      closedAt: new Date().toISOString(),
      reason,
      wethReceived: result.wethReceived,
      txHash: result.txHash,
      simulated: result.simulated,
    };
    await this.callbacks.onClosed?.(position);
  }
}
