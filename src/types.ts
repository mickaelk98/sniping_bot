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

/** Raison de fermeture finale d'une position. */
export type CloseReason = "stop-loss" | "manual" | "emergency" | "trailing-stop" | "tiers-complete";

/** Vente partielle exécutée sur un palier de take-profit. */
export interface PartialSell {
  /** Multiple prix/entrée du palier (2 = x2). */
  multiple: number;
  /** Part du solde restant vendue (pourcentage). */
  sharePct: number;
  tokensSold: bigint;
  wethReceived: bigint;
  simulated: boolean;
  at: string;
}

/** Position ouverte suivie par le position-manager. */
export interface Position {
  id: string;
  token: `0x${string}`;
  tokenSymbol: string;
  poolAddress: `0x${string}`;
  fee: number;
  baseToken: "WETH" | "USDC";
  amountInWeth: bigint;
  /** Tokens détenus à l'ouverture (référence du multiple de prix). */
  initialTokenAmount: bigint;
  /** Tokens restants : décroît à chaque vente partielle. */
  tokenAmount: bigint;
  /** Valeur WETH estimée des tokens à l'ouverture (wei). */
  entryValueWeth: bigint;
  /** WETH encaissés par les ventes partielles (wei). */
  realizedWeth: bigint;
  /** Multiple prix/entrée le plus haut observé. */
  highWaterMultiple: number;
  /** Index du prochain palier TAKE_PROFIT_TIERS à exécuter. */
  nextTierIndex: number;
  sells: PartialSell[];
  openedAt: string;
  openedTxHash?: `0x${string}`;
  status: "open" | "closed";
  consecutiveQuoteFailures: number;
  close?: {
    closedAt: string;
    reason: CloseReason;
    /** Total WETH réalisé sur toute la vie de la position (partiels inclus). */
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
