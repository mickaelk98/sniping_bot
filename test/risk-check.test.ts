import { describe, expect, it } from "vitest";
import { roundtripRetention, scanAbiForThreats } from "../src/risk-check.js";

const CLEAN_ABI = JSON.stringify([
  { type: "function", name: "transfer", inputs: [], outputs: [], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [], outputs: [], stateMutability: "view" },
]);

const RUG_ABI = JSON.stringify([
  { type: "function", name: "transfer", inputs: [], outputs: [], stateMutability: "view" },
  { type: "function", name: "mint", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setBlacklist", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setTaxFee", inputs: [], outputs: [], stateMutability: "nonpayable" },
]);

describe("scanAbiForThreats", () => {
  it("ne remonte rien sur un token propre", () => {
    expect(scanAbiForThreats(CLEAN_ABI)).toEqual([]);
  });

  it("détecte mint, blacklist et taxes", () => {
    const threats = scanAbiForThreats(RUG_ABI);
    expect(threats).toContain("mint");
    expect(threats).toContain("setBlacklist");
    expect(threats).toContain("setTaxFee");
    expect(threats).toHaveLength(3);
  });

  it("signale une ABI non parsable sans lever", () => {
    expect(scanAbiForThreats("ceci n'est pas du json")).toEqual(["<abi_non_parsee>"]);
  });

  it("ignore les entrées non-fonction (events, constructor)", () => {
    const abi = JSON.stringify([
      { type: "event", name: "Minted", inputs: [] },
      { type: "constructor", inputs: [] },
    ]);
    expect(scanAbiForThreats(abi)).toEqual([]);
  });
});

describe("roundtripRetention", () => {
  it("calcule la rétention d'un aller-retour", () => {
    expect(roundtripRetention(1_000_000n, 800_000n)).toBeCloseTo(0.8);
    expect(roundtripRetention(parse1e18(), parse1e18())).toBeCloseTo(1);
  });

  it("retourne 0 pour un achat nul ou impossible", () => {
    expect(roundtripRetention(0n, 100n)).toBe(0);
    expect(roundtripRetention(100n, 0n)).toBe(0);
  });
});

function parse1e18(): bigint {
  return 1_000_000_000_000_000_000n;
}
