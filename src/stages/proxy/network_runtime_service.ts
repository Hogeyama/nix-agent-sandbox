/**
 * NetworkRuntimeService — Effect-based abstraction over network runtime
 * directory management (GC stale sessions, copy mitmproxy addon, write review rules).
 *
 * Live implementation delegates to FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { SecretConfig } from "../../config/types.ts";
import { resolveAsset, resolveAssetDir } from "../../lib/asset.ts";
import {
  type ResolvedDocument,
  withoutInjectLiterals,
} from "../../network/authz/resolve.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { FsService } from "../../services/fs.ts";
import { SecretResolverService } from "../../services/secret_resolver.ts";

// ---------------------------------------------------------------------------
// NetworkRuntimeService tag
// ---------------------------------------------------------------------------

export class NetworkRuntimeService extends Context.Tag(
  "nas/NetworkRuntimeService",
)<
  NetworkRuntimeService,
  {
    readonly ensureRuntimeDirs: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly gcStaleRuntime: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly copyAddonScript: (
      paths: NetworkRuntimePaths,
    ) => Effect.Effect<void>;
    readonly writeAuthzDocument: (
      paths: NetworkRuntimePaths,
      sessionId: string,
      document: ResolvedDocument,
    ) => Effect.Effect<void>;
    /** セッション終了時に解決済みドキュメントを消す。無ければ何もしない。 */
    readonly removeAuthzDocument: (
      paths: NetworkRuntimePaths,
      sessionId: string,
    ) => Effect.Effect<void>;
    readonly computeAddonHash: () => Effect.Effect<string>;
    readonly resolveSecrets: (
      secrets: Readonly<Record<string, SecretConfig>>,
      env: Record<string, string | undefined>,
    ) => Effect.Effect<Record<string, string[]>>;
  }
>() {}

/** セッションの解決済みドキュメントの置き場所。書く側と消す側で共有する。 */
function authzDocumentPath(
  paths: NetworkRuntimePaths,
  sessionId: string,
): string {
  return `${paths.authzDir}/${sessionId}.json`;
}

// ---------------------------------------------------------------------------
// Addon + vendored dependency helpers
// ---------------------------------------------------------------------------

type Fs = Context.Tag.Service<FsService>;

function addonSourcePath(): string {
  return resolveAsset(
    "docker/mitmproxy/nas_addon.py",
    import.meta.url,
    "../../docker/mitmproxy/nas_addon.py",
  );
}

function vendorSourceDir(): string {
  return resolveAssetDir(
    "docker/mitmproxy/vendor",
    import.meta.url,
    "../../docker/mitmproxy/vendor",
  );
}

// -- D1 wrappers: exactly one IO call each. The composed helpers below go
// through these so they never invoke an fs primitive inline.
//
// readText/writeText move file content through strings, so hashing and
// copying below are text-only. That is fine for pure-Python vendored
// trees, but a future pin shipping binary artifacts (e.g. a .so wheel)
// would be silently corrupted — pins must stay pure source.

const readText = (fs: Fs, path: string): Effect.Effect<string> =>
  fs.readFile(path);

const writeText = (
  fs: Fs,
  path: string,
  content: string,
): Effect.Effect<void> => fs.writeFile(path, content, { mode: 0o644 });

const fileExists = (fs: Fs, path: string): Effect.Effect<boolean> =>
  fs.exists(path);

const makeDirs = (fs: Fs, path: string): Effect.Effect<void> =>
  fs.mkdir(path, { recursive: true });

const removeTree = (fs: Fs, path: string): Effect.Effect<void> =>
  fs.rm(path, { recursive: true, force: true });

const listDir = (fs: Fs, path: string) => fs.readdir(path);

// -- D2 helpers: compose the wrappers above, touch no primitives --------------

function readFileOrEmpty(fs: Fs, path: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    return (yield* fileExists(fs, path)) ? yield* readText(fs, path) : "";
  });
}

/**
 * Every regular file under `dir`, as `/`-separated paths relative to `dir`,
 * sorted ascending. Directories themselves are not listed.
 */
function listFilesRecursive(fs: Fs, dir: string): Effect.Effect<string[]> {
  const walk = (rel: string): Effect.Effect<string[]> =>
    Effect.gen(function* () {
      const entries = yield* listDir(fs, rel === "" ? dir : `${dir}/${rel}`);
      const files: string[] = [];
      for (const entry of entries) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          files.push(...(yield* walk(childRel)));
        } else {
          files.push(childRel);
        }
      }
      return files;
    });
  return Effect.map(walk(""), (files) => files.sort());
}

/**
 * SHA-256 over a file set: entries are taken in ascending `rel` order and each
 * contributes its relative path followed by its content, so the digest moves
 * when any file is added, removed, renamed, or edited.
 */
function hashFiles(
  fs: Fs,
  files: readonly { rel: string; abs: string }[],
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const sorted = [...files].sort((a, b) => (a.rel < b.rel ? -1 : 1));
    let acc = "";
    for (const file of sorted) {
      acc += `${file.rel}\0${yield* readText(fs, file.abs)}\0`;
    }
    const data = new TextEncoder().encode(acc);
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", data),
    );
    return Buffer.from(new Uint8Array(digest)).toString("hex");
  });
}

/**
 * Python bytecode caches appear under `vendor/` as soon as anything imports
 * the vendored package from the source tree. They are not part of the
 * vendored source; letting them into the hash would make it depend on whether
 * the Python tests happened to run on this checkout, and copying them would
 * ship stale bytecode into the runtime dir.
 */
function isVendorArtifact(rel: string): boolean {
  return (
    rel.split("/").includes("__pycache__") ||
    rel.endsWith(".pyc") ||
    rel.endsWith(".pyo")
  );
}

/**
 * The files of the vendored dependency tree, or a defect explaining how to
 * populate it. `vendor/` is gitignored and generated by `bun run vendor`
 * (see vendor-requirements.txt), so a fresh checkout has nothing there.
 * Shipping an empty tree would only surface later, when the addon dies on
 * `import graphql` inside the proxy container — fail here instead, where the
 * fix is obvious.
 */
function listVendorFiles(
  fs: Fs,
  vendorSource: string,
): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const present = yield* fileExists(fs, vendorSource);
    if (!present) {
      return yield* Effect.die(
        new Error(
          `vendored Python dependencies are missing at ${vendorSource}. ` +
            "They are generated, not committed: run `bun run vendor` " +
            "(uv pip install --target src/docker/mitmproxy/vendor " +
            "-r src/docker/mitmproxy/vendor-requirements.txt).",
        ),
      );
    }
    const files = (yield* listFilesRecursive(fs, vendorSource)).filter(
      (rel) => !isVendorArtifact(rel),
    );
    if (files.length === 0) {
      return yield* Effect.die(
        new Error(
          `vendored Python dependency tree at ${vendorSource} is empty. ` +
            "Re-run `bun run vendor` to repopulate it.",
        ),
      );
    }
    return files;
  });
}

/**
 * Replace `destDir` with a fresh copy of `files` out of `srcDir`. Stale files
 * that vanished from the source disappear with the old tree.
 */
function rebuildTree(
  fs: Fs,
  srcDir: string,
  destDir: string,
  files: readonly string[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* removeTree(fs, destDir);
    yield* makeDirs(fs, destDir);
    for (const rel of files) {
      const slash = rel.lastIndexOf("/");
      if (slash !== -1) {
        yield* makeDirs(fs, `${destDir}/${rel.slice(0, slash)}`);
      }
      const content = yield* readText(fs, `${srcDir}/${rel}`);
      yield* writeText(fs, `${destDir}/${rel}`, content);
    }
  });
}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const NetworkRuntimeServiceLive: Layer.Layer<
  NetworkRuntimeService,
  never,
  FsService | SecretResolverService
> = Layer.effect(
  NetworkRuntimeService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    const secretResolver = yield* SecretResolverService;

    return NetworkRuntimeService.of({
      ensureRuntimeDirs: (paths) =>
        Effect.gen(function* () {
          yield* fs.mkdir(paths.runtimeDir, { recursive: true, mode: 0o755 });
          yield* fs.mkdir(paths.sessionsDir, { recursive: true });
          yield* fs.mkdir(paths.pendingDir, { recursive: true });
          yield* fs.mkdir(paths.brokersDir, { recursive: true });
          yield* fs.mkdir(paths.caCertDir, { recursive: true });
          yield* fs.mkdir(paths.authzDir, { recursive: true });
        }),

      gcStaleRuntime: (_paths) => Effect.void,

      copyAddonScript: (paths) =>
        Effect.gen(function* () {
          const addonSource = addonSourcePath();
          const source = yield* readText(fs, addonSource);
          const existing = yield* readFileOrEmpty(fs, paths.addonScriptPath);
          if (source !== existing) {
            yield* writeText(fs, paths.addonScriptPath, source);
          }

          // The vendored tree the addon puts on sys.path. The sentinel
          // records the source hash from the last copy, so an unchanged
          // tree skips rebuilding the destination — but detecting that
          // still walks and reads every vendored file to compute
          // vendorHash; only the rewrite of the destination tree is
          // avoided.
          const vendorSource = vendorSourceDir();
          const vendorDest = `${paths.runtimeDir}/vendor`;
          const vendorFiles = yield* listVendorFiles(fs, vendorSource);
          const vendorHash = yield* hashFiles(
            fs,
            vendorFiles.map((rel) => ({
              rel,
              abs: `${vendorSource}/${rel}`,
            })),
          );
          const sentinel = yield* readFileOrEmpty(fs, `${vendorDest}/.hash`);
          if (sentinel === vendorHash) return;
          yield* rebuildTree(fs, vendorSource, vendorDest, vendorFiles);
          yield* writeText(fs, `${vendorDest}/.hash`, vendorHash);
        }),

      computeAddonHash: () =>
        Effect.gen(function* () {
          // The hash labels the proxy container so that editing either the
          // addon or a vendored file forces a recreate; a library update that
          // left the hash alone would keep the old container running the old
          // code.
          const vendorSource = vendorSourceDir();
          const vendorFiles = yield* listVendorFiles(fs, vendorSource);
          return yield* hashFiles(fs, [
            { rel: "nas_addon.py", abs: addonSourcePath() },
            ...vendorFiles.map((rel) => ({
              rel: `vendor/${rel}`,
              abs: `${vendorSource}/${rel}`,
            })),
          ]);
        }),

      writeAuthzDocument: (paths, sessionId, document) =>
        Effect.gen(function* () {
          // 注入の地の文はファイルに載せない。addon は inject の形を検証する
          // だけで中身を読まず、実際に注入されるヘッダーは broker が組み立てる。
          yield* fs.writeFile(
            authzDocumentPath(paths, sessionId),
            JSON.stringify(withoutInjectLiterals(document)),
            // このファイルはセッションの認可規則そのものである。ホストの他の
            // 利用者に読ませる理由はないので、他のセッション固有のランタイム
            // ファイルと同じ 0600 で置く。proxy コンテナは root で走るので
            // 読める。
            { mode: 0o600 },
          );
        }),

      removeAuthzDocument: (paths, sessionId) =>
        // セッションが終わればこの規則は誰の役にも立たない。残しておくと、
        // 次に同じ runtime dir を見た人が生きている設定と見分けられない。
        fs
          .rm(authzDocumentPath(paths, sessionId), { force: true })
          .pipe(Effect.orDie),

      resolveSecrets: (secrets, env) =>
        secretResolver.resolveRegistry(secrets, env).pipe(Effect.orDie),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface NetworkRuntimeServiceFakeConfig {
  readonly ensureRuntimeDirs?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
  readonly gcStaleRuntime?: (paths: NetworkRuntimePaths) => Effect.Effect<void>;
  readonly copyAddonScript?: (
    paths: NetworkRuntimePaths,
  ) => Effect.Effect<void>;
  readonly writeAuthzDocument?: (
    paths: NetworkRuntimePaths,
    sessionId: string,
    document: ResolvedDocument,
  ) => Effect.Effect<void>;
  readonly removeAuthzDocument?: (
    paths: NetworkRuntimePaths,
    sessionId: string,
  ) => Effect.Effect<void>;
  readonly computeAddonHash?: () => Effect.Effect<string>;
  readonly resolveSecrets?: (
    secrets: Readonly<Record<string, SecretConfig>>,
    env: Record<string, string | undefined>,
  ) => Effect.Effect<Record<string, string[]>>;
}

export function makeNetworkRuntimeServiceFake(
  overrides: NetworkRuntimeServiceFakeConfig = {},
): Layer.Layer<NetworkRuntimeService> {
  return Layer.succeed(
    NetworkRuntimeService,
    NetworkRuntimeService.of({
      ensureRuntimeDirs: overrides.ensureRuntimeDirs ?? (() => Effect.void),
      gcStaleRuntime: overrides.gcStaleRuntime ?? (() => Effect.void),
      copyAddonScript: overrides.copyAddonScript ?? (() => Effect.void),
      writeAuthzDocument: overrides.writeAuthzDocument ?? (() => Effect.void),
      removeAuthzDocument: overrides.removeAuthzDocument ?? (() => Effect.void),
      computeAddonHash:
        overrides.computeAddonHash ?? (() => Effect.succeed("fakehash")),
      resolveSecrets: overrides.resolveSecrets ?? (() => Effect.succeed({})),
    }),
  );
}
