import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  CODEX_DUMMY_REFRESH_TOKEN,
  CodexOAuthUnavailableError,
} from "../../agents/codex_oauth.ts";
import {
  prepareDummyCodexCredentials,
  removeDummyCodexCredentials,
} from "./codex_credentials_fs.ts";

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(), "nas-codex-creds-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

test("prepareDummyCodexCredentials: writes a private dummy auth.json", async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, ".codex"));
    await writeFile(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: jwt({}),
          access_token: jwt({ exp: 1 }),
          refresh_token: "real-refresh",
          account_id: "acct-1",
        },
      }),
    );
    const dummy = await prepareDummyCodexCredentials(home, 0);
    try {
      expect(path.basename(dummy.file)).toBe("auth.json");
      expect((await stat(dummy.file)).mode & 0o777).toBe(0o600);
      const text = await readFile(dummy.file, "utf8");
      expect(text).not.toContain("real-refresh");
      expect(JSON.parse(text).tokens.refresh_token).toBe(
        CODEX_DUMMY_REFRESH_TOKEN,
      );
    } finally {
      await removeDummyCodexCredentials(dummy);
    }
    await expect(stat(dummy.dir)).rejects.toThrow();
  });
});

test("prepareDummyCodexCredentials: a missing host file asks for codex login", async () => {
  await withHome(async (home) => {
    await expect(prepareDummyCodexCredentials(home)).rejects.toBeInstanceOf(
      CodexOAuthUnavailableError,
    );
  });
});
