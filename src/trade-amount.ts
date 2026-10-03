import { parseEther } from "viem";
import type { PublicClient } from "viem";
import { QUOTER_V2, QUOTER_V2_ABI, USDC_NATIVE, WETH9 } from "./constants.js";
import type { BotConfig } from "./config.js";
import { logInfo, logWarn } from "./logger.js";

/** Bornes de sécurité du montant calculé (protection contre un prix aberrant). */
export const MIN_TRADE_WEI = 100_000_000_000_000n; // 0.0001 ETH
export const MAX_TRADE_WEI = 100_000_000_000_000_000n; // 0.1 ETH

/** Surface de lecture nécessaire (structurel). */
export type QuoteClient = {
  readContract: PublicClient["readContract"];
};

/**
 * Fournit le montant effectif par trade :
 * - mode fixe (pas de TRADE_AMOUNT_USD) : renvoie cfg.tradeAmountWei ;
 * - mode dynamique : montant = TRADE_AMOUNT_USD / prix ETH, prix lu on-chain
 *   via la pool WETH/USDC 0.05% (QuoterV2), mis en cache pour
 *   cfg.ethPriceRefreshMinutes. Retourne 0n si le montant sort des bornes
 *   ou si aucun prix n'est disponible : l'appelant bloque le trade.
 */
export class TradeAmountProvider {
  private priceUsd: number | undefined;
  private fetchedAt = 0;

  constructor(
    private readonly cfg: BotConfig,
    private readonly client: QuoteClient,
  ) {}

  async currentAmountWei(): Promise<bigint> {
    if (this.cfg.tradeAmountUsd === undefined) {
      return this.cfg.tradeAmountWei;
    }
    const price = await this.currentEthPriceUsd();
    if (price === undefined) {
      logWarn("montant_indisponible", { raison: "prix ETH indisponible" });
      return 0n;
    }
    const ethAmount = this.cfg.tradeAmountUsd / price;
    const wei = parseEther(ethAmount.toFixed(9));
    if (wei < MIN_TRADE_WEI || wei > MAX_TRADE_WEI) {
      logWarn("montant_hors_bornes", {
        tradeAmountUsd: this.cfg.tradeAmountUsd,
        prixEthUsd: price,
        montantEth: ethAmount,
        bornesEth: [Number(MIN_TRADE_WEI) / 1e18, Number(MAX_TRADE_WEI) / 1e18],
      });
      return 0n;
    }
    return wei;
  }

  /** Prix ETH en USD (cache inclus). undefined si aucun prix exploitable. */
  async currentEthPriceUsd(): Promise<number | undefined> {
    await this.refreshPriceIfNeeded();
    return this.priceUsd;
  }

  private async refreshPriceIfNeeded(): Promise<void> {
    const ttlMs = this.cfg.ethPriceRefreshMinutes * 60_000;
    if (this.priceUsd !== undefined && Date.now() - this.fetchedAt < ttlMs) {
      return;
    }
    try {
      const result = await this.client.readContract({
        address: QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [[WETH9, USDC_NATIVE, 1_000_000_000_000_000_000n, 500n, 0n]],
      });
      const usdcOut = result[0]; // USDC natif, 6 décimales
      const price = Number(usdcOut) / 1e6;
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`prix invalide : ${price}`);
      }
      this.priceUsd = price;
      this.fetchedAt = Date.now();
      logInfo("prix_eth", { prixUsd: price, source: "pool WETH/USDC 0.05% (on-chain)" });
    } catch (err) {
      // Pas de prix connu -> remonte (l'appelant bloque) ; sinon on garde
      // l'ancien prix (périmé) plutôt que de paralyser le bot.
      if (this.priceUsd === undefined) {
        logWarn("prix_eth_indisponible", {
          erreur: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      logWarn("prix_eth_perime_utilise", {
        dernierPrix: this.priceUsd,
        erreur: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
