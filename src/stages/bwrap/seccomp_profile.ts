/**
 * The seccomp profile an agent container runs under when `bwrap.support` is
 * on: Docker's default profile with the system calls bubblewrap needs to set
 * up an unprivileged user namespace.
 *
 * `src/docker/seccomp/default.json` is moby/profiles' `seccomp/default.json`
 * at {@link DOCKER_DEFAULT_SECCOMP_REVISION}, unmodified, under the Apache
 * License 2.0 next to it. The addition is made here, at run time, so the
 * distributed file stays the upstream one.
 */

import dockerDefault from "../../docker/seccomp/default.json";

/** moby/profiles commit the vendored profile was taken from. */
export const DOCKER_DEFAULT_SECCOMP_REVISION =
  "2ceae35d351c156cb5a8efc0fdc4a08cf94569d8";

/**
 * Docker allows these only with CAP_SYS_ADMIN (and `clone` only without
 * namespace flags), which the agent never holds. Inside the user namespace
 * bubblewrap creates, the kernel grants the capabilities they need, so
 * allowing the calls grants no privilege outside it; what it adds is the
 * kernel code reachable from the container.
 */
export const BWRAP_SYSCALLS = [
  "clone",
  "unshare",
  "mount",
  "umount2",
  "pivot_root",
] as const;

/** The profile as the JSON text `docker run --security-opt seccomp=` reads. */
export function bwrapSeccompProfile(): string {
  return JSON.stringify(
    {
      ...dockerDefault,
      syscalls: [
        ...dockerDefault.syscalls,
        {
          names: [...BWRAP_SYSCALLS],
          action: "SCMP_ACT_ALLOW",
          comment:
            "nas bwrap.support: let bubblewrap create an unprivileged user namespace",
        },
      ],
    },
    null,
    2,
  );
}
