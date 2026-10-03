import { describe, expect, it } from "vitest";
import { toCandidate } from "../src/listener.js";
import { USDC_NATIVE, WETH9 } from "../src/constants.js";

const TOKEN = "0x1234567890123456789012345678901234567890" as `0x${string}`;
const POOL = "0xabcdef0000000000000000000000000000000001" as `0x${string}`;

describe("toCandidate (filtre PoolCreated)", () => {
  it("accepte une pool WETH/token et désigne le token snipé", () => {
    const c = toCandidate({ token0: TOKEN, token1: WETH9, fee: 10000, poolAddress: POOL });
    expect(c).not.toBeNull();
    expect(c!.snipedToken).toBe(TOKEN);
    expect(c!.baseToken).toBe("WETH");
    expect(c!.fee).toBe(10000);
    expect(c!.detectedAt).toBeTruthy();
  });

  it("accepte une pool USDC/token (USDC natif)", () => {
    const c = toCandidate({ token0: USDC_NATIVE, token1: TOKEN, fee: 3000, poolAddress: POOL });
    expect(c).not.toBeNull();
    expect(c!.snipedToken).toBe(TOKEN);
    expect(c!.baseToken).toBe("USDC");
  });

  it("rejette la pool WETH/USDC (aucun token snipé)", () => {
    expect(toCandidate({ token0: WETH9, token1: USDC_NATIVE, fee: 500, poolAddress: POOL })).toBeNull();
  });

  it("rejette une pool exotique sans token de cotation", () => {
    const OTHER = "0x9999999999999999999999999999999999999999" as `0x${string}`;
    expect(toCandidate({ token0: TOKEN, token1: OTHER, fee: 100, poolAddress: POOL })).toBeNull();
  });

  it("rejette WETH en minuscules/majuscules mixtes via normalisation", () => {
    const wethMixed = "0x4200000000000000000000000000000000000006" as `0x${string}`;
    const c = toCandidate({ token0: wethMixed, token1: TOKEN, fee: 500, poolAddress: POOL });
    expect(c?.baseToken).toBe("WETH");
  });
});
