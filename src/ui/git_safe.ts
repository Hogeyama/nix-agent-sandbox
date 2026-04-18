/**
 * Sandboxed git invocations for the UI daemon.
 *
 * The UI daemon accepts a `cwd` parameter from HTTP requests and runs git
 * against it. A malicious or mistaken `cwd` could point at a directory
 * containing a `.git/config` with dangerous settings (`core.sshCommand`,
 * `core.fsmonitor`, `core.hooksPath`, ...) that git would otherwise execute
 * as the daemon user.
 *
 * This helper invokes git with env overrides and `-c` flags that neutralize
 * the most commonly abused config surfaces:
 *
 *   - GIT_CONFIG_GLOBAL=/dev/null / GIT_CONFIG_SYSTEM=/dev/null — prevent
 *     reading ~/.gitconfig and /etc/gitconfig (no host-wide sshCommand etc).
 *   - protocol.file.allow=never — disable the local `file://` transport
 *     which has been a source of past RCEs.
 *   - core.sshCommand=/bin/false — neutralize any sshCommand override
 *     coming from a repo-local config. Normal local git operations
 *     (rev-parse, symbolic-ref, show-toplevel) do not invoke ssh, so
 *     this does not break legitimate use.
 *   - core.fsmonitor=false — disable the fsmonitor hook which can run an
 *     arbitrary binary on almost every git command.
 *   - core.hooksPath=/dev/null — no-op hooks dir to prevent repo-level
 *     hooks from being executed.
 */

export interface SpawnGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const SANDBOX_CONFIG_ARGS = [
  "-c",
  "protocol.file.allow=never",
  "-c",
  "core.sshCommand=/bin/false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
];

function sandboxEnv(): Record<string, string> {
  // Start from the current env but override git-config discovery and a few
  // other variables known to load external configuration / run external
  // helpers. PATH is preserved so git itself can still locate helpers like
  // `git-sh-setup` that are shipped with the distribution.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  // `git` honors GIT_CONFIG_NOSYSTEM as a belt-and-braces for /etc/gitconfig.
  env.GIT_CONFIG_NOSYSTEM = "1";
  // Disable any ssh/askpass invocation paths — even though we also override
  // core.sshCommand, GIT_SSH / GIT_SSH_COMMAND take precedence when set.
  env.GIT_SSH_COMMAND = "/bin/false";
  delete env.GIT_SSH;
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  // Prevent terminal prompts that could block the daemon.
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * Spawn `git` with a hardened environment and safe `-c` overrides.
 *
 * @param args — arguments *after* the leading `git` (sandbox `-c` flags are
 *   prepended automatically; callers do not need to pass them).
 * @param opts.cwd — working directory for the git process.
 */
export async function spawnGitSafely(
  args: string[],
  opts: { cwd?: string } = {},
): Promise<SpawnGitResult> {
  const fullArgs = ["git", ...SANDBOX_CONFIG_ARGS, ...args];
  const proc = Bun.spawn(fullArgs, {
    cwd: opts.cwd,
    env: sandboxEnv(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdoutBuf, stderrBuf] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdoutBuf, stderr: stderrBuf, exitCode };
}

/**
 * Return the top-level directory of the git repo containing `dir`, or throw.
 * Sandboxed equivalent of `git_helpers.getGitRoot`.
 */
export async function getGitRootSafe(dir: string): Promise<string> {
  const res = await spawnGitSafely(["rev-parse", "--show-toplevel"], {
    cwd: dir,
  });
  if (res.exitCode !== 0) {
    throw new Error(
      `"${dir}" is not inside a git repository. Worktree requires a git repo.`,
    );
  }
  return res.stdout.trim();
}

/** Current branch name or null in detached HEAD state. Sandboxed. */
export async function getCurrentBranchSafe(
  repoRoot: string,
): Promise<string | null> {
  const res = await spawnGitSafely(["symbolic-ref", "--short", "HEAD"], {
    cwd: repoRoot,
  });
  if (res.exitCode !== 0) return null;
  const branch = res.stdout.trim();
  return branch || null;
}

/** Whether the given local branch exists in this repo. Sandboxed. */
export async function hasLocalBranchSafe(
  repoRoot: string,
  branchName: string,
): Promise<boolean> {
  const res = await spawnGitSafely(
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    { cwd: repoRoot },
  );
  return res.exitCode === 0;
}
