/**
 * Launch info — 新規セッション開始ダイアログに必要な情報を提供
 */

import { loadConfig } from "../config/load.ts";
import { dtachIsAvailable } from "../dtach/client.ts";
import { listSessions } from "../sessions/store.ts";
import type { UiDataContext } from "./data.ts";

export interface LaunchInfo {
  dtachAvailable: boolean;
  profiles: string[];
  defaultProfile?: string;
  recentDirectories: string[];
  currentBranch: string | null;
}

export async function getLaunchInfo(ctx: UiDataContext): Promise<LaunchInfo> {
  const [dtachAvailable, config, sessions] = await Promise.all([
    dtachIsAvailable(),
    loadConfig(),
    listSessions(ctx.sessionPaths),
  ]);

  const profiles = Object.keys(config.profiles);
  const defaultProfile = config.default;

  // Collect worktree directories from sessions, deduplicated, sorted by startedAt descending, max 10
  const seen = new Set<string>();
  const recentDirectories: string[] = [];
  const sorted = [...sessions].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  for (const session of sorted) {
    if (!session.worktree) continue;
    if (seen.has(session.worktree)) continue;
    seen.add(session.worktree);
    recentDirectories.push(session.worktree);
    if (recentDirectories.length >= 10) break;
  }

  // Resolve current branch
  let currentBranch: string | null = null;
  if (ctx.gitRoot) {
    try {
      const proc = Bun.spawn(
        ["git", "-C", ctx.gitRoot, "symbolic-ref", "--short", "HEAD"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        const text = await new Response(proc.stdout).text();
        currentBranch = text.trim() || null;
      }
    } catch {
      // detached HEAD or git error — leave as null
    }
  }

  return {
    dtachAvailable,
    profiles,
    defaultProfile,
    recentDirectories,
    currentBranch,
  };
}
