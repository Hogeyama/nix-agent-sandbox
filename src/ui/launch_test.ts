import { describe, expect, test } from "bun:test";
import type { LaunchRequest } from "./launch.ts";
import { LaunchValidationError, launchSession } from "./launch.ts";

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
 * Assert that `launchSession(req)` does NOT throw a LaunchValidationError
 * with the given message.  The promise may resolve (dtach present) or reject
 * with a different error (dtach absent) — both are fine.
 */
async function expectNoValidationError(
  req: LaunchRequest,
  forbiddenMessage: string,
): Promise<void> {
  try {
    await launchSession(req);
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
    expect(launchSession({ ...validReq, profile: "" })).rejects.toThrow(
      "Invalid profile name",
    );
  });

  test("undefined-ish (empty after cast) throws 'Invalid profile name'", () => {
    expect(
      launchSession({ profile: undefined as unknown as string }),
    ).rejects.toThrow("Invalid profile name");
  });

  test("shell meta-characters throw 'Invalid profile name'", () => {
    expect(
      launchSession({ ...validReq, profile: "my;profile" }),
    ).rejects.toThrow("Invalid profile name");
  });

  test("spaces throw 'Invalid profile name'", () => {
    expect(
      launchSession({ ...validReq, profile: "my profile" }),
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
      launchSession({ ...validReq, worktreeBase: "main;rm" }),
    ).rejects.toThrow("Invalid worktree base branch");
  });

  test("path traversal (..) throws 'Invalid worktree base branch'", () => {
    expect(
      launchSession({ ...validReq, worktreeBase: "../../etc" }),
    ).rejects.toThrow("Invalid worktree base branch");
  });

  test("spaces throw 'Invalid worktree base branch'", () => {
    expect(
      launchSession({ ...validReq, worktreeBase: "my branch" }),
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
    expect(launchSession({ ...validReq, name: longName })).rejects.toThrow(
      "Invalid session name",
    );
  });

  test("special characters throw 'Invalid session name'", () => {
    expect(launchSession({ ...validReq, name: "my session!" })).rejects.toThrow(
      "Invalid session name",
    );
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
    expect(launchSession({ ...validReq, cwd: "./relative" })).rejects.toThrow(
      "Invalid cwd: must be an absolute path",
    );
  });

  test("path with .. throws 'path contains disallowed segments'", () => {
    expect(launchSession({ ...validReq, cwd: "/foo/../bar" })).rejects.toThrow(
      "Invalid cwd: path contains disallowed segments",
    );
  });

  test("valid absolute path passes validation", async () => {
    await expectNoValidationError(
      { ...validReq, cwd: "/home/user/project" },
      "Invalid cwd",
    );
  });
});
