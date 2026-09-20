/**
 * NetworkRuntimeService unit tests.
 *
 * Most tests drive the Live service with a fake FsService layer so we
 * exercise the real branching logic without touching disk. The
 * copyAddonScript / computeAddonHash vendored-tree tests at the bottom use
 * FsServiceLive against tmp dirs, because the vendored asset tree only
 * exists on the real filesystem.
 */

import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import {
  documentWithScopes,
  resolvedDocument,
} from "../../network/authz/testing.ts";
import type { NetworkRuntimePaths } from "../../network/registry.ts";
import { FsServiceLive, makeFsServiceFake } from "../../services/fs.ts";
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

// ---------------------------------------------------------------------------
// copyAddonScript / computeAddonHash — vendored tree (real fs, tmp dirs)
// ---------------------------------------------------------------------------
//
// The vendored graphql-core lives on the real filesystem, so these tests run
// the Live service over FsServiceLive instead of the in-memory fake. A staged
// NAS_ASSET_DIR isolates each test from the repository tree where needed.

function realFsLiveLayer(): Layer.Layer<NetworkRuntimeService> {
  return NetworkRuntimeServiceLive.pipe(
    Layer.provide(Layer.mergeAll(FsServiceLive, SecretResolverServiceLive)),
  );
}

function tmpPaths(root: string): NetworkRuntimePaths {
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

async function runCopyAddonScript(p: NetworkRuntimePaths): Promise<void> {
  await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) => svc.copyAddonScript(p)).pipe(
      Effect.provide(realFsLiveLayer()),
    ),
  );
}

async function runComputeAddonHash(): Promise<string> {
  return await Effect.runPromise(
    Effect.flatMap(NetworkRuntimeService, (svc) => svc.computeAddonHash()).pipe(
      Effect.provide(realFsLiveLayer()),
    ),
  );
}

/** Point NAS_ASSET_DIR at `assetDir` (or delete it) until the body returns. */
async function withAssetDir<T>(
  assetDir: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const previous = process.env.NAS_ASSET_DIR;
  if (assetDir === undefined) delete process.env.NAS_ASSET_DIR;
  else process.env.NAS_ASSET_DIR = assetDir;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.NAS_ASSET_DIR;
    else process.env.NAS_ASSET_DIR = previous;
  }
}

/** A minimal asset tree: one addon file and a two-file vendored package. */
async function stageAssetDir(): Promise<string> {
  const assetDir = await mkdtemp(path.join(tmpdir(), "nas-assets-"));
  const mitmproxyDir = path.join(assetDir, "docker", "mitmproxy");
  await mkdir(path.join(mitmproxyDir, "vendor", "pkg", "sub"), {
    recursive: true,
  });
  await writeFile(path.join(mitmproxyDir, "nas_addon.py"), "# addon v1\n");
  await writeFile(
    path.join(mitmproxyDir, "vendor", "pkg", "__init__.py"),
    "PKG = 1\n",
  );
  await writeFile(
    path.join(mitmproxyDir, "vendor", "pkg", "sub", "mod.py"),
    "MOD = 1\n",
  );
  return assetDir;
}

test("copyAddonScript: stages the vendored tree next to the addon script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-runtime-"));
  try {
    // Resolve assets from the repository tree even when the suite runs inside
    // an installed nas session that exports NAS_ASSET_DIR.
    await withAssetDir(undefined, async () => {
      const p = tmpPaths(root);
      await runCopyAddonScript(p);

      const addon = await readFile(p.addonScriptPath, "utf8");
      expect(addon).toContain("mitmproxy addon");
      const vendoredVersion = await readFile(
        path.join(root, "vendor", "graphql", "version.py"),
        "utf8",
      );
      expect(vendoredVersion).toContain('version = "3.2.11"');
      // `bun run vendor` produces the `uv pip install --target` layout:
      // the package dir plus its dist-info. Assert on the stable parts
      // rather than the versioned dist-info name.
      const vendorEntries = await readdir(path.join(root, "vendor"));
      expect(vendorEntries).toContain(".hash");
      expect(vendorEntries).toContain("graphql");
      expect(vendorEntries.some((e) => e.endsWith(".dist-info"))).toBe(true);
      const sentinel = await readFile(
        path.join(root, "vendor", ".hash"),
        "utf8",
      );
      expect(sentinel).toMatch(/^[0-9a-f]{64}$/);

      // Bytecode caches build up under the source vendor/ once Python has
      // imported it; they must not leak into the runtime dir.
      const copiedFiles: string[] = [];
      const dirs = [path.join(root, "vendor")];
      for (let dir = dirs.pop(); dir !== undefined; dir = dirs.pop()) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) dirs.push(abs);
          else copiedFiles.push(abs);
        }
      }
      expect(
        copiedFiles.some(
          (f) => f.includes("__pycache__") || f.endsWith(".pyc"),
        ),
      ).toBe(false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copyAddonScript: the sentinel skips rebuilds and tracks the source hash", async () => {
  const assetDir = await stageAssetDir();
  const root = await mkdtemp(path.join(tmpdir(), "nas-runtime-"));
  const vendoredFile = path.join(root, "vendor", "pkg", "sub", "mod.py");
  const sourceFile = path.join(
    assetDir,
    "docker",
    "mitmproxy",
    "vendor",
    "pkg",
    "sub",
    "mod.py",
  );
  try {
    await withAssetDir(assetDir, async () => {
      const p = tmpPaths(root);
      await runCopyAddonScript(p);
      expect(await readFile(vendoredFile, "utf8")).toEqual("MOD = 1\n");

      // An unchanged source hash leaves the staged tree alone — including a
      // file that drifted after the copy. The sentinel records what was
      // copied, not what is there now.
      await writeFile(vendoredFile, "drifted\n");
      await runCopyAddonScript(p);
      expect(await readFile(vendoredFile, "utf8")).toEqual("drifted\n");

      // Once the source moves, the tree is rebuilt from scratch.
      await writeFile(sourceFile, "MOD = 2\n");
      await runCopyAddonScript(p);
      expect(await readFile(vendoredFile, "utf8")).toEqual("MOD = 2\n");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("computeAddonHash: a vendored file change moves the hash", async () => {
  const assetDir = await stageAssetDir();
  const vendoredFile = path.join(
    assetDir,
    "docker",
    "mitmproxy",
    "vendor",
    "pkg",
    "sub",
    "mod.py",
  );
  try {
    await withAssetDir(assetDir, async () => {
      const before = await runComputeAddonHash();
      await writeFile(vendoredFile, "MOD = 2\n");
      const after = await runComputeAddonHash();
      expect(after).toMatch(/^[0-9a-f]{64}$/);
      expect(after).not.toEqual(before);
    });
  } finally {
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("computeAddonHash: an addon script change also moves the hash", async () => {
  const assetDir = await stageAssetDir();
  try {
    await withAssetDir(assetDir, async () => {
      const before = await runComputeAddonHash();
      await writeFile(
        path.join(assetDir, "docker", "mitmproxy", "nas_addon.py"),
        "# addon v2\n",
      );
      expect(await runComputeAddonHash()).not.toEqual(before);
    });
  } finally {
    await rm(assetDir, { recursive: true, force: true });
  }
});

test("copyAddonScript: a missing vendor dir fails with the bootstrap command", async () => {
  // vendor/ is gitignored, so a fresh checkout has no vendored tree until
  // `bun run vendor` runs. Failing here is what keeps the addon from dying
  // on `import graphql` inside the proxy container instead.
  const assetDir = await mkdtemp(path.join(tmpdir(), "nas-assets-"));
  const root = await mkdtemp(path.join(tmpdir(), "nas-runtime-"));
  try {
    await mkdir(path.join(assetDir, "docker", "mitmproxy"), {
      recursive: true,
    });
    await writeFile(
      path.join(assetDir, "docker", "mitmproxy", "nas_addon.py"),
      "# addon\n",
    );
    const exit = await withAssetDir(assetDir, () =>
      Effect.runPromiseExit(
        Effect.flatMap(NetworkRuntimeService, (svc) =>
          svc.copyAddonScript(tmpPaths(root)),
        ).pipe(Effect.provide(realFsLiveLayer())),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("bun run vendor");
    }
  } finally {
    await rm(assetDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("computeAddonHash: an empty vendor dir fails instead of hashing nothing", async () => {
  const assetDir = await mkdtemp(path.join(tmpdir(), "nas-assets-"));
  try {
    await mkdir(path.join(assetDir, "docker", "mitmproxy", "vendor"), {
      recursive: true,
    });
    const exit = await withAssetDir(assetDir, () =>
      Effect.runPromiseExit(
        Effect.flatMap(NetworkRuntimeService, (svc) =>
          svc.computeAddonHash(),
        ).pipe(Effect.provide(realFsLiveLayer())),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain("bun run vendor");
    }
  } finally {
    await rm(assetDir, { recursive: true, force: true });
  }
});
