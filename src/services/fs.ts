/**
 * FsService — Effect-based filesystem abstraction.
 *
 * Live implementation wraps node:fs/promises.
 * Fake implementation uses an in-memory Map for testing.
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { Context, Effect, Layer } from "effect";

export class FsService extends Context.Tag("nas/FsService")<
  FsService,
  {
    readonly mkdir: (
      path: string,
      opts: { recursive?: boolean; mode?: number },
    ) => Effect.Effect<void>;
    readonly writeFile: (
      path: string,
      content: string,
      opts?: { mode?: number },
    ) => Effect.Effect<void>;
    readonly chmod: (path: string, mode: number) => Effect.Effect<void>;
    readonly symlink: (target: string, path: string) => Effect.Effect<void>;
    readonly rm: (
      path: string,
      opts?: { recursive?: boolean; force?: boolean },
    ) => Effect.Effect<void>;
    readonly stat: (path: string) => Effect.Effect<Stats>;
    readonly exists: (path: string) => Effect.Effect<boolean>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export const FsServiceLive = Layer.succeed(FsService, {
  mkdir: (path, opts) =>
    Effect.tryPromise(() => fs.mkdir(path, opts).then(() => undefined)).pipe(
      Effect.orDie,
    ),

  writeFile: (path, content, opts) =>
    Effect.tryPromise(() =>
      fs.writeFile(path, content, opts ? { mode: opts.mode } : undefined),
    ).pipe(Effect.orDie),

  chmod: (path, mode) =>
    Effect.tryPromise(() => fs.chmod(path, mode)).pipe(Effect.orDie),

  symlink: (target, path) =>
    Effect.tryPromise(() => fs.symlink(target, path)).pipe(Effect.orDie),

  rm: (path, opts) =>
    Effect.tryPromise(() => fs.rm(path, opts)).pipe(Effect.orDie),

  stat: (path) => Effect.tryPromise(() => fs.stat(path)).pipe(Effect.orDie),

  exists: (path) =>
    Effect.tryPromise(() =>
      fs.stat(path).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return false;
          throw e;
        },
      ),
    ).pipe(Effect.orDie),
});

// ---------------------------------------------------------------------------
// Fake (in-memory, for testing)
// ---------------------------------------------------------------------------

interface FakeEntry {
  content: string;
  mode: number;
  /** If set, this entry is a symlink pointing at `symlinkTarget`. */
  symlinkTarget?: string;
  /** If true, the entry represents a directory. */
  isDirectory?: boolean;
}

export function makeFsServiceFake(): {
  layer: Layer.Layer<FsService>;
  /** Direct access to the backing store for test assertions. */
  store: Map<string, FakeEntry>;
} {
  const store = new Map<string, FakeEntry>();

  const layer = Layer.succeed(FsService, {
    mkdir: (path, opts) =>
      Effect.sync(() => {
        if (!store.has(path) || opts.recursive) {
          store.set(path, {
            content: "",
            mode: opts.mode ?? 0o755,
            isDirectory: true,
          });
        }
      }),

    writeFile: (path, content, opts) =>
      Effect.sync(() => {
        store.set(path, { content, mode: opts?.mode ?? 0o644 });
      }),

    chmod: (path, mode) =>
      Effect.sync(() => {
        const entry = store.get(path);
        if (!entry) {
          throw new Error(`ENOENT: ${path}`);
        }
        entry.mode = mode;
      }),

    symlink: (target, path) =>
      Effect.sync(() => {
        store.set(path, { content: "", mode: 0o777, symlinkTarget: target });
      }),

    rm: (path, opts) =>
      Effect.sync(() => {
        if (!store.has(path) && !opts?.force) {
          throw new Error(`ENOENT: ${path}`);
        }
        if (opts?.recursive) {
          const prefix = path.endsWith("/") ? path : `${path}/`;
          for (const key of store.keys()) {
            if (key === path || key.startsWith(prefix)) {
              store.delete(key);
            }
          }
        } else {
          store.delete(path);
        }
      }),

    stat: (path) =>
      Effect.sync(() => {
        const entry = store.get(path);
        if (!entry) {
          throw new Error(`ENOENT: ${path}`);
        }
        // Return a minimal Stats-like object. Cast is necessary because the
        // full Stats class has many fields; tests that need more fidelity
        // should use the Live layer against a tmp directory.
        return {
          mode: entry.mode,
          size: entry.content.length,
          isFile: () => !entry.isDirectory && !entry.symlinkTarget,
          isDirectory: () => !!entry.isDirectory,
          isSymbolicLink: () => !!entry.symlinkTarget,
        } as unknown as Stats;
      }),

    exists: (path) => Effect.sync(() => store.has(path)),
  });

  return { layer, store };
}
