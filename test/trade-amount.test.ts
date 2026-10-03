import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { TradeAmountProvider, type QuoteClient } from "../src/trade-amount.js";
import type { BotConfig } from "../src/config.js";

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    dryRun: true,
    wsUrl: "wss://x",
    rpcUrl: "https://x",
    tradeAmountWei: 10_000_000_000_000_000n,
    tradeAmountUsd: undefined,
    ethPriceRefreshMinutes: 10,
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

/** Client de prix factice : renvoie usdcPerEth (6 décimales) pour 1 WETH. */
function priceClient(
  usdcPerEth: bigint,
  counter?: { count: number },
  shouldThrow = false,
): QuoteClient {
  return {
    readContract: async () => {
      if (counter) counter.count += 1;
      if (shouldThrow) throw new Error("rpc ko");
      return [usdcPerEth];
    },
  } as unknown as QuoteClient;
}

describe("TradeAmountProvider - mode fixe", () => {
  it("renvoie cfg.tradeAmountWei sans consulter le prix", async () => {
    const counter = { count: 0 };
    const provider = new TradeAmountProvider(
      makeConfig(),
      priceClient(2_700_000_000n, counter),
    );
    const amount = await provider.currentAmountWei();
    expect(amount).toBe(10_000_000_000_000_000n);
    expect(counter.count).toBe(0);
  });
});

describe("TradeAmountProvider - mode dynamique", () => {
  it("calcule 5$ de WETH au prix du marché", async () => {
    const provider = new TradeAmountProvider(
      makeConfig({ tradeAmountUsd: 5 }),
      priceClient(2_750_000_000n), // 2750 USDC par ETH
    );
    const amount = await provider.currentAmountWei();
    expect(amount).toBe(parseEther((5 / 2750).toFixed(9)));
  });

  it("utilise le cache : un seul appel prix pour plusieurs montants", async () => {
    const counter = { count: 0 };
    const provider = new TradeAmountProvider(
      makeConfig({ tradeAmountUsd: 5 }),
      priceClient(2_700_000_000n, counter),
    );
    await provider.currentAmountWei();
    await provider.currentAmountWei();
    await provider.currentAmountWei();
    expect(counter.count).toBe(1);
  });

  it("bloque (0n) si le prix donne un montant sous la borne minimale", async () => {
    const provider = new TradeAmountProvider(
      makeConfig({ tradeAmountUsd: 5 }),
      priceClient(1_000_000_000_000n), // 1M $/ETH -> 0.000005 ETH < 0.0001
    );
    expect(await provider.currentAmountWei()).toBe(0n);
  });

  it("bloque (0n) si le prix donne un montant au-dessus de la borne maximale", async () => {
    const provider = new TradeAmountProvider(
      makeConfig({ tradeAmountUsd: 5 }),
      priceClient(30_000_000n), // 30 $/ETH -> 0.166 ETH > 0.1
    );
    expect(await provider.currentAmountWei()).toBe(0n);
  });

  it("bloque (0n) si aucun prix n'est disponible", async () => {
    const provider = new TradeAmountProvider(
      makeConfig({ tradeAmountUsd: 5 }),
      priceClient(0n, undefined, true),
    );
    expect(await provider.currentAmountWei()).toBe(0n);
  });
});
