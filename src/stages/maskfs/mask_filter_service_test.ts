import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FsService } from "../../services/fs.ts";
import { ProcessService, type SpawnHandle } from "../../services/process.ts";
import {
  MASK_FILTER_CONTAINER_PATH,
  type MaskFilterResult,
  MaskFilterService,
  MaskFilterServiceLive,
} from "./mask_filter_service.ts";

const SESSION_DIR = "/run/user/1000/nas/mask-filter/sess_x";
const SOCKET_DIR = "/run/user/1000/nas/mask-filter/sess_x-sock";
const FRAME = `${SESSION_DIR}/mask-secrets`;
const SOCKET = `${SOCKET_DIR}/mask.sock`;
const LOG = `${SESSION_DIR}/serve.log`;
const BINARY = "/usr/local/bin/nas-mask-filter";

/**
 * Would a bind mount of `mountSource` expose `target` to the container?
 *
 * Substring matching is not good enough here: the defect this guards against
 * is mounting the frame's *parent* directory, whose path does not contain
 * "mask-secrets" at all.
 */
function reachable(target: string, mountSource: string): boolean {
  const src = mountSource.endsWith("/") ? mountSource : `${mountSource}/`;
  return target === mountSource || target.startsWith(src);
}

interface WrittenFile {
  readonly path: string;
  readonly data: Uint8Array;
  readonly mode: number | undefined;
}

interface SpawnRecord {
  readonly command: string;
  readonly args: string[];
}

interface Recorded {
  readonly result: MaskFilterResult;
  readonly written: WrittenFile[];
  readonly spawns: SpawnRecord[];
  readonly spawnEnv: Array<Record<string, string> | undefined>;
  readonly spawnLogFiles: Array<string | undefined>;
  readonly chmods: Array<{ path: string; mode: number }>;
  readonly mkdirs: Array<{ path: string; mode: number | undefined }>;
  /** rm と rmdir を 1 本の列に混ぜて記録する (削除の順序を見るため)。 */
  readonly removed: string[];
  readonly waited: Array<{ path: string; timeoutMs: number }>;
  readonly killed: number;
}

const host = {
  home: "/home/u",
  user: "u",
  uid: 1000,
  gid: 1000,
  isWSL: false,
  env: new Map([["TEST_SECRET", "hunter2secret"]]),
} as any;

/**
 * Runs prepareMaskFilter against fake FsService / ProcessService layers and
 * records every interaction. The scope is closed before returning, so the
 * finalizer's effects are visible in `removed` / `killed`.
 */
async function runCapturing(): Promise<Recorded> {
  const written: WrittenFile[] = [];
  const spawns: SpawnRecord[] = [];
  const spawnEnv: Array<Record<string, string> | undefined> = [];
  const spawnLogFiles: Array<string | undefined> = [];
  const chmods: Array<{ path: string; mode: number }> = [];
  const mkdirs: Array<{ path: string; mode: number | undefined }> = [];
  const removed: string[] = [];
  const waited: Array<{ path: string; timeoutMs: number }> = [];
  let killed = 0;

  const fakeFs = Layer.succeed(
    FsService,
    FsService.of({
      mkdir: (p, opts) =>
        Effect.sync(() => {
          mkdirs.push({ path: p, mode: opts.mode });
        }),
      writeFile: (p, data, opts) =>
        Effect.sync(() => {
          written.push({
            path: p,
            data:
              data instanceof Uint8Array
                ? data
                : new TextEncoder().encode(String(data)),
            mode: opts?.mode,
          });
        }),
      chmod: (p, mode) =>
        Effect.sync(() => {
          chmods.push({ path: p, mode });
        }),
      rm: (p) =>
        Effect.sync(() => {
          removed.push(p);
        }),
      rmdir: (p) =>
        Effect.sync(() => {
          removed.push(p);
        }),
      readFile: () => Effect.succeed(""),
      symlink: () => Effect.void,
      rename: () => Effect.void,
      stat: () => Effect.succeed({} as any),
      exists: () => Effect.succeed(false),
      mkdtemp: () => Effect.succeed("/tmp/fake"),
    }),
  );

  const fakeProc = Layer.succeed(
    ProcessService,
    ProcessService.of({
      spawn: (command, args, opts) =>
        Effect.sync(() => {
          spawns.push({ command, args });
          spawnEnv.push(opts?.env);
          spawnLogFiles.push(opts?.logFile);
          return {
            kill: () => {
              killed++;
            },
            exited: Effect.succeed(0),
            pid: 4242,
          } satisfies SpawnHandle;
        }),
      waitForFileExists: (p, timeoutMs) =>
        Effect.sync(() => {
          waited.push({ path: p, timeoutMs });
        }),
      exec: () => Effect.succeed(""),
    }),
  );

  const result = await Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* MaskFilterService;
          const secrets = yield* svc.resolveSecrets(
            [{ source: "env:TEST_SECRET" }],
            host,
          );
          return yield* svc.prepareMaskFilter(
            {
              secretsFramePath: FRAME,
              filterBinaryHostPath: BINARY,
              socketDir: SOCKET_DIR,
              socketPath: SOCKET,
              logFile: LOG,
              timeoutMs: 5000,
              pollIntervalMs: 25,
            },
            secrets,
          );
        }),
      ),
      MaskFilterServiceLive.pipe(Layer.provide(Layer.merge(fakeFs, fakeProc))),
    ),
  );

  return {
    result,
    written,
    spawns,
    spawnEnv,
    spawnLogFiles,
    chmods,
    mkdirs,
    removed,
    waited,
    killed,
  };
}

async function run(): Promise<MaskFilterResult> {
  return (await runCapturing()).result;
}

describe("MaskFilterServiceLive.prepareMaskFilter", () => {
  test("no mount can reach the secrets frame (C1)", async () => {
    const result = await run();
    for (const m of result.mounts)
      expect(reachable(FRAME, m.source)).toBe(false);
  });

  test("no mount can reach the serve log", async () => {
    const result = await run();
    for (const m of result.mounts) expect(reachable(LOG, m.source)).toBe(false);
  });

  test("no container env names the frame (S1)", async () => {
    const result = await run();
    expect(result.envVars.NAS_MASK_SECRETS_FILE).toBeUndefined();
    expect(JSON.stringify(result.envVars)).not.toContain("mask-secrets");
  });

  test("writes the frame host-side (hostexec C3 depends on it)", async () => {
    const { written } = await runCapturing();
    expect(written.map((w) => w.path)).toContain(FRAME);
    const frame = written.find((w) => w.path === FRAME);
    expect(frame?.mode).toBe(0o600);
    expect(new TextDecoder().decode(frame?.data)).toContain("hunter2secret");
  });

  test("mounts the socket directory read-only and spawns the daemon", async () => {
    const { result, spawns } = await runCapturing();
    expect(
      result.mounts.some(
        (m) =>
          m.source === SOCKET_DIR &&
          m.target === SOCKET_DIR &&
          m.readOnly === true,
      ),
    ).toBe(true);
    expect(result.envVars.NAS_MASK_SOCKET).toBe(SOCKET);
    expect(spawns).toEqual([{ command: BINARY, args: ["--serve", SOCKET] }]);
  });

  test("mounts the filter binary read-only", async () => {
    const result = await run();
    expect(result.mounts).toContainEqual({
      source: BINARY,
      target: MASK_FILTER_CONTAINER_PATH,
      readOnly: true,
    });
    expect(result.envVars.NAS_MASK_FILTER).toBe(MASK_FILTER_CONTAINER_PATH);
  });

  test("passes the frame path in the daemon's own env, not the container's", async () => {
    const { spawnEnv, spawnLogFiles } = await runCapturing();
    expect(spawnEnv[0]?.NAS_MASK_SECRETS_FILE).toBe(FRAME);
    expect(spawnLogFiles[0]).toBe(LOG);
  });

  test("creates the frame and socket directories 0700 and tightens the log to 0600", async () => {
    const { mkdirs, chmods } = await runCapturing();
    expect(mkdirs).toContainEqual({ path: SESSION_DIR, mode: 0o700 });
    expect(mkdirs).toContainEqual({ path: SOCKET_DIR, mode: 0o700 });
    // ProcessService.spawn opens the log with openSync(path, "a") => 0644.
    expect(chmods).toContainEqual({ path: LOG, mode: 0o600 });
  });

  test("waits for the socket before returning", async () => {
    const { waited } = await runCapturing();
    expect(waited).toEqual([{ path: SOCKET, timeoutMs: 5000 }]);
  });

  test("scope release kills the daemon and removes everything it created (S2)", async () => {
    const { killed, removed } = await runCapturing();
    expect(killed).toBe(1);
    // Finalizers run in reverse acquisition order. The directories and the
    // frame are acquired before the daemon, so on release the daemon (and its
    // socket/log) is torn down first, then the frame, then the directories
    // that held them — contents always before their directory.
    //
    // Registering the directories with acquireRelease (rather than removing
    // them from releaseServe) also means they are reclaimed even when the
    // daemon never successfully starts.
    expect(removed).toEqual([SOCKET, LOG, FRAME, SOCKET_DIR, SESSION_DIR]);
  });

  test("removes the frame and directories if spawn throws before the daemon starts", async () => {
    // Mirrors ProcessService's real spawn: Effect.sync around Bun.spawn,
    // which throws synchronously on e.g. EACCES for a non-executable file.
    // Nothing must survive an aborted session even though the daemon never
    // got a chance to start (and so releaseServe's finalizer never gets
    // registered).
    const written: WrittenFile[] = [];
    const removed: string[] = [];

    const fakeFs = Layer.succeed(
      FsService,
      FsService.of({
        mkdir: () => Effect.void,
        writeFile: (p, data, opts) =>
          Effect.sync(() => {
            written.push({
              path: p,
              data:
                data instanceof Uint8Array
                  ? data
                  : new TextEncoder().encode(String(data)),
              mode: opts?.mode,
            });
          }),
        chmod: () => Effect.void,
        rm: (p) =>
          Effect.sync(() => {
            removed.push(p);
          }),
        rmdir: (p) =>
          Effect.sync(() => {
            removed.push(p);
          }),
        readFile: () => Effect.succeed(""),
        symlink: () => Effect.void,
        rename: () => Effect.void,
        stat: () => Effect.succeed({} as any),
        exists: () => Effect.succeed(false),
        mkdtemp: () => Effect.succeed("/tmp/fake"),
      }),
    );

    const fakeProc = Layer.succeed(
      ProcessService,
      ProcessService.of({
        spawn: () =>
          Effect.sync(() => {
            throw new Error("EACCES: permission denied, spawn");
          }),
        waitForFileExists: () => Effect.void,
        exec: () => Effect.succeed(""),
      }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* MaskFilterService;
            return yield* svc.prepareMaskFilter(
              {
                secretsFramePath: FRAME,
                filterBinaryHostPath: BINARY,
                socketDir: SOCKET_DIR,
                socketPath: SOCKET,
                logFile: LOG,
                timeoutMs: 5000,
                pollIntervalMs: 25,
              },
              ["hunter2secret"],
            );
          }),
        ),
        MaskFilterServiceLive.pipe(
          Layer.provide(Layer.merge(fakeFs, fakeProc)),
        ),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(written.map((w) => w.path)).toEqual([FRAME]);
    expect(removed).toEqual([FRAME, SOCKET_DIR, SESSION_DIR]);
  });

  // rmdir が失敗しても release 全体を落としてはならない (finalizer は失敗
  // してはならない)。落とすと、後続の finalizer — ここではセッション
  // ディレクトリの削除 — が走らなくなる。
  test("a directory that will not go away does not abort the release", async () => {
    const removed: string[] = [];

    const fakeFs = Layer.succeed(
      FsService,
      FsService.of({
        mkdir: () => Effect.void,
        writeFile: () => Effect.void,
        chmod: () => Effect.void,
        rm: (p) =>
          Effect.sync(() => {
            removed.push(p);
          }),
        rmdir: (p) =>
          Effect.sync(() => {
            if (p === SOCKET_DIR) throw new Error(`ENOTEMPTY: ${p}`);
            removed.push(p);
          }),
        readFile: () => Effect.succeed(""),
        symlink: () => Effect.void,
        rename: () => Effect.void,
        stat: () => Effect.succeed({} as any),
        exists: () => Effect.succeed(false),
        mkdtemp: () => Effect.succeed("/tmp/fake"),
      }),
    );

    const fakeProc = Layer.succeed(
      ProcessService,
      ProcessService.of({
        spawn: () =>
          Effect.succeed({
            kill: () => {},
            exited: Effect.succeed(0),
            pid: 4242,
          } satisfies SpawnHandle),
        waitForFileExists: () => Effect.void,
        exec: () => Effect.succeed(""),
      }),
    );

    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.scoped(
          Effect.gen(function* () {
            const svc = yield* MaskFilterService;
            return yield* svc.prepareMaskFilter(
              {
                secretsFramePath: FRAME,
                filterBinaryHostPath: BINARY,
                socketDir: SOCKET_DIR,
                socketPath: SOCKET,
                logFile: LOG,
                timeoutMs: 5000,
                pollIntervalMs: 25,
              },
              ["hunter2secret"],
            );
          }),
        ),
        MaskFilterServiceLive.pipe(
          Layer.provide(Layer.merge(fakeFs, fakeProc)),
        ),
      ),
    );

    expect(exit._tag).toBe("Success");
    expect(removed).toEqual([SOCKET, LOG, FRAME, SESSION_DIR]);
  });
});
