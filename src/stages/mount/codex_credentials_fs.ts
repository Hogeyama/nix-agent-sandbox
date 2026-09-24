import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildDummyCodexAuth,
  codexCredentialsReadError,
} from "../../agents/codex_oauth.ts";

export interface DummyCodexCredentials {
  readonly dir: string;
  readonly file: string;
}

/**
 * ホストの Codex の auth.json からダミーを作り、セッション専用の
 * ディレクトリに置く。container の `~/.codex/auth.json` に被せる。
 */
export async function prepareDummyCodexCredentials(
  hostHome: string,
  now: number = Date.now(),
): Promise<DummyCodexCredentials> {
  let hostText: string;
  try {
    hostText = await readFile(
      path.join(hostHome, ".codex", "auth.json"),
      "utf8",
    );
  } catch (error) {
    throw codexCredentialsReadError(error);
  }
  const dummy = buildDummyCodexAuth(hostText, now);
  const dir = await mkdtemp(path.join(tmpdir(), "nas-codex-credentials-"));
  const file = path.join(dir, "auth.json");
  try {
    await writeFile(file, dummy, { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
}

export async function removeDummyCodexCredentials(
  state: DummyCodexCredentials,
): Promise<void> {
  await rm(state.dir, { recursive: true, force: true });
}
