/**
 * NetworkRuntimeService unit tests (no real fs).
 *
 * Drives the Live service with a fake FsService layer so we
 * exercise the real ensureRuntimeDirs and copyAddonScript branching logic
 * without touching disk.
 */

import { expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  documentWithScopes,
  resolvedDocument,
} from "../../network/authz/testing.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { makeFsServiceFake } from "../../services/fs.ts";
import { makeProcessServiceFake } from "../../services/process.ts";
import { SecretResolverServiceLive } from "../../services/secret_resolver.ts";
import {
  NetworkRuntimeService,
  NetworkRuntimeServiceLive,
} from "./network_runtime_service.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paths(): NetworkRuntimePaths {
  const root = "/run/user/1000/nas/xyz/network";
  return {
    runtimeDir: root,
    sessionsDir: `${root}/sessions`,
    pendingDir: `${root}/pending`,
    brokersDir: `${root}/brokers`,
    caCertDir: `${root}/mitmproxy-ca`,
    addonScriptPath: `${root}/nas_addon.py`,
    authzDir: `${root}/authz`,
  };
}

function makeLiveLayer(
  fsFake: ReturnType<typeof makeFsServiceFake>,
): Layer.Layer<NetworkRuntimeService> {
  return NetworkRuntimeServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        fsFake.layer,
        makeProcessServiceFake(),
        SecretResolverServiceLive,
      ),
    ),
  );
}

async function runGc(
  fsFake: ReturnType<typeof makeFsServiceFake>,
): Promise<void> {
  const live = makeLiveLayer(fsFake);
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.gcStaleRuntime(paths()),
    ).pipe(Effect.provide(live)),
  );
}

// ---------------------------------------------------------------------------
// gcStaleRuntime
// ---------------------------------------------------------------------------

test("gcStaleRuntime: is a no-op", async () => {
  const fsFake = makeFsServiceFake();
  // gcStaleRuntime is now a no-op (Effect.void); just assert it completes.
  await runGc(fsFake);
  // No files should have been touched.
  expect(fsFake.store.size).toEqual(0);
});

// ---------------------------------------------------------------------------
// writeAuthzDocument
// ---------------------------------------------------------------------------

test("writeAuthzDocument: writes the whole document where the addon reads it", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  const live = makeLiveLayer(fsFake);

  const document = documentWithScopes({
    example: { targets: ["*.example.com"], fallback: "allow" },
  });
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.writeAuthzDocument(p, "sess-123", document),
    ).pipe(Effect.provide(live)),
  );

  const documentPath = `${p.authzDir}/sess-123.json`;
  expect(fsFake.store.has(documentPath)).toEqual(true);
  const stored = fsFake.store.get(documentPath);
  expect(JSON.parse(stored!.content as string)).toEqual(document);
});

test("writeAuthzDocument: the file is readable only by its owner", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  const live = makeLiveLayer(fsFake);

  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.writeAuthzDocument(p, "sess-123", documentWithScopes({})),
    ).pipe(Effect.provide(live)),
  );

  expect(fsFake.store.get(`${p.authzDir}/sess-123.json`)?.mode).toEqual(0o600);
});

test("writeAuthzDocument: the injected literal never reaches the file", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  const live = makeLiveLayer(fsFake);

  const document = resolvedDocument({
    secrets: { "gh-token": { from: "env:GH" } },
    network: {
      scopes: {
        github: {
          targets: ["api.github.com:443"],
          secrets: { "gh-token": "inject" },
          inject: [{ name: "X-Scope", value: "literal:scope-secret-value" }],
          rules: {
            write: {
              match: { paths: ["/graphql"] },
              onMatch: "allow",
              inject: [
                {
                  name: "Authorization",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: `template:` の参照構文であってテンプレートリテラルではない
                  value: "template:Bearer rule-secret-value ${gh-token}",
                },
              ],
            },
          },
        },
      },
    },
  });
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.writeAuthzDocument(p, "sess-123", document),
    ).pipe(Effect.provide(live)),
  );

  // 注入の値を読むのは broker だけである。addon はこのファイルの inject を
  // 検証するが中身を使わないので、地の文を置く理由がない。
  const stored = fsFake.store.get(`${p.authzDir}/sess-123.json`)
    ?.content as string;
  expect(stored).not.toContain("scope-secret-value");
  expect(stored).not.toContain("rule-secret-value");
  // 名前と参照は残る。承認 UI と監査がどのヘッダーがどの秘密で組まれるかを
  // 言えなくなってはならない。
  expect(stored).toContain("Authorization");
  expect(stored).toContain("X-Scope");
  expect(stored).toContain("gh-token");
});

test("removeAuthzDocument: deletes the session's document", async () => {
  const fsFake = makeFsServiceFake();
  const p = paths();
  const live = makeLiveLayer(fsFake);

  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      Effect.gen(function* () {
        yield* svc.writeAuthzDocument(p, "sess-123", documentWithScopes({}));
        yield* svc.removeAuthzDocument(p, "sess-123");
      }),
    ).pipe(Effect.provide(live)),
  );

  expect(fsFake.store.has(`${p.authzDir}/sess-123.json`)).toEqual(false);
});

test("removeAuthzDocument: a document that is already gone is not an error", async () => {
  const fsFake = makeFsServiceFake();
  const live = makeLiveLayer(fsFake);
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.removeAuthzDocument(paths(), "sess-absent"),
    ).pipe(Effect.provide(live)),
  );
  expect(exit._tag).toEqual("Success");
});

// ---------------------------------------------------------------------------
// resolveSecrets
// ---------------------------------------------------------------------------

test("resolveSecrets: resolves the registry by name via live layer", async () => {
  const fsFake = makeFsServiceFake();
  const live = makeLiveLayer(fsFake);
  const values = await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.resolveSecrets(
        { "api-token": { from: "env:MY_SECRET" } },
        { MY_SECRET: "s3cret-value" },
      ),
    ).pipe(Effect.provide(live)),
  );
  expect(values).toEqual({ "api-token": ["s3cret-value"] });
});

test("resolveSecrets: dies when a required secret is unavailable (fail-closed)", async () => {
  const fsFake = makeFsServiceFake();
  const live = makeLiveLayer(fsFake);
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(NetworkRuntimeService, (svc) =>
      svc.resolveSecrets({ "api-token": { from: "env:MISSING" } }, {}),
    ).pipe(Effect.provide(live)),
  );
  expect(exit._tag).toEqual("Failure");
  if (!Exit.isFailure(exit)) return;
  expect(Cause.isDieType(exit.cause)).toEqual(true);
});
