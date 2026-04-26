/**
 * Pure (Solid-agnostic) helpers backing the new-session dialog form.
 *
 * The dialog component owns reactive state; this module owns the
 * stateless decisions about what the user input means at submit time
 * and how to keep the worktree-base radio in sync with the latest
 * `LaunchBranches` snapshot. Keeping these as plain functions makes
 * the logic unit-testable without booting Solid or the DOM and keeps
 * the component body focused on rendering.
 */

import type { LaunchBranches } from "../api/client";

/**
 * Worktree-base radio choice.
 *
 *   - "none":    use whatever default the chosen profile defines
 *                (sent as `worktreeBase: undefined`).
 *   - "main":    branch off "main" — only valid when
 *                `LaunchBranches.hasMain` is true.
 *   - "current": branch off the current branch — only valid when the
 *                cwd is a git checkout AND its current branch is not
 *                "main" (otherwise it would duplicate the "main" choice).
 *   - "custom":  branch off a user-typed branch name.
 */
export type WorktreeChoice = "none" | "main" | "current" | "custom";

/**
 * Resolve the `worktreeBase` value to send in the launch payload.
 *
 * Returns `undefined` whenever the chosen option does not produce a
 * usable branch name (no selection, custom field empty, current branch
 * unknown). The launch endpoint treats `undefined` as "use profile
 * default", which is the desired fallback for every degenerate case
 * here.
 */
export function pickWorktreeBase(
  choice: WorktreeChoice,
  customWorktree: string,
  branches: LaunchBranches | null,
): string | undefined {
  switch (choice) {
    case "none":
      return undefined;
    case "main":
      return "main";
    case "current":
      return branches?.currentBranch ?? undefined;
    case "custom": {
      const trimmed = customWorktree.trim();
      return trimmed === "" ? undefined : trimmed;
    }
  }
}

/**
 * Resolve the `cwd` value the form is currently pointing at.
 *
 * Returns the empty string when the user picked "default", which the
 * dialog interprets as "let the daemon pick". Custom paths are trimmed
 * so a stray leading/trailing space cannot break the git-branch
 * detection round-trip.
 */
export function pickEffectiveCwd(
  dirChoice: "default" | "recent" | "custom",
  customDir: string,
  selectedRecentDir: string,
): string {
  switch (dirChoice) {
    case "custom":
      return customDir.trim();
    case "recent":
      return selectedRecentDir.trim();
    case "default":
      return "";
  }
}

/**
 * Reconcile the worktree-base selection against the latest branches
 * snapshot.
 *
 * When the user changes cwd, the previously valid "main" / "current"
 * options may become invalid (e.g. switched to a non-git directory, or
 * to a repo whose only branch is "main" so "current" would just
 * duplicate "main"). This function downgrades stale selections to
 * "none" so the rendered radio always reflects an option that exists.
 * "custom" is never reconciled away — the user typed it explicitly and
 * the launch endpoint will validate the branch name.
 */
export function reconcileWorktreeChoice(
  choice: WorktreeChoice,
  branches: LaunchBranches | null,
): WorktreeChoice {
  if (choice === "main" && (branches === null || !branches.hasMain)) {
    return "none";
  }
  if (choice === "current") {
    const current = branches?.currentBranch ?? null;
    if (current === null || current === "main") {
      return "none";
    }
  }
  return choice;
}
