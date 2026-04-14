/**
 * Launch info — 新規セッション開始ダイアログに必要な情報を提供
 */

import * as path from "node:path";
import { loadConfig } from "../config/load.ts";
import {
  dtachIsAvailable,
  dtachNewSession,
  shellEscape,
  socketPathFor,
} from "../dtach/client.ts";
import { listSessions } from "../sessions/store.ts";
import { getCurrentBranch } from "../stages/worktree/git_helpers.ts";
import type { UiDataContext } from "./data.ts";

/** Client-facing validation error (maps to HTTP 400). */
export class LaunchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchValidationError";
  }
}

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

// ---------------------------------------------------------------------------
// Launch session
// ---------------------------------------------------------------------------

export interface LaunchRequest {
  profile: string;
  worktreeBase?: string; // branch name. undefined = profile default
  name?: string; // session name
  cwd?: string; // working directory
}

export interface LaunchResult {
  sessionId: string;
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(data).toString("hex");
}

export async function launchSession(req: LaunchRequest): Promise<LaunchResult> {
  // --- Input validation ---

  if (!req.profile || !/^[a-zA-Z0-9_-]+$/.test(req.profile)) {
    throw new LaunchValidationError("Invalid profile name");
  }

  if (req.worktreeBase !== undefined) {
    if (
      !/^[a-zA-Z0-9_./@-]+$/.test(req.worktreeBase) ||
      req.worktreeBase.includes("..")
    ) {
      throw new LaunchValidationError("Invalid worktree base branch");
    }
  }

  if (req.name !== undefined) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.name)) {
      throw new LaunchValidationError("Invalid session name");
    }
  }

  if (req.cwd !== undefined) {
    if (!path.isAbsolute(req.cwd)) {
      throw new LaunchValidationError("Invalid cwd: must be an absolute path");
    }
    const normalized = path.normalize(req.cwd);
    if (normalized !== req.cwd) {
      throw new LaunchValidationError(
        "Invalid cwd: path contains disallowed segments",
      );
    }
  }

  // --- dtach availability ---

  if (!(await dtachIsAvailable())) {
    throw new LaunchValidationError("dtach is not available");
  }

  // --- Build and launch session ---

  const sessionId = `sess_${randomHex(6)}`;
  const socketPath = socketPathFor(sessionId);

  const cmdArgs: string[] = [process.execPath, req.profile];
  if (req.worktreeBase !== undefined) {
    cmdArgs.push("--worktree", req.worktreeBase);
  }
  if (req.name !== undefined) {
    cmdArgs.push("--name", req.name);
  }

  const escaped = shellEscape(cmdArgs);
  const escapedSessionId = shellEscape([sessionId]);
  const shellCommand = `NAS_INSIDE_DTACH=1 NAS_SESSION_ID=${escapedSessionId} ${escaped}`;

  await dtachNewSession(socketPath, shellCommand, { cwd: req.cwd });

  return { sessionId };
}
