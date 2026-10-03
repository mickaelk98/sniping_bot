import type { BotConfig } from "./config.js";
import { logWarn } from "./logger.js";

/** Étiquette de mode : [TEST] = simulation, [RÉEL] = vrais fonds. */
export function modeTag(cfg: BotConfig): string {
  return cfg.dryRun ? "[TEST]" : "[RÉEL]";
}

/** Message complet envoyé aux canaux. Pur, testable. */
export function formatMessage(cfg: BotConfig, title: string, message: string): string {
  return `${modeTag(cfg)} ${title}\n${message}`;
}

/**
 * Envoie une notification sur tous les canaux configurés (Discord, Telegram).
 * Best-effort : une notification qui échoue ne casse jamais le bot.
 */
export async function notify(
  cfg: BotConfig,
  title: string,
  message: string,
): Promise<void> {
  const text = formatMessage(cfg, title, message);
  const jobs: Promise<void>[] = [];

  if (cfg.discordWebhookUrl) {
    jobs.push(
      fetch(cfg.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: AbortSignal.timeout(8000),
      }).then(() => undefined),
    );
  }

  if (cfg.telegramBotToken && cfg.telegramChatId) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
        signal: AbortSignal.timeout(8000),
      }).then(() => undefined),
    );
  }

  const results = await Promise.allSettled(jobs);
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn("notification_failed", {
        channel: index === 0 && cfg.discordWebhookUrl ? "discord" : "telegram",
        error: String(result.reason),
      });
    }
  });
}
