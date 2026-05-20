export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLogLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

export function logDebug(message: string): void {
  if (shouldLog("debug")) {
    console.log(message);
  }
}

export function logInfo(message: string): void {
  if (shouldLog("info")) {
    console.log(message);
  }
}

export function logWarn(message: string): void {
  if (shouldLog("warn")) {
    console.log(message);
  }
}

export function logError(message: string): void {
  if (shouldLog("error")) {
    console.error(message);
  }
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
