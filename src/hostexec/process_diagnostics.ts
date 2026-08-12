import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { logWarn } from "../log.ts";

export interface ProcessIdentity {
  readonly pid: number;
  readonly comm: string;
  readonly state: string;
  readonly ppid: number;
  readonly processGroupId: number;
  readonly sessionId: number;
  readonly ttyNumber: number;
  readonly foregroundProcessGroupId: number;
}

export interface HostExecDiagnosticDetails {
  readonly requestId?: string;
  readonly command?: string;
  readonly argumentCount?: number;
  readonly process?: ProcessIdentity | null;
  readonly signal?: "SIGTERM" | "SIGKILL";
  readonly exitCode?: number;
  readonly signalCode?: string | null;
  readonly error?: string;
}

export function parseLinuxProcStat(stat: string): ProcessIdentity {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(") ");
  if (open <= 0 || close <= open) {
    throw new Error("invalid /proc stat: missing comm field");
  }
  const pid = Number.parseInt(stat.slice(0, open).trim(), 10);
  const comm = stat.slice(open + 1, close);
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  if (!Number.isSafeInteger(pid) || fields.length < 6) {
    throw new Error("invalid /proc stat: missing process identifiers");
  }
  const numbers = fields.slice(1, 6).map((field) => Number.parseInt(field, 10));
  if (numbers.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("invalid /proc stat: non-numeric process identifier");
  }
  return {
    pid,
    comm,
    state: fields[0],
    ppid: numbers[0],
    processGroupId: numbers[1],
    sessionId: numbers[2],
    ttyNumber: numbers[3],
    foregroundProcessGroupId: numbers[4],
  };
}

export async function readProcessIdentity(
  pid: number,
): Promise<ProcessIdentity | null> {
  try {
    return parseLinuxProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

export class HostExecProcessDiagnostics {
  readonly filePath: string;
  private warned = false;

  constructor(
    runtimeDir: string,
    private readonly hostexecSessionId: string,
  ) {
    const safeSessionId = hostexecSessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
    this.filePath = path.join(
      runtimeDir,
      "diagnostics",
      `${safeSessionId}.jsonl`,
    );
  }

  async record(
    event: string,
    details: HostExecDiagnosticDetails = {},
  ): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      await appendFile(
        this.filePath,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          event,
          hostexecSessionId: this.hostexecSessionId,
          brokerProcess: await readProcessIdentity(process.pid),
          ...details,
        })}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        logWarn(
          `[nas] hostexec diagnostics unavailable at ${this.filePath}: ${error}`,
        );
      }
    }
  }
}
