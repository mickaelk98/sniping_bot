import "dotenv/config";
import { createInterface } from "node:readline/promises";

/**
 * Trouve le TELEGRAM_CHAT_ID automatiquement.
 * Usage :
 *   1. Renseigner TELEGRAM_BOT_TOKEN dans .env (obtenu via @BotFather).
 *   2. Ouvrir Telegram et envoyer n'importe quel message (/start) au bot.
 *   3. Lancer : npx tsx scripts/telegram-setup.ts
 */

interface TelegramUpdate {
  message?: { chat?: { id: number; type: string; username?: string; first_name?: string; title?: string } };
  channel_post?: { chat?: { id: number; type: string; username?: string; first_name?: string; title?: string } };
}

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN absent du .env. Renseigne-le d'abord (via @BotFather).");
    process.exit(1);
  }

  console.log("1. Ouvre Telegram et envoie un message a ton bot (par exemple /start).");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("2. Appuie ensuite sur Entree ici pour lire sa boite de reception...");
  rl.close();

  const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await response.json()) as { ok: boolean; result?: TelegramUpdate[] };

  const chats = new Map<string, string>();
  for (const update of data.result ?? []) {
    const chat = update.message?.chat ?? update.channel_post?.chat;
    if (chat) {
      const label = [chat.type, chat.username ? `@${chat.username}` : "", chat.first_name ?? chat.title ?? ""]
        .filter(Boolean)
        .join(" ");
      chats.set(String(chat.id), label);
    }
  }

  if (chats.size === 0) {
    console.error("Aucun message recu. Envoie /start a ton bot dans Telegram, puis relance ce script.");
    process.exit(1);
  }

  console.log("\nChats trouvés (copie la bonne ligne dans .env) :\n");
  for (const [id, label] of chats) {
    console.log(`  TELEGRAM_CHAT_ID=${id}   (${label})`);
  }
  console.log("\nPour une conversation privee avec toi-meme, prends l'ID de type 'private'.");
}

main().catch((err) => {
  console.error("Erreur :", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
