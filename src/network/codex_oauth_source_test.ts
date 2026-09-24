import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { RefreshedCodexTokens } from "../agents/codex_oauth.ts";
import { LockContendedError } from "../lib/oauth_refresh_lock.ts";
import {
  CODEX_CLIENT_ID,
  CodexOAuthCredentialSource,
  type CodexOAuthSourceDeps,
  type CodexRefreshRequest,
  overwriteFileInPlace,
  parseCodexRefreshResponse,
  resolveNasStateHome,
} from "./codex_oauth_source.ts";

const MIN = 60_000;

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function access(name: string, expSeconds: number, clientId?: string): string {
  return jwt({
    exp: expSeconds,
    name,
    ...(clientId ? { client_id: clientId } : {}),
  });
}

function authFile(accessToken: string, refreshToken: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({}),
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: "acct-1",
    },
    last_refresh: "2026-09-01T00:00:00.000Z",
  });
}

interface FakeState {
  file: string;
  now: number;
  refreshes: CodexRefreshRequest[];
  scheduled: { fn: () => void; delayMs: number }[];
  lockFailures: number;
  warnings: string[];
  nextAccess: string;
}

function fakeDeps(state: FakeState): CodexOAuthSourceDeps {
  return {
    readCredentials: async () => state.file,
    writeCredentials: async (text) => {
      state.file = text;
    },
    acquireLock: async () => {
      if (state.lockFailures > 0) {
        state.lockFailures--;
        throw new LockContendedError("/lock");
      }
      return { release: async () => {}, isCompromised: () => false };
    },
    refresh: async (request) => {
      state.refreshes.push(request);
      return {
        accessToken: state.nextAccess,
        refreshToken: "refresh-2",
        refreshedAt: state.now,
      };
    },
    now: () => state.now,
    sleep: async () => {},
    schedule: (fn, delayMs) => {
      const entry = { fn, delayMs };
      state.scheduled.push(entry);
      return () => {
        state.scheduled = state.scheduled.filter((e) => e !== entry);
      };
    },
    log: (message) => {
      state.warnings.push(message);
    },
  };
}

function initialState(nowMs: number, expSeconds: number): FakeState {
  return {
    file: authFile(access("a1", expSeconds), "refresh-1"),
    now: nowMs,
    refreshes: [],
    scheduled: [],
    lockFailures: 0,
    warnings: [],
    nextAccess: access("a2", expSeconds + 3600),
  };
}

test("CodexOAuthCredentialSource: serves the host token and account id", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  expect(source.current()).toEqual({
    accessToken: access("a1", 10_000),
    accountId: "acct-1",
  });
  await source.close();
});

test("CodexOAuthCredentialSource: schedules the refresh 2 minutes before expiry", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  expect(state.scheduled.map((e) => e.delayMs)).toEqual([10_000_000 - 2 * MIN]);
  await source.close();
});

test("CodexOAuthCredentialSource: refreshes with the default client id and writes back", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes).toEqual([
    { refreshToken: "refresh-1", clientId: CODEX_CLIENT_ID },
  ]);
  expect(source.current()?.accessToken).toBe(state.nextAccess);
  const written = JSON.parse(state.file);
  expect(written.tokens.access_token).toBe(state.nextAccess);
  expect(written.tokens.refresh_token).toBe("refresh-2");
  expect(written.tokens.account_id).toBe("acct-1");
  await source.close();
});

test("CodexOAuthCredentialSource: uses the client id from the access token", async () => {
  const state = initialState(0, 10_000);
  state.file = authFile(access("a1", 10_000, "app_custom"), "refresh-1");
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  await source.refreshNow();
  expect(state.refreshes[0]?.clientId).toBe("app_custom");
  await source.close();
});

test("CodexOAuthCredentialSource: adopts a token the host Codex already refreshed", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  const hostRefreshed = access("host", 20_000);
  state.file = authFile(hostRefreshed, "refresh-host");
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  expect(source.current()?.accessToken).toBe(hostRefreshed);
  await source.close();
});

test("CodexOAuthCredentialSource: revoke stops serving and refreshing", async () => {
  const state = initialState(0, 10_000);
  const source = await CodexOAuthCredentialSource.open(fakeDeps(state));
  source.revoke();
  expect(source.current()).toBeNull();
  expect(state.scheduled).toEqual([]);
  await source.refreshNow();
  expect(state.refreshes).toEqual([]);
  await source.close();
});

test("CodexOAuthCredentialSource: revoke during an in-flight refresh drops the pending write-back", async () => {
  const state = initialState(0, 10_000);
  let resolveRefresh: ((tokens: RefreshedCodexTokens) => void) | undefined;
  const gate = new Promise<RefreshedCodexTokens>((resolve) => {
    resolveRefresh = resolve;
  });
  let writeCalls = 0;
  const deps: CodexOAuthSourceDeps = {
    ...fakeDeps(state),
    refresh: async (request) => {
      state.refreshes.push(request);
      return gate;
    },
    writeCredentials: async (text) => {
      writeCalls++;
      state.file = text;
    },
  };
  const source = await CodexOAuthCredentialSource.open(deps);

  const refreshing = source.refreshNow();
  source.revoke();

  resolveRefresh?.({
    accessToken: state.nextAccess,
    refreshToken: "refresh-2",
    refreshedAt: state.now,
  });
  await refreshing;
  await source.close();

  expect(writeCalls).toBe(0);
  expect(source.current()).toBeNull();
});

test("parseCodexRefreshResponse: requires an access token and keeps optional tokens", () => {
  expect(
    parseCodexRefreshResponse(
      { access_token: "a", refresh_token: "r", id_token: "i" },
      5,
    ),
  ).toEqual({
    accessToken: "a",
    refreshToken: "r",
    idToken: "i",
    refreshedAt: 5,
  });
  expect(parseCodexRefreshResponse({ access_token: "a" }, 5)).toEqual({
    accessToken: "a",
    refreshedAt: 5,
  });
  expect(() => parseCodexRefreshResponse({}, 5)).toThrow();
});

test("overwriteFileInPlace: keeps the inode and refuses to create a file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-codex-write-"));
  try {
    const file = path.join(dir, "auth.json");
    await writeFile(file, "old content that is longer", { mode: 0o600 });
    const before = await stat(file);
    await overwriteFileInPlace(file, "new");
    const after = await stat(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("new");
    await expect(
      overwriteFileInPlace(path.join(dir, "missing.json"), "x"),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("overwriteFileInPlace: writes the whole content even when a single write is short", async () => {
  // 1 回の write はカーネルの都合で途中までしか書かないことがある。
  let content = "old";
  const handle = {
    truncate: async (length: number) => {
      content = content.slice(0, length);
    },
    write: async (text: string) => {
      const written = text.slice(0, 4);
      content += written;
      return { bytesWritten: Buffer.byteLength(written), buffer: written };
    },
    writeFile: async (text: string) => {
      content += text;
    },
    sync: async () => {},
    close: async () => {},
  };
  const text = JSON.stringify({ tokens: { access_token: "a".repeat(64) } });
  await overwriteFileInPlace("/unused", text, async () => handle);
  expect(content).toBe(text);
});

test("resolveNasStateHome: prefers XDG_STATE_HOME", () => {
  expect(resolveNasStateHome("/home/u", { XDG_STATE_HOME: "/state" })).toBe(
    "/state",
  );
  expect(resolveNasStateHome("/home/u", {})).toBe("/home/u/.local/state");
});
