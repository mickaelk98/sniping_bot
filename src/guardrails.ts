import type { BotConfig } from "./config.js";

export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Garde-fous globaux : budget par trade, budget journalier, positions max.
 * Le reset journalier est basé sur la date UTC ; atteinte du budget journalier
 * = arrêt automatique du bot (géré par l'appelant via `shouldStop()`).
 */
export class Guardrails {
  private readonly cfg: BotConfig;
  private dayKey = todayKey();
  private spentTodayWei = 0n;

  constructor(cfg: BotConfig) {
    this.cfg = cfg;
  }

  /** À appeler avant chaque achat. Vérifie tous les garde-fous. */
  canOpenPosition(openPositionCount: number): GuardrailVerdict {
    this.rollDayIfNeeded();

    if (openPositionCount >= this.cfg.maxOpenPositions) {
      return {
        allowed: false,
        reason: `positions_max (${openPositionCount}/${this.cfg.maxOpenPositions} ouvertes)`,
      };
    }
    if (this.cfg.tradeAmountWei > this.cfg.dailyBudgetWei) {
      return {
        allowed: false,
        reason: "budget_trade_superieur_budget_journalier (configuration incohérente)",
      };
    }
    const remaining = this.cfg.dailyBudgetWei - this.spentTodayWei;
    if (this.cfg.tradeAmountWei > remaining) {
      return {
        allowed: false,
        reason: `budget_journalier_atteint (${formatEth(this.spentTodayWei)}/${formatEth(
          this.cfg.dailyBudgetWei,
        )} ETH dépensés)`,
      };
    }
    return { allowed: true };
  }

  /** Budget journalier épuisé : le bot doit s'arrêter automatiquement. */
  shouldStop(): boolean {
    this.rollDayIfNeeded();
    return this.cfg.dailyBudgetWei - this.spentTodayWei < this.cfg.tradeAmountWei;
  }

  /** Enregistre une dépense d'achat (en WETH/ETH wei). */
  recordSpend(amountWei: bigint): void {
    this.rollDayIfNeeded();
    this.spentTodayWei += amountWei;
  }

  /** Une vente restitue du budget consommable pour la journée. */
  recordRefund(amountWei: bigint): void {
    this.rollDayIfNeeded();
    this.spentTodayWei = this.spentTodayWei > amountWei ? this.spentTodayWei - amountWei : 0n;
  }

  status(): { day: string; spentTodayWeth: bigint; dailyBudgetWeth: bigint } {
    this.rollDayIfNeeded();
    return {
      day: this.dayKey,
      spentTodayWeth: this.spentTodayWei,
      dailyBudgetWeth: this.cfg.dailyBudgetWei,
    };
  }

  private rollDayIfNeeded(): void {
    const today = todayKey();
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.spentTodayWei = 0n;
    }
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fraction}`;
}
