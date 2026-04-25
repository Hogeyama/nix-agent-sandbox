import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import type { NetworkRuntimePaths } from "../network/registry.ts";
import type { SessionRuntimePaths } from "../sessions/store.ts";
import type { UiDataContext } from "./data.ts";
import type { LaunchRequest } from "./launch.ts";
import {
  getLaunchBranches,
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
