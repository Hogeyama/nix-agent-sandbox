import { rename, writeFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * 確定した session id をファイルへ書く。
 *
 * クライアントは nas を起動したあとこのファイルを読み、`--session` に渡して
 * 自分のセッションの承認だけを購読する。
 *
 * 一時ファイルへ書いてから rename する。読み手はファイルの出現を待つだけで
 * よく、空や書きかけの内容を読むことがない。
 */
export async function writeSessionIdFile(
  filePath: string,
  sessionId: string,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
  );
  await writeFile(tempPath, `${sessionId}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}
