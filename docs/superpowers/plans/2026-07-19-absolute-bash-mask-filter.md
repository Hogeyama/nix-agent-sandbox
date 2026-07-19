# Absolute Bash Mask Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex command shells invoked through absolute `/bin/bash` pass stdout and stderr through `nas-mask-filter` without filtering the agent or interactive shell process itself.

**Architecture:** Entrypoint preserves the image-provided Bash at `/tmp/nas-bash-override/bash.real`, generates one non-recursive wrapper, and atomically installs that wrapper both as the `PATH` override and over the usrmerge-resolved system Bash. Entrypoint-owned launch shells use `bash.real`; agent-created Bash processes continue to resolve to the wrapper.

**Tech Stack:** Bash entrypoint, Bun test runner, Docker integration tests, Zig `nas-mask-filter` binary.

## Global Constraints

- Read and follow `test-policy`, `post-change-checks`, and `effect-separation` before implementation and review.
- The design authority is `docs/superpowers/specs/2026-07-19-absolute-bash-mask-filter-design.md`.
- Keep `/tmp/nas-bash-override` as the Bash-wrapper ownership boundary; do not add files under `/opt/nas`.
- Cover `/bin/bash` only. Do not intercept `/bin/sh`, zsh, fish, direct executable launches, or add `LD_PRELOAD` behavior.
- Resolve `/bin/bash` once with `readlink -f`; do not replace `/bin/bash` and `/usr/bin/bash` independently.
- Preserve the original image Bash only when `bash.real` is absent; never back up an already-installed wrapper over it.
- Remove `__NAS_MASK_FILTER_SKIP`; entrypoint-owned shells must bypass filtering by explicitly executing `bash.real`.
- Filter setup remains fail-closed under entrypoint's `set -euo pipefail`.
- When mask filtering is disabled, leave the system Bash executable unchanged.
- Tests added under `src/` import repository modules by relative path and use the existing Docker skip guards and temporary-directory cleanup patterns.

---

### Task 1: Intercept absolute Bash without filtering entrypoint-owned shells

**Files:**
- Modify: `src/stages/launch/integration_test.ts:21-180,182-283`
- Modify: `src/docker/embed/entrypoint.sh:287-389,458-490`

**Interfaces:**
- Consumes: `resolveMaskFilterBinPath(): Promise<string | null>` from `src/stages/maskfs/mask_filter_path.ts` and `encodeMaskSecrets(secrets: readonly string[]): Uint8Array` from `src/stages/maskfs/secrets_frame.ts`.
- Produces: runtime files `/tmp/nas-bash-override/bash` and `/tmp/nas-bash-override/bash.real`, plus shell variable `NAS_REAL_BASH` containing the executable entrypoint must use for unfiltered launch shells.
- Preserves: `dockerRun(testCommand, options)` and the launch-stage `ContainerPlan` contract; no new stage or service API is introduced.

- [ ] **Step 1: Add real-filter fixtures and absolute-Bash regression tests**

Add these imports beside the existing launch integration-test imports:

```typescript
import { resolveMaskFilterBinPath } from "../maskfs/mask_filter_path.ts";
import { encodeMaskSecrets } from "../maskfs/secrets_frame.ts";
```

Resolve the optional development binary next to the Docker availability probe:

```typescript
const dockerAvailable = await isDockerAvailable();
const maskFilterBinPath = await resolveMaskFilterBinPath();
```

Add the following tests immediately after the existing `canBindMount` declaration. The first proves that disabled setup does not replace the system ELF executable. The second copies the real filter into the Docker-visible temporary tree, mounts both filter and framed secrets read-only, starts an unfiltered `/bin/sh` parent, and then invokes `/bin/bash` by absolute path.

```typescript
test.skipIf(!dockerAvailable)(
  "Integration: absolute /bin/bash remains the system executable when mask filter is disabled",
  async () => {
    const result = await dockerRun([
      "/bin/sh",
      "-c",
      "od -An -t x1 -N 4 /bin/bash",
    ]);

    expect(result.code).toEqual(0);
    expect(result.stdout.trim().replace(/\s+/g, " ")).toEqual("7f 45 4c 46");
  },
);

test.skipIf(!canBindMount || !maskFilterBinPath)(
  "Integration: absolute /bin/bash masks stdout and stderr while preserving argv0",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-filter-");
    const containerFixtureDir = "/tmp/nas-mask-filter-test";
    const filterPath = path.join(fixtureDir, "nas-mask-filter");
    const secretsPath = path.join(fixtureDir, "secrets.frame");
    const secret = "my-secret-password";
    const masked = "*".repeat(secret.length);

    try {
      await writeFile(filterPath, await readFile(maskFilterBinPath));
      await chmod(filterPath, 0o755);
      await writeFile(secretsPath, encodeMaskSecrets([secret]));

      const script =
        `printf 'shell=%s\\nstdout=${secret}\\n' "$0"; ` +
        `printf 'stderr=${secret}\\n' >&2`;
      const result = await dockerRun(
        ["/bin/sh", "-c", 'exec /bin/bash -c "$1"', "parent", script],
        {
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SECRETS_FILE: `${containerFixtureDir}/secrets.frame`,
          },
          extraArgs: ["-v", `${fixtureDir}:${containerFixtureDir}:ro`],
        },
      );

      expect(result.code).toEqual(0);
      expect(result.stdout).toContain("shell=/bin/bash");
      expect(result.stdout).toContain(`stdout=${masked}`);
      expect(result.stderr).toContain(`stderr=${masked}`);
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run the focused tests and verify the absolute-path case fails**

Run:

```bash
bun test src/stages/launch/integration_test.ts --test-name-pattern "absolute /bin/bash"
```

Expected with Docker and the Zig binary available: the disabled-filter test passes, while `absolute /bin/bash masks stdout and stderr while preserving argv0` fails because `my-secret-password` is still present instead of 18 asterisks. If Docker or the binary is unavailable, the applicable test is skipped; record that limitation and continue with the code reviewable through the test diff.

- [ ] **Step 3: Install a non-recursive wrapper over the resolved system Bash**

Move the Bash-override setup to immediately after `HOSTEXEC_PATH_PREFIX` is computed and before the `NAS_SHELL_MODE` branch. Replace the duplicated shell-mode and normal-mode wrapper generation with this single setup block:

```bash
# --- bash override ---
NAS_BASH_OVERRIDE="/tmp/nas-bash-override"
NAS_REAL_BASH="/bin/bash"
mkdir -p "$NAS_BASH_OVERRIDE"

if [ -n "${NAS_MASK_FILTER:-}" ] && [ -n "${NAS_MASK_SECRETS_FILE:-}" ]; then
  BASH_SYSTEM_PATH="$(readlink -f /bin/bash)"
  NAS_REAL_BASH="$NAS_BASH_OVERRIDE/bash.real"

  if [ ! -x "$NAS_REAL_BASH" ]; then
    cp --preserve=mode "$BASH_SYSTEM_PATH" "$NAS_REAL_BASH"
  fi

  BASH_WRAPPER_TMP="$NAS_BASH_OVERRIDE/bash.tmp.$$"
  cat > "$BASH_WRAPPER_TMP" << 'MASK_WRAPPER'
#!/tmp/nas-bash-override/bash.real
if [ "${1:-}" = "/entrypoint.sh" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ -n "${NAS_MASK_SECRETS_FILE:-}" ] && [ -f "${NAS_MASK_FILTER:-}" ]; then
  exec > >("$NAS_MASK_FILTER") 2> >("$NAS_MASK_FILTER" >&2)
fi
exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
MASK_WRAPPER
  chmod +x "$BASH_WRAPPER_TMP"

  BASH_PATH_WRAPPER_TMP="$NAS_BASH_OVERRIDE/bash.next.$$"
  cp --preserve=mode "$BASH_WRAPPER_TMP" "$BASH_PATH_WRAPPER_TMP"
  mv -f "$BASH_PATH_WRAPPER_TMP" "$NAS_BASH_OVERRIDE/bash"

  BASH_SYSTEM_WRAPPER_TMP="${BASH_SYSTEM_PATH}.nas-wrapper.$$"
  cp --preserve=mode "$BASH_WRAPPER_TMP" "$BASH_SYSTEM_WRAPPER_TMP"
  mv -f "$BASH_SYSTEM_WRAPPER_TMP" "$BASH_SYSTEM_PATH"
  rm -f "$BASH_WRAPPER_TMP"

  # Nix devshell source may reset SHELL; apply this after sourcing it.
  if [ -z "$NAS_ENV_OPS_FILE" ]; then
    NAS_ENV_OPS_FILE="$(mktemp /tmp/nas-env-ops.XXXXXX)"
    chmod 644 "$NAS_ENV_OPS_FILE"
  fi
  echo "export SHELL='$NAS_BASH_OVERRIDE/bash'" >> "$NAS_ENV_OPS_FILE"
  nas_debug "[nas] mask-filter: NAS_ENV_OPS_FILE=$NAS_ENV_OPS_FILE"
  nas_debug "[nas] mask-filter: env-ops content=$(cat "$NAS_ENV_OPS_FILE" 2>/dev/null | tail -3)"
elif [ -x /bin/bash ]; then
  ln -sf /bin/bash "$NAS_BASH_OVERRIDE/bash"
fi

export NAS_BASH_OVERRIDE NAS_REAL_BASH
export PATH="${NAS_BASH_OVERRIDE}:${PATH}"
```

This removes both existing wrapper heredocs and every read/write of `__NAS_MASK_FILTER_SKIP`. The adjacent `${BASH_SYSTEM_PATH}.nas-wrapper.$$` file makes the final replacement a same-filesystem rename even if `/tmp` is mounted separately. Keep `set -euo pipefail` responsible for aborting on failed resolve, copy, chmod, or rename.

- [ ] **Step 4: Route every entrypoint-owned Bash through the preserved executable**

In the shell-mode branch, retain `SHELL_PATH_PREFIX` and the existing environment-cache logic, but remove its local `NAS_BASH_OVERRIDE_DIR` setup. Replace both final interactive launches:

```bash
exec_nas "${EXEC_PREFIX[@]}" "$NAS_REAL_BASH" --noprofile --rcfile "$SHELL_RC_FILE" -i
```

```bash
exec_nas "${EXEC_PREFIX[@]}" "$NAS_REAL_BASH" -i
```

Set `SHELL_PATH_PREFIX` from the unified variable:

```bash
SHELL_PATH_PREFIX="${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE}:"
```

In all five Nix launch paths currently ending in `bash -c`, replace the executable token with the quoted preserved path while leaving each command string unchanged:

```bash
"$NAS_REAL_BASH" -c "..."
```

Do not route `exec_agent_command` through Bash. It must continue to directly execute `AGENT_COMMAND`, allowing Codex itself to retain the container terminal while its later `/bin/bash` children hit the wrapper.

- [ ] **Step 5: Run focused and neighboring integration tests**

Run:

```bash
bun test src/stages/launch/integration_test.ts --test-name-pattern "absolute /bin/bash|container runs command|non-zero exit code|USER and HOME|hostexec wrapper"
```

Expected with Docker and the Zig binary available: all selected tests pass. The absolute-path test reports `/bin/bash`, replaces both secret occurrences with 18 asterisks, and exposes no plaintext secret. Without Docker, Bun reports the Docker-dependent tests skipped rather than failed.

- [ ] **Step 6: Run repository post-change checks**

Run each command in order, stopping on the first failure:

```bash
bun run fmt
bun run lint
bun run check
bun test
```

Expected: formatting, lint, strict type checking, and the test suite pass. Docker-dependent tests may be skipped when the daemon is unavailable; record their skip count and the focused-test limitation in the task result.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/docker/embed/entrypoint.sh src/stages/launch/integration_test.ts
git commit -m "fix(entrypoint): filter absolute bash commands"
```
