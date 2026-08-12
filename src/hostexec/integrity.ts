import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface FileIntegrity {
  readonly inode: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

export type IntegritySnapshot = FileIntegrity | "absent";

export type IntegrityVerdict = "pass" | "prompt";

/**
 * baseline と現在値から実行可否を決める純粋関数。
 * `baseline === undefined` は「LD_PRELOAD 対象だが起動時に snapshot していない
 * パス」を表し、確認できないので prompt に倒す。content の一致は sha256 で判定し、
 * inode/mtime の違いは（同一 content の atomic 置換など良性を許すため）無視する。
 */
export function decideIntegrity(
  baseline: IntegritySnapshot | undefined,
  current: IntegritySnapshot,
): IntegrityVerdict {
  if (baseline === undefined) return "prompt";
  if (baseline === "absent") {
    return current === "absent" ? "pass" : "prompt";
  }
  if (current === "absent") return "prompt";
  return current.sha256 === baseline.sha256 ? "pass" : "prompt";
}

/**
 * ファイルの integrity スナップショットを読む（D1）。
 * stat・読み込み・sha256 算出を毎回実行し、再ハッシュを省略する高速パスは
 * 持たない。inode/mtimeMs/size が一致していても content の差し替えを検出
 * する必要があるため（同一 inode に同一サイズで別内容を書き込み、mtime を
 * utimensat で復元する攻撃を防止するため）、常に実ファイルを読んでハッシュを
 * 再計算する。ファイルが存在しない場合は "absent" を返す。
 */
export async function readFileIntegrity(
  filePath: string,
): Promise<IntegritySnapshot> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  let content: Awaited<ReturnType<typeof readFile>>;
  try {
    content = await readFile(filePath);
  } catch (e) {
    // stat と readFile の間でファイルが消える競合が存在する（broker 起動時の
    // snapshot 中など）ため、ENOENT はここでも absent として扱う。
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { inode: st.ino, mtimeMs: st.mtimeMs, size: st.size, sha256 };
}
