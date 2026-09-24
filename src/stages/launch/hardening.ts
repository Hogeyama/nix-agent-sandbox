/**
 * Privilege settings shared by every agent container launch path
 * (`docker run` via compileLaunchOpts and Dev Container Compose via
 * compileCompose), so the two cannot drift apart.
 *
 * The entrypoint starts as root, prepares the user and filesystem, then
 * drops to the host UID/GID with `setpriv`. The agent payload therefore
 * holds no capabilities regardless of this list; the list bounds what the
 * root phase (and the `--shell` / Dev Container `docker exec -u 0` paths)
 * can do, and what an exploit that regains root inside the container could
 * use against the kernel.
 */

/**
 * Keep the kernel from granting privileges across execve: setuid/setgid
 * binaries and file capabilities stop working. The image ships no sudo and
 * no setuid helper the agent relies on, and `setpriv` is run by root, so it
 * only ever lowers privileges.
 */
export const AGENT_NO_NEW_PRIVILEGES = "no-new-privileges";

/**
 * The only capabilities re-added after dropping the Docker default set.
 * Each one is used by the root phase of `src/docker/embed/entrypoint.sh`.
 */
export const AGENT_CAP_ADD: readonly string[] = [
  // chown of $NAS_HOME and Docker-created mount parents under it, the
  // .gnupg directory, and `install -o` of /run/nas-devcontainer.
  "CHOWN",
  // Root reaches into directories owned by the agent user (a 0700 ~/.gnupg
  // to find the gpg-agent socket, host-owned dirs `find` walks under
  // $NAS_HOME) and writes files the agent user may own.
  "DAC_OVERRIDE",
  // `chmod 700 ~/.gnupg` after that directory was chowned to the agent user.
  "FOWNER",
  // `setpriv --reuid/--regid --init-groups|--groups` drops to the agent user.
  "SETUID",
  "SETGID",
  // The root shell signals processes it started as the agent user: the
  // initial port relay is checked with `kill -0` and killed on failure.
  // Without this the check fails with EPERM and the session never starts.
  "KILL",
];

/** `docker run` arguments applying the settings above. */
export function agentPrivilegeRunArgs(): string[] {
  const args = ["--security-opt", AGENT_NO_NEW_PRIVILEGES, "--cap-drop", "ALL"];
  for (const cap of AGENT_CAP_ADD) {
    args.push("--cap-add", cap);
  }
  return args;
}
