/**
 * ProcessService — Effect-based abstraction over process spawning and
 * file-system readiness polling.
 */

import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { Context, Effect, Layer, Schedule } from "effect";

// ---------------------------------------------------------------------------
// SpawnHandle
// ---------------------------------------------------------------------------

export interface SpawnHandle {
  readonly kill: () => void;
  readonly exited: Effect.Effect<number>;
}

// ---------------------------------------------------------------------------
// ProcessService tag
// ---------------------------------------------------------------------------

export class ProcessService extends Context.Tag("nas/ProcessService")<
  ProcessService,
  {
    readonly spawn: (
      command: string,
      args: string[],
      opts?: { logFile?: string; env?: Record<string, string> },
    ) => Effect.Effect<SpawnHandle>;
    readonly waitForFileExists: (
      path: string,
      timeoutMs: number,
      pollIntervalMs: number,
    ) => Effect.Effect<void>;
    readonly exec: (
      cmd: string[],
      opts?: { cwd?: string },
    ) => Effect.Effect<string>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const ProcessServiceLive: Layer.Layer<ProcessService> = Layer.succeed(
  ProcessService,
  ProcessService.of({
    spawn: (command, args, opts) =>
      Effect.sync(() => {
        // logFile: child の stdout/stderr をこのパスに追記する。Agent の
        // TTY を汚さず、後から `tail` で閲覧できる。未指定なら pipe のまま
        // (呼び出し側が読む責任を持つ前提)。
        let logFd: number | null = null;
        if (opts?.logFile) {
          logFd = openSync(opts.logFile, "a");
        }
        const child = Bun.spawn([command, ...args], {
          stdout: logFd !== null ? logFd : "pipe",
          stderr: logFd !== null ? logFd : "pipe",
          env: opts?.env ? { ...process.env, ...opts.env } : undefined,
        });
        if (logFd !== null) {
          // spawn が FD を複製しているので、親プロセスで持ってる側は閉じて
          // 漏れを防ぐ。子側の複製は child 終了まで生きる。
          closeSync(logFd);
        }
        return {
          kill: () => {
            try {
              child.kill();
            } catch (e: unknown) {
              // ESRCH means the process already exited — safe to ignore.
              // All other errors are re-thrown.
              const isEsrch =
                e instanceof Error &&
                "code" in e &&
                (e as NodeJS.ErrnoException).code === "ESRCH";
              if (!isEsrch) throw e;
            }
          },
          exited: Effect.tryPromise({
            try: () => child.exited,
            catch: (e) =>
              new Error(
                `Process exited abnormally: ${e instanceof Error ? e.message : String(e)}`,
              ),
          }).pipe(Effect.orDie),
        } satisfies SpawnHandle;
      }),

    waitForFileExists: (path, timeoutMs, pollIntervalMs) =>
      Effect.tryPromise({
        try: () => stat(path),
        catch: () => new Error("ENOENT"),
      }).pipe(
        Effect.asVoid,
        Effect.retry(
          Schedule.addDelay(
            Schedule.recurs(Math.ceil(timeoutMs / pollIntervalMs)),
            () => `${pollIntervalMs} millis`,
          ),
        ),
        Effect.catchAll(() =>
          Effect.fail(
            new Error(
              `[nas] Timed out waiting for file: ${path} (${timeoutMs}ms)`,
            ),
          ),
        ),
        Effect.orDie,
      ),

    exec: (cmd, opts) =>
      Effect.tryPromise({
        try: async () => {
          const [command = "", ...args] = cmd;
          const child = Bun.spawn([command, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            cwd: opts?.cwd,
          });
          const exitCode = await child.exited;
          const stdout = await new Response(child.stdout).text();
          if (exitCode !== 0) {
            const stderr = await new Response(child.stderr).text();
            throw new Error(
              `Command failed (exit ${exitCode}): ${cmd.join(" ")}\n${stderr}`,
            );
          }
          return stdout;
        },
        catch: (e) =>
          new Error(
            `exec failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
      }).pipe(Effect.orDie),
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface ProcessServiceFakeConfig {
  readonly spawn?: (
    command: string,
    args: string[],
    opts?: { logFile?: string; env?: Record<string, string> },
  ) => Effect.Effect<SpawnHandle>;
  readonly waitForFileExists?: (
    path: string,
    timeoutMs: number,
    pollIntervalMs: number,
  ) => Effect.Effect<void>;
  readonly exec?: (
    cmd: string[],
    opts?: { cwd?: string },
  ) => Effect.Effect<string>;
}

const defaultSpawnHandle: SpawnHandle = {
  kill: () => {},
  exited: Effect.succeed(0),
};

export function makeProcessServiceFake(
  overrides: ProcessServiceFakeConfig = {},
): Layer.Layer<ProcessService> {
  return Layer.succeed(
    ProcessService,
    ProcessService.of({
      spawn: overrides.spawn ?? (() => Effect.succeed(defaultSpawnHandle)),
      waitForFileExists: overrides.waitForFileExists ?? (() => Effect.void),
      exec: overrides.exec ?? (() => Effect.succeed("")),
    }),
  );
}
