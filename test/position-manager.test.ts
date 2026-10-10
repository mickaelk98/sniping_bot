import { describe, expect, it } from "vitest";
import { PositionManager, priceMultiple, type PositionExecutor } from "../src/position-manager.js";
import type { SellResult } from "../src/execution.js";
import type { BotConfig } from "../src/config.js";
import type { Position } from "../src/types.js";

const TOKEN = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const POOL = "0xabcdef0000000000000000000000000000000001" as `0x${string}`;

const TIERS = [
  { multiple: 2, sellPct: 50 },
  { multiple: 5, sellPct: 20 },
  { multiple: 10, sellPct: 20 },
  { multiple: 20, sellPct: 20 },
  { multiple: 30, sellPct: 20 },
  { multiple: 40, sellPct: 20 },
  { multiple: 50, sellPct: 20 },
  { multiple: 100, sellPct: 50 },
];

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
    takeProfitTiers: TIERS,
    trailingStopPct: 20,
    stopLossPct: 30,
    maxHoldHours: 6,
    positionPollSeconds: 10,
    ...overrides,
  };
}

/** Position de référence : 1M tokens, entrée 1e18 wei (1e12 wei/token). */
function makePosition(id = "pos-1"): Position {
  return {
    id,
    token: TOKEN,
    tokenSymbol: "TEST",
    poolAddress: POOL,
    fee: 10000,
    baseToken: "WETH",
    amountInWeth: 1_000_000_000_000_000_000n,
    initialTokenAmount: 1_000_000n,
    tokenAmount: 1_000_000n,
    entryValueWeth: 1_000_000_000_000_000_000n,
    realizedWeth: 0n,
    highWaterMultiple: 1,
    nextTierIndex: 0,
    sells: [],
    openedAt: new Date().toISOString(),
    status: "open",
    consecutiveQuoteFailures: 0,
  };
}

class FakeExecutor implements PositionExecutor {
  multiple = 1;
  quoteShouldFail = false;
  sellFailuresRemaining = 0;
  sells: { amount: bigint; reason: string }[] = [];

  async quoteSell(
    _token: `0x${string}`,
    _fee: number,
    _baseToken: "WETH" | "USDC",
    amountTokens: bigint,
  ): Promise<bigint> {
    if (this.quoteShouldFail) throw new Error("quote ko");
    return BigInt(Math.round(this.multiple * 1e12)) * amountTokens;
  }

  async sell(_position: Position, amountTokens: bigint, reason: string): Promise<SellResult> {
    this.sells.push({ amount: amountTokens, reason });
    if (this.sellFailuresRemaining > 0) {
      this.sellFailuresRemaining -= 1;
      return { ok: false, wethReceived: 0n, simulated: true, error: "vente ko" };
    }
    return {
      ok: true,
      wethReceived: BigInt(Math.round(this.multiple * 1e12)) * amountTokens,
      simulated: true,
    };
  }
}

describe("priceMultiple", () => {
  it("calcule le multiple prix/entrée en ignorant les ventes partielles", () => {
    const position = makePosition();
    position.tokenAmount = 400_000n; // après deux ventes partielles
    const quote400k = BigInt(5 * 1e12) * 400_000n; // prix x5
    expect(priceMultiple(position, quote400k)).toBeCloseTo(5);
  });

  it("retourne 1 sur données incohérentes", () => {
    const position = makePosition();
    position.tokenAmount = 0n;
    expect(priceMultiple(position, 1n)).toBe(1);
  });
});

describe("PositionManager - paliers escaladés", () => {
  it("x2 : vend 50% du solde et sécurise le capital initial", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 2;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);
    await pm.tick();

    expect(position.sells).toHaveLength(1);
    expect(position.sells[0]!.tokensSold).toBe(500_000n);
    expect(position.sells[0]!.wethReceived).toBe(1_000_000_000_000_000_000n); // capital initial
    expect(position.tokenAmount).toBe(500_000n);
    expect(position.nextTierIndex).toBe(1);
    expect(position.status).toBe("open");
  });

  it("gap de prix : franchit plusieurs paliers dans le même tick", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 6; // dépasse x2 et x5
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);
    await pm.tick();

    expect(position.sells).toHaveLength(2); // x2 (50%) puis x5 (20% du reste)
    expect(position.tokenAmount).toBe(400_000n);
    expect(position.nextTierIndex).toBe(2);
  });

  it("vente partielle échouée : le palier est retenté au tick suivant", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 2;
    executor.sellFailuresRemaining = 1;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);
    await pm.tick();
    expect(position.nextTierIndex).toBe(0); // palier non consommé

    await pm.tick();
    expect(position.nextTierIndex).toBe(1);
    expect(position.tokenAmount).toBe(500_000n);
  });

  it("dernier palier à 100% : clôture tiers-complete", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 2;
    const pm = new PositionManager(
      makeConfig({ takeProfitTiers: [{ multiple: 2, sellPct: 100 }] }),
      executor,
    );
    const position = makePosition();
    pm.open(position);
    await pm.tick();

    expect(position.tokenAmount).toBe(0n);
    expect(position.status).toBe("closed");
    expect(position.close?.reason).toBe("tiers-complete");
  });
});

describe("PositionManager - trailing stop", () => {
  it("actif après le premier palier : chute de 20% depuis le plus haut", async () => {
    const executor = new FakeExecutor();
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);

    executor.multiple = 2.2; // palier x2 + plus haut à 2.2
    await pm.tick();
    expect(position.status).toBe("open");

    executor.multiple = 1.7; // 2.2 * 0.8 = 1.76 -> déclenche
    await pm.tick();
    expect(position.status).toBe("closed");
    expect(position.close?.reason).toBe("trailing-stop");
    expect(position.close?.wethReceived).toBe(
      1_100_000_000_000_000_000n + 850_000_000_000_000_000n, // x2 (50%) + 1.7 (50%)
    );
  });

  it("inactif avant le premier palier : une oscillation ne sort pas", async () => {
    const executor = new FakeExecutor();
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);

    executor.multiple = 1.5;
    await pm.tick();
    executor.multiple = 1.1; // chute depuis 1.5, mais aucun palier passé
    await pm.tick();
    expect(position.status).toBe("open");
    expect(position.sells).toHaveLength(0);
  });
});

describe("PositionManager - stop-loss et urgence", () => {
  it("stop-loss d'entrée à -30%", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 0.69;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    pm.open(position);
    await pm.tick();

    expect(position.status).toBe("closed");
    expect(position.close?.reason).toBe("stop-loss");
    expect(position.tokenAmount).toBe(0n);
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
    expect(position.close?.reason).toBe("emergency");
  });

  it("onSell remonte chaque événement (partiel puis final)", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 2.2;
    const events: string[] = [];
    const pm = new PositionManager(makeConfig(), executor, {
      onSell: (_p, e) => {
        events.push(e.kind === "partial" ? `partial x${e.tier?.multiple}` : `final ${e.reason}`);
      },
    });
    const position = makePosition();
    pm.open(position);
    await pm.tick();
    expect(events).toEqual(["partial x2"]);

    executor.multiple = 1.7;
    await pm.tick();
    expect(events).toEqual(["partial x2", "final trailing-stop"]);
  });
});

describe("PositionManager - durée max de détention", () => {
  const H7 = 7 * 3_600_000;

  it("position âgée sans palier -> vente max-hold du solde complet", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 1.2; // zone morte : ni palier ni stop-loss
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    position.openedAt = new Date(Date.now() - H7).toISOString();
    pm.open(position);
    await pm.tick();

    expect(position.status).toBe("closed");
    expect(position.close?.reason).toBe("max-hold");
    expect(executor.sells).toHaveLength(1);
    expect(executor.sells[0]!.amount).toBe(1_000_000n);
  });

  it("palier franchi : la position gagnante est exempte", async () => {
    const executor = new FakeExecutor();
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition();
    position.openedAt = new Date(Date.now() - H7).toISOString();
    executor.multiple = 2;
    pm.open(position);
    await pm.tick(); // palier x2 consommé, capital sécurisé

    executor.multiple = 1.7; // au-dessus du trailing (2 * 0.8 = 1.6)
    await pm.tick();
    expect(position.status).toBe("open"); // âgée de 7 h mais gagnante : conservée
  });

  it("MAX_HOLD_HOURS=0 désactive la règle", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 1.2;
    const pm = new PositionManager(makeConfig({ maxHoldHours: 0 }), executor);
    const position = makePosition();
    position.openedAt = new Date(Date.now() - H7).toISOString();
    pm.open(position);
    await pm.tick();
    expect(position.status).toBe("open");
  });

  it("position récente : pas de fermeture", async () => {
    const executor = new FakeExecutor();
    executor.multiple = 1.2;
    const pm = new PositionManager(makeConfig(), executor);
    const position = makePosition(); // openedAt = maintenant
    pm.open(position);
    await pm.tick();
    expect(position.status).toBe("open");
  });
});
