/** Candidat détecté par le listener, avant toute analyse. */
export interface PoolCandidate {
  poolAddress: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  /** Côté non-WETH/non-USDC de la paire : le token snipé. */
  snipedToken: `0x${string}`;
  /** Token de cotation de la pool : WETH ou USDC. */
  baseToken: "WETH" | "USDC";
  blockNumber?: bigint;
  txHash?: `0x${string}`;
  detectedAt: string;
}

/** Résultat d'un sous-contrôle de risque. */
export interface RiskMetric {
  check: string;
  passed: boolean;
  value?: string;
  detail: string;
}

/** Rapport de risk-check complet pour un candidat. */
export interface RiskReport {
  candidate: PoolCandidate;
  passed: boolean;
  metrics: RiskMetric[];
  /** Quote WETH -> snipedToken (montant brut, decimals du token snipé). */
  buyQuoteTokens?: bigint;
  /** Quote snipedToken -> WETH (en wei), base de la simulation de vente. */
  sellQuoteWeth?: bigint;
  tokenDecimals?: number;
  tokenSymbol?: string;
}

/** Résultat d'un achat (réel ou simulé). */
export interface BuyResult {
  ok: boolean;
  simulated: boolean;
  token: `0x${string}`;
  amountInWeth: bigint;
  tokenAmount: bigint;
  txHash?: `0x${string}`;
  error?: string;
}

/** Raison de fermeture d'une position. */
export type CloseReason = "take-profit" | "stop-loss" | "manual" | "emergency";

/** Position ouverte suivie par le position-manager. */
export interface Position {
  id: string;
  token: `0x${string}`;
  tokenSymbol: string;
  poolAddress: `0x${string}`;
  fee: number;
  baseToken: "WETH" | "USDC";
  amountInWeth: bigint;
  tokenAmount: bigint;
  /** Valeur WETH estimée des tokens à l'ouverture (wei). */
  entryValueWeth: bigint;
  openedAt: string;
  openedTxHash?: `0x${string}`;
  status: "open" | "closed";
  consecutiveQuoteFailures: number;
  close?: {
    closedAt: string;
    reason: CloseReason;
    wethReceived: bigint;
    txHash?: `0x${string}`;
    simulated: boolean;
  };
}

/** Résumé périodique de l'état du bot. */
export interface BotStatus {
  dryRun: boolean;
  poolsSeen: number;
  candidatesAccepted: number;
  riskPassed: number;
  buysExecuted: number;
  openPositions: number;
  spentTodayWeth: bigint;
}
