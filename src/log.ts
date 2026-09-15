import { closeSync, openSync, writeSync } from "node:fs";
import { Logger } from "effect";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let diagnosticStderr = false;
let logFd: number | undefined;

export function setDiagnosticStderr(enabled: boolean): void {
  diagnosticStderr = enabled;
}

export function diagnosticsUseStderr(): boolean {
  return diagnosticStderr;
}

/** Only nas diagnostic events reach this sink; child streams never do. */
export function openDiagnosticLog(file: string): () => void {
  const fd = openSync(file, "a", 0o600);
  logFd = fd;
  return () => {
    if (logFd === fd) logFd = undefined;
    closeSync(fd);
  };
}

function emit(level: LogLevel, message: string): void {
  if (!shouldLog(level)) return;
  if (logFd !== undefined) {
    writeSync(logFd, `${message}\n`);
  } else if (diagnosticStderr || level === "error") {
    console.error(message);
  } else {
    console.log(message);
  }
}

export const diagnosticLogger = Logger.replace(
  Logger.defaultLogger,
  Logger.make(({ logLevel, message }) => {
    const level: LogLevel =
      logLevel.ordinal >= 40000
        ? "error"
        : logLevel.ordinal >= 30000
          ? "warn"
          : logLevel.ordinal < 20000
            ? "debug"
            : "info";
    emit(
      level,
      Array.isArray(message) ? message.map(String).join(" ") : String(message),
    );
  }),
);

let currentLogLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

export function logDebug(message: string): void {
  emit("debug", message);
}

export function logInfo(message: string): void {
  emit("info", message);
}

export function logWarn(message: string): void {
  emit("warn", message);
}

export function logError(message: string): void {
  emit("error", message);
}

function shouldLog(level: LogLevel): boolean {
  return LOG_PRIORITY[level] >= LOG_PRIORITY[currentLogLevel];
}

/**
 * performance.now() の差分を人間が読みやすい文字列にフォーマットする。
 * 1000ms 未満は `123ms`、1000ms 以上は `1.23s` の形式。
 */
export function formatElapsed(startMs: number): string {
  const elapsed = performance.now() - startMs;
  if (elapsed < 1000) {
    return `${Math.round(elapsed)}ms`;
  }
  return `${(elapsed / 1000).toFixed(2)}s`;
}
