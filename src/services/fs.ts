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
    readonly readFile: (path: string) => Effect.Effect<string>;
    readonly rename: (oldPath: string, newPath: string) => Effect.Effect<void>;
    readonly mkdtemp: (prefix: string) => Effect.Effect<string>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

const fsError =
  (op: string, ...args: string[]) =>
  (e: unknown) =>
    new Error(
      `fs.${op}(${args.join(", ")}) failed: ${e instanceof Error ? e.message : String(e)}`,
    );

export const FsServiceLive = Layer.succeed(FsService, {
  mkdir: (path, opts) =>
    Effect.tryPromise({
      try: () => fs.mkdir(path, opts).then(() => undefined),
      catch: fsError("mkdir", path),
    }).pipe(Effect.orDie),

  writeFile: (path, content, opts) =>
    Effect.tryPromise({
      try: () =>
        fs.writeFile(path, content, opts ? { mode: opts.mode } : undefined),
      catch: fsError("writeFile", path),
    }).pipe(Effect.orDie),

  chmod: (path, mode) =>
    Effect.tryPromise({
      try: () => fs.chmod(path, mode),
      catch: fsError("chmod", path),
    }).pipe(Effect.orDie),

  symlink: (target, path) =>
    Effect.tryPromise({
      try: () => fs.symlink(target, path),
      catch: fsError("symlink", target, path),
    }).pipe(Effect.orDie),

  rm: (path, opts) =>
    Effect.tryPromise({
      try: () => fs.rm(path, opts),
      catch: fsError("rm", path),
    }).pipe(Effect.orDie),

  stat: (path) =>
    Effect.tryPromise({
      try: () => fs.stat(path),
      catch: fsError("stat", path),
    }).pipe(Effect.orDie),

  exists: (path) =>
    Effect.tryPromise({
      try: () =>
        fs.stat(path).then(
          () => true,
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return false;
            throw e;
          },
        ),
      catch: fsError("exists", path),
    }).pipe(Effect.orDie),

  readFile: (path) =>
    Effect.tryPromise({
      try: () => fs.readFile(path, "utf8"),
      catch: fsError("readFile", path),
    }).pipe(Effect.orDie),

  rename: (oldPath, newPath) =>
    Effect.tryPromise({
      try: () => fs.rename(oldPath, newPath),
      catch: fsError("rename", oldPath, newPath),
    }).pipe(Effect.orDie),

  mkdtemp: (prefix) =>
    Effect.tryPromise({
      try: () => fs.mkdtemp(prefix),
      catch: fsError("mkdtemp", prefix),
    }).pipe(Effect.orDie),
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

    readFile: (path) =>
      Effect.sync(() => {
        const entry = store.get(path);
        if (!entry) {
          throw new Error(`ENOENT: ${path}`);
        }
        return entry.content;
      }),

    rename: (oldPath, newPath) =>
      Effect.sync(() => {
        const entry = store.get(oldPath);
        if (!entry) {
          throw new Error(`ENOENT: ${oldPath}`);
        }
        store.delete(oldPath);
        store.set(newPath, entry);
      }),

    mkdtemp: (prefix) =>
      Effect.sync(() => {
        let counter = 0;
        let path: string;
        do {
          path = `${prefix}${counter.toString().padStart(6, "0")}`;
          counter++;
        } while (store.has(path));
        store.set(path, { content: "", mode: 0o700, isDirectory: true });
        return path;
      }),
  });

  return { layer, store };
}
