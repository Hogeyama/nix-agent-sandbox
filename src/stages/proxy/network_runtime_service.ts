/**
 * NetworkRuntimeService — Effect-based abstraction over network runtime
 * directory management (GC stale sessions, copy mitmproxy addon, write review rules).
 *
 * Live implementation delegates to FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer } from "effect";
import type { SecretConfig } from "../../config/types.ts";
import { resolveAsset } from "../../lib/asset.ts";
import {
  type ResolvedDocument,
  withoutInjectLiterals,
} from "../../network/authz/resolve.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { resolveSecretRegistry } from "../../network/secrets.ts";
import { FsService } from "../../services/fs.ts";

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
// Live implementation
// ---------------------------------------------------------------------------

export const NetworkRuntimeServiceLive: Layer.Layer<
  NetworkRuntimeService,
  never,
  FsService
> = Layer.effect(
  NetworkRuntimeService,
  Effect.gen(function* () {
    const fs = yield* FsService;

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
          const addonSource = resolveAsset(
            "docker/mitmproxy/nas_addon.py",
            import.meta.url,
            "../../docker/mitmproxy/nas_addon.py",
          );
          const source = yield* fs.readFile(addonSource);
          const alreadyExists = yield* fs.exists(paths.addonScriptPath);
          const existing = alreadyExists
            ? yield* fs.readFile(paths.addonScriptPath)
            : "";
          if (source === existing) return;
          yield* fs.writeFile(paths.addonScriptPath, source, { mode: 0o644 });
        }),

      computeAddonHash: () =>
        Effect.gen(function* () {
          const addonSource = resolveAsset(
            "docker/mitmproxy/nas_addon.py",
            import.meta.url,
            "../../docker/mitmproxy/nas_addon.py",
          );
          const content = yield* fs.readFile(addonSource);
          const data = new TextEncoder().encode(content);
          const digest = yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", data),
          );
          return Buffer.from(new Uint8Array(digest)).toString("hex");
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
        Effect.tryPromise({
          try: () => resolveSecretRegistry(secrets, env),
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        }).pipe(Effect.orDie),
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
