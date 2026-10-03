import type { BotConfig } from "./config.js";
import { logWarn } from "./logger.js";

/**
 * Envoie une notification sur tous les canaux configurés (Discord, Telegram).
 * Best-effort : une notification qui échoue ne casse jamais le bot.
 */
export async function notify(
  cfg: BotConfig,
  title: string,
  message: string,
): Promise<void> {
  const text = `**${title}**\n${message}`;
  const jobs: Promise<void>[] = [];

  if (cfg.discordWebhookUrl) {
    jobs.push(
      fetch(cfg.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
      }).then(() => undefined),
    );
  }

  if (cfg.telegramBotToken && cfg.telegramChatId) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegramChatId, text }),
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
