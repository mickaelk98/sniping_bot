import type { BotConfig, ProfitTier } from "./config.js";
import type { SellResult } from "./execution.js";
import { logError } from "./logger.js";
import type { CloseReason, Position } from "./types.js";

/** Surface du SwapExecutor consommée par le gestionnaire de positions. */
export interface PositionExecutor {
  quoteSell(
    token: `0x${string}`,
    fee: number,
    baseToken: "WETH" | "USDC",
    amountTokens: bigint,
  ): Promise<bigint>;
  sell(position: Position, amountTokens: bigint, reason: string): Promise<SellResult>;
}

/** Événement de vente remonté à l'orchestrateur (partielle ou finale). */
export interface SellEvent {
  kind: "partial" | "final";
  tier?: ProfitTier;
  reason?: CloseReason;
  wethReceived: bigint;
  simulated: boolean;
  txHash?: `0x${string}`;
}

/**
 * Multiple de prix courant : prix actuel par token / prix d'entrée par token.
 * Pur, testable. Incompatible -> 1 (neutre).
 */
export function priceMultiple(
  position: Pick<Position, "tokenAmount" | "initialTokenAmount" | "entryValueWeth">,
  currentQuoteRemaining: bigint,
): number {
  if (position.tokenAmount <= 0n || position.initialTokenAmount <= 0n) return 1;
  const WAD = 10n ** 18n;
  const currentPerToken = Number((currentQuoteRemaining * WAD) / position.tokenAmount) / 1e18;
  const entryPerToken = Number((position.entryValueWeth * WAD) / position.initialTokenAmount) / 1e18;
  if (entryPerToken <= 0) return 1;
  return currentPerToken / entryPerToken;
}

/**
 * Gestion des positions ouvertes, stratégie de sortie asymétrique :
 * - paliers de take-profit escaladés (TAKE_PROFIT_TIERS) : vente partielle
 *   de la part configurée du solde restant à chaque multiple franchi ;
 * - trailing stop (TRAILING_STOP_PCT) actif dès le premier palier passé
 *   (capital initial sécurisé) : vente totale si chute depuis le plus haut ;
 * - stop-loss d'entrée (STOP_LOSS_PCT) tant qu'aucun palier n'est passé ;
 * - durée max de détention (MAX_HOLD_HOURS) pour une position qui n'a jamais
 *   franchi de palier : libère le slot et restitue du budget ;
 * - vente d'urgence après 3 échecs de quotage consécutifs (pool morte).
 * Une vente échouée laisse la position ouverte pour retry au tick suivant.
 */
export class PositionManager {
  private readonly positions: Position[] = [];

  constructor(
    private readonly cfg: BotConfig,
    private readonly executor: PositionExecutor,
    private readonly callbacks: { onSell?: (p: Position, e: SellEvent) => Promise<void> | void } = {},
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
          await this.sellAll(position, "emergency");
        }
        continue;
      }

      position.consecutiveQuoteFailures = 0;
      const multiple = priceMultiple(position, currentValue);
      if (multiple > position.highWaterMultiple) {
        position.highWaterMultiple = multiple;
      }

      // 1. Paliers : un gap de prix peut en franchir plusieurs d'un coup.
      while (
        position.status === "open" &&
        position.nextTierIndex < this.cfg.takeProfitTiers.length
      ) {
        const tier = this.cfg.takeProfitTiers[position.nextTierIndex];
        if (tier === undefined || multiple < tier.multiple) break;

        const tokensToSell = (position.tokenAmount * BigInt(tier.sellPct)) / 100n;
        if (tokensToSell <= 0n) {
          position.nextTierIndex += 1;
          continue;
        }
        const result = await this.executor.sell(position, tokensToSell, `take-profit x${tier.multiple}`);
        if (!result.ok) {
          logError("vente_partielle_echouee", {
            token: position.token,
            palier: tier.multiple,
            erreur: result.error,
          });
          break; // réessayé au prochain tick
        }
        position.tokenAmount -= tokensToSell;
        position.realizedWeth += result.wethReceived;
        position.sells.push({
          multiple: tier.multiple,
          sharePct: tier.sellPct,
          tokensSold: tokensToSell,
          wethReceived: result.wethReceived,
          simulated: result.simulated,
          at: new Date().toISOString(),
        });
        position.nextTierIndex += 1;
        await this.callbacks.onSell?.(position, {
          kind: "partial",
          tier,
          wethReceived: result.wethReceived,
          simulated: result.simulated,
          txHash: result.txHash,
        });
        if (position.tokenAmount <= 0n) {
          await this.finalizePosition(position, "tiers-complete", result);
        }
      }
      if (position.status !== "open") continue;

      // 2. Trailing stop : actif dès que le premier palier est passé
      //    (capital initial récupéré, le solde restant est "gratuit").
      if (position.nextTierIndex > 0 && this.cfg.trailingStopPct > 0) {
        const trigger = position.highWaterMultiple * (1 - this.cfg.trailingStopPct / 100);
        if (multiple <= trigger) {
          await this.sellAll(position, "trailing-stop");
          continue;
        }
      }

      // 3. Stop-loss d'entrée : tant qu'aucun palier n'a été exécuté.
      if (position.nextTierIndex === 0 && multiple <= 1 - this.cfg.stopLossPct / 100) {
        await this.sellAll(position, "stop-loss");
      }
      if (position.status !== "open") continue;

      // 4. Durée max : une position qui n'a jamais décollé bloque un slot
      //    et du budget ; au-delà de MAX_HOLD_HOURS, sortie à prix de marché.
      //    Les positions ayant passé un palier restent gérées par le trailing stop.
      if (
        this.cfg.maxHoldHours > 0 &&
        position.nextTierIndex === 0 &&
        Date.now() - Date.parse(position.openedAt) >= this.cfg.maxHoldHours * 3_600_000
      ) {
        await this.sellAll(position, "max-hold");
      }
    }
  }

  /** Vente de tout le solde restant, puis clôture (ou retry au prochain tick). */
  private async sellAll(position: Position, reason: CloseReason): Promise<void> {
    const result = await this.executor.sell(position, position.tokenAmount, reason);
    if (!result.ok) {
      logError("vente_echouee", {
        token: position.token,
        raison: reason,
        erreur: result.error,
      });
      return;
    }
    position.tokenAmount = 0n;
    if (result.wethReceived > 0n) {
      position.realizedWeth += result.wethReceived;
    }
    await this.finalizePosition(position, reason, result);
  }

  private async finalizePosition(
    position: Position,
    reason: CloseReason,
    result: { txHash?: `0x${string}`; simulated: boolean },
  ): Promise<void> {
    position.status = "closed";
    position.close = {
      closedAt: new Date().toISOString(),
      reason,
      wethReceived: position.realizedWeth,
      txHash: result.txHash,
      simulated: result.simulated,
    };
    await this.callbacks.onSell?.(position, {
      kind: "final",
      reason,
      wethReceived: position.realizedWeth,
      simulated: result.simulated,
      txHash: result.txHash,
    });
  }
}
