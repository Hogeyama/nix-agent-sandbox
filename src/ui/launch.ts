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
import { readRecentDirs } from "../sessions/recent_dirs.ts";
import {
  getCurrentBranch,
  getGitRoot,
  hasLocalBranch,
} from "../stages/worktree/git_helpers.ts";
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
}

export interface LaunchBranches {
  currentBranch: string | null;
  hasMain: boolean;
}

export async function getLaunchInfo(_ctx: UiDataContext): Promise<LaunchInfo> {
  const [dtachAvailable, config, recentDirectories] = await Promise.all([
    dtachIsAvailable(),
    loadConfig(),
    readRecentDirs(),
  ]);

  return {
    dtachAvailable,
    profiles: Object.keys(config.profiles),
    defaultProfile: config.default,
    recentDirectories,
  };
}

export async function getLaunchBranches(cwd: string): Promise<LaunchBranches> {
  validateCwd(cwd);
  let root: string;
  try {
    root = await getGitRoot(cwd);
  } catch {
    return { currentBranch: null, hasMain: false };
  }
  const [currentBranch, hasMain] = await Promise.all([
    getCurrentBranch(root),
    hasLocalBranch(root, "main"),
  ]);
  return { currentBranch, hasMain };
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

/**
 * Resolve a stable path to the `nas` binary for spawning new sessions.
 *
 * `process.execPath` points at the nix-bundle-elf self-extracted binary
 * under /tmp, which is removed when the originating nas session exits.
 * The UI daemon outlives that session, so that path becomes unusable.
 *
 * Resolution order:
 *   1. NAS_BIN_PATH env var — set by packaging (flake.nix) or the developer.
 *   2. process.execPath, if not under /tmp (covers `bun build --compile`
 *      dev builds and the non-bundled nix wrapper's resolved sibling).
 *
 * PATH lookup is intentionally NOT used: during development with
 * `nix run`, PATH may point at a different installed version of nas
 * (e.g. ~/.local/bin/nas) which silently diverges from the one the
 * developer is actually iterating on.
 */
async function resolveStableNasBin(): Promise<string | null> {
  const envOverride = process.env.NAS_BIN_PATH;
  if (envOverride && envOverride.trim().length > 0) return envOverride;

  const exec = process.execPath;
  if (exec && !exec.startsWith("/tmp/")) return exec;

  return null;
}

function validateCwd(cwd: string): void {
  if (!cwd) {
    throw new LaunchValidationError("Invalid cwd: must be an absolute path");
  }
  if (!path.isAbsolute(cwd)) {
    throw new LaunchValidationError("Invalid cwd: must be an absolute path");
  }
  const normalized = path.normalize(cwd);
  if (normalized !== cwd) {
    throw new LaunchValidationError(
      "Invalid cwd: path contains disallowed segments",
    );
  }
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
    validateCwd(req.cwd);
  }

  // --- dtach availability ---

  if (!(await dtachIsAvailable())) {
    throw new LaunchValidationError("dtach is not available");
  }

  // --- Build and launch session ---

  const sessionId = `sess_${randomHex(6)}`;
  const socketPath = socketPathFor(sessionId);

  const nasBin = await resolveStableNasBin();
  if (!nasBin) {
    throw new Error(
      "Could not resolve a stable path to the nas binary. " +
        "process.execPath is under /tmp (nix-bundle-elf self-extraction) " +
        "which is removed when the originating session exits. " +
        "Set NAS_BIN_PATH to the wrapper or compiled binary that should " +
        "be used for launching new sessions.",
    );
  }
  const cmdArgs: string[] = [nasBin];
  if (req.worktreeBase !== undefined) {
    cmdArgs.push("--worktree", req.worktreeBase);
  }
  if (req.name !== undefined) {
    cmdArgs.push("--name", req.name);
  }
  cmdArgs.push(req.profile);

  const escaped = shellEscape(cmdArgs);
  const escapedSessionId = shellEscape([sessionId]);
  const shellCommand = `NAS_INSIDE_DTACH=1 NAS_SESSION_ID=${escapedSessionId} ${escaped}`;

  await dtachNewSession(socketPath, shellCommand, { cwd: req.cwd });

  return { sessionId };
}
