import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { LockContendedError } from "../lib/oauth_refresh_lock.ts";
import {
  CLAUDE_CODE_CLIENT_ID,
  ClaudeOAuthCredentialSource,
  type ClaudeOAuthSourceDeps,
  type ClaudeRefreshRequest,
  liveClaudeOAuthSourceDeps,
  parseRefreshResponse,
} from "./claude_oauth_source.ts";

const MIN = 60_000;

function credentials(access: string, refresh: string, expiresAt: number) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      scopes: ["user:inference"],
    },
  });
}

interface FakeState {
  file: string;
  now: number;
  writes: string[];
  refreshes: ClaudeRefreshRequest[];
  scheduled: { fn: () => void; delayMs: number }[];
  lockFailures: number;
  refreshError?: Error;
  onLockAttempt?: () => void;
  lockCompromised?: boolean;
  warnings: string[];
  readCredentialsCalls: number;
  writeFailures: number;
  writeCredentialsCalls: number;
  releaseError?: Error;
  acquireLockError?: Error;
}

function fakeDeps(state: FakeState): ClaudeOAuthSourceDeps {
  return {
    readCredentials: async () => {
      state.readCredentialsCalls++;
      return state.file;
    },
    writeCredentials: async (text) => {
      state.writeCredentialsCalls++;
      if (state.writeFailures > 0) {
        state.writeFailures--;
        throw new Error("failed to write the credentials file");
      }
      state.writes.push(text);
      state.file = text;
    },
    acquireLock: async () => {
      state.onLockAttempt?.();
      if (state.acquireLockError) throw state.acquireLockError;
      if (state.lockFailures > 0) {
        state.lockFailures--;
        throw new LockContendedError("/lock");
      }
      return {
        release: async () => {
          if (state.releaseError) throw state.releaseError;
        },
        isCompromised: () => state.lockCompromised ?? false,
      };
    },
    refresh: async (request) => {
      state.refreshes.push(request);
      if (state.refreshError) throw state.refreshError;
      return {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAt: state.now + 60 * MIN,
      };
    },
    now: () => state.now,
    sleep: async () => {},
    schedule: (fn, delayMs) => {
      state.scheduled.push({ fn, delayMs });
      return () => {};
    },
    log: (message) => {
      state.warnings.push(message);
    },
  };
}

function initial(overrides: Partial<FakeState> = {}): FakeState {
  return {
    file: credentials("access-1", "refresh-1", 60 * MIN),
    now: 0,
    writes: [],
    refreshes: [],
    scheduled: [],
    lockFailures: 0,
    warnings: [],
    readCredentialsCalls: 0,
    writeFailures: 0,
    writeCredentialsCalls: 0,
    ...overrides,
  };
}

test("open: serves the host access token and schedules a refresh 5 minutes before expiry", async () => {
  const state = initial();
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(55 * MIN);
});

test("open: fails when the host has no OAuth tokens", async () => {
  const state = initial({ file: "{}" });
  await expect(
    ClaudeOAuthCredentialSource.open(fakeDeps(state)),
  ).rejects.toThrow(/claude \/login/);
});

test("open: reports missing credentials with the login guidance when the file doesn't exist", async () => {
  const state = initial();
  const enoent = Object.assign(new Error("no such file or directory"), {
    code: "ENOENT",
  });
  await expect(
    ClaudeOAuthCredentialSource.open({
      ...fakeDeps(state),
      readCredentials: async () => {
        throw enoent;
      },
    }),
  ).rejects.toThrow(/claude \/login/);
});

test("open: rethrows a non-ENOENT readCredentials failure unchanged", async () => {
  const state = initial();
  const eacces = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });
  await expect(
    ClaudeOAuthCredentialSource.open({
      ...fakeDeps(state),
      readCredentials: async () => {
        throw eacces;
      },
    }),
  ).rejects.toBe(eacces);
});

test("refreshNow: refreshes, writes back, and serves the new token", async () => {
  const state = initial({ now: 56 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([
    {
      refreshToken: "refresh-1",
      clientId: CLAUDE_CODE_CLIENT_ID,
      scopes: ["user:inference"],
    },
  ]);
  expect(source.current()).toBe("access-2");
  expect(JSON.parse(state.writes[0]).claudeAiOauth.refreshToken).toBe(
    "refresh-2",
  );
  expect(state.scheduled.at(-1)?.delayMs).toBe(55 * MIN);
});

test("refreshNow: adopts a token another process already refreshed", async () => {
  const state = initial({ now: 56 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  state.file = credentials("access-other", "refresh-other", 200 * MIN);
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(source.current()).toBe("access-other");
});

test("refreshNow: keeps the old token and retries in 30 seconds when the refresh fails", async () => {
  const state = initial({ now: 56 * MIN, refreshError: new Error("offline") });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);
});

test("refreshNow: retries a contended lock and adopts the holder's result", async () => {
  const state = initial({ now: 56 * MIN, lockFailures: 1 });
  state.onLockAttempt = () => {
    if (state.lockFailures === 0) return;
    state.file = credentials("access-holder", "refresh-holder", 200 * MIN);
  };
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()).toBe("access-holder");
});

test("refreshNow: gives up after 5 contended attempts and retries later", async () => {
  const state = initial({ now: 56 * MIN, lockFailures: 5 });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);
});

test("refreshNow: uses the clientId stored in the file", async () => {
  const state = initial({
    now: 56 * MIN,
    file: JSON.stringify({
      claudeAiOauth: {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 60 * MIN,
        scopes: ["s1", "s2"],
        clientId: "client-x",
      },
    }),
  });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes[0]).toEqual({
    refreshToken: "r",
    clientId: "client-x",
    scopes: ["s1", "s2"],
  });
});

test("refreshNow: still writes back when the lock was taken over during the refresh", async () => {
  const state = initial({ now: 56 * MIN, lockCompromised: true });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.writes).toHaveLength(1);
  expect(JSON.parse(state.writes[0]).claudeAiOauth.refreshToken).toBe(
    "refresh-2",
  );
  expect(source.current()).toBe("access-2");
  expect(state.warnings.some((w) => /compromis/i.test(w))).toBe(true);
});

test("refreshNow: keeps serving the new token and retries the write-back when writing fails", async () => {
  const state = initial({ now: 56 * MIN, writeFailures: 1 });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-2");
  expect(state.writes).toEqual([]);
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);

  await source.refreshNow();
  expect(state.refreshes).toHaveLength(1);
  expect(JSON.parse(state.writes[0]).claudeAiOauth.refreshToken).toBe(
    "refresh-2",
  );
  expect(source.current()).toBe("access-2");
});

test("refreshNow: keeps serving the new token and retries the write-back when the file becomes unwritable", async () => {
  // Simplest fake for "the on-disk file can't be turned back into valid
  // credentials at write time": make writeCredentials fail once, same as a
  // transient write error. The expected recovery is identical either way.
  const state = initial({ now: 56 * MIN, writeFailures: 1 });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-2");
  expect(state.writes).toEqual([]);

  await source.refreshNow();
  expect(state.refreshes).toHaveLength(1);
  expect(source.current()).toBe("access-2");
  expect(JSON.parse(state.writes[0]).claudeAiOauth.refreshToken).toBe(
    "refresh-2",
  );
});

test("refreshNow: a pending write-back survives lock contention against the file's stale token", async () => {
  const state = initial({ now: 56 * MIN, writeFailures: 1 });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-2");
  expect(state.writes).toEqual([]);

  // The file on disk still holds the old, now-dead token (the write above
  // failed). A contended lock retry must not compare that stale on-disk
  // token against the already-refreshed in-memory tokens and adopt it.
  state.lockFailures = 1;
  await source.refreshNow();

  expect(source.current()).toBe("access-2");
  expect(JSON.parse(state.file).claudeAiOauth.refreshToken).toBe("refresh-2");
  expect(state.refreshes).toHaveLength(1);
});

test("refreshNow: a release() failure after a successful refresh is logged but doesn't block success", async () => {
  const state = initial({
    now: 56 * MIN,
    releaseError: new Error("release boom"),
  });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-2");
  // The normal before-expiry delay, not the 30s retry delay: the release
  // failure must not make a successful refresh look like a failure.
  expect(state.scheduled.at(-1)?.delayMs).toBe(55 * MIN);
  expect(state.warnings.some((w) => /release boom/.test(w))).toBe(true);
});

test("refreshNow: a release() failure after the body already failed still logs and retries on the original error", async () => {
  const state = initial({
    now: 56 * MIN,
    refreshError: new Error("offline"),
    releaseError: new Error("release boom"),
  });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);
  expect(state.warnings.some((w) => /release boom/.test(w))).toBe(true);
  expect(state.warnings.some((w) => /offline/.test(w))).toBe(true);
});

test("refreshNow: a non-contended acquireLock failure skips the refresh and retries in 30 seconds", async () => {
  const state = initial({
    now: 56 * MIN,
    acquireLockError: new Error("lock directory unreadable"),
  });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()).toBe("access-1");
  expect(state.scheduled.at(-1)?.delayMs).toBe(30_000);
  expect(state.warnings.some((w) => /lock directory unreadable/.test(w))).toBe(
    true,
  );
});

test("refreshNow: reads the credentials file only once while holding the lock", async () => {
  const state = initial({ now: 56 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  state.readCredentialsCalls = 0;
  await source.refreshNow();
  expect(state.readCredentialsCalls).toBe(1);
});

test("open: caps the scheduled delay for a far-future expiry at the setTimeout limit", async () => {
  const state = initial({
    file: credentials("access-1", "refresh-1", 60 * 24 * 60 * MIN),
  });
  await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  expect(state.scheduled.at(-1)?.delayMs).toBe(2_147_483_647);
});

test("open: a capped schedule firing before the token is due just reschedules, without refreshing", async () => {
  const state = initial({
    now: 0,
    file: credentials("access-1", "refresh-1", 60 * 24 * 60 * MIN),
  });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  const capped = state.scheduled.at(-1);
  expect(capped?.delayMs).toBe(2_147_483_647);

  // The timer fires at its capped delay, long before the token is actually
  // due for refresh.
  state.now = 2_147_483_647;
  capped?.fn();
  expect(state.refreshes).toEqual([]);
  expect(source.current()).toBe("access-1");
  const rescheduled = state.scheduled.at(-1);
  expect(rescheduled).not.toBe(capped);
  expect(rescheduled?.delayMs).toBe(2_147_483_647);
});

test("refreshNow: a scheduled fire at or after the due time still refreshes", async () => {
  const state = initial({ now: 55 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  const scheduled = state.scheduled.at(-1);
  scheduled?.fn();
  // The schedule callback kicks off refreshNow() without returning its
  // promise (deps.schedule only accepts `() => void`); flush the event loop
  // so the fake's async reads/writes settle before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(state.refreshes).toHaveLength(1);
  expect(source.current()).toBe("access-2");
});

test("close: cancels the scheduled refresh", async () => {
  const state = initial();
  let cancelled = 0;
  const deps = fakeDeps(state);
  const source = await ClaudeOAuthCredentialSource.open({
    ...deps,
    schedule: (fn, delayMs) => {
      state.scheduled.push({ fn, delayMs });
      return () => {
        cancelled++;
      };
    },
  });
  await source.close();
  expect(cancelled).toBe(1);
});

test("close: waits for an in-flight refresh before returning", async () => {
  const state = initial({ now: 56 * MIN });
  let releaseRefresh: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const deps = fakeDeps(state);
  const source = await ClaudeOAuthCredentialSource.open({
    ...deps,
    refresh: async (request) => {
      await gate;
      return deps.refresh(request);
    },
  });

  const scheduledBeforeClose = state.scheduled.length;

  const refreshing = source.refreshNow();
  let closed = false;
  const closing = source.close().then(() => {
    closed = true;
  });

  // The refresh is still blocked on the gate, so close() must not have
  // resolved yet.
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);

  releaseRefresh?.();
  await refreshing;
  await closing;
  expect(closed).toBe(true);
  expect(state.writes).toHaveLength(1);

  // A successful refresh normally reschedules itself via
  // scheduleBeforeExpiry(); close() must have suppressed that.
  expect(state.scheduled.length).toBe(scheduledBeforeClose);
});

test("close: makes one more attempt to save a pending write-back, and logs if it still fails", async () => {
  const state = initial({ now: 56 * MIN, writeFailures: Infinity });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-2");
  expect(state.writes).toEqual([]);

  const scheduledBeforeClose = state.scheduled.length;
  const writeCallsBeforeClose = state.writeCredentialsCalls;

  await source.close();

  expect(state.writeCredentialsCalls).toBeGreaterThan(writeCallsBeforeClose);
  expect(state.writes).toEqual([]);
  expect(state.warnings.some((w) => /claude \/login/.test(w))).toBe(true);
  expect(state.scheduled.length).toBe(scheduledBeforeClose);
});

test("refreshNow: an overlapping call reuses the in-flight refresh instead of starting a second one", async () => {
  const state = initial({ now: 56 * MIN });
  let releaseRefresh: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const deps = fakeDeps(state);
  const source = await ClaudeOAuthCredentialSource.open({
    ...deps,
    refresh: async (request) => {
      await gate;
      return deps.refresh(request);
    },
  });

  const first = source.refreshNow();
  const second = source.refreshNow();
  expect(second).toBe(first);
  expect(state.refreshes).toEqual([]);

  releaseRefresh?.();
  await first;
  await second;

  expect(state.refreshes).toHaveLength(1);
  expect(source.current()).toBe("access-2");

  // No refresh is in flight any more, so close() should not have to wait.
  let closed = false;
  const closing = source.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(true);
  await closing;
});

test("refreshNow: does nothing once close() has started", async () => {
  const state = initial({ now: 56 * MIN });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.close();

  state.refreshes = [];
  state.writes = [];
  let acquireLockCalled = false;
  state.onLockAttempt = () => {
    acquireLockCalled = true;
  };
  const scheduledBefore = state.scheduled.length;

  await source.refreshNow();

  expect(state.refreshes).toEqual([]);
  expect(state.writes).toEqual([]);
  expect(acquireLockCalled).toBe(false);
  expect(state.scheduled.length).toBe(scheduledBefore);
});

test("close: successfully saves a pending write-back before returning", async () => {
  const state = initial({ now: 56 * MIN, writeFailures: 1 });
  const source = await ClaudeOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(source.current()).toBe("access-2");
  expect(state.writes).toEqual([]);

  await source.close();

  expect(JSON.parse(state.file).claudeAiOauth.refreshToken).toBe("refresh-2");
  expect(source.current()).toBe("access-2");
  expect(state.refreshes).toHaveLength(1);
  expect(state.warnings.some((w) => /claude \/login/.test(w))).toBe(false);
});

test("parseRefreshResponse: keeps the previous refresh token when omitted", () => {
  expect(
    parseRefreshResponse({ access_token: "a", expires_in: 60 }, "old", 1000),
  ).toEqual({ accessToken: "a", refreshToken: "old", expiresAt: 61_000 });
});

test("parseRefreshResponse: reads the rotated refresh token and its expiry", () => {
  expect(
    parseRefreshResponse(
      {
        access_token: "a",
        refresh_token: "new",
        expires_in: 60,
        refresh_token_expires_in: 120,
      },
      "old",
      1000,
    ),
  ).toEqual({
    accessToken: "a",
    refreshToken: "new",
    expiresAt: 61_000,
    refreshTokenExpiresAt: 121_000,
  });
});

test("parseRefreshResponse: rejects a body without an access token", () => {
  expect(() => parseRefreshResponse({ expires_in: 60 }, "old")).toThrow();
});

test("liveClaudeOAuthSourceDeps: writeCredentials replaces the file with exactly the new text, mode 0600, and no temp file left", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-oauth-source-"));
  try {
    const claudeDir = path.join(home, ".claude");
    const file = path.join(claudeDir, ".credentials.json");
    await mkdir(claudeDir);
    await writeFile(file, "x".repeat(200), { mode: 0o644 });
    const text = JSON.stringify({ claudeAiOauth: "y".repeat(50) });
    await liveClaudeOAuthSourceDeps(home).writeCredentials(text);
    expect(await Bun.file(file).text()).toBe(text);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(claudeDir)).toEqual([".credentials.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("liveClaudeOAuthSourceDeps: writeCredentials removes the temp file and rethrows when the replace fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nas-oauth-source-"));
  try {
    const claudeDir = path.join(home, ".claude");
    // A directory at the target path makes the rename fail.
    await mkdir(path.join(claudeDir, ".credentials.json"), { recursive: true });
    const error = await liveClaudeOAuthSourceDeps(home)
      .writeCredentials("{}")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBeDefined();
    expect(await readdir(claudeDir)).toEqual([".credentials.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
