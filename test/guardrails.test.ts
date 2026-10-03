import { describe, expect, it } from "vitest";
import { Guardrails } from "../src/guardrails.js";
import type { BotConfig } from "../src/config.js";

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    dryRun: true,
    wsUrl: "wss://x",
    rpcUrl: "https://x",
    tradeAmountWei: 50_000_000_000_000_000n, // 0.05 ETH
    dailyBudgetWei: 150_000_000_000_000_000n, // 0.15 ETH = 3 trades
    maxOpenPositions: 2,
    maxSlippageBps: 500,
    swapDeadlineSeconds: 120,
    minPoolLiquidityEth: 2,
    maxHolderPct: 50,
    takeProfitPct: 50,
    stopLossPct: 30,
    positionPollSeconds: 10,
    ...overrides,
  };
}

describe("Guardrails", () => {
  it("autorise tant que budget et positions le permettent", () => {
    const g = new Guardrails(makeConfig());
    expect(g.canOpenPosition(0).allowed).toBe(true);
    g.recordSpend(50_000_000_000_000_000n);
    expect(g.canOpenPosition(1).allowed).toBe(true);
  });

  it("bloque au-delà du nombre max de positions", () => {
    const g = new Guardrails(makeConfig());
    const verdict = g.canOpenPosition(2);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("positions_max");
  });

  it("bloque quand le budget journalier restant est insuffisant", () => {
    const g = new Guardrails(makeConfig());
    g.recordSpend(150_000_000_000_000_000n);
    const verdict = g.canOpenPosition(0);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("budget_journalier_atteint");
    expect(g.shouldStop()).toBe(true);
  });

  it("detecte l'arrêt automatique dès qu'il ne reste plus assez pour un trade", () => {
    const g = new Guardrails(makeConfig());
    g.recordSpend(110_000_000_000_000_000n); // reste 0.04 < 0.05
    expect(g.shouldStop()).toBe(true);
  });

  it("recordRefund restitue du budget sans passer sous zéro", () => {
    const g = new Guardrails(makeConfig());
    g.recordSpend(100_000_000_000_000_000n);
    g.recordRefund(80_000_000_000_000_000n);
    expect(g.status().spentTodayWeth).toBe(20_000_000_000_000_000n);
    g.recordRefund(999_999_999_999_999_999n);
    expect(g.status().spentTodayWeth).toBe(0n);
  });

  it("detecte une configuration incohérente (trade > budget journalier)", () => {
    const g = new Guardrails(makeConfig({ dailyBudgetWei: 10_000_000_000_000n }));
    expect(g.canOpenPosition(0).reason).toContain(
      "budget_trade_superieur_budget_journalier",
    );
  });
});
