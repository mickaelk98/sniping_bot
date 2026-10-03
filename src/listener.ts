import { createPublicClient, webSocket } from "viem";
import { base } from "viem/chains";
import { FACTORY_ABI, QUOTE_TOKENS, UNISWAP_V3_FACTORY } from "./constants.js";
import { logDebug } from "./logger.js";
import type { PoolCandidate } from "./types.js";

export interface ListenerHandle {
  stop(): Promise<void>;
}

export interface PoolCreatedArgs {
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  poolAddress: `0x${string}`;
  blockNumber?: bigint;
  transactionHash?: `0x${string}`;
}

/**
 * Filtre pur d'un event PoolCreated en candidat de sniping.
 * Retourne null si la paire ne contient pas exactement un token de cotation
 * (WETH ou USDC natif) : pool WETH/USDC sans token snipé, ou pool exotique.
 */
export function toCandidate(args: PoolCreatedArgs): PoolCandidate | null {
  const base0 = QUOTE_TOKENS[args.token0.toLowerCase()] as "WETH" | "USDC" | undefined;
  const base1 = QUOTE_TOKENS[args.token1.toLowerCase()] as "WETH" | "USDC" | undefined;

  // Exactement un côté doit être un token de cotation.
  if ((base0 !== undefined) === (base1 !== undefined)) {
    return null;
  }

  const baseToken = base0 ?? base1;
  if (baseToken === undefined) {
    return null;
  }

  return {
    poolAddress: args.poolAddress,
    token0: args.token0,
    token1: args.token1,
    fee: args.fee,
    snipedToken: base0 !== undefined ? args.token1 : args.token0,
    baseToken,
    blockNumber: args.blockNumber,
    txHash: args.transactionHash,
    detectedAt: new Date().toISOString(),
  };
}

/**
 * Écoute l'event PoolCreated de la factory Uniswap V3 sur Base via
 * WebSocket (eth_subscribe, jamais de polling) et transmet les candidats
 * filtrés au callback.
 */
export async function startPoolListener(
  wsUrl: string,
  onCandidate: (candidate: PoolCandidate) => void,
): Promise<ListenerHandle> {
  const client = createPublicClient({
    chain: base,
    transport: webSocket(wsUrl),
  });

  const unwatch = client.watchContractEvent({
    address: UNISWAP_V3_FACTORY,
    abi: FACTORY_ABI,
    eventName: "PoolCreated",
    onLogs: (logs) => {
      for (const log of logs) {
        const args = log.args;
        if (!args.token0 || !args.token1 || !args.pool) {
          logDebug("pool_event_incomplet", { log });
          continue;
        }
        const candidate = toCandidate({
          token0: args.token0,
          token1: args.token1,
          fee: Number(args.fee),
          poolAddress: args.pool,
          blockNumber: log.blockNumber ?? undefined,
          transactionHash: log.transactionHash,
        });
        if (candidate === null) {
          logDebug("pool_ignoree", {
            token0: args.token0,
            token1: args.token1,
            fee: Number(args.fee),
          });
          continue;
        }
        logDebug("pool_acceptee", {
          pool: candidate.poolAddress,
          token: candidate.snipedToken,
          baseToken: candidate.baseToken,
          fee: candidate.fee,
        });
        onCandidate(candidate);
      }
    },
  });

  return {
    stop: async () => {
      unwatch();
    },
  };
}
