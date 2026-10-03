import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { loadConfig } from "../src/config.js";
import { assessRisk } from "../src/risk-check.js";
import { FACTORY_ABI, UNISWAP_V3_FACTORY, WETH9 } from "../src/constants.js";
import type { PoolCandidate } from "../src/types.js";

// Démo : risk-check complet sur un token réel (DEGEN) avec la config .env.
const cfg = loadConfig();
const client = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

const TOKEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed"; // DEGEN
const FEE = 3000;

const pool = await client.readContract({
  address: UNISWAP_V3_FACTORY,
  abi: FACTORY_ABI,
  functionName: "getPool",
  args: [TOKEN, WETH9, FEE],
});
console.log("Pool V3 trouvée :", pool);

const sorted = TOKEN.toLowerCase() < WETH9.toLowerCase();
const candidate: PoolCandidate = {
  poolAddress: pool,
  token0: sorted ? TOKEN : WETH9,
  token1: sorted ? WETH9 : TOKEN,
  fee: FEE,
  snipedToken: TOKEN,
  baseToken: "WETH",
  detectedAt: new Date().toISOString(),
};

const report = await assessRisk(client, cfg, candidate);
console.log("Token :", report.tokenSymbol, "(decimals:", report.tokenDecimals ?? "?", ")");
for (const m of report.metrics) {
  console.log(`  ${m.passed ? "OK " : "KO "} ${m.check} : ${m.detail}${m.value ? ` [${m.value}]` : ""}`);
}
console.log("VERDICT :", report.passed ? "ACHAT AUTORISÉ" : "ACHAT REFUSÉ");
