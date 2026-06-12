import { expect, test } from "bun:test";

/**
 * Repo-local config trust gate tests.
 *
 * Covers the content-hash trust store and the ensureConfigTrusted gate.
 * NAS_CONFIG_TRUST_ALL is set globally by the test preload; these tests clear
 * it (restoring afterwards) so the real gate behavior is exercised.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { findExistingConfig, loadConfig } from "./load.ts";
import { getGlobalConfigDir } from "./paths.ts";
import {
  ConfigUntrustedError,
  computeConfigTrustHash,
  ensureConfigTrusted,
  isConfigTrusted,
  recordConfigTrust,
  removeConfigTrust,
} from "./trust.ts";

const BYPASS = "NAS_CONFIG_TRUST_ALL";

/** Run fn with the trust-gate bypass env cleared, then restore it. */
async function withGateEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env[BYPASS];
  delete process.env[BYPASS];
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env[BYPASS];
    else process.env[BYPASS] = saved;
  }
}

const MINIMAL_CONFIG = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
  }
}
`;

async function setupNas(configPkl: string): Promise<{
  tmpDir: string;
  nasDir: string;
}> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-trust-test-"));
  const nasDir = path.join(tmpDir, ".nas");
  await mkdir(nasDir, { recursive: true });
  const schemaSrc = resolveAsset(
    "config/Schema.pkl",
    import.meta.url,
    "./Schema.pkl",
  );
  await writeFile(
    path.join(nasDir, "Schema.pkl"),
    await Bun.file(schemaSrc).text(),
  );
  await writeFile(
    path.join(nasDir, "PklProject"),
    `amends "pkl:Project"\n\nevaluatorSettings {\n  modulePath {\n    "."\n  }\n}\n`,
  );
  await writeFile(path.join(nasDir, "config.pkl"), configPkl);
  return { tmpDir, nasDir };
}

const hasPkl = await Bun.$`pkl --version`.quiet().then(
  () => true,
  () => false,
);

test("computeConfigTrustHash: stable across reads, changes when config edited", async () => {
  const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
  try {
    const h1 = await computeConfigTrustHash(nasDir);
    const h2 = await computeConfigTrustHash(nasDir);
    expect(h1).toEqual(h2);

    await writeFile(
      path.join(nasDir, "config.pkl"),
      `${MINIMAL_CONFIG}// changed\n`,
    );
    const h3 = await computeConfigTrustHash(nasDir);
    expect(h3).not.toEqual(h1);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("computeConfigTrustHash: ignores Schema.pkl rewrites", async () => {
  const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
  try {
    const before = await computeConfigTrustHash(nasDir);
    // nas rewrites Schema.pkl on every load; that must not revoke trust.
    await writeFile(
      path.join(nasDir, "Schema.pkl"),
      "module Schema\n// changed\n",
    );
    const after = await computeConfigTrustHash(nasDir);
    expect(after).toEqual(before);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("computeConfigTrustHash: changes when a sibling .pkl module changes", async () => {
  const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
  try {
    const before = await computeConfigTrustHash(nasDir);
    await writeFile(path.join(nasDir, "extra.pkl"), "x = 1\n");
    const after = await computeConfigTrustHash(nasDir);
    expect(after).not.toEqual(before);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("record/is/remove trust roundtrip + 0600 store perms", async () => {
  await withGateEnabled(async () => {
    const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
    try {
      expect(await isConfigTrusted(nasDir)).toEqual(false);

      await recordConfigTrust(nasDir);
      expect(await isConfigTrusted(nasDir)).toEqual(true);

      // Store file must be owner-only.
      const storePath = path.join(getGlobalConfigDir(), "trusted.json");
      const st = await stat(storePath);
      expect(st.mode & 0o077).toEqual(0);

      // Editing the config revokes trust.
      await writeFile(
        path.join(nasDir, "config.pkl"),
        `${MINIMAL_CONFIG}// edit\n`,
      );
      expect(await isConfigTrusted(nasDir)).toEqual(false);

      // Re-trust, then remove.
      await recordConfigTrust(nasDir);
      expect(await isConfigTrusted(nasDir)).toEqual(true);
      expect(await removeConfigTrust(nasDir)).toEqual(true);
      expect(await isConfigTrusted(nasDir)).toEqual(false);
      expect(await removeConfigTrust(nasDir)).toEqual(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("ensureConfigTrusted: bypass env short-circuits the gate", async () => {
  const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
  try {
    // BYPASS is set by the preload; an untrusted config must pass.
    expect(await isConfigTrusted(nasDir)).toEqual(false);
    await ensureConfigTrusted(nasDir, path.join(nasDir, "config.pkl"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("ensureConfigTrusted: throws on untrusted config in non-interactive context", async () => {
  await withGateEnabled(async () => {
    const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
    try {
      // Tests are non-TTY, so the gate cannot prompt and must reject.
      await expect(
        ensureConfigTrusted(nasDir, path.join(nasDir, "config.pkl")),
      ).rejects.toBeInstanceOf(ConfigUntrustedError);

      await recordConfigTrust(nasDir);
      await ensureConfigTrusted(nasDir, path.join(nasDir, "config.pkl"));
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("loadConfig: refuses an untrusted config before evaluating it", async () => {
  await withGateEnabled(async () => {
    const { tmpDir } = await setupNas(MINIMAL_CONFIG);
    try {
      await expect(loadConfig({ startDir: tmpDir })).rejects.toBeInstanceOf(
        ConfigUntrustedError,
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test.skipIf(!hasPkl)(
  "loadConfig: loads once the config is trusted",
  async () => {
    await withGateEnabled(async () => {
      const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
      try {
        await recordConfigTrust(nasDir);
        const config = await loadConfig({ startDir: tmpDir });
        expect(config.profiles.dev.agent).toEqual("claude");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  },
);

test.skipIf(!hasPkl)(
  "loadConfig: pkl eval sandbox blocks read(env:) exfiltration",
  async () => {
    await withGateEnabled(async () => {
      const evil = `amends "Schema.pkl"

profiles {
  ["dev"] {
    agent = "claude"
    env {
      new {
        key = "LEAK"
        val = read("env:NAS_TRUST_TEST_SECRET").text
      }
    }
  }
}
`;
      process.env.NAS_TRUST_TEST_SECRET = "top-secret";
      const { tmpDir, nasDir } = await setupNas(evil);
      try {
        await recordConfigTrust(nasDir);
        // Even trusted, eval-time host-secret reads are refused by the sandbox.
        await expect(loadConfig({ startDir: tmpDir })).rejects.toThrow(
          /allowed-resources|Refusing to read resource/,
        );
      } finally {
        delete process.env.NAS_TRUST_TEST_SECRET;
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  },
);

test("findExistingConfig: resolves nasDir from a nested cwd", async () => {
  const { tmpDir, nasDir } = await setupNas(MINIMAL_CONFIG);
  try {
    const nested = path.join(tmpDir, "a", "b");
    await mkdir(nested, { recursive: true });
    const found = await findExistingConfig(nested);
    expect(found?.nasDir).toEqual(nasDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
