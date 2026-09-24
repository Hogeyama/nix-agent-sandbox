import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildDummyClaudeCredentials,
  claudeCredentialsReadError,
} from "../../agents/claude_oauth.ts";

export interface DummyClaudeCredentials {
  readonly dir: string;
  readonly file: string;
}

/**
 * ホストの Claude の credential からダミーを作り、セッション専用の
 * ディレクトリに置く。Dev Container は bind 元が実在しないと起動しないので、
 * マウント前に必ず作っておく。
 */
export async function prepareDummyClaudeCredentials(
  hostHome: string,
): Promise<DummyClaudeCredentials> {
  let hostText: string;
  try {
    hostText = await readFile(
      path.join(hostHome, ".claude", ".credentials.json"),
      "utf8",
    );
  } catch (error) {
    throw claudeCredentialsReadError(error);
  }
  const dummy = buildDummyClaudeCredentials(hostText);
  const dir = await mkdtemp(path.join(tmpdir(), "nas-claude-credentials-"));
  const file = path.join(dir, ".credentials.json");
  try {
    await writeFile(file, dummy, { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, file };
}

export async function removeDummyClaudeCredentials(
  state: DummyClaudeCredentials,
): Promise<void> {
  await rm(state.dir, { recursive: true, force: true });
}
