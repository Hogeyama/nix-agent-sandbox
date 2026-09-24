import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN,
  ClaudeOAuthUnavailableError,
} from "../../agents/claude_oauth.ts";
import {
  prepareDummyClaudeCredentials,
  removeDummyClaudeCredentials,
} from "./claude_credentials_fs.ts";

const isRoot = process.getuid?.() === 0;

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "nas-claude-creds-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("prepareDummyClaudeCredentials: writes a private dummy file", async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, ".claude"));
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "real",
          refreshToken: "real-r",
          expiresAt: 1,
          scopes: [],
        },
      }),
    );
    const dummy = await prepareDummyClaudeCredentials(home);
    try {
      const text = await Bun.file(dummy.file).text();
      expect(text).toContain(CLAUDE_OAUTH_DUMMY_ACCESS_TOKEN);
      expect(text).not.toContain("real");
      expect((await stat(dummy.file)).mode & 0o777).toBe(0o600);
    } finally {
      await removeDummyClaudeCredentials(dummy);
    }
    expect(await stat(dummy.dir).catch(() => null)).toBeNull();
  });
});

test("prepareDummyClaudeCredentials: fails when the host is not logged in", async () => {
  await withHome(async (home) => {
    await expect(prepareDummyClaudeCredentials(home)).rejects.toThrow(
      /claude \/login/,
    );
  });
});

test("prepareDummyClaudeCredentials: reports a missing ~/.claude as not logged in", async () => {
  await withHome(async (home) => {
    await expect(prepareDummyClaudeCredentials(home)).rejects.toBeInstanceOf(
      ClaudeOAuthUnavailableError,
    );
  });
});

test("prepareDummyClaudeCredentials: reports a non-directory ~/.claude as not logged in", async () => {
  await withHome(async (home) => {
    await writeFile(path.join(home, ".claude"), "");
    await expect(prepareDummyClaudeCredentials(home)).rejects.toBeInstanceOf(
      ClaudeOAuthUnavailableError,
    );
  });
});

test.skipIf(isRoot)(
  "prepareDummyClaudeCredentials: rethrows an unreadable credentials file unchanged",
  async () => {
    await withHome(async (home) => {
      await mkdir(path.join(home, ".claude"));
      const file = path.join(home, ".claude", ".credentials.json");
      await writeFile(file, "{}");
      await chmod(file, 0o000);
      const error = await prepareDummyClaudeCredentials(home).catch(
        (e: unknown) => e,
      );
      expect(error).not.toBeInstanceOf(ClaudeOAuthUnavailableError);
      expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    });
  },
);
