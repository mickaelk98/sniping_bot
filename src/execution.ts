import type { PublicClient, WalletClient } from "viem";
import {
  ERC20_ABI,
  HELPER_CONTRACT_ABI,
  QUOTER_V2,
  QUOTER_V2_ABI,
  ROUTER_ABI,
  SWAP_ROUTER_02,
  USDC_NATIVE,
  WETH9,
  WETH_ABI,
  encodeV3Path,
} from "./constants.js";
import type { BotConfig } from "./config.js";
import { logInfo, logWarn } from "./logger.js";
import type { BuyResult, CloseReason, PoolCandidate, Position } from "./types.js";

const NATIVE_ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Pool canonique WETH/USDC 0.05% : premier saut des routes multihop. */
const WETH_USDC_FEE = 500;

/** Réserve d'ETH gardée pour le gaz lors du wrapping du tampon WETH. */
const GAS_RESERVE_WEI = 10_000_000_000_000n; // 0.00001 ETH

export interface SellResult {
  ok: boolean;
  wethReceived: bigint;
  txHash?: `0x${string}`;
  simulated: boolean;
  error?: string;
}

/** Surface de lecture consommée (structurel : évite la variance des clients viem). */
export interface ReadClient {
  readContract: PublicClient["readContract"];
  waitForTransactionReceipt: PublicClient["waitForTransactionReceipt"];
  getBalance: PublicClient["getBalance"];
}

/** Surface d'écriture consommée. */
export interface WriteClient {
  writeContract: WalletClient["writeContract"];
  account: WalletClient["account"];
}

export interface ExecutorDeps {
  publicClient: ReadClient;
  walletClient?: WriteClient;
  cfg: BotConfig;
}

/** Slippage : amountOutMin = amountOut * (1 - slippageBps/10000), floor. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps <= 0) return amountOut;
  return (amountOut * (10_000n - BigInt(slippageBps))) / 10_000n;
}

/**
 * Exécuteur de swaps : achat WETH->token et vente token->WETH.
 * Deux modes :
 * - contrat helper (HELPER_CONTRACT_ADDRESS) : ETH in/out, deadline validée
 *   par le contrat non-custodial MultiHopSwap ;
 * - routeur direct (défaut) : WETH + approbations finies au SwapRouter02.
 * En dry-run : quotages réels, aucune transaction envoyée, résultats simulés.
 */
export class SwapExecutor {
  protected readonly deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  private get cfg(): BotConfig {
    return this.deps.cfg;
  }

  private get accountAddress(): `0x${string}` | undefined {
    return this.deps.walletClient?.account?.address;
  }

  /** Quote WETH -> token (montant de tokens attendu). */
  async quoteBuy(
    token: `0x${string}`,
    fee: number,
    baseToken: "WETH" | "USDC",
    amountInWeth: bigint,
  ): Promise<bigint> {
    if (baseToken === "WETH") {
      const result = await this.deps.publicClient.readContract({
        address: QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [[WETH9, token, amountInWeth, BigInt(fee), 0n]],
      });
      return result[0];
    }
    const path = encodeV3Path([WETH9, USDC_NATIVE, token], [WETH_USDC_FEE, fee]);
    const result = await this.deps.publicClient.readContract({
      address: QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [path, amountInWeth],
    });
    return result[0];
  }

  /** Quote token -> WETH (valeur WETH courante des tokens). */
  async quoteSell(
    token: `0x${string}`,
    fee: number,
    baseToken: "WETH" | "USDC",
    amountTokens: bigint,
  ): Promise<bigint> {
    if (baseToken === "WETH") {
      const result = await this.deps.publicClient.readContract({
        address: QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [[token, WETH9, amountTokens, BigInt(fee), 0n]],
      });
      return result[0];
    }
    const path = encodeV3Path([token, USDC_NATIVE, WETH9], [fee, WETH_USDC_FEE]);
    const result = await this.deps.publicClient.readContract({
      address: QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [path, amountTokens],
    });
    return result[0];
  }

  /**
   * Mode routeur direct live : pré-constitue un tampon WETH couvrant le
   * budget journalier pour que les achats restent rapides (un seul tx par
   * achat). En dry-run ou mode contrat : simple log.
   */
  async ensureWethBuffer(): Promise<void> {
    const { walletClient, publicClient } = this.deps;
    if (this.cfg.helperContractAddress || !walletClient || !this.accountAddress) {
      logInfo("tampon_weth_non_requis", { mode: this.cfg.helperContractAddress ? "contrat" : "dry-run" });
      return;
    }
    try {
      const account = this.accountAddress;
      const wethBalance = await publicClient.readContract({
        address: WETH9,
        abi: WETH_ABI,
        functionName: "balanceOf",
        args: [account],
      });
      if (wethBalance >= this.cfg.tradeAmountWei) {
        logInfo("tampon_weth_ok", { weth: Number(wethBalance) / 1e18 });
        return;
      }
      const missing = this.cfg.dailyBudgetWei - wethBalance;
      const ethBalance = await publicClient.getBalance({ address: account });
      const wrappable = ethBalance - GAS_RESERVE_WEI;
      if (wrappable <= 0n) {
        logWarn("tampon_weth_impossible", { raison: "solde ETH insuffisant (réserve gaz)" });
        return;
      }
      const amount = missing > wrappable ? wrappable : missing;
      const hash = await walletClient.writeContract({
        address: WETH9,
        abi: WETH_ABI,
        functionName: "deposit",
        value: amount,
        chain: null, account,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      logInfo("tampon_weth_constitue", {
        weth: Number(amount) / 1e18,
        txHash: receipt.status === "success" ? hash : `${hash} (ECHEC)`,
      });
    } catch (err) {
      logWarn("tampon_weth_echec", {
        erreur: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Achat : quote frais -> amountOutMin dynamique -> swap (ou simulation). */
  async buy(candidate: PoolCandidate): Promise<BuyResult> {
    let quotedTokens: bigint;
    try {
      quotedTokens = await this.quoteBuy(
        candidate.snipedToken,
        candidate.fee,
        candidate.baseToken,
        this.cfg.tradeAmountWei,
      );
    } catch (err) {
      return {
        ok: false,
        simulated: this.cfg.dryRun,
        token: candidate.snipedToken,
        amountInWeth: this.cfg.tradeAmountWei,
        tokenAmount: 0n,
        error: `quotage achat impossible : ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const amountOutMin = applySlippage(quotedTokens, this.cfg.maxSlippageBps);

    if (this.cfg.dryRun) {
      logInfo("dry_run_buy", {
        token: candidate.snipedToken,
        fee: candidate.fee,
        baseToken: candidate.baseToken,
        mode: this.cfg.helperContractAddress ? "contrat" : "routeur",
        montantInWei: this.cfg.tradeAmountWei.toString(),
        tokensQuotes: quotedTokens.toString(),
        amountOutMin: amountOutMin.toString(),
      });
      return {
        ok: true,
        simulated: true,
        token: candidate.snipedToken,
        amountInWeth: this.cfg.tradeAmountWei,
        tokenAmount: quotedTokens,
      };
    }

    const { walletClient, publicClient } = this.deps;
    if (!walletClient || !this.accountAddress) {
      return {
        ok: false,
        simulated: false,
        token: candidate.snipedToken,
        amountInWeth: this.cfg.tradeAmountWei,
        tokenAmount: 0n,
        error: "wallet absent (PRIVATE_KEY non configure)",
      };
    }
    const account = this.accountAddress;

    try {
      const balanceBefore = await this.tokenBalance(candidate.snipedToken, account);
      let hash: `0x${string}`;

      if (this.cfg.helperContractAddress) {
        const deadline = BigInt(Math.floor(Date.now() / 1000) + this.cfg.swapDeadlineSeconds);
        hash =
          candidate.baseToken === "WETH"
            ? await walletClient.writeContract({
                address: this.cfg.helperContractAddress,
                abi: HELPER_CONTRACT_ABI,
                functionName: "swapExactInputSingle",
                args: [
                  NATIVE_ZERO,
                  candidate.snipedToken,
                  candidate.fee,
                  this.cfg.tradeAmountWei,
                  amountOutMin,
                  deadline,
                ],
                value: this.cfg.tradeAmountWei,
                chain: null, account,
              })
            : await walletClient.writeContract({
                address: this.cfg.helperContractAddress,
                abi: HELPER_CONTRACT_ABI,
                functionName: "swapExactInputMultihop",
                args: [
                  encodeV3Path([WETH9, USDC_NATIVE, candidate.snipedToken], [WETH_USDC_FEE, candidate.fee]),
                  true,
                  false,
                  this.cfg.tradeAmountWei,
                  amountOutMin,
                  deadline,
                ],
                value: this.cfg.tradeAmountWei,
                chain: null, account,
              });
      } else {
        const wethBalance = await publicClient.readContract({
          address: WETH9,
          abi: WETH_ABI,
          functionName: "balanceOf",
          args: [account],
        });
        if (wethBalance < this.cfg.tradeAmountWei) {
          return {
            ok: false,
            simulated: false,
            token: candidate.snipedToken,
            amountInWeth: this.cfg.tradeAmountWei,
            tokenAmount: 0n,
            error: "solde WETH insuffisant (tampon non constitue)",
          };
        }
        await this.approveAndWait(WETH9, SWAP_ROUTER_02, this.cfg.tradeAmountWei);
        hash =
          candidate.baseToken === "WETH"
            ? await walletClient.writeContract({
                address: SWAP_ROUTER_02,
                abi: ROUTER_ABI,
                functionName: "exactInputSingle",
                args: [
                  {
                    tokenIn: WETH9,
                    tokenOut: candidate.snipedToken,
                    fee: candidate.fee,
                    recipient: account,
                    amountIn: this.cfg.tradeAmountWei,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
                chain: null, account,
              })
            : await walletClient.writeContract({
                address: SWAP_ROUTER_02,
                abi: ROUTER_ABI,
                functionName: "exactInput",
                args: [
                  {
                    path: encodeV3Path([WETH9, USDC_NATIVE, candidate.snipedToken], [WETH_USDC_FEE, candidate.fee]),
                    recipient: account,
                    amountIn: this.cfg.tradeAmountWei,
                    amountOutMinimum: amountOutMin,
                  },
                ],
                chain: null, account,
              });
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return {
          ok: false,
          simulated: false,
          token: candidate.snipedToken,
          amountInWeth: this.cfg.tradeAmountWei,
          tokenAmount: 0n,
          txHash: hash,
          error: "tx revertee",
        };
      }
      const balanceAfter = await this.tokenBalance(candidate.snipedToken, account);
      const tokenAmount = balanceAfter - balanceBefore;
      if (tokenAmount <= 0n) {
        return {
          ok: false,
          simulated: false,
          token: candidate.snipedToken,
          amountInWeth: this.cfg.tradeAmountWei,
          tokenAmount: 0n,
          txHash: hash,
          error: "aucun token recu apres swap",
        };
      }
      return {
        ok: true,
        simulated: false,
        token: candidate.snipedToken,
        amountInWeth: this.cfg.tradeAmountWei,
        tokenAmount,
        txHash: hash,
      };
    } catch (err) {
      return {
        ok: false,
        simulated: false,
        token: candidate.snipedToken,
        amountInWeth: this.cfg.tradeAmountWei,
        tokenAmount: 0n,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Vente de la position : TP/SL/urgence, retour WETH (ou ETH puis diff). */
  async sell(position: Position, reason: CloseReason): Promise<SellResult> {
    if (this.cfg.dryRun) {
      let weth: bigint;
      try {
        weth = await this.quoteSell(position.token, position.fee, position.baseToken, position.tokenAmount);
      } catch {
        if (reason !== "emergency") {
          return { ok: false, wethReceived: 0n, simulated: true, error: "quotage vente impossible" };
        }
        weth = 0n;
      }
      logInfo("dry_run_sell", {
        token: position.token,
        raison: reason,
        tokens: position.tokenAmount.toString(),
        wethQuote: weth.toString(),
      });
      return { ok: true, wethReceived: weth, simulated: true };
    }

    const { walletClient, publicClient } = this.deps;
    if (!walletClient || !this.accountAddress) {
      return { ok: false, wethReceived: 0n, simulated: false, error: "wallet absent" };
    }
    const account = this.accountAddress;

    try {
      let amountOutMin: bigint;
      try {
        const quote = await this.quoteSell(position.token, position.fee, position.baseToken, position.tokenAmount);
        amountOutMin = applySlippage(quote, this.cfg.maxSlippageBps);
      } catch {
        if (reason === "emergency") {
          // Dernier recours : sortie à n'importe quel prix d'une position mourante.
          logWarn("vente_urgente_sans_quote", { token: position.token });
          amountOutMin = 0n;
        } else {
          return { ok: false, wethReceived: 0n, simulated: false, error: "quotage vente impossible" };
        }
      }

      // Mode contrat : l'ETH arrive directement (diff de solde ETH).
      // Mode routeur : le WETH arrive dans le wallet (diff de solde WETH).
      const viaContract = this.cfg.helperContractAddress !== undefined;
      const before = viaContract
        ? await publicClient.getBalance({ address: account })
        : await publicClient.readContract({
            address: WETH9,
            abi: WETH_ABI,
            functionName: "balanceOf",
            args: [account],
          });

      const spender = viaContract ? this.cfg.helperContractAddress! : SWAP_ROUTER_02;
      await this.approveAndWait(position.token, spender, position.tokenAmount);

      const deadline = BigInt(Math.floor(Date.now() / 1000) + this.cfg.swapDeadlineSeconds);
      let hash: `0x${string}`;
      if (viaContract) {
        hash =
          position.baseToken === "WETH"
            ? await walletClient.writeContract({
                address: this.cfg.helperContractAddress!,
                abi: HELPER_CONTRACT_ABI,
                functionName: "swapExactInputSingle",
                args: [position.token, NATIVE_ZERO, position.fee, position.tokenAmount, amountOutMin, deadline],
                chain: null, account,
              })
            : await walletClient.writeContract({
                address: this.cfg.helperContractAddress!,
                abi: HELPER_CONTRACT_ABI,
                functionName: "swapExactInputMultihop",
                args: [
                  encodeV3Path([position.token, USDC_NATIVE, WETH9], [position.fee, WETH_USDC_FEE]),
                  false,
                  true,
                  position.tokenAmount,
                  amountOutMin,
                  deadline,
                ],
                chain: null, account,
              });
      } else {
        hash =
          position.baseToken === "WETH"
            ? await walletClient.writeContract({
                address: SWAP_ROUTER_02,
                abi: ROUTER_ABI,
                functionName: "exactInputSingle",
                args: [
                  {
                    tokenIn: position.token,
                    tokenOut: WETH9,
                    fee: position.fee,
                    recipient: account,
                    amountIn: position.tokenAmount,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
                chain: null, account,
              })
            : await walletClient.writeContract({
                address: SWAP_ROUTER_02,
                abi: ROUTER_ABI,
                functionName: "exactInput",
                args: [
                  {
                    path: encodeV3Path([position.token, USDC_NATIVE, WETH9], [position.fee, WETH_USDC_FEE]),
                    recipient: account,
                    amountIn: position.tokenAmount,
                    amountOutMinimum: amountOutMin,
                  },
                ],
                chain: null, account,
              });
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return { ok: false, wethReceived: 0n, txHash: hash, simulated: false, error: "tx revertee" };
      }

      const after = viaContract
        ? await publicClient.getBalance({ address: account })
        : await publicClient.readContract({
            address: WETH9,
            abi: WETH_ABI,
            functionName: "balanceOf",
            args: [account],
          });
      const wethReceived = after - before;
      if (wethReceived <= 0n) {
        return {
          ok: false,
          wethReceived: 0n,
          txHash: hash,
          simulated: false,
          error: "aucun WETH/ETH recu apres vente (le diff inclut le gaz en mode contrat)",
        };
      }
      return { ok: true, wethReceived, txHash: hash, simulated: false };
    } catch (err) {
      return {
        ok: false,
        wethReceived: 0n,
        simulated: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tokenBalance(token: `0x${string}`, account: `0x${string}`): Promise<bigint> {
    try {
      return await this.deps.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account],
      });
    } catch (err) {
      logWarn("lecture_solde_token_echec", {
        token,
        erreur: err instanceof Error ? err.message : String(err),
      });
      return 0n;
    }
  }

  /** Approbation finie (jamais infinie) + attente de confirmation. */
  private async approveAndWait(
    token: `0x${string}`,
    spender: `0x${string}`,
    amount: bigint,
  ): Promise<void> {
    const { walletClient, publicClient } = this.deps;
    const account = this.accountAddress!;
    const hash = await walletClient!.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [spender, amount],
      chain: null, account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error("approbation revertee");
    }
  }
}
