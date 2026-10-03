import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const LOG_DIR = join(process.cwd(), "logs");

let logDirReady = false;

function ensureLogDir(): void {
  if (logDirReady) return;
  mkdirSync(LOG_DIR, { recursive: true });
  logDirReady = true;
}

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(data ?? {}),
  };
  const line = JSON.stringify(entry);
  console.log(line);
  try {
    ensureLogDir();
    const file = join(LOG_DIR, `bot-${new Date().toISOString().slice(0, 10)}.log`);
    appendFileSync(file, line + "\n");
  } catch (err) {
    // Le fichier de log est un best-effort : on ne casse jamais le bot pour ça.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "log_file_write_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export const logDebug = (event: string, data?: Record<string, unknown>): void =>
  write("debug", event, data);
export const logInfo = (event: string, data?: Record<string, unknown>): void =>
  write("info", event, data);
export const logWarn = (event: string, data?: Record<string, unknown>): void =>
  write("warn", event, data);
export const logError = (event: string, data?: Record<string, unknown>): void =>
  write("error", event, data);
