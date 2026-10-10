import "dotenv/config";
import { getAddress, parseEther } from "viem";

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration invalide (.env) :\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

export interface ProfitTier {
  /** Multiple prix/entrée déclencheur (2 = x2). */
  multiple: number;
  /** Part du solde restant à vendre, en pourcentage. */
  sellPct: number;
}

export interface BotConfig {
  dryRun: boolean;
  privateKey?: `0x${string}`;
  wsUrl: string;
  rpcUrl: string;
  helperContractAddress?: `0x${string}`;
  basescanApiKey?: string;
  discordWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  /** Mode fixe : montant par trade en wei. Ignoré si tradeAmountUsd est défini. */
  tradeAmountWei: bigint;
  /** Mode dynamique : montant par trade en USD (prioritaire sur tradeAmountWei). */
  tradeAmountUsd?: number;
  /** Rafraîchissement du prix ETH (mode dynamique), en minutes. */
  ethPriceRefreshMinutes: number;
  dailyBudgetWei: bigint;
  maxOpenPositions: number;
  maxSlippageBps: number;
  swapDeadlineSeconds: number;
  minPoolLiquidityEth: number;
  maxHolderPct: number;
  /** Paliers de take-profit escaladés (ventes partielles). */
  takeProfitTiers: ProfitTier[];
  /** Trailing stop : chute maximale depuis le plus haut, en pourcentage. */
  trailingStopPct: number;
  stopLossPct: number;
  /** Durée max de détention d'une position sans palier franchi (heures ; 0 = désactivé). */
  maxHoldHours: number;
  positionPollSeconds: number;
}

function readString(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function readNumber(name: string, fallback?: number): number | undefined {
  const raw = readString(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return value;
}

function readEthToWei(name: string): bigint | undefined {
  const raw = readString(name);
  if (raw === undefined) return undefined;
  try {
    return parseEther(raw);
  } catch {
    return undefined;
  }
}

function readAddress(name: string): `0x${string}` | "invalid" | undefined {
  const raw = readString(name);
  if (raw === undefined) return undefined;
  try {
    return getAddress(raw);
  } catch {
    return "invalid";
  }
}

/**
 * Charge et valide la configuration depuis l'environnement.
 * En mode dry-run, PRIVATE_KEY et les clés API sont optionnelles ;
 * en mode live, tout ce qui est requis doit être présent.
 * Lève ConfigError avec la liste exhaustive des problèmes.
 */
export function loadConfig(): BotConfig {
  const problems: string[] = [];

  const dryRunRaw = readString("DRY_RUN") ?? "true";
  const dryRun = dryRunRaw.toLowerCase() !== "false";
  if (!["true", "false", "1", "0"].includes(dryRunRaw.toLowerCase())) {
    problems.push("DRY_RUN doit valoir true ou false");
  }

  const wsUrl = readString("BASE_WS_URL");
  const rpcUrl = readString("BASE_RPC_URL");
  if (!wsUrl?.startsWith("wss://") && !wsUrl?.startsWith("ws://")) {
    problems.push("BASE_WS_URL requis (wss://...) pour le listener temps réel");
  }
  if (!rpcUrl?.startsWith("https://")) {
    problems.push("BASE_RPC_URL requis (https://...) pour l'exécution");
  }

  const privateKey = readString("PRIVATE_KEY") as `0x${string}` | undefined;
  if (privateKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    problems.push("PRIVATE_KEY invalide (attendu : 0x + 64 caractères hex)");
  }
  if (!dryRun && privateKey === undefined) {
    problems.push("PRIVATE_KEY requis en mode live (DRY_RUN=false)");
  }

  const helper = readAddress("HELPER_CONTRACT_ADDRESS");
  if (helper === "invalid") {
    problems.push("HELPER_CONTRACT_ADDRESS invalide (adresse 0x40 hex attendue)");
  }

  const tradeAmountUsd = readNumber("TRADE_AMOUNT_USD");
  if (tradeAmountUsd !== undefined && tradeAmountUsd <= 0) {
    problems.push("TRADE_AMOUNT_USD invalide (doit être > 0)");
  }

  const ethPriceRefreshMinutes = readNumber("ETH_PRICE_REFRESH_MINUTES", 10);
  if (
    ethPriceRefreshMinutes === undefined ||
    ethPriceRefreshMinutes < 1 ||
    ethPriceRefreshMinutes > 1440
  ) {
    problems.push("ETH_PRICE_REFRESH_MINUTES invalide (1..1440)");
  }

  const tradeAmountWei = readEthToWei("TRADE_AMOUNT_ETH");
  if (tradeAmountUsd === undefined) {
    if (tradeAmountWei === undefined || tradeAmountWei <= 0n) {
      problems.push("TRADE_AMOUNT_ETH requis (ex: 0.05) ou TRADE_AMOUNT_USD (ex: 5)");
    }
  } else if (tradeAmountWei !== undefined && tradeAmountWei <= 0n) {
    problems.push("TRADE_AMOUNT_ETH invalide (ex: 0.05)");
  }

  const dailyBudgetWei = readEthToWei("DAILY_BUDGET_ETH");
  if (dailyBudgetWei === undefined || dailyBudgetWei <= 0n) {
    problems.push("DAILY_BUDGET_ETH invalide (ex: 0.5)");
  }

  const maxOpenPositions = readNumber("MAX_OPEN_POSITIONS", 3);
  if (maxOpenPositions === undefined || maxOpenPositions < 1) {
    problems.push("MAX_OPEN_POSITIONS invalide (entier >= 1)");
  }

  const maxSlippageBps = readNumber("MAX_SLIPPAGE_BPS", 500);
  if (maxSlippageBps === undefined || maxSlippageBps < 0 || maxSlippageBps >= 10000) {
    problems.push("MAX_SLIPPAGE_BPS invalide (0..9999)");
  }

  const swapDeadlineSeconds = readNumber("SWAP_DEADLINE_SECONDS", 120);
  if (swapDeadlineSeconds === undefined || swapDeadlineSeconds < 30) {
    problems.push("SWAP_DEADLINE_SECONDS invalide (>= 30)");
  }

  const minPoolLiquidityEth = readNumber("MIN_POOL_LIQUIDITY_ETH", 2);
  if (minPoolLiquidityEth === undefined || minPoolLiquidityEth < 0) {
    problems.push("MIN_POOL_LIQUIDITY_ETH invalide");
  }

  const maxHolderPct = readNumber("MAX_HOLDER_PCT", 50);
  if (maxHolderPct === undefined || maxHolderPct <= 0 || maxHolderPct > 100) {
    problems.push("MAX_HOLDER_PCT invalide (1..100)");
  }

  const tiersRaw =
    readString("TAKE_PROFIT_TIERS") ?? "2:50,5:20,10:20,20:20,30:20,40:20,50:20,100:50";
  const takeProfitTiers: ProfitTier[] = [];
  for (const part of tiersRaw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) continue;
    const [multipleRaw, pctRaw] = entry.split(":");
    const multiple = Number(multipleRaw);
    const sellPct = Number(pctRaw);
    if (!Number.isFinite(multiple) || !Number.isFinite(sellPct) || multiple <= 1 || sellPct < 1 || sellPct > 100) {
      problems.push(`TAKE_PROFIT_TIERS invalide (format "multiple:pct", ex 2:50,5:20) : "${entry}"`);
      break;
    }
    takeProfitTiers.push({ multiple, sellPct });
  }
  if (takeProfitTiers.length === 0 && problems.length === 0) {
    problems.push("TAKE_PROFIT_TIERS : au moins un palier requis");
  }
  for (let i = 1; i < takeProfitTiers.length; i++) {
    if (takeProfitTiers[i].multiple <= takeProfitTiers[i - 1].multiple) {
      problems.push("TAKE_PROFIT_TIERS : les multiples doivent être strictement croissants");
      break;
    }
  }

  const trailingStopPct = readNumber("TRAILING_STOP_PCT", 20);
  if (trailingStopPct === undefined || trailingStopPct < 1 || trailingStopPct > 90) {
    problems.push("TRAILING_STOP_PCT invalide (1..90)");
  }

  const stopLossPct = readNumber("STOP_LOSS_PCT", 30);
  if (stopLossPct === undefined || stopLossPct <= 0) {
    problems.push("STOP_LOSS_PCT invalide (> 0)");
  }

  const maxHoldHours = readNumber("MAX_HOLD_HOURS", 6);
  if (maxHoldHours === undefined || maxHoldHours < 0) {
    problems.push("MAX_HOLD_HOURS invalide (>= 0 ; 0 = désactivé)");
  }

  const positionPollSeconds = readNumber("POSITION_POLL_SECONDS", 10);
  if (positionPollSeconds === undefined || positionPollSeconds < 3) {
    problems.push("POSITION_POLL_SECONDS invalide (>= 3)");
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    dryRun,
    privateKey,
    wsUrl: wsUrl!,
    rpcUrl: rpcUrl!,
    helperContractAddress: helper === "invalid" ? undefined : helper,
    basescanApiKey: readString("BASESCAN_API_KEY"),
    discordWebhookUrl: readString("DISCORD_WEBHOOK_URL"),
    telegramBotToken: readString("TELEGRAM_BOT_TOKEN"),
    telegramChatId: readString("TELEGRAM_CHAT_ID"),
    tradeAmountWei: tradeAmountWei ?? 0n,
    tradeAmountUsd,
    ethPriceRefreshMinutes: ethPriceRefreshMinutes!,
    dailyBudgetWei: dailyBudgetWei!,
    maxOpenPositions: maxOpenPositions!,
    maxSlippageBps: maxSlippageBps!,
    swapDeadlineSeconds: swapDeadlineSeconds!,
    minPoolLiquidityEth: minPoolLiquidityEth!,
    maxHolderPct: maxHolderPct!,
    takeProfitTiers,
    trailingStopPct: trailingStopPct!,
    stopLossPct: stopLossPct!,
    maxHoldHours: maxHoldHours!,
    positionPollSeconds: positionPollSeconds!,
  };
}
