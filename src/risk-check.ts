import { parseEther } from "viem";
import type { PublicClient } from "viem";
import {
  ERC20_ABI,
  QUOTER_V2,
  QUOTER_V2_ABI,
  USDC_NATIVE,
  WETH9,
  encodeV3Path,
} from "./constants.js";
import type { BotConfig } from "./config.js";
import { logWarn } from "./logger.js";
import type { PoolCandidate, RiskMetric, RiskReport } from "./types.js";

/** FEE de la pool canonique WETH/USDC 0.05%, premier saut des routes multihop. */
const WETH_USDC_FEE = 500;

/** Rétention minimale du trajet achète-puis-revend (anti taxe/honeypot). */
const MIN_ROUNDTRIP_RETENTION = 0.8;

/** Noms de fonctions considérés dangereux (match par sous-chaîne, minuscules). */
const DANGEROUS_SUBSTRINGS = [
  "mint",
  "blacklist",
  "setfee",
  "settax",
  "pause",
  "setowner",
  "transferownership",
  "exclude",
  "whitelist",
  "setmaxtx",
  "antibot",
  "setlp",
  "setselllimit",
  "issue",
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

/**
 * Analyse un texte d'ABI (JSON) et retourne les noms de fonctions dangereuses.
 * Pur, testable. ABI non parsable -> ["<abi_non_parsee>"].
 */
export function scanAbiForThreats(abiJsonText: string): string[] {
  let abi: unknown;
  try {
    abi = JSON.parse(abiJsonText);
  } catch {
    return ["<abi_non_parsee>"];
  }
  if (!Array.isArray(abi)) {
    return ["<abi_non_parsee>"];
  }
  const threats = new Set<string>();
  for (const entry of abi) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      entry.type === "function" &&
      "name" in entry &&
      typeof entry.name === "string"
    ) {
      const name = entry.name.toLowerCase();
      for (const pattern of DANGEROUS_SUBSTRINGS) {
        if (name.includes(pattern)) {
          threats.add(entry.name);
          break;
        }
      }
    }
  }
  return [...threats];
}

/**
 * Rétention d'un aller-retour : partie du WETH investi récupérée à la revente
 * immédiate. 0.8 = 80%. Pur, testable.
 */
export function roundtripRetention(buyInWeth: bigint, sellOutWeth: bigint): number {
  if (buyInWeth <= 0n) return 0;
  return Number(sellOutWeth * 10_000n / buyInWeth) / 10_000;
}

/** Surface de lecture consommée (structurel : évite la variance des clients viem). */
type RiskReadClient = {
  readContract: PublicClient["readContract"];
};

interface EtherscanResponse {
  status: string;
  message: string;
  result: unknown;
}

/**
 * Endpoints de l'API Etherscan V2. Le domaine officiel (.org) a connu des
 * interruptions TLS globales (octobre 2026, alerte unrecognized_name depuis
 * tous types de clients) : l'ancien domaine .io, encore fonctionnel, sert
 * de repli automatique. L'échec TLS étant instantané, le coût du fallback
 * est négligeable.
 */
const ETHERSCAN_HOSTS = ["https://api.etherscan.org", "https://api.etherscan.io"] as const;

async function fetchEtherscan(params: Record<string, string>): Promise<EtherscanResponse> {
  const search = new URLSearchParams({ chainid: "8453", ...params });
  let lastError: unknown;
  for (const host of ETHERSCAN_HOSTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      try {
        const response = await fetch(`${host}/v2/api?${search.toString()}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} (${host})`);
        }
        return (await response.json()) as EtherscanResponse;
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function quoteSingle(
  publicClient: RiskReadClient,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
  fee: number,
): Promise<bigint> {
  const result = await publicClient.readContract({
    address: QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInputSingle",
    args: [[tokenIn, tokenOut, amountIn, BigInt(fee), 0n]],
  });
  return result[0];
}

async function quotePath(
  publicClient: RiskReadClient,
  path: `0x${string}`,
  amountIn: bigint,
): Promise<bigint> {
  const result = await publicClient.readContract({
    address: QUOTER_V2,
    abi: QUOTER_V2_ABI,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  });
  return result[0];
}

/** Chemins d'achat (WETH -> token) et de vente (token -> WETH) selon la pool. */
function swapPaths(
  candidate: PoolCandidate,
): { buySingle: boolean; sellSingle: boolean; buyPath?: `0x${string}`; sellPath?: `0x${string}` } {
  if (candidate.baseToken === "WETH") {
    return { buySingle: true, sellSingle: true };
  }
  return {
    buySingle: false,
    sellSingle: false,
    buyPath: encodeV3Path([WETH9, USDC_NATIVE, candidate.snipedToken], [WETH_USDC_FEE, candidate.fee]),
    sellPath: encodeV3Path([candidate.snipedToken, USDC_NATIVE, WETH9], [candidate.fee, WETH_USDC_FEE]),
  };
}

/**
 * Évalue le risque d'un candidat avant tout achat. Chaque contrôle produit
 * une RiskMetric ; le rapport passe si toutes passent. Ne lève jamais :
 * une erreur inattendue devient un rapport échoué (fail-safe = pas de trade).
 */
export async function assessRisk(
  publicClient: RiskReadClient,
  cfg: BotConfig,
  candidate: PoolCandidate,
  tradeAmountWei?: bigint,
): Promise<RiskReport> {
  const metrics: RiskMetric[] = [];
  const report: RiskReport = {
    candidate,
    passed: false,
    metrics,
  };

  try {
    // Métadonnées du token (best-effort).
    try {
      const [decimals, symbol] = await Promise.all([
        publicClient.readContract({
          address: candidate.snipedToken,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
        publicClient.readContract({
          address: candidate.snipedToken,
          abi: ERC20_ABI,
          functionName: "symbol",
        }),
      ]);
      report.tokenDecimals = decimals;
      report.tokenSymbol = symbol;
    } catch (err) {
      logWarn("token_metadata_echec", {
        token: candidate.snipedToken,
        erreur: err instanceof Error ? err.message : String(err),
      });
    }

    // 1. Contrat vérifié (Basescan) + récupération de l'ABI.
    let abiText: string | undefined;
    if (!cfg.basescanApiKey) {
      metrics.push({
        check: "basescan_verified",
        passed: false,
        detail: "BASESCAN_API_KEY absente : vérification impossible, achat bloqué",
      });
    } else {
      try {
        const response = await fetchEtherscan({
          module: "contract",
          action: "getsourcecode",
          address: candidate.snipedToken,
          apikey: cfg.basescanApiKey,
        });
        const first =
          Array.isArray(response.result) && response.result.length > 0
            ? (response.result[0] as { ABI?: string })
            : undefined;
        abiText = first?.ABI;
        if (response.status !== "1" || abiText === undefined || abiText === "Contract source code not verified") {
          metrics.push({
            check: "basescan_verified",
            passed: false,
            detail: "contrat non vérifié (ou réponse Basescan invalide)",
          });
          // ABI inutilisable : les contrôles suivants prennent le chemin
          // "ABI indisponible" au lieu de tenter de parser la phrase d'erreur.
          abiText = undefined;
        } else {
          metrics.push({ check: "basescan_verified", passed: true, detail: "contrat vérifié" });
        }
      } catch (err) {
        metrics.push({
          check: "basescan_verified",
          passed: false,
          detail: `erreur Basescan : ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 2. Fonctions dangereuses dans l'ABI.
    if (abiText === undefined) {
      metrics.push({
        check: "dangerous_functions",
        passed: false,
        detail: "ABI indisponible (contrôle basescan échoué)",
      });
    } else {
      const threats = scanAbiForThreats(abiText);
      metrics.push({
        check: "dangerous_functions",
        passed: threats.length === 0,
        value: threats.join(","),
        detail:
          threats.length === 0
            ? "aucune fonction dangereuse détectée"
            : `fonctions suspectes : ${threats.join(", ")}`,
      });

      // 3. Ownership : renoncé (owner nul) ou détenu par la pool elle-même.
      const hasOwner = JSON.parse(abiText).some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { type?: string; name?: string }).type === "function" &&
          (entry as { name?: string }).name === "owner",
      );
      if (!hasOwner) {
        metrics.push({
          check: "ownership",
          passed: true,
          detail: "pas de fonction owner() : pas de contrôle propriétaire",
        });
      } else {
        try {
          const owner = (await publicClient.readContract({
            address: candidate.snipedToken,
            abi: ERC20_ABI,
            functionName: "owner",
          })) as `0x${string}`;
          const renouncedOrPool =
            owner.toLowerCase() === ZERO_ADDRESS ||
            owner.toLowerCase() === candidate.poolAddress.toLowerCase();
          metrics.push({
            check: "ownership",
            passed: renouncedOrPool,
            value: owner,
            detail: renouncedOrPool
              ? "ownership renoncé (ou détenu par la pool)"
              : `owner actif ${owner} : risque de modification du contrat`,
          });
        } catch (err) {
          metrics.push({
            check: "ownership",
            passed: false,
            detail: `lecture owner() impossible : ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    const paths = swapPaths(candidate);

    // 4. Liquidité initiale de la pool (côté WETH, ou converti pour USDC).
    try {
      const minLiquidityWei = parseEther(String(cfg.minPoolLiquidityEth));
      let liquidityWeth: bigint;
      if (candidate.baseToken === "WETH") {
        liquidityWeth = await publicClient.readContract({
          address: WETH9,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [candidate.poolAddress],
        });
      } else {
        const usdcBalance = await publicClient.readContract({
          address: USDC_NATIVE,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [candidate.poolAddress],
        });
        // Taux WETH/USDC via la pool canonique 0.05%.
        const sampleUsdc = 1_000_000n;
        const wethPer1000Usdc = await quoteSingle(
          publicClient,
          USDC_NATIVE,
          WETH9,
          sampleUsdc,
          WETH_USDC_FEE,
        );
        liquidityWeth = usdcBalance * wethPer1000Usdc / sampleUsdc;
      }
      const liquidityOk = liquidityWeth >= minLiquidityWei;
      metrics.push({
        check: "pool_liquidity",
        passed: liquidityOk,
        value: `${Number(liquidityWeth) / 1e18} ETH`,
        detail: liquidityOk
          ? "liquidité initiale suffisante"
          : `liquidité ${Number(liquidityWeth) / 1e18} ETH < seuil ${cfg.minPoolLiquidityEth} ETH`,
      });
    } catch (err) {
      metrics.push({
        check: "pool_liquidity",
        passed: false,
        detail: `quotage liquidité impossible : ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 5. Simulation de vente (anti-honeypot) : quote aller puis retour.
    const simulationAmount = tradeAmountWei ?? cfg.tradeAmountWei;
    try {
      const buyTokens = paths.buySingle
        ? await quoteSingle(publicClient, WETH9, candidate.snipedToken, simulationAmount, candidate.fee)
        : await quotePath(publicClient, paths.buyPath!, simulationAmount);
      const sellWeth = paths.sellSingle
        ? await quoteSingle(publicClient, candidate.snipedToken, WETH9, buyTokens, candidate.fee)
        : await quotePath(publicClient, paths.sellPath!, buyTokens);
      report.buyQuoteTokens = buyTokens;
      report.sellQuoteWeth = sellWeth;
      const retention = roundtripRetention(simulationAmount, sellWeth);
      const retentionOk = retention >= MIN_ROUNDTRIP_RETENTION;
      metrics.push({
        check: "sell_simulation",
        passed: retentionOk,
        value: `${(retention * 100).toFixed(1)}%`,
        detail: retentionOk
          ? "vente simulée avec rétention suffisante"
          : `taxes/honeypot : rétention aller-retour ${(retention * 100).toFixed(1)}% < ${MIN_ROUNDTRIP_RETENTION * 100}%`,
      });
    } catch (err) {
      metrics.push({
        check: "sell_simulation",
        passed: false,
        detail: `honeypot probable : quote de vente échoue (${err instanceof Error ? err.message : String(err)})`,
      });
    }

    // 6. Concentration des holders (best-effort : endpoint PRO sur Etherscan V2).
    if (!cfg.basescanApiKey) {
      metrics.push({
        check: "holders_concentration",
        passed: true,
        detail: "indisponible (pas de clé API), contrôle ignoré",
      });
    } else {
      try {
        const response = await fetchEtherscan({
          module: "token",
          action: "topholders",
          contractaddress: candidate.snipedToken,
          page: "1",
          offset: "20",
          apikey: cfg.basescanApiKey,
        });
        if (response.status !== "1" || !Array.isArray(response.result)) {
          metrics.push({
            check: "holders_concentration",
            passed: true,
            detail: "indisponible (endpoint PRO), contrôle ignoré",
          });
        } else {
          const totalSupply = await publicClient.readContract({
            address: candidate.snipedToken,
            abi: ERC20_ABI,
            functionName: "totalSupply",
          });
          const excluded = new Set(
            [candidate.poolAddress.toLowerCase(), ZERO_ADDRESS, DEAD_ADDRESS.toLowerCase()].map((a) => a),
          );
          let maxShare = 0;
          for (const raw of response.result as Array<Record<string, unknown>>) {
            const address = typeof raw.address === "string" ? raw.address.toLowerCase() : "";
            if (excluded.has(address)) continue;
            const shares = BigInt(typeof raw.share === "string" ? Math.trunc(Number(raw.share) * 1e6) : 0);
            // `share` arrive en fraction de 1 sur cet endpoint ; conversion en /1e6 fixe.
            maxShare = Math.max(maxShare, Number(shares));
          }
          const maxSharePct = maxShare / 10_000; // 1e6 -> pourcent
          const holdersOk = maxSharePct <= cfg.maxHolderPct || totalSupply === 0n;
          metrics.push({
            check: "holders_concentration",
            passed: holdersOk,
            value: `${maxSharePct.toFixed(1)}%`,
            detail: holdersOk
              ? "aucun wallet dominant hors pool"
              : `un wallet détient ${maxSharePct.toFixed(1)}% > ${cfg.maxHolderPct}% hors pool`,
          });
        }
      } catch {
        metrics.push({
          check: "holders_concentration",
          passed: true,
          detail: "indisponible (erreur réseau), contrôle ignoré",
        });
      }
    }

    report.passed = metrics.every((m) => m.passed);
    return report;
  } catch (err) {
    logWarn("risk_check_erreur_interne", {
      token: candidate.snipedToken,
      erreur: err instanceof Error ? err.message : String(err),
    });
    metrics.push({
      check: "internal_error",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    report.passed = false;
    return report;
  }
}
