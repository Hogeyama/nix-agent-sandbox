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
 * `prev` が与えられ inode+mtimeMs+size が一致する場合、content は変わっていないと
 * みなして再ハッシュを省き `prev` をそのまま返す（fast-path）。ファイルが無ければ
 * "absent" を返す。
 */
export async function readFileIntegrity(
  filePath: string,
  prev?: IntegritySnapshot,
): Promise<IntegritySnapshot> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  if (
    prev &&
    prev !== "absent" &&
    prev.inode === st.ino &&
    prev.mtimeMs === st.mtimeMs &&
    prev.size === st.size
  ) {
    return prev;
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
