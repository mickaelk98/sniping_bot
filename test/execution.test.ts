import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { SwapExecutor, applySlippage } from "../src/execution.js";
import { TradeAmountProvider, type QuoteClient } from "../src/trade-amount.js";
import type { BotConfig } from "../src/config.js";
import type { PoolCandidate, Position } from "../src/types.js";

const TOKEN = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const POOL = "0xabcdef0000000000000000000000000000000001" as `0x${string}`;

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    dryRun: true,
    wsUrl: "wss://x",
    rpcUrl: "https://x",
    tradeAmountWei: 50_000_000_000_000_000n,
    dailyBudgetWei: 500_000_000_000_000_000n,
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

/** Exécuteur avec quotages stubbés : le dry-run n'émet aucun appel réseau. */
class StubbedExecutor extends SwapExecutor {
  override async quoteBuy(): Promise<bigint> {
    return 1_000_000n;
  }
  override async quoteSell(
    _token: `0x${string}`,
    _fee: number,
    _baseToken: "WETH" | "USDC",
    amountTokens: bigint,
  ): Promise<bigint> {
    return (47_500_000_000_000_000n * amountTokens) / 1_000_000n;
  }
}

function stubbedExecutor(cfg: BotConfig): StubbedExecutor {
  // Mode fixe : le provider ne consulte jamais le client de prix.
  const amounts = new TradeAmountProvider(cfg, {} as unknown as QuoteClient);
  return new StubbedExecutor({ publicClient: {} as unknown as PublicClient, amounts, cfg });
}

const CANDIDATE: PoolCandidate = {
  poolAddress: POOL,
  token0: TOKEN,
  token1: "0x4200000000000000000000000000000000000006",
  fee: 10000,
  snipedToken: TOKEN,
  baseToken: "WETH",
  detectedAt: new Date().toISOString(),
};

function makePosition(): Position {
  return {
    id: "pos-1",
    token: TOKEN,
    tokenSymbol: "TEST",
    poolAddress: POOL,
    fee: 10000,
    baseToken: "WETH",
    amountInWeth: 50_000_000_000_000_000n,
    initialTokenAmount: 1_000_000n,
    tokenAmount: 1_000_000n,
    entryValueWeth: 50_000_000_000_000_000n,
    realizedWeth: 0n,
    highWaterMultiple: 1,
    nextTierIndex: 0,
    sells: [],
    openedAt: new Date().toISOString(),
    status: "open",
    consecutiveQuoteFailures: 0,
  };
}

describe("applySlippage", () => {
  it("applique le slippage en basis points (floor)", () => {
    expect(applySlippage(1_000_000n, 500)).toBe(950_000n);
    expect(applySlippage(1_000_001n, 500)).toBe(950_000n);
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
  });
});

describe("SwapExecutor dry-run", () => {
  it("buy() simule avec le quote et le montant configuré", async () => {
    const executor = stubbedExecutor(makeConfig());
    const result = await executor.buy(CANDIDATE);
    expect(result.ok).toBe(true);
    expect(result.simulated).toBe(true);
    expect(result.tokenAmount).toBe(1_000_000n);
    expect(result.amountInWeth).toBe(50_000_000_000_000_000n);
    expect(result.txHash).toBeUndefined();
  });

  it("buy() échoue proprement si le quote échoue", async () => {
    class FailingQuote extends StubbedExecutor {
      override async quoteBuy(): Promise<bigint> {
        throw new Error("quote ko");
      }
    }
    const executor = new FailingQuote({
      publicClient: {} as unknown as PublicClient,
      amounts: new TradeAmountProvider(makeConfig(), {} as unknown as QuoteClient),
      cfg: makeConfig(),
    });
    const result = await executor.buy(CANDIDATE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("quotage achat impossible");
  });

  it("buy() en live sans wallet renvoie une erreur explicite", async () => {
    const executor = stubbedExecutor(makeConfig({ dryRun: false }));
    const result = await executor.buy(CANDIDATE);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wallet absent");
  });

  it("sell() simule avec le quote courant (montant partiel ou total)", async () => {
    const executor = stubbedExecutor(makeConfig());
    const position = makePosition();
    const total = await executor.sell(position, position.tokenAmount, "take-profit x2");
    expect(total.ok).toBe(true);
    expect(total.simulated).toBe(true);
    expect(total.wethReceived).toBe(47_500_000_000_000_000n);

    const partiel = await executor.sell(position, 400_000n, "take-profit x5");
    expect(partiel.ok).toBe(true);
    expect(partiel.wethReceived).toBe(47_500_000_000_000_000n * 400_000n / 1_000_000n);
  });
});
