import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

function setEnv(vars: Record<string, string | undefined>): void {
  const keys = [
    "DRY_RUN",
    "PRIVATE_KEY",
    "BASE_WS_URL",
    "BASE_RPC_URL",
    "TRADE_AMOUNT_ETH",
    "TRADE_AMOUNT_USD",
    "ETH_PRICE_REFRESH_MINUTES",
    "DAILY_BUDGET_ETH",
  ];
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const VALID_BASE = {
  BASE_WS_URL: "wss://base.example.com",
  BASE_RPC_URL: "https://base.example.com",
  TRADE_AMOUNT_ETH: "0.05",
  DAILY_BUDGET_ETH: "0.5",
};

describe("loadConfig", () => {
  it("charge une configuration valide en dry-run sans clé privée", () => {
    setEnv(VALID_BASE);
    const cfg = loadConfig();
    expect(cfg.dryRun).toBe(true);
    expect(cfg.privateKey).toBeUndefined();
    expect(cfg.tradeAmountWei).toBe(50000000000000000n);
    expect(cfg.dailyBudgetWei).toBe(500000000000000000n);
  });

  it("défaut dry-run = true quand DRY_RUN est absent", () => {
    setEnv(VALID_BASE);
    expect(loadConfig().dryRun).toBe(true);
  });

  it("DRY_RUN=false exige une clé privée valide", () => {
    setEnv({ ...VALID_BASE, DRY_RUN: "false" });
    expect(() => loadConfig()).toThrow(ConfigError);

    setEnv({
      ...VALID_BASE,
      DRY_RUN: "false",
      PRIVATE_KEY: "0x" + "ab".repeat(32),
    });
    expect(loadConfig().dryRun).toBe(false);
  });

  it("rejette une clé privée mal formée même en dry-run", () => {
    setEnv({ ...VALID_BASE, PRIVATE_KEY: "0x1234" });
    expect(() => loadConfig()).toThrow(/PRIVATE_KEY/);
  });

  it("liste tous les problèmes manquants d'un coup", () => {
    setEnv({});
    try {
      loadConfig();
      throw new Error("aurait dû lever ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain("BASE_WS_URL");
      expect(message).toContain("BASE_RPC_URL");
      expect(message).toContain("TRADE_AMOUNT_ETH");
      expect(message).toContain("DAILY_BUDGET_ETH");
    }
  });

  it("rejette un TRADE_AMOUNT_ETH écrasant le budget journalier ? non, mais un montant invalide oui", () => {
    setEnv({ ...VALID_BASE, TRADE_AMOUNT_ETH: "abc" });
    expect(() => loadConfig()).toThrow(/TRADE_AMOUNT_ETH/);
  });

  it("mode dynamique : TRADE_AMOUNT_USD sans TRADE_AMOUNT_ETH est valide", () => {
    const { TRADE_AMOUNT_ETH: _omis, ...sansEth } = VALID_BASE;
    setEnv({ ...sansEth, TRADE_AMOUNT_USD: "5" });
    const cfg = loadConfig();
    expect(cfg.tradeAmountUsd).toBe(5);
    expect(cfg.tradeAmountWei).toBe(0n);
    expect(cfg.ethPriceRefreshMinutes).toBe(10);
  });

  it("TRADE_AMOUNT_USD est prioritaire quand les deux sont définis", () => {
    setEnv({ ...VALID_BASE, TRADE_AMOUNT_USD: "5" });
    const cfg = loadConfig();
    expect(cfg.tradeAmountUsd).toBe(5);
    expect(cfg.tradeAmountWei).toBe(50_000_000_000_000_000n);
  });

  it("aucun montant défini (ni ETH ni USD) -> erreur", () => {
    const { TRADE_AMOUNT_ETH: _omis, ...sansEth } = VALID_BASE;
    setEnv(sansEth);
    expect(() => loadConfig()).toThrow(/TRADE_AMOUNT_ETH/);
  });
});
