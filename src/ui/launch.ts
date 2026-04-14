/**
 * Launch info — 新規セッション開始ダイアログに必要な情報を提供
 */

import { loadConfig } from "../config/load.ts";
import { dtachIsAvailable } from "../dtach/client.ts";
import { listSessions } from "../sessions/store.ts";
import { getCurrentBranch } from "../stages/worktree/git_helpers.ts";
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

  // Resolve current branch at git root
  const currentBranch = ctx.gitRoot
    ? await getCurrentBranch(ctx.gitRoot)
    : null;

  return {
    dtachAvailable,
    profiles,
    defaultProfile,
    recentDirectories,
    currentBranch,
  };
}
