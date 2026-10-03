import { describe, expect, it } from "vitest";
import { PositionManager, priceChangePct, type PositionExecutor } from "../src/position-manager.js";
import type { SellResult } from "../src/execution.js";
import type { BotConfig } from "../src/config.js";
import type { CloseReason, Position } from "../src/types.js";

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
    takeProfitPct: 50,
    stopLossPct: 30,
    positionPollSeconds: 10,
    ...overrides,
  };
}

function makePosition(id = "pos-1"): Position {
  return {
    id,
    token: TOKEN,
    tokenSymbol: "TEST",
    poolAddress: POOL,
    fee: 10000,
    baseToken: "WETH",
    amountInWeth: 1_000_000_000_000_000_000n,
    tokenAmount: 1_000_000n,
    entryValueWeth: 1_000_000_000_000_000_000n,
    openedAt: new Date().toISOString(),
    status: "open",
    consecutiveQuoteFailures: 0,
  };
}

class FakeExecutor implements PositionExecutor {
  quoteValue = 1_000_000_000_000_000_000n;
  quoteShouldFail = false;
  sellShouldFail = false;
  sells: { position: Position; reason: CloseReason }[] = [];

  async quoteSell(): Promise<bigint> {
    if (this.quoteShouldFail) throw new Error("quote ko");
    return this.quoteValue;
  }

  async sell(position: Position, reason: CloseReason): Promise<SellResult> {
    this.sells.push({ position, reason });
    if (this.sellShouldFail) {
      return { ok: false, wethReceived: 0n, simulated: true, error: "vente ko" };
    }
    return { ok: true, wethReceived: 1_500_000_000_000_000_000n, simulated: true };
  }
}

describe("priceChangePct", () => {
  it("calcule le pourcentage de variation", () => {
    const e18 = 1_000_000_000_000_000_000n;
    expect(priceChangePct(e18, e18 * 3n / 2n)).toBeCloseTo(50);
    expect(priceChangePct(e18, e18 * 7n / 10n)).toBeCloseTo(-30);
    expect(priceChangePct(e18, e18)).toBe(0);
    expect(priceChangePct(0n, e18)).toBe(0);
  });
});

describe("PositionManager.tick", () => {
  it("déclenche le take-profit à +50%", async () => {
    const executor = new FakeExecutor();
    executor.quoteValue = 1_500_000_000_000_000_000n;
    const pm = new PositionManager(makeConfig(), executor);
    pm.open(makePosition());
    await pm.tick();
    expect(executor.sells).toHaveLength(1);
    expect(executor.sells[0]!.reason).toBe("take-profit");
    expect(pm.openCount()).toBe(0);
  });

  it("déclenche le stop-loss à -30%", async () => {
    const executor = new FakeExecutor();
    executor.quoteValue = 700_000_000_000_000_000n;
    const pm = new PositionManager(makeConfig(), executor);
    pm.open(makePosition());
    await pm.tick();
    expect(executor.sells[0]!.reason).toBe("stop-loss");
  });

  it("ne fait rien entre les seuils", async () => {
    const executor = new FakeExecutor();
    executor.quoteValue = 1_200_000_000_000_000_000n;
    const pm = new PositionManager(makeConfig(), executor);
    pm.open(makePosition());
    await pm.tick();
    expect(executor.sells).toHaveLength(0);
    expect(pm.openCount()).toBe(1);
  });

  it("trois échecs de quote consécutifs -> vente d'urgence", async () => {
    const executor = new FakeExecutor();
    executor.quoteShouldFail = true;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);
    await pm.tick();
    await pm.tick();
    expect(executor.sells).toHaveLength(0);
    await pm.tick();
    expect(executor.sells).toHaveLength(1);
    expect(executor.sells[0]!.reason).toBe("emergency");
  });

  it("reset le compteur d'échecs après un quote réussi", async () => {
    const executor = new FakeExecutor();
    executor.quoteShouldFail = true;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);
    await pm.tick();
    await pm.tick();
    executor.quoteShouldFail = false;
    await pm.tick();
    expect(position.consecutiveQuoteFailures).toBe(0);
    expect(executor.sells).toHaveLength(0);
  });

  it("une vente échouée laisse la position ouverte pour retry", async () => {
    const executor = new FakeExecutor();
    executor.quoteValue = 1_500_000_000_000_000_000n;
    executor.sellShouldFail = true;
    const pm = new PositionManager(makeConfig(), executor);
    pm.open(makePosition());
    await pm.tick();
    expect(pm.openCount()).toBe(1);
    executor.sellShouldFail = false;
    await pm.tick();
    expect(pm.openCount()).toBe(0);
  });

  it("appelle onClosed avec les infos de clôture", async () => {
    const executor = new FakeExecutor();
    executor.quoteValue = 2_000_000_000_000_000_000n;
    const closed: Position[] = [];
    const pm = new PositionManager(makeConfig(), executor, {
      onClosed: (p) => {
        closed.push(p);
      },
    });
    pm.open(makePosition());
    await pm.tick();
    expect(closed).toHaveLength(1);
    expect(closed[0]!.close?.reason).toBe("take-profit");
    expect(closed[0]!.close?.wethReceived).toBe(1_500_000_000_000_000_000n);
  });

  it("ignore les positions déjà fermées", async () => {
    const executor = new FakeExecutor();
    executor.quoteValue = 1_500_000_000_000_000_000n;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    position.status = "closed";
    pm.open(position);
    await pm.tick();
    expect(executor.sells).toHaveLength(0);
  });
});
