import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";

interface PreparationScope {
  signal: AbortSignal;
  pending: Set<Promise<unknown>>;
}
const preparation = new AsyncLocalStorage<PreparationScope>();

export function preparationSignal(): AbortSignal | undefined {
  return preparation.getStore()?.signal;
}

/** Join owned child teardown even if the interrupted Effect has already unwound. */
export async function withPreparationCommands<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!signal) return run();
  const owner = new AbortController();
  const scope: PreparationScope = {
    signal: AbortSignal.any([signal, owner.signal]),
    pending: new Set(),
  };
  return preparation.run(scope, async () => {
    try {
      return await run();
    } finally {
      owner.abort();
      await Promise.allSettled(scope.pending);
    }
  });
}

export interface PreparationCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** ACP preparation children have no protocol stdin and an independently killable group. */
export async function runPreparationCommand(
  command: string,
  args: readonly string[],
  options: {
    diagnostic?: boolean;
    signal?: AbortSignal;
    graceMs?: number;
  } = {},
): Promise<PreparationCommandResult> {
  const scope = preparation.getStore();
  const signals = [options.signal, scope?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  const running = executePreparationCommand(command, args, options, signal);
  scope?.pending.add(running);
  try {
    return await running;
  } finally {
    scope?.pending.delete(running);
  }
}

async function executePreparationCommand(
  command: string,
  args: readonly string[],
  options: { diagnostic?: boolean; graceMs?: number },
  signal?: AbortSignal,
): Promise<PreparationCommandResult> {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: [
      "ignore",
      options.diagnostic ? 2 : "pipe",
      options.diagnostic ? 2 : "pipe",
    ],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kill = (sig: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const abort = () => {
    kill("SIGTERM");
    timer ??= setTimeout(() => kill("SIGKILL"), options.graceMs ?? 1000);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    signal?.throwIfAborted();
    return {
      exitCode,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (timer) clearTimeout(timer);
  }
}

/** Preserve the terminal probe's Bun implementation outside an ACP preparation scope. */
export async function runProbeCommand(
  command: string[],
  ignoreStderr = true,
): Promise<PreparationCommandResult> {
  if (preparationSignal())
    return runPreparationCommand(command[0], command.slice(1));
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: ignoreStderr ? "ignore" : "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.stderr ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}
