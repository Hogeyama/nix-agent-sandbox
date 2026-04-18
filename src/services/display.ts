/**
 * DisplayService — Effect-based abstraction over xpra lifecycle.
 *
 * Manages per-session runtime dir creation, MIT-MAGIC-COOKIE generation,
 * Xauthority file construction, xpra process spawn (detached X server
 * backed by Xvfb; no viewer is spawned — the user attaches `xpra attach`
 * on demand), and Xvfb socket readiness waiting.
 *
 * Live implementation delegates to FsService + ProcessService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer, type Scope } from "effect";
import {
  gcDisplayRuntime,
  removeDisplayRegistry,
  resolveDisplayRuntimePaths,
  writeDisplayRegistry,
} from "../display/registry.ts";
import { FsService } from "./fs.ts";
import { ProcessService } from "./process.ts";

// ---------------------------------------------------------------------------
// Service-local plan interface
// ---------------------------------------------------------------------------

export interface DisplayStartPlan {
  readonly xpraBinaryPath: string;
  readonly sessionDir: string;
  readonly xauthorityPath: string;
  /**
   * xpra が自分で生成して Xvfb に渡す xauth のパス。通常は
   * `$XDG_RUNTIME_DIR/xpra/<N>/xauthority`。起動後にここから cookie を
   * 読み出して、docker container 向けに FamilyWild 化して
   * `xauthorityPath` に書き直す。
   */
  readonly xpraInternalXauthPath: string;
  readonly displayNumber: number;
  readonly size: string;
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly sessionId: string;
}

export interface DisplayHandle {
  readonly kill: () => void;
  readonly displayNumber: number;
  readonly socketPath: string;
  readonly xauthorityPath: string;
  readonly logPath: string;
}

// ---------------------------------------------------------------------------
// DisplayService tag
// ---------------------------------------------------------------------------

export class DisplayService extends Context.Tag("nas/DisplayService")<
  DisplayService,
  {
    readonly startXpra: (
      plan: DisplayStartPlan,
    ) => Effect.Effect<DisplayHandle, unknown, Scope.Scope>;
  }
>() {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an Xauthority file containing a single MIT-MAGIC-COOKIE-1 entry
 * with `family = FamilyWild (0xffff)` so the cookie matches **any** hostname
 * the X11 client identifies as. nas spawns the X server on the host but the
 * agent container has its own (docker-assigned) hostname; a FamilyLocal entry
 * bound to the host's hostname (which is what `xauth add :N` would produce)
 * fails authentication from inside the container with
 * "Authorization required, but no authorization protocol specified".
 *
 * Wire format (big-endian) per Xauthority(5):
 *   u16 family        = 0xffff (FamilyWild)
 *   u16 addr_len      = 0      (no host bytes)
 *   u16 number_len    + display number bytes (e.g. "100")
 *   u16 name_len      + protocol name bytes ("MIT-MAGIC-COOKIE-1")
 *   u16 data_len      + cookie bytes (16 random bytes)
 */
export function buildWildXauthorityRecord(
  displayNumber: number,
  cookie: Uint8Array,
): Uint8Array {
  const FAMILY_WILD = 0xffff;
  const PROTO = "MIT-MAGIC-COOKIE-1";
  const display = String(displayNumber);
  const enc = new TextEncoder();
  const displayBytes = enc.encode(display);
  const protoBytes = enc.encode(PROTO);

  const totalLen =
    2 + 2 + 2 + displayBytes.length + 2 + protoBytes.length + 2 + cookie.length;
  const buf = new Uint8Array(totalLen);
  const view = new DataView(buf.buffer);
  let off = 0;
  view.setUint16(off, FAMILY_WILD, false);
  off += 2;
  view.setUint16(off, 0, false); // addr_len = 0
  off += 2;
  view.setUint16(off, displayBytes.length, false);
  off += 2;
  buf.set(displayBytes, off);
  off += displayBytes.length;
  view.setUint16(off, protoBytes.length, false);
  off += 2;
  buf.set(protoBytes, off);
  off += protoBytes.length;
  view.setUint16(off, cookie.length, false);
  off += 2;
  buf.set(cookie, off);
  return buf;
}

/**
 * `xauth -f <path> list` の出力から display=:N の MIT-MAGIC-COOKIE-1 を
 * 取り出す。バイナリ parse は xpra のファイルレイアウトで相性が悪かった
 * ので、xauth CLI に形式解釈を任せる。
 *
 * 典型的な出力:
 *   nixos/unix:100  MIT-MAGIC-COOKIE-1  a1b2c3d4...
 */
export function extractCookieFromXauthList(
  stdout: string,
  displayNumber: number,
): Uint8Array {
  const suffix = `:${displayNumber}`;
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [displayField, proto, hex] = parts;
    if (!displayField.endsWith(suffix)) continue;
    if (proto !== "MIT-MAGIC-COOKIE-1") continue;
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) continue;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  throw new Error(
    `no MIT-MAGIC-COOKIE-1 entry for :${displayNumber} in xauth output`,
  );
}

/**
 * xpra が非同期に書き出す xauth ファイルを poll し、`xauth list` で
 * cookie を取り出す。ファイルが無い・まだ書き込み途中で xauth が
 * 空出力を返す間はリトライする。
 */
async function readXpraCookieWithRetry(
  path: string,
  displayNumber: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<Uint8Array> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const proc = Bun.spawn(["xauth", "-f", path, "list"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code === 0 && stdout.trim() !== "") {
        return extractCookieFromXauthList(stdout, displayNumber);
      }
      lastError = new Error(
        stderr.trim() || `xauth list exit=${code}, empty output`,
      );
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for xpra xauth at ${path}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const DisplayServiceLive: Layer.Layer<
  DisplayService,
  never,
  FsService | ProcessService
> = Layer.effect(
  DisplayService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    return DisplayService.of({
      startXpra: (plan) =>
        Effect.gen(function* () {
          // Reap stale registry entries from previous nas runs that crashed
          // before their scope finalizers could remove them. Best-effort —
          // a broken registry dir must not block starting a new session.
          const runtimePaths = yield* Effect.tryPromise({
            try: () => resolveDisplayRuntimePaths(),
            catch: (e) =>
              new Error(
                `failed to resolve display runtime paths: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              ),
          }).pipe(Effect.orDie);
          yield* Effect.tryPromise({
            try: () => gcDisplayRuntime(runtimePaths),
            catch: (e) => e,
          }).pipe(Effect.catchAll(() => Effect.void));

          yield* fs.mkdir(plan.sessionDir, { recursive: true, mode: 0o700 });

          // xpra には default の Xvfb コマンドを使わせる。`--xvfb` で
          // `-auth <file>` を上書きすると、xpra 内部で別 cookie を生成
          // しているため client 側が合わず "Invalid MIT-MAGIC-COOKIE-1
          // key" で即死する。xpra に任せると xauth を自動生成して整合を
          // 取ってくれるので、nas はそれを後から拾う。
          //
          // control socket は default (`$XDG_RUNTIME_DIR/xpra/`) に作ら
          // れるので、ユーザは追加パス指定無しで `xpra attach :N` のみで
          // 繋がる。
          // `--resize-display=WxH` で Xvfb の初期解像度を指示する。
          // seamless モード既定は "yes" (クライアント追従) のため、
          // profile で指定された解像度が無視される。`--xvfb` 上書きは
          // xpra 内部 cookie 整合を壊すので避ける。
          const xpraArgs = [
            "start",
            `:${plan.displayNumber}`,
            `--resize-display=${plan.size}`,
            "--daemon=no",
            "--exit-with-children=no",
            "--systemd-run=no",
            "--mdns=no",
            "--notifications=no",
            "--webcam=no",
            "--pulseaudio=no",
            "--speaker=no",
            "--microphone=no",
            "--bell=no",
            "--start-new-commands=no",
          ];

          // xpra の stdout/stderr を per-session log ファイルへ追記する。
          // pipe 放置だと buffer が詰まって xpra が死ぬし、inherit は
          // agent TTY に混ざるのでどちらもダメ。ファイルに落として後から
          // `tail` で見れる形が一番扱いやすい。
          const logPath = `${plan.sessionDir}/xpra.log`;
          const spawnHandle = yield* Effect.acquireRelease(
            proc.spawn(plan.xpraBinaryPath, xpraArgs, { logFile: logPath }),
            (handle) => Effect.sync(() => handle.kill()),
          );

          // Xvfb ソケットの出現 = X server 起動完了。
          yield* proc.waitForFileExists(
            plan.socketPath,
            plan.timeoutMs,
            plan.pollIntervalMs,
          );

          // xpra 生成の xauth を読んで MIT-MAGIC-COOKIE-1 を取り出し、
          // docker container と hostname が違ってもマッチする FamilyWild
          // エントリとして書き直す。xauth ファイルは xpra が非同期に
          // 書き込むので、ファイルが出来て中身が parse 可能になるまで
          // poll する。
          const cookie = yield* Effect.tryPromise({
            try: () =>
              readXpraCookieWithRetry(
                plan.xpraInternalXauthPath,
                plan.displayNumber,
                plan.timeoutMs,
                plan.pollIntervalMs,
              ),
            catch: (e) =>
              new Error(
                `failed to read xpra xauth at ${plan.xpraInternalXauthPath}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              ),
          });
          const wildBytes = buildWildXauthorityRecord(
            plan.displayNumber,
            cookie,
          );
          yield* Effect.tryPromise({
            try: () =>
              Bun.write(plan.xauthorityPath, wildBytes).then(() => undefined),
            catch: (e) =>
              new Error(
                `failed to write Xauthority at ${plan.xauthorityPath}: ${
                  e instanceof Error ? e.message : String(e)
                }`,
              ),
          });
          yield* fs.chmod(plan.xauthorityPath, 0o600);

          // Auto-attach a host-side `xpra attach :N` so seamless-mode
          // windows pop up on the user's display without an explicit
          // command. The attach client inherits this nas process's
          // DISPLAY/XAUTHORITY (the user's actual X session). If the
          // host has no DISPLAY (e.g. headless ssh), xpra attach exits
          // immediately and the log explains why; the agent container
          // and the X server keep running unaffected.
          const attachLogPath = `${plan.sessionDir}/xpra-attach.log`;
          const attachHandle = yield* Effect.acquireRelease(
            proc.spawn(
              plan.xpraBinaryPath,
              ["attach", `:${plan.displayNumber}`],
              { logFile: attachLogPath },
            ),
            (handle) => Effect.sync(() => handle.kill()),
          );

          // Both processes alive — publish a registry entry so a future
          // GC can detect orphan state if nas dies without its scope
          // finalizers. The finalizer removes the entry on clean shutdown.
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                writeDisplayRegistry(runtimePaths, {
                  sessionId: plan.sessionId,
                  xpraServerPid: spawnHandle.pid,
                  attachPid: attachHandle.pid,
                  sessionDir: plan.sessionDir,
                  displayNumber: plan.displayNumber,
                  socketPath: plan.socketPath,
                  createdAt: new Date().toISOString(),
                }),
              catch: (e) =>
                new Error(
                  `failed to write display registry entry: ${
                    e instanceof Error ? e.message : String(e)
                  }`,
                ),
            }).pipe(Effect.orDie),
            () =>
              Effect.tryPromise({
                try: () => removeDisplayRegistry(runtimePaths, plan.sessionId),
                catch: (e) => e,
              }).pipe(Effect.catchAll(() => Effect.void)),
          );

          return {
            kill: () => spawnHandle.kill(),
            displayNumber: plan.displayNumber,
            socketPath: plan.socketPath,
            xauthorityPath: plan.xauthorityPath,
            logPath,
          } satisfies DisplayHandle;
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface DisplayServiceFakeConfig {
  readonly startXpra?: (
    plan: DisplayStartPlan,
  ) => Effect.Effect<DisplayHandle, unknown, Scope.Scope>;
}

export function makeDisplayServiceFake(
  overrides: DisplayServiceFakeConfig = {},
): Layer.Layer<DisplayService> {
  return Layer.succeed(
    DisplayService,
    DisplayService.of({
      startXpra:
        overrides.startXpra ??
        ((plan) =>
          Effect.succeed({
            kill: () => {},
            displayNumber: plan.displayNumber,
            socketPath: plan.socketPath,
            xauthorityPath: plan.xauthorityPath,
            logPath: `${plan.sessionDir}/xpra.log`,
          })),
    }),
  );
}
