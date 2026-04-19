export type LogLevel = "info" | "warn" | "error";

const LOG_PRIORITY: Record<LogLevel, number> = {
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
