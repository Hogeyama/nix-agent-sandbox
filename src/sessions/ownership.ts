import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { defaultRuntimeDir } from "../lib/fs_utils.ts";

/**
 * session id の所有権。
 *
 * ソケット、認可文書、資格情報のコピー、コンテナ名など、セッション単位の
 * リソースは session id から名前を決め、起動時と終了時に `force` で消す。
 * 同じ id で 2 つ目の nas が起動すると、稼働中のセッションのリソースを
 * 上書きし、終了時にはまとめて消してしまう。session id は環境変数や
 * `--session` で外から渡せるため、承認された `hostexec nas` 経由でも
 * これが起こりうる。そこでリソースに触れる前に id を排他的に確保する。
 */
export interface SessionOwnership {
  release(): void;
}

export class SessionIdInUseError extends Error {
  constructor(sessionId: string, pid: number) {
    super(
      `Session ${sessionId} is already running (pid ${pid}). ` +
        "Refusing to start a second nas with the same session id.",
    );
    this.name = "SessionIdInUseError";
  }
}

interface Owner {
  pid: number;
  startTime: string;
}

export function sessionOwnershipDir(): string {
  return defaultRuntimeDir("session-owners");
}

/**
 * `sessionId` をこのプロセスの所有として確保する。生きている別プロセスが
 * 所有していれば {@link SessionIdInUseError} を投げる。所有者が死んでいれば
 * 残ったファイルを引き継ぐ。
 */
export function claimSessionId(
  sessionId: string,
  dir: string = sessionOwnershipDir(),
): SessionOwnership {
  const ownerPath = ownerPathFor(dir, sessionId);
  const self = currentOwner();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return withOwnershipLock(dir, () => {
    const existing = readOwner(ownerPath);
    if (existing && isOwnerAlive(existing)) {
      throw new SessionIdInUseError(sessionId, existing.pid);
    }
    unlinkQuietly(ownerPath);
    writeFileSync(ownerPath, formatOwner(self), { flag: "wx", mode: 0o600 });
    let released = false;
    return {
      release: () => {
        if (released) return;
        withOwnershipLock(dir, () => releaseIfOwned(ownerPath, self));
        released = true;
      },
    };
  });
}

/**
 * 所有者ファイルの作成途中や stale 判定と削除の間に、別の取得を挟ませない。
 * 削除しない親ディレクトリを flock するので、ロック自体の stale 回収は不要。
 * 子に継承した fd 0 と親の fd は同じ open file description を共有し、子が
 * 終了した後も closeSync までロックを保持する。プロセス死亡時も自動解放される。
 */
function withOwnershipLock<A>(dir: string, operation: () => A): A {
  const fd = openSync(dir, "r");
  try {
    const result = Bun.spawnSync(["flock", "-x", "0"], {
      stdin: fd,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not lock session ownership directory: ${dir}`);
    }
    return operation();
  } finally {
    closeSync(fd);
  }
}

function ownerPathFor(dir: string, sessionId: string): string {
  if (
    sessionId.length === 0 ||
    sessionId !== path.basename(sessionId) ||
    sessionId.startsWith(".")
  ) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
  }
  return path.join(dir, `${sessionId}.owner`);
}

function currentOwner(): Owner {
  const startTime = readStartTime(process.pid);
  if (startTime === null) {
    throw new Error("Cannot read this process's start time from /proc");
  }
  return { pid: process.pid, startTime };
}

function formatOwner(owner: Owner): string {
  return `${owner.pid} ${owner.startTime}\n`;
}

function readOwner(ownerPath: string): Owner | null {
  let text: string;
  try {
    text = readFileSync(ownerPath, "utf8");
  } catch {
    return null;
  }
  const [pidText, startTime] = text.trim().split(" ");
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0 || !startTime) return null;
  return { pid, startTime };
}

/** pid の再利用に騙されないよう、起動時刻まで一致したときだけ生存とみなす。 */
function isOwnerAlive(owner: Owner): boolean {
  return readStartTime(owner.pid) === owner.startTime;
}

/** `/proc/<pid>/stat` の 22 番目のフィールド (starttime)。 */
function readStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  // comm は空白や括弧を含みうるので、最後の ")" 以降だけを数える。
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[19] ?? null;
}

function releaseIfOwned(ownerPath: string, self: Owner): void {
  const existing = readOwner(ownerPath);
  if (existing?.pid !== self.pid || existing.startTime !== self.startTime) {
    return;
  }
  unlinkQuietly(ownerPath);
}

function unlinkQuietly(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {}
}
