import { createPublicClient, createWalletClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig, ConfigError } from "./config.js";
import { logError, logInfo, logWarn } from "./logger.js";
import { notify } from "./notifier.js";
import { Guardrails } from "./guardrails.js";
import { startPoolListener, type ListenerHandle } from "./listener.js";
import { assessRisk } from "./risk-check.js";
import { SwapExecutor } from "./execution.js";
import { PositionManager } from "./position-manager.js";
import type { PoolCandidate } from "./types.js";

const SEEN_POOL_TTL_MS = 60 * 60 * 1000;

/** Libellés humains des contrôles de risque, pour les notifications. */
const CHECK_LABELS: Record<string, string> = {
  basescan_verified: "contrat non vérifié",
  dangerous_functions: "fonctions dangereuses (mint/blacklist)",
  ownership: "owner actif",
  pool_liquidity: "liquidité insuffisante",
  sell_simulation: "revente impossible (honeypot/taxes)",
  holders_concentration: "holders trop concentrés",
  internal_error: "erreur interne",
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const counters = {
  poolsSeen: 0,
  candidatesAccepted: 0,
  riskPassed: 0,
  buysExecuted: 0,
};

async function main(): Promise<void> {
  const cfg = loadConfig();

  logInfo("demarrage", {
    mode: cfg.dryRun ? "DRY-RUN (simulation)" : "LIVE (transactions reelles)",
    tradeAmountEth: Number(cfg.tradeAmountWei) / 1e18,
    dailyBudgetEth: Number(cfg.dailyBudgetWei) / 1e18,
    maxOpenPositions: cfg.maxOpenPositions,
    takeProfitPct: cfg.takeProfitPct,
    stopLossPct: cfg.stopLossPct,
    execution: cfg.helperContractAddress ? "contrat helper" : "routeur direct",
  });

  if (cfg.telegramBotToken && !cfg.telegramChatId) {
    logWarn("telegram_incomplet", {
      note: "TELEGRAM_BOT_TOKEN present sans TELEGRAM_CHAT_ID : lance npx tsx scripts/telegram-setup.ts",
    });
  }

  await notify(
    cfg,
    "Bot démarré",
    cfg.dryRun
      ? "Mode TEST (dry-run) : transactions simulées, aucun vrai fond engagé."
      : "Mode RÉEL : le bot trade avec de vrais fonds.",
  );

  const publicClient = createPublicClient({ chain: base, transport: http(cfg.rpcUrl) });

  const walletClient = cfg.privateKey
    ? createWalletClient({
        chain: base,
        transport: http(cfg.rpcUrl),
        account: privateKeyToAccount(cfg.privateKey),
      })
    : undefined;

  if (!cfg.dryRun && !walletClient) {
    logError("demarrage_impossible", { raison: "mode live sans PRIVATE_KEY" });
    process.exit(1);
  }

  const guardrails = new Guardrails(cfg);
  const executor = new SwapExecutor({ publicClient, walletClient, cfg });

  const positions = new PositionManager(cfg, executor, {
    onClosed: (position) => {
      if (position.close) {
        guardrails.recordRefund(position.close.wethReceived);
        logInfo("position_fermee", {
          token: position.token,
          raison: position.close.reason,
          wethRecus: Number(position.close.wethReceived) / 1e18,
          pnlPct:
            Number(position.close.wethReceived * 10_000n / position.amountInWeth) / 100 - 100,
          simule: position.close.simulated,
        });
        void notify(
          cfg,
          "Position fermée",
          `${position.close.reason} sur ${position.tokenSymbol} (${position.token})\n` +
            `Reçu : ${Number(position.close.wethReceived) / 1e18} ETH` +
            (position.close.simulated ? " (simulé)" : ""),
        );
      }
    },
  });

  // Déduplication des pools déjà vues (TTL 1h).
  const seenPools = new Map<string, number>();

  let stopping = false;
  let listener: ListenerHandle | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  async function stopBot(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logWarn("arret_bot", { raison: reason });
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await listener?.stop();
    logInfo("arret_final", {
      ...counters,
      positionsOuvertes: positions.openCount(),
      ...guardrails.status(),
    });
    await notify(cfg, "Bot arrêté", reason);
    process.exit(0);
  }

  async function handleCandidate(candidate: PoolCandidate): Promise<void> {
    const now = Date.now();
    if (seenPools.has(candidate.poolAddress.toLowerCase())) return;
    seenPools.set(candidate.poolAddress.toLowerCase(), now);
    if (seenPools.size > 1000) {
      for (const [key, ts] of seenPools) {
        if (now - ts > SEEN_POOL_TTL_MS) seenPools.delete(key);
      }
    }

    counters.poolsSeen++;
    logInfo("pool_detectee", {
      pool: candidate.poolAddress,
      token: candidate.snipedToken,
      baseToken: candidate.baseToken,
      fee: candidate.fee,
    });

    // Garde-fous AVANT toute analyse coûteuse.
    const verdict = guardrails.canOpenPosition(positions.openCount());
    if (!verdict.allowed) {
      logInfo("candidat_ignore", { raison: verdict.reason, token: candidate.snipedToken });
      if (guardrails.shouldStop()) {
        await stopBot("budget journalier atteint (arrêt automatique)");
      }
      return;
    }

    // 1. Risk-checks on-chain.
    const report = await assessRisk(publicClient, cfg, candidate);
    logInfo("risk_check", {
      token: candidate.snipedToken,
      passe: report.passed,
      checks: report.metrics.map((m) => `${m.check}:${m.passed ? "ok" : "KO"}`),
    });
    if (!report.passed) {
      logInfo("risk_check_echoue", {
        token: candidate.snipedToken,
        details: report.metrics.filter((m) => !m.passed).map((m) => `${m.check} - ${m.detail}`),
      });
      const raisons = report.metrics
        .filter((m) => !m.passed)
        .map((m) => CHECK_LABELS[m.check] ?? m.check)
        .join(", ");
      await notify(
        cfg,
        "Refusé",
        `${report.tokenSymbol ?? shortAddress(candidate.snipedToken)} (${shortAddress(candidate.snipedToken)})\nMotif : ${raisons}`,
      );
      return;
    }
    counters.riskPassed++;

    // 2. Exécution de l'achat.
    counters.candidatesAccepted++;
    const buy = await executor.buy(candidate);
    if (!buy.ok) {
      logWarn("achat_echoue", { token: candidate.snipedToken, erreur: buy.error });
      return;
    }
    counters.buysExecuted++;
    guardrails.recordSpend(buy.amountInWeth);

    positions.open({
      id: crypto.randomUUID(),
      token: candidate.snipedToken,
      tokenSymbol: report.tokenSymbol ?? "?",
      poolAddress: candidate.poolAddress,
      fee: candidate.fee,
      baseToken: candidate.baseToken,
      amountInWeth: buy.amountInWeth,
      tokenAmount: buy.tokenAmount,
      entryValueWeth: report.sellQuoteWeth ?? buy.amountInWeth,
      openedAt: new Date().toISOString(),
      openedTxHash: buy.txHash,
      status: "open",
      consecutiveQuoteFailures: 0,
    });

    logInfo("achat_execute", {
      token: candidate.snipedToken,
      symbole: report.tokenSymbol ?? "?",
      montantWeth: Number(buy.amountInWeth) / 1e18,
      tokensRecus: buy.tokenAmount.toString(),
      simule: buy.simulated,
      txHash: buy.txHash,
    });
    await notify(
      cfg,
      "Achat exécuté",
      `${report.tokenSymbol ?? "?"} (${candidate.snipedToken})\n` +
        `Montant : ${Number(buy.amountInWeth) / 1e18} ETH` +
        (buy.simulated ? " (SIMULÉ - dry-run)" : ""),
    );

    if (guardrails.shouldStop()) {
      await stopBot("budget journalier atteint après achat (arrêt automatique)");
    }
  }

  // Mode live : pré-constitue le tampon WETH pour le routeur direct.
  if (!cfg.dryRun) {
    await executor.ensureWethBuffer();
  }

  listener = await startPoolListener(cfg.wsUrl, (candidate) => {
    void handleCandidate(candidate).catch((err) => {
      logError("pipeline_error", {
        token: candidate.snipedToken,
        erreur: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // Surveillance TP/SL des positions ouvertes.
  let ticking = false;
  pollTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void positions
      .tick()
      .catch((err) => {
        logError("position_tick_error", {
          erreur: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        ticking = false;
      });
  }, cfg.positionPollSeconds * 1000);

  // Battement de coeur périodique.
  heartbeatTimer = setInterval(() => {
    logInfo("statut", {
      ...counters,
      positionsOuvertes: positions.openCount(),
      ...guardrails.status(),
    });
  }, 5 * 60 * 1000);

  process.on("SIGINT", () => void stopBot("SIGINT"));
  process.on("SIGTERM", () => void stopBot("SIGTERM"));

  logInfo("bot_pret", {
    ecoute: "PoolCreated (factory Uniswap V3, Base)",
    pollSeconds: cfg.positionPollSeconds,
  });
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    logError("configuration_invalide", { problemes: err.problems });
  } else {
    logError("fatal", { erreur: err instanceof Error ? err.stack : String(err) });
  }
  process.exit(1);
});
