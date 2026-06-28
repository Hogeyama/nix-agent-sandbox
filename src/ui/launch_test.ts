import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import { resolveAsset } from "../lib/asset.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import type { UiDataContext } from "./data.ts";
import type { LaunchRequest } from "./launch.ts";
import {
  getLaunchBranches,
  getLaunchInfo,
  LaunchValidationError,
  launchSession,
  resolveStableNasCommand,
} from "./launch.ts";

/**
 * Tests for launchSession() input validation.
 *
 * Validation runs before the dtach availability check, so validation-failure
 * cases never need dtach.  For inputs that *pass* validation the function
 * proceeds to the dtach check or actual launch; we verify the rejection is
 * NOT an input validation error (it may be "dtach is not available" or
 * the call may succeed).
 */

// Helper: a valid base request that passes all validation.
const validReq: LaunchRequest = { profile: "default" };

/**
 * Minimal dummy UiDataContext for launchSession tests.
 * `launchSession` only reads `terminalRuntimeDir` when it proceeds past
 * validation + dtach availability; the other paths are unused here.
 */
function createDummyCtx(): UiDataContext {
  const networkPaths: NetworkRuntimePaths = {
    runtimeDir: "/tmp/nas-launch-test-unused/network",
    sessionsDir: "/tmp/nas-launch-test-unused/network/sessions",
    pendingDir: "/tmp/nas-launch-test-unused/network/pending",
    brokersDir: "/tmp/nas-launch-test-unused/network/brokers",
    caCertDir: "/tmp/nas-launch-test-unused/network/mitmproxy-ca",
    addonScriptPath: "/tmp/nas-launch-test-unused/network/nas_addon.py",
    reviewRulesDir: "/tmp/nas-launch-test-unused/network/review-rules",
  };
  const hostExecPaths: HostExecRuntimePaths = {
    runtimeDir: "/tmp/nas-launch-test-unused/hostexec",
    sessionsDir: "/tmp/nas-launch-test-unused/hostexec/sessions",
    pendingDir: "/tmp/nas-launch-test-unused/hostexec/pending",
    brokersDir: "/tmp/nas-launch-test-unused/hostexec/brokers",
    wrappersDir: "/tmp/nas-launch-test-unused/hostexec/wrappers",
  };
  const sessionPaths: SessionRuntimePaths = {
    runtimeDir: "/tmp/nas-launch-test-unused/sessions-root",
    sessionsDir: "/tmp/nas-launch-test-unused/sessions-root/sessions",
  };
  return {
    networkPaths,
    hostExecPaths,
    sessionPaths,
    auditDir: "/tmp/nas-launch-test-unused/audit",
    terminalRuntimeDir: "/tmp/nas-launch-test-unused/dtach",
    historyDbPath: "/tmp/nas-launch-test-unused/history.db",
    history: {
      readConversationList: () => [],
      readConversationDetail: () => null,
      readInvocationDetail: () => null,
      readModelTokenTotals: () => [],
      readConversationModelTokenTotals: () => [],
      readConversationModelTokenTotalsByConversationIds: () => ({}),
    },
    pricing: {
      getSnapshot: async () => ({
        fetched_at: "2026-05-02T00:00:00.000Z",
        source: "unavailable",
        stale: true,
        models: {},
      }),
    },
  };
}

const dummyCtx = createDummyCtx();

/**
 * Assert that `launchSession(ctx, req)` does NOT throw a LaunchValidationError
 * with the given message.  The promise may resolve (dtach present) or reject
 * with a different error (dtach absent) — both are fine.
 */
async function expectNoValidationError(
  req: LaunchRequest,
  forbiddenMessage: string,
): Promise<void> {
  try {
    await launchSession(dummyCtx, req);
    // resolved — validation passed, dtach was available and launch succeeded
  } catch (err: unknown) {
    if (
      err instanceof LaunchValidationError &&
      err.message === forbiddenMessage
    ) {
      throw new Error(
        `Expected validation to pass, but got LaunchValidationError: ${err.message}`,
      );
    }
    // Other errors (e.g. "dtach is not available") are acceptable
  }
}

// ---------------------------------------------------------------------------
// profile validation
// ---------------------------------------------------------------------------

describe("launchSession: profile validation", () => {
  test("empty string throws 'Invalid profile name'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, profile: "" }),
    ).rejects.toThrow("Invalid profile name");
  });

  test("undefined-ish (empty after cast) throws 'Invalid profile name'", () => {
    expect(
      launchSession(dummyCtx, { profile: undefined as unknown as string }),
    ).rejects.toThrow("Invalid profile name");
  });

  test("shell meta-characters throw 'Invalid profile name'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, profile: "my;profile" }),
    ).rejects.toThrow("Invalid profile name");
  });

  test("spaces throw 'Invalid profile name'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, profile: "my profile" }),
    ).rejects.toThrow("Invalid profile name");
  });

  test("valid profile names pass validation", async () => {
    for (const name of ["my-profile", "profile_1"]) {
      await expectNoValidationError(
        { ...validReq, profile: name },
        "Invalid profile name",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// worktreeBase validation
// ---------------------------------------------------------------------------

describe("launchSession: worktreeBase validation", () => {
  test("shell meta-characters throw 'Invalid worktree base branch'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, worktreeBase: "main;rm" }),
    ).rejects.toThrow("Invalid worktree base branch");
  });

  test("path traversal (..) throws 'Invalid worktree base branch'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, worktreeBase: "../../etc" }),
    ).rejects.toThrow("Invalid worktree base branch");
  });

  test("spaces throw 'Invalid worktree base branch'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, worktreeBase: "my branch" }),
    ).rejects.toThrow("Invalid worktree base branch");
  });

  test("valid branch names pass validation", async () => {
    for (const branch of ["main", "feature/foo", "origin/main"]) {
      await expectNoValidationError(
        { ...validReq, worktreeBase: branch },
        "Invalid worktree base branch",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// name validation
// ---------------------------------------------------------------------------

describe("launchSession: name validation", () => {
  test("201-char name throws validation error", () => {
    const longName = "a".repeat(201);
    expect(
      launchSession(dummyCtx, { ...validReq, name: longName }),
    ).rejects.toThrow("Session name must be 200 characters or fewer");
  });

  test("200-char name passes validation", async () => {
    await expectNoValidationError(
      { ...validReq, name: "a".repeat(200) },
      "Session name must be 200 characters or fewer",
    );
  });

  test("control characters are stripped", async () => {
    // Name with only control chars becomes empty → treated as undefined (no error)
    await expectNoValidationError(
      { ...validReq, name: "\x01\x02\x03" },
      "Session name",
    );
  });

  test("valid names pass validation", async () => {
    for (const name of [
      "my-session",
      "test_1",
      "my session",
      "テスト",
      "v1.0-fix",
      "hello world!",
    ]) {
      await expectNoValidationError({ ...validReq, name }, "Session name");
    }
  });
});

// ---------------------------------------------------------------------------
// cwd validation
// ---------------------------------------------------------------------------

describe("launchSession: cwd validation", () => {
  test("relative path throws 'must be an absolute path'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, cwd: "./relative" }),
    ).rejects.toThrow("Invalid cwd: must be an absolute path");
  });

  test("path with .. throws 'path contains disallowed segments'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, cwd: "/foo/../bar" }),
    ).rejects.toThrow("Invalid cwd: path contains disallowed segments");
  });

  test("valid absolute path passes validation", async () => {
    await expectNoValidationError(
      { ...validReq, cwd: "/home/user/project" },
      "Invalid cwd",
    );
  });
});

// ---------------------------------------------------------------------------
// getLaunchBranches
// ---------------------------------------------------------------------------

describe("getLaunchBranches", () => {
  test("empty cwd rejects with LaunchValidationError", () => {
    expect(getLaunchBranches("")).rejects.toThrow(LaunchValidationError);
  });

  test("non-absolute cwd rejects with LaunchValidationError", () => {
    expect(getLaunchBranches("relative/path")).rejects.toThrow(
      LaunchValidationError,
    );
  });

  test("non-git directory resolves to null/false", async () => {
    const result = await getLaunchBranches(tmpdir());
    expect(result).toEqual({ currentBranch: null, hasMain: false });
  });

  test("git repo cwd returns string-or-null branch and boolean hasMain", async () => {
    const result = await getLaunchBranches(process.cwd());
    expect(
      typeof result.currentBranch === "string" || result.currentBranch === null,
    ).toEqual(true);
    expect(typeof result.hasMain).toEqual("boolean");
  });
});

// ---------------------------------------------------------------------------
// getLaunchInfo
// ---------------------------------------------------------------------------

/**
 * getLaunchInfo は loadConfig を呼ぶため、global config (~/.config/nas) の
 * 影響を受ける。テスト中は XDG_CONFIG_HOME を空ディレクトリに差し替えて、
 * global の有無を明示的に制御する。
 */
describe("getLaunchInfo", () => {
  let testRoot: string;
  let xdgDir: string;
  let originalXdg: string | undefined;

  beforeEach(async () => {
    testRoot = await mkdtemp(path.join(tmpdir(), "nas-launchinfo-"));
    xdgDir = path.join(testRoot, "xdg");
    await mkdir(xdgDir, { recursive: true });
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdgDir;
  });

  afterEach(async () => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    await rm(testRoot, { recursive: true, force: true });
  });

  /** Read bundled Schema.pkl text for test setup. */
  async function readBundledSchema(): Promise<string> {
    const schemaSrc = resolveAsset(
      "config/Schema.pkl",
      import.meta.url,
      "../config/Schema.pkl",
    );
    return readFile(schemaSrc, "utf8");
  }

  /** Set up a .nas/ directory with config.pkl, Schema.pkl, and PklProject. */
  async function writeLocalNasConfig(dir: string, pkl: string): Promise<void> {
    const nasDir = path.join(dir, ".nas");
    await mkdir(nasDir, { recursive: true });
    const schemaText = await readBundledSchema();
    await writeFile(path.join(nasDir, "Schema.pkl"), schemaText);
    await writeFile(
      path.join(nasDir, "PklProject"),
      `amends "pkl:Project"\nevaluatorSettings { modulePath { "." } }\n`,
    );
    await writeFile(
      path.join(nasDir, "config.pkl"),
      `amends "Schema.pkl"\n${pkl}`,
    );
  }

  test("引数なし呼び出しは process.cwd() 起点で loadConfig() を呼ぶ", async () => {
    // 引数なし / 空 opts / cwd undefined はすべて同一の profiles を返すことを pin する。
    const extract = (p: Promise<{ profiles: string[] }>) =>
      p.then(
        (v) => v.profiles,
        (e: Error) => `ERR:${e.constructor.name}`,
      );
    const a = extract(getLaunchInfo(dummyCtx));
    const b = extract(getLaunchInfo(dummyCtx, {}));
    const c = extract(getLaunchInfo(dummyCtx, { cwd: undefined }));
    expect(await a).toEqual(await b);
    expect(await a).toEqual(await c);
  });

  test("opts.cwd が指定された場合、その cwd 配下の local config を読む", async () => {
    const dirA = path.join(testRoot, "projA");
    const dirB = path.join(testRoot, "projB");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeLocalNasConfig(
      dirA,
      `default = "a"\nprofiles {\n  ["a"] {\n    agent = "claude"\n  }\n}\n`,
    );
    await writeLocalNasConfig(
      dirB,
      `default = "b"\nprofiles {\n  ["b"] {\n    agent = "claude"\n  }\n}\n`,
    );

    const infoA = await getLaunchInfo(dummyCtx, { cwd: dirA });
    expect(infoA.profiles).toEqual(["a"]);
    expect(infoA.defaultProfile).toEqual("a");

    const infoB = await getLaunchInfo(dummyCtx, { cwd: dirB });
    expect(infoB.profiles).toEqual(["b"]);
    expect(infoB.defaultProfile).toEqual("b");
  });

  test("opts.cwd が相対パスの場合 LaunchValidationError を throw する", () => {
    expect(getLaunchInfo(dummyCtx, { cwd: "relative" })).rejects.toThrow(
      LaunchValidationError,
    );
  });

  test("opts.cwd が空文字の場合は未指定と同等 (cwd 未指定の結果と一致)", async () => {
    const extract = (p: Promise<{ profiles: string[] }>) =>
      p.then(
        (v) => v.profiles,
        (e: Error) => `ERR:${e.constructor.name}`,
      );
    const infoEmpty = extract(getLaunchInfo(dummyCtx, { cwd: "" }));
    const infoUndef = extract(getLaunchInfo(dummyCtx));
    expect(await infoEmpty).toEqual(await infoUndef);
  });

  test("opts.cwd 配下に .nas/config.pkl 無しの場合は auto-init でデフォルト設定を返す", async () => {
    const emptyDir = path.join(testRoot, "no-config-anywhere");
    await mkdir(emptyDir, { recursive: true });
    const info = await getLaunchInfo(dummyCtx, { cwd: emptyDir });
    expect(info.profiles).toContain("default");
  });
});

describe("resolveStableNasCommand", () => {
  test("NAS_BIN_PATH があればそれを優先する", () => {
    expect(
      resolveStableNasCommand(
        { NAS_BIN_PATH: "/opt/nas/bin/nas" },
        "/nix/store/bun/bin/bun",
        ["/nix/store/bun/bin/bun", "/repo/main.ts", "ui"],
      ),
    ).toEqual({
      nasBin: "/opt/nas/bin/nas",
      nasArgs: [],
    });
  });

  test("bun main.ts 経由で起動している場合は script path を再利用する", () => {
    expect(
      resolveStableNasCommand({}, "/nix/store/bun/bin/bun", [
        "/nix/store/bun/bin/bun",
        "/repo/main.ts",
        "ui",
        "--port",
        "3939",
      ]),
    ).toEqual({
      nasBin: "/nix/store/bun/bin/bun",
      nasArgs: ["/repo/main.ts"],
    });
  });

  test("compiled binary では execPath 単体を使う", () => {
    expect(
      resolveStableNasCommand({}, "/home/user/bin/nas", [
        "/home/user/bin/nas",
        "ui",
      ]),
    ).toEqual({
      nasBin: "/home/user/bin/nas",
      nasArgs: [],
    });
  });
});
