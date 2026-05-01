import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
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
    authRouterSocket: "/tmp/nas-launch-test-unused/network/auth-router.sock",
    authRouterPidFile: "/tmp/nas-launch-test-unused/network/auth-router.pid",
    envoyConfigFile: "/tmp/nas-launch-test-unused/network/envoy.yaml",
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
  test("65-char name throws 'Invalid session name'", () => {
    const longName = "a".repeat(65);
    expect(
      launchSession(dummyCtx, { ...validReq, name: longName }),
    ).rejects.toThrow("Invalid session name");
  });

  test("special characters throw 'Invalid session name'", () => {
    expect(
      launchSession(dummyCtx, { ...validReq, name: "my session!" }),
    ).rejects.toThrow("Invalid session name");
  });

  test("valid names pass validation", async () => {
    for (const name of ["my-session", "test_1"]) {
      await expectNoValidationError(
        { ...validReq, name },
        "Invalid session name",
      );
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

  async function writeGlobalYml(yaml: string): Promise<void> {
    const nasDir = path.join(xdgDir, "nas");
    await mkdir(nasDir, { recursive: true });
    await writeFile(path.join(nasDir, "agent-sandbox.yml"), yaml);
  }

  async function writeLocalYml(dir: string, yaml: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, ".agent-sandbox.yml"), yaml);
  }

  test("引数なし呼び出しは process.cwd() 起点で loadConfig() を呼ぶ", async () => {
    // 引数なし呼び出しは loadConfig() (= process.cwd() 起点) を使う。
    // process.cwd() に依存する具体値は環境依存なので assert せず、
    // 「引数なし / 空 opts / cwd undefined はすべて同一結果」というシグネチャ互換を pin する。
    await writeGlobalYml(`default: g\nprofiles:\n  g:\n    agent: claude\n`);
    const a = await getLaunchInfo(dummyCtx);
    const b = await getLaunchInfo(dummyCtx, {});
    const c = await getLaunchInfo(dummyCtx, { cwd: undefined });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  test("opts.cwd が指定された場合、その cwd 配下の local config を読む", async () => {
    const dirA = path.join(testRoot, "projA");
    const dirB = path.join(testRoot, "projB");
    await writeLocalYml(
      dirA,
      `default: a\nprofiles:\n  a:\n    agent: claude\n`,
    );
    await writeLocalYml(
      dirB,
      `default: b\nprofiles:\n  b:\n    agent: claude\n`,
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
    // 空文字は未指定と同じパス (loadConfig() = process.cwd() 起点) を辿るはず。
    // 環境依存の値を直接 assert するのではなく、cwd 未指定の結果と同一であることを pin する。
    await writeGlobalYml(`default: g\nprofiles:\n  g:\n    agent: claude\n`);
    const infoEmpty = await getLaunchInfo(dummyCtx, { cwd: "" });
    const infoUndef = await getLaunchInfo(dummyCtx);
    expect(infoEmpty.profiles).toEqual(infoUndef.profiles);
    expect(infoEmpty.defaultProfile).toEqual(infoUndef.defaultProfile);
  });

  test("opts.cwd 配下に local 無し + global あり の場合は throw しない (global の profiles が見える)", async () => {
    await writeGlobalYml(`default: g\nprofiles:\n  g:\n    agent: claude\n`);
    const emptyDir = path.join(testRoot, "no-config-here");
    await mkdir(emptyDir, { recursive: true });

    const info = await getLaunchInfo(dummyCtx, { cwd: emptyDir });
    expect(info.profiles).toContain("g");
    expect(info.defaultProfile).toEqual("g");
  });

  test("opts.cwd 配下に local 無し + global も無し の場合は loadConfig が throw する", () => {
    // beforeEach で xdgDir は空。global ymlは書かない。
    const emptyDir = path.join(testRoot, "no-config-anywhere");
    // mkdir 同期は不要 — loadConfig は startDir を path.resolve して上方向に走査するだけで stat は ENOENT を catch するので存在しなくても問題ないが、念のためテスト前提を明確化するため mkdir する
    expect(
      (async () => {
        await mkdir(emptyDir, { recursive: true });
        return getLaunchInfo(dummyCtx, { cwd: emptyDir });
      })(),
    ).rejects.toThrow(/not found/);
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
