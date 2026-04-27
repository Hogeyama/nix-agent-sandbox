/**
 * Launch info — 新規セッション開始ダイアログに必要な情報を提供
 */

import * as path from "node:path";
import { loadConfig } from "../config/load.ts";
import { makeSessionLaunchClient } from "../domain/launch.ts";
import { dtachIsAvailable } from "../dtach/client.ts";
import { readRecentDirs } from "../sessions/recent_dirs.ts";
import type { UiDataContext } from "./data.ts";
import {
  getCurrentBranchSafe,
  getGitRootSafe,
  hasLocalBranchSafe,
} from "./git_safe.ts";

const launchClient = makeSessionLaunchClient();

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

export async function getLaunchInfo(
  _ctx: UiDataContext,
  opts?: { cwd?: string },
): Promise<LaunchInfo> {
  const cwd = opts?.cwd;
  if (cwd) {
    validateCwd(cwd);
  }
  const [dtachAvailable, config, recentDirectories] = await Promise.all([
    dtachIsAvailable(),
    loadConfig({ startDir: cwd }),
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
    root = await getGitRootSafe(cwd);
  } catch {
    return { currentBranch: null, hasMain: false };
  }
  const [currentBranch, hasMain] = await Promise.all([
    getCurrentBranchSafe(root),
    hasLocalBranchSafe(root, "main"),
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

export interface NasLaunchCommand {
  nasBin: string;
  nasArgs: string[];
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Buffer.from(data).toString("hex");
}

/**
 * Resolve a stable command for spawning new sessions.
 *
 * `process.execPath` points at the nix-bundle-elf self-extracted binary
 * under /tmp, which is removed when the originating nas session exits.
 * The UI daemon outlives that session, so that path becomes unusable.
 *
 * Resolution order:
 *   1. NAS_BIN_PATH env var — set by packaging (flake.nix) or the developer.
 *   2. If running via a script runner such as `bun main.ts`, reuse
 *      `process.execPath + process.argv[1]` so the spawned session
 *      re-enters the checked-out source tree instead of invoking bare `bun`.
 *   3. process.execPath, if not under /tmp (covers `bun build --compile`
 *      dev builds and the non-bundled nix wrapper's resolved sibling).
 *
 * PATH lookup is intentionally NOT used: during development with
 * `nix run`, PATH may point at a different installed version of nas
 * (e.g. ~/.local/bin/nas) which silently diverges from the one the
 * developer is actually iterating on.
 */
export function resolveStableNasCommand(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  argv: readonly string[] = process.argv,
): NasLaunchCommand | null {
  const envOverride = env.NAS_BIN_PATH?.trim();
  if (envOverride) {
    return { nasBin: envOverride, nasArgs: [] };
  }

  if (!execPath || execPath.startsWith("/tmp/")) return null;

  const entry = argv[1];
  const runner = path.basename(execPath);
  if (
    (runner === "bun" || runner === "node") &&
    typeof entry === "string" &&
    path.isAbsolute(entry)
  ) {
    return { nasBin: execPath, nasArgs: [entry] };
  }

  return { nasBin: execPath, nasArgs: [] };
}

export function validateCwd(cwd: string): void {
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

export async function launchSession(
  ctx: UiDataContext,
  req: LaunchRequest,
): Promise<LaunchResult> {
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

  const nasCommand = resolveStableNasCommand();
  if (!nasCommand) {
    throw new Error(
      "Could not resolve a stable command for nas session launch. " +
        "process.execPath is under /tmp (nix-bundle-elf self-extraction) " +
        "which is removed when the originating session exits. " +
        "Set NAS_BIN_PATH to the wrapper or compiled binary that should " +
        "be used for launching new sessions.",
    );
  }
  const extraArgs: string[] = [];
  if (req.worktreeBase !== undefined) {
    extraArgs.push("--worktree", req.worktreeBase);
  }
  if (req.name !== undefined) {
    extraArgs.push("--name", req.name);
  }
  extraArgs.push(req.profile);

  // NAS_INSIDE_DTACH / NAS_SESSION_ID env prefix の組み立てと
  // socketPathFor + dtachNewSession + 失敗時 safeRemove の cleanup は
  // SessionLaunchService Live 実装に吸収済み。
  return await launchClient.launchAgentSession(ctx.terminalRuntimeDir, {
    sessionId,
    nasBin: nasCommand.nasBin,
    nasArgs: nasCommand.nasArgs,
    extraArgs,
    cwd: req.cwd,
  });
}
