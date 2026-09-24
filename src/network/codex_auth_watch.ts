/**
 * ホストの `~/.codex/auth.json` が消えるか別のファイルに置き換わったことを
 * 検知する。
 *
 * container にはダミーの auth.json をホストの auth.json の上に bind mount
 * している。Linux では、別の mount namespace で mount point になっている
 * ファイルを unlink や rename で置き換えると、その mount が外れる。外れた後に
 * ホストで本物が書かれると、read-write で mount したホストの `~/.codex` を
 * 通して container から読める。ホストの Codex の保存は同じファイルへの上書き
 * なので inode は変わらない。変わるのは `codex logout` と、rename で置き換える
 * 別のツールである。
 *
 * fs.watch はイベントを取りこぼしうるので、一定間隔でも確かめる。
 */

import { watch as watchDir } from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import { CodexOAuthUnavailableError } from "../agents/codex_oauth.ts";

export const CODEX_AUTH_CHECK_INTERVAL_MS = 5_000;

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface CodexAuthWatchDeps {
  /** auth.json の device と inode。無ければ null。 */
  identify(): Promise<FileIdentity | null>;
  /** auth.json に関わるかもしれないイベントのたびに onEvent を呼ぶ。戻り値は停止。 */
  watch(onEvent: () => void): () => void;
  /** 戻り値は予約の取り消し。 */
  schedule(fn: () => void, delayMs: number): () => void;
}

/**
 * 監視を始め、置き換わったら onReplaced を1回だけ呼んで監視をやめる。
 * 戻り値は監視の停止。開始時にファイルが無ければ失敗する。
 */
export async function watchCodexAuthFile(
  deps: CodexAuthWatchDeps,
  onReplaced: () => void,
): Promise<() => void> {
  const initial = await deps.identify();
  if (initial === null) {
    throw new CodexOAuthUnavailableError("no auth.json");
  }
  let done = false;
  let cancelTimer: () => void = () => {};
  let unwatch: () => void = () => {};

  function stop(): void {
    done = true;
    cancelTimer();
    unwatch();
  }

  async function check(): Promise<void> {
    if (done) return;
    // 読めないときも、置き換わったものとして扱う (安全側)。
    const current = await deps.identify().catch(() => null);
    if (done) return;
    if (
      current === null ||
      current.dev !== (initial as FileIdentity).dev ||
      current.ino !== (initial as FileIdentity).ino
    ) {
      stop();
      onReplaced();
    }
  }

  function tick(): void {
    void check().finally(() => {
      if (!done) {
        cancelTimer = deps.schedule(tick, CODEX_AUTH_CHECK_INTERVAL_MS);
      }
    });
  }

  unwatch = deps.watch(() => {
    void check();
  });
  cancelTimer = deps.schedule(tick, CODEX_AUTH_CHECK_INTERVAL_MS);
  return stop;
}

export function liveCodexAuthWatchDeps(hostHome: string): CodexAuthWatchDeps {
  const codexDir = path.join(hostHome, ".codex");
  const authPath = path.join(codexDir, "auth.json");
  return {
    identify: async () => {
      try {
        const info = await stat(authPath);
        return { dev: info.dev, ino: info.ino };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw error;
      }
    },
    watch: (onEvent) => {
      try {
        const watcher = watchDir(codexDir, (_event, filename) => {
          if (filename === null || filename === "auth.json") onEvent();
        });
        // 監視できなくなっても、一定間隔の確認が続く。
        watcher.on("error", () => {});
        watcher.unref?.();
        return () => watcher.close();
      } catch {
        return () => {};
      }
    },
    schedule: (fn, delayMs) => {
      const timer = setTimeout(fn, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  };
}
