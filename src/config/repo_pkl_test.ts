import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveAsset } from "../lib/asset.ts";
import { decide, resolveAuthzConfig } from "../network/authz/resolve.ts";
import type { JsonValue } from "../network/authz/types.ts";
import { loadConfig } from "./load.ts";
import { useRepoSchemaAsset } from "./schema_asset_testing.ts";

let restoreSchemaAsset: (() => Promise<void>) | undefined;

beforeAll(async () => {
  restoreSchemaAsset = await useRepoSchemaAsset();
});

afterAll(async () => {
  await restoreSchemaAsset?.();
});

async function pklAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pkl", "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

const hasPkl = await pklAvailable();

test.skipIf(!hasPkl)(
  "repository config routes OpenAI Responses by the stream flag",
  async () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const config = await loadConfig({ startDir: repoRoot });
    const profile = config.profiles.codex;
    const resolved = resolveAuthzConfig(profile);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.document).not.toBeNull();

    const decideStream = (value: JsonValue) =>
      decide(
        resolved.document!,
        { host: "api.openai.com", port: 443 },
        {
          method: "POST",
          path: "/v1/responses",
          body: { kind: "json", value },
        },
      );

    expect(decideStream({ stream: false })).toMatchObject({
      action: "allow",
      ruleId: "openai-responses.non-streaming",
      reason: "rule",
    });
    expect(decideStream({ stream: true })).toMatchObject({
      action: "review",
      ruleId: "openai-responses.streaming",
      reason: "rule",
    });
    expect(decideStream({})).toMatchObject({
      action: "review",
      ruleId: "openai-responses.$fallback",
      reason: "scope-fallback",
    });
    expect(decideStream({ stream: {} })).toMatchObject({
      action: "deny",
      ruleId: "openai-responses.streaming",
      reason: "indeterminate",
    });
  },
);

test.skipIf(!hasPkl)(
  "repository default Claude profile masks through the fail-closed Anthropic preset",
  async () => {
    const repoRoot = path.resolve(import.meta.dir, "../..");
    const config = await loadConfig({ startDir: repoRoot });
    expect(config.default).toBe("claude");

    const profile = config.profiles.claude;
    expect(profile.mask).toBeDefined();
    expect(profile.mask!.proxy).toBe(true);
    expect(profile.mask!.apply).toContain("workspace-demo");
    expect(config.profiles["claude-remote"].network).toEqual(profile.network);
    expect(config.profiles["claude-remote"].mask).toEqual(profile.mask);

    const resolved = resolveAuthzConfig(profile);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.document).not.toBeNull();

    const messages = decide(
      resolved.document!,
      { host: "api.anthropic.com", port: 443 },
      {
        method: "POST",
        path: "/v1/messages",
        body: {
          kind: "json",
          value: {
            model: "claude-opus-4-8",
            messages: [
              { role: "user", content: [{ type: "text", text: "hello" }] },
            ],
          },
        },
      },
    );
    expect(messages).toMatchObject({
      action: "allow",
      ruleId: "anthropic.messages",
      reason: "rule",
      secrets: { "*": "mask" },
    });

    expect(
      decide(
        resolved.document!,
        { host: "api.anthropic.com", port: 443 },
        {
          method: "POST",
          path: "/v1/files",
          body: { kind: "json", value: {} },
        },
      ),
    ).toMatchObject({
      action: "deny",
      ruleId: "anthropic.$fallback",
      reason: "scope-fallback",
    });

    expect(
      decide(
        resolved.document!,
        { host: "api.anthropic.com", port: 443 },
        {
          method: "POST",
          path: "/v1/messages",
          body: { kind: "binary" },
        },
      ),
    ).toMatchObject({
      action: "deny",
      ruleId: "anthropic.messages",
      reason: "indeterminate",
    });
  },
);

/** バンドルされた Schema.pkl のテキストを読み込む */
async function readBundledSchema(): Promise<string> {
  const schemaSrc = resolveAsset(
    "config/Schema.pkl",
    import.meta.url,
    "./Schema.pkl",
  );
  return readFile(schemaSrc, "utf8");
}

/**
 * .nas/ 構造をセットアップする。
 */
async function setupNasDir(
  parentDir: string,
  configPkl: string,
): Promise<string> {
  const nasDir = path.join(parentDir, ".nas");
  await mkdir(nasDir, { recursive: true });

  const schemaText = await readBundledSchema();
  await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);

  const pklProject = `amends "pkl:Project"

evaluatorSettings {
  modulePath {
    "."
  }
}
`;
  await writeFile(path.join(nasDir, "PklProject"), pklProject);
  await writeFile(path.join(nasDir, "config.pkl"), configPkl);
  return nasDir;
}

test.skipIf(!hasPkl)(
  "a retired name inside a string literal does not block startup",
  async () => {
    // 廃止したのは識別子であって語ではない。パスやホスト名にたまたま同じ綴りが
    // 現れる設定は、移行の対象ではないので動かなければならない。
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-repo-pkl-legacy-"));
    try {
      await setupNasDir(
        tmpDir,
        `amends "Schema.pkl"

profiles {
  ["claude"] {
    agent = "claude"
    network {
      scopes {
        ["vault"] {
          targets { "credentials.example.com" }
          rules {
            ["read"] {
              match { paths { "/v1/credentials/**" } }
              onMatch = "allow"
            }
          }
        }
      }
    }
  }
}
`,
      );

      const config = await loadConfig({ startDir: tmpDir });
      expect(Object.keys(config.profiles.claude.network.scopes)).toEqual([
        "vault",
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(!hasPkl)(
  "Schema.pkl loads with all profile features via .nas/ project-dir",
  async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "nas-repo-pkl-test-"));
    try {
      await setupNasDir(
        tmpDir,
        `amends "Schema.pkl"

local baseProfile: Profile = new {
  agent = "claude"
  session { multiplex = true }
  nix { extraPackages { "nixpkgs#gh" } }
}

profiles {
  ["claude"] = (baseProfile) {}
  ["copilot"] = (baseProfile) { agent = "copilot" }
  ["codex"] = (baseProfile) { agent = "codex" }
  ["hostexec-demo"] = (baseProfile) {
    hostexec = new HostExecConfig {
      rules {
        new {
          id = "gh-cli"
          match { argv0 = "gh" }
        }
      }
    }
  }
}
`,
      );

      const config = await loadConfig({ startDir: tmpDir });
      expect(Object.keys(config.profiles)).toEqual(
        expect.arrayContaining(["claude", "copilot", "codex", "hostexec-demo"]),
      );
      expect(config.profiles.claude.agent).toBe("claude");
      expect(config.profiles["hostexec-demo"].agent).toBe("claude");
      expect(config.profiles["hostexec-demo"].nix.enable).toBe("auto");
      expect(config.profiles["hostexec-demo"].session.multiplex).toBe(true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  },
);
