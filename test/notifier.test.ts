import { describe, expect, it } from "vitest";
import { formatMessage, modeTag } from "../src/notifier.js";
import type { BotConfig } from "../src/config.js";

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    dryRun: true,
    wsUrl: "wss://x",
    rpcUrl: "https://x",
    tradeAmountWei: 10_000_000_000_000_000n,
    dailyBudgetWei: 100_000_000_000_000_000n,
    maxOpenPositions: 3,
    maxSlippageBps: 500,
    swapDeadlineSeconds: 120,
    minPoolLiquidityEth: 2,
    maxHolderPct: 50,
    takeProfitTiers: [{ multiple: 2, sellPct: 50 }],
    trailingStopPct: 20,
    stopLossPct: 30,
    positionPollSeconds: 10,
    ...overrides,
  };
}

describe("notifier - étiquette de mode", () => {
  it("[TEST] en dry-run, [RÉEL] en live", () => {
    expect(modeTag(makeConfig({ dryRun: true }))).toBe("[TEST]");
    expect(modeTag(makeConfig({ dryRun: false }))).toBe("[RÉEL]");
  });

  it("compose le message avec l'étiquette en préfixe", () => {
    const text = formatMessage(makeConfig({ dryRun: true }), "Bot démarré", "Contenu");
    expect(text).toBe("[TEST] Bot démarré\nContenu");
  });
});
