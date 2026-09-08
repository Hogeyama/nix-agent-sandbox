# Direnv Environment Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development with patched-superpowers to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The written plan requires user approval before implementation.

**Goal:** Replace nas-managed devShell loading and `nix.extraPackages` with opt-in `direnv.enable`, refusing to launch through an unapproved `.envrc`.

**Architecture:** A small container-side launcher checks native direnv approval and evaluates the environment as the agent user. Mount probes locate host approval data; the pure mount planner shares it read-only. Nix mounting remains independent while configuration and entrypoint code lose nas-specific environment evaluation and caching.

**Tech Stack:** Bun/TypeScript, Pkl, Bash, direnv, Docker, Nix packaging, Astro documentation.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-09-08-direnv-enable-design.md`.
- Worktree: `/home/hogeyama/repo/nix-agent-sandbox/.worktrees/direnv-enable`; branch: `feat/direnv-enable`.
- Read the repository `AGENTS.md`, `skills/security-constraints/SKILL.md`, `skills/effect-separation/SKILL.md`, `skills/test-policy/SKILL.md`, and `skills/post-change-checks/SKILL.md` before implementation. Documentation also follows `docs-site/AGENTS.md` and `skills/reader-decision-writing/SKILL.md`.
- `direnv.enable` defaults to `false`. `nix.enable` and `nix.mountSocket` retain their existing defaults and mounting behavior, except for removal of the nas devShell cache mount.
- nas never calls `direnv allow`. Unapproved, changed, or denied RC files stop startup. A missing RC allows startup without an additional environment.
- Host approval data is read-only. Host direnv configuration, HOME, and environment dumps are not automatically shared.
- Evaluate inside the container, after dropping to the agent user. Preserve native path/content approval semantics for worktrees.
- Initial agent launch and additional `--shell` launch use the same approval check. Reattachment to an existing process does not reload; installing an interactive shell hook is out of scope.
- Preserve argv, exit status, terminal ownership, env prefix/suffix operations, and hostexec/bash-wrapper PATH priority.
- Do not delete existing host cache files, change hostexec approval policy, or fix the unrelated interceptor TLS issue in this branch.
- Local Bun and Node tooling currently needs `env -u LD_PRELOAD` because the installed interceptor causes thread creation failures. Baseline: 3371 unit tests passed, 9 skipped, 0 failed.
- While iterating, use unit tests and the named integration files. The user-provided AGENTS instructions require `bun run test` once as the final full check; that instruction takes precedence over the skill's generic NAS unit-only guidance. Report integration skips accurately; never move tests to the host implicitly.
- Before Task 1, record `implementation-base: <current HEAD>` in the progress ledger. Review each task with the patched-superpowers reviewer before continuing; use git-commit for every commit.

## File and responsibility map

| Files | Responsibility |
| --- | --- |
| New `src/docker/embed/direnv-exec.sh` | Native approval check, environment evaluation, final env/PATH application, exec |
| New `src/docker/direnv_exec_test.ts`, `src/docker/direnv_exec_integration_test.ts` | Fake-command boundary tests and real-direnv behavior tests |
| `src/docker/embed/Dockerfile`, `src/docker/client.ts`, `flake.nix` | Install direnv and ship/hash the launcher in every distribution |
| `src/config/Schema.pkl`, `src/config/types.ts`, `src/config/validate.ts` | New option, retired option, raw-config migration errors |
| New `src/config/retired_nix.ts`, `src/config/retired_nix_test.ts` | Retired-field diagnostics and legacy-object migration |
| New `src/lib/pkl_source.ts` | Existing Pkl source masking code shared by migration diagnostics |
| `src/network/authz/validate.ts`, `src/config/load.ts`, `src/config/migrate.ts` | Reuse lexical masking, report retired fields before Pkl evaluation, stop invalid migrations |
| `src/stages/mount/mount_probes.ts`, `src/stages/mount/stage.ts`, `src/stages/mount.ts` | Approval-data discovery/mount, runtime flag, old cache/extra-package removal |
| `src/docker/embed/entrypoint.sh`, `src/stages/nix_detect/stage.ts` | Unified agent/shell launch and removal of automatic Nix evaluation |
| Existing profile/mount/config tests | New required profile field and assertions for the changed contract |
| `docs-site/editorial/pages.md`, `docs-site/src/content/docs/configuration/development.md`, `src/config/templates/config.pkl` | Migration, allow/error recovery, optional setting example |

## Task 1: Package an independently testable direnv launcher

**Files:** Create the three `direnv_exec`/`direnv-exec` files above. Modify `src/docker/embed/Dockerfile`, `src/docker/client.ts`, and `flake.nix`.

**Interfaces:** The executable is installed at `/usr/local/bin/nas-direnv-exec` and takes:

```text
nas-direnv-exec WORKSPACE ENV_OPS_FILE PATH_PREFIX COMMAND [ARG...]
```

It consumes `NAS_DIRENV_ENABLED` (`true` or absent/false) and `NAS_REAL_BASH` (an absolute executable path). `ENV_OPS_FILE` may be empty. `PATH_PREFIX` includes its trailing colon when nonempty. Callers invoke it under the existing `EXEC_PREFIX`, so it must not create users or perform root setup. No new TypeScript service is needed for this container-local executable.

- [ ] **1. Add boundary tests with fake executables.** Use temporary directories and executable fake `direnv` scripts, allowed in the unit lane. Test that disabled mode never invokes direnv; malformed status and status-command failure do not launch the payload; arguments containing spaces, quotes, and shell metacharacters remain separate literal argv entries; a payload exit status of 37 remains 37. Do not run Docker in this file.

  Build the child argv with an array, never shell interpolation:

  ```typescript
  const proc = Bun.spawn(
    ["bash", launcherPath, workspace, opsFile, prefix, "bash", "-c", "exit 37"],
    { env: childEnv, stdout: "pipe", stderr: "pipe" },
  );
  expect(await proc.exited).toBe(37);
  ```

  Each fixture uses `mkdtemp(path.join(tmpdir(), "nas-direnv-exec-"))` and removes that directory in `finally`. Resolve `launcherPath` with `new URL("./embed/direnv-exec.sh", import.meta.url)` and `fileURLToPath`. Use `childEnv` cloned from `process.env` with an isolated HOME/XDG tree and fake-bin prefix.

- [ ] **2. Implement the complete launcher.** Start with this executable structure:

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail

  if [ "$#" -lt 4 ]; then
    echo 'usage: nas-direnv-exec WORKSPACE ENV_OPS_FILE PATH_PREFIX COMMAND [ARG...]' >&2
    exit 64
  fi
  workspace=$1
  ops_file=$2
  path_prefix=$3
  shift 3
  real_bash=${NAS_REAL_BASH:?NAS_REAL_BASH must be set}

  finish='set -euo pipefail
  ops_file=$1; path_prefix=$2; shift 2
  if [ -n "$ops_file" ]; then source "$ops_file"; fi
  export PATH="${path_prefix}${PATH}"
  exec "$@"'

  if [ "${NAS_DIRENV_ENABLED:-false}" != true ]; then
    exec "$real_bash" -c "$finish" nas-direnv "$ops_file" "$path_prefix" "$@"
  fi

  # Never reverse a host-side direnv environment diff in this container.
  unset DIRENV_DIFF DIRENV_DIR DIRENV_FILE DIRENV_WATCHES DIRENV_LAYOUT_DIR
  cd -- "$workspace"
  if ! status=$(direnv status --json); then
    echo '[nas] direnv status failed; refusing to start.' >&2
    exit 1
  fi
  if ! jq -e '
    (.state | type == "object") and
    (.state | has("foundRC")) and
    (.state.foundRC == null or
      ((.state.foundRC.path | type == "string") and
       (.state.foundRC.allowed | type == "number")))
  ' >/dev/null <<<"$status"; then
    echo '[nas] Invalid direnv status; refusing to start.' >&2
    exit 1
  fi
  if ! jq -e '.state.foundRC == null or .state.foundRC.allowed == 0' \
      >/dev/null <<<"$status"; then
    rc_path=$(jq -r '.state.foundRC.path' <<<"$status")
    printf '[nas] direnv has not allowed %q. On the host, run: direnv allow %q\n' \
      "$rc_path" "$rc_path" >&2
    echo '[nas] If this is a new nas worktree, keep it at cleanup and reuse it after allowing.' >&2
    exit 1
  fi

  exec direnv exec "$workspace" "$real_bash" -c "$finish" \
    nas-direnv "$ops_file" "$path_prefix" "$@"
  ```

  Native status codes are `0` allowed, `1` not allowed, `2` denied. Accept only `0` when an RC exists. Do not use `eval "$(direnv export bash)"`: exporting shell text can obscure failure and accidentally apply a partial environment. `direnv exec` must propagate its own failure.

- [ ] **3. Add real-direnv integration cases.** The file-local capability probe uses `Bun.which("direnv")` and `Bun.which("jq")`, with `test.skipIf` for missing dependencies. An isolated fixture creates `workspace`, `data`, `config`, and `cache` directories. Set HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, and NAS_REAL_BASH only on spawned processes; never mutate the process-global HOME. Tests may call `direnv allow` in their private fixture to model the human's action; production code may not.

  The essential denial fixture writes this RC and uses a separate payload marker:

  ```bash
  printf evaluated > "$PWD/rc-ran"
  export NAS_DIRENV_TEST_VALUE=loaded
  ```

  Run the launcher while unapproved and assert nonzero exit, an allow instruction naming the RC path, no `rc-ran`, and no payload marker. Allow it and assert both the variable and markers. Change the RC contents and assert rejection again. Call `direnv deny` and assert rejection rather than a successful payload with no environment. Use a new directory with identical RC contents to assert path-specific approval. Additional cases: no RC, `exit 23` in the RC, inherited invalid DIRENV_DIFF, PATH reset in the RC followed by wrapper-prefix restoration, and env-ops prefix/suffix applied after the RC.

- [ ] **4. Package the executable and dependency.** Add `direnv` to the existing Dockerfile apt list; copy the new asset to `/usr/local/bin/nas-direnv-exec` and mark it executable:

  ```dockerfile
  COPY direnv-exec.sh /usr/local/bin/nas-direnv-exec
  RUN chmod +x /entrypoint.sh /usr/local/bin/nas-direnv-exec
  ```

  Add `"direnv-exec.sh"` to `EMBEDDED_ASSET_GROUPS[0].files` in `src/docker/client.ts`, so environment-launcher changes invalidate the image hash. Add the corresponding asset copy beside entrypoint.sh in `flake.nix`:

  ```nix
  cp ${self}/src/docker/embed/direnv-exec.sh $out/docker/embed/
  ```

  Add `pkgs.direnv` to the development shell packages for integration tests. If the current shell lacks it, obtain direnv from this repository's locked nixpkgs input and prepend that store path only to the test environment. Do not download a different version from an arbitrary mirror or use hostexec to run the tests.

- [ ] **5. Verify and commit.** Run `bash -n src/docker/embed/direnv-exec.sh`, `env -u LD_PRELOAD bun test src/docker/direnv_exec_test.ts`, and `env -u LD_PRELOAD bun test src/docker/direnv_exec_integration_test.ts`. The integration lane must actually execute when direnv/jq are available; a skip does not prove the launcher works. Record missing capabilities. Commit the helper, tests, and packaging together, then run the task reviewer.

## Task 2: Wire the profile and replace the Nix launch path

**Files:** Modify `src/config/Schema.pkl`, `src/config/types.ts`, `src/config/validate.ts`, `src/config/load.ts`, `src/config/migrate.ts`; create `src/config/retired_nix.ts`, `src/config/retired_nix_test.ts`, `src/lib/pkl_source.ts`; update `src/network/authz/validate.ts` to import its existing masking implementation. Modify the mount and entrypoint files in the map. Tests: `src/config/validate_test.ts`, `src/config/migrate_test.ts`, `src/config/load_integration_test.ts`, `src/config/repo_pkl_test.ts`, `src/config/pkl_integration_test.ts`, `src/stages/mount/stage_test.ts`, `src/stages/mount/integration_test.ts`, and the existing profile/probe fixtures located by the command below.

**Interfaces produced:**

```typescript
export interface DirenvConfig { enable: boolean; }
export const DEFAULT_DIRENV_CONFIG: DirenvConfig = { enable: false };
// Profile gains: direnv: DirenvConfig
// MountProbes gains: direnvDataDir: string | null
```

`direnvDataDir` is the existing absolute host `${XDG_DATA_HOME:-HOME/.local/share}/direnv` directory, or null. Task 1 consumes the emitted `NAS_DIRENV_ENABLED` flag and existing `NAS_REAL_BASH`.

- [ ] **1. Add schema/default and retired-field tests, then implement the profile.** In Schema.pkl, add `direnv: DirenvConfig = new {}` to Profile and define:

  ```pkl
  class DirenvConfig {
    /// 起動時に許可済みの .envrc をコンテナ内で読み込む。
    enable: Boolean = false
  }
  ```

  Remove `extraPackages` from NixConfig and its TypeScript interface/default. Bump the bundled schema version from `0.14.1` to `0.15.3` so version-aware global schema replacement works. Check schema-version tests for assumptions; do not edit a user's installed global schema. Add Pkl evaluation cases proving absent direnv yields false and explicit true works without requiring Nix. Update all full Profile and MountProbes fixture literals while preserving each test's other values:

  ```bash
  rg -l 'extraPackages|MountProbes|DEFAULT_NIX_CONFIG' src tests --glob '*.ts'
  ```

  Full profile literals gain `direnv: { enable: false }`; old `nix` literals lose the empty extraPackages entry. Compiler errors locate full profile fixtures that did not use the old Nix field. Do not silence these errors with `as Profile`, optional types, or runtime defaults in every consumer.

- [ ] **2. Provide migration diagnostics at both source and raw-object boundaries.** Move the existing `maskNonCode`, `stringOpener`, and `containsIdentifier` implementation from the end of `src/network/authz/validate.ts` into `src/lib/pkl_source.ts`, exporting them. Keep existing network diagnostics unchanged by importing these functions. This reuses handling of Pkl strings, comments, and interpolation instead of adding a second lexer.

  `src/config/retired_nix.ts` exports:

  ```typescript
  export const NIX_EXTRA_PACKAGES_MIGRATION =
    "nix.extraPackages is no longer supported. Define packages in .envrc or " +
    "a devShell, set direnv.enable = true, and run direnv allow on the host.";

  export function retiredNixSourceErrors(source: string, fileName: string): string[] {
    return maskNonCode(source).split("\n").flatMap((line, index) =>
      containsIdentifier(line, "extraPackages")
        ? [`${fileName}:${index + 1}: ${NIX_EXTRA_PACKAGES_MIGRATION}`]
        : [],
    );
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  export function normalizeLegacyNixPackages(
    raw: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!isRecord(raw.profiles)) return raw;
    const profiles = Object.fromEntries(Object.entries(raw.profiles).map(([name, profile]) => {
      if (!isRecord(profile) || !isRecord(profile.nix)) return [name, profile];
      const nix = { ...profile.nix };
      for (const key of ["extraPackages", "extra-packages"]) {
        if (!(key in nix)) continue;
        const value = nix[key];
        if (!Array.isArray(value) || value.length !== 0) {
          throw new Error(`profile "${name}": ${NIX_EXTRA_PACKAGES_MIGRATION}`);
        }
        delete nix[key];
      }
      return [name, { ...profile, nix }];
    }));
    return { ...raw, profiles };
  }
  ```

  Implement source diagnostics by masking non-code, scanning lines for the retired identifier `extraPackages`, and returning `fileName:line` plus the migration message. Combine these errors with existing source diagnostics for the local config and referenced global.pkl in load.ts. Test comments and normal/raw/multiline strings remain accepted; executable references, including interpolation, are rejected. Do not inspect an unrelated global.pkl when it is not referenced.

  Replace `validateNixExtraPackages` with a presence check at the raw boundary:

  ```typescript
  if ("extraPackages" in profile.nix) {
    errors.push(`profile "${name}": ${NIX_EXTRA_PACKAGES_MIGRATION}`);
  }
  ```

  This rejects even an empty retired field in an already-evaluated config. A legacy conversion has a different contract: `normalizeLegacyNixPackages` shallow-copies profiles and their nix objects, removes `extraPackages` or `extra-packages` only when the value is an empty array, and throws the profile-named migration error for any other value. It must leave the input object unchanged. Invoke it in `objectToPklSource` before rendering so YAML, local Nix, and global Nix conversions all use it. Test both spellings, empty and nonempty lists, unrelated profile fields, and absence of partially written output after failure.

- [ ] **3. Discover and mount native approval data.** In `resolveMountProbes`, inspect the host data directory only when profile.direnv.enable is true. Return the path only for an existing directory. Missing paths become null; permission and other unexpected filesystem errors propagate. Do not create host directories just to mount an empty approval store.

  In the pure mount planner, emit the flag and read-only mount independently of the Nix branch:

  ```typescript
  if (profile.direnv.enable) {
    envVars.NAS_DIRENV_ENABLED = "true";
    if (probes.direnvDataDir !== null) {
      addMount(args, mounts, probes.direnvDataDir,
        `${containerHome}/.local/share/direnv`, true);
    }
  }
  ```

  Place final target selection after explicit profile environment values have been resolved: when a static container XDG_DATA_HOME is set, mount to `${resolvedXdgDataHome}/direnv` instead of the default. Resolve relative/tilde inputs with the existing container path rules. Preserve a default target when XDG_DATA_HOME is absent/empty. Dynamic prefix/suffix env operations run after direnv and do not relocate its startup approval store.

  Test disabled mode produces neither flag nor mount; enabled mode works with Nix disabled; custom host XDG paths work; absent approval data produces no mount; custom container XDG paths and default paths are correct; mounts are read-only; no host config-directory mount is added. The actual workspace must retain its host absolute path.

- [ ] **4. Remove the old Nix-only data flow.** Delete `serializeNixExtraPackages` and its barrel export, the `NIX_EXTRA_PACKAGES` environment construction, and the nas-cache directory/mount block from MountStage. Keep `/nix`, the Nix configuration/binary setup, NIX_REMOTE, and the separate `.cache/nix` mount. Update mount assertions to prove this distinction, including cases that previously expected both caches.

- [ ] **5. Route both launches through Task 1.** Keep root setup, proxy startup, user setup, and bash wrapper installation in entrypoint.sh. Replace the old shell-cache branch and all Nix integration branches with one final dispatch:

  ```bash
  PATH_PREFIX="${HOSTEXEC_PATH_PREFIX:+$HOSTEXEC_PATH_PREFIX:}${NAS_BASH_OVERRIDE:+$NAS_BASH_OVERRIDE:}"
  if [ "$NAS_SHELL_MODE" = true ]; then
    AGENT_COMMAND=("$NAS_REAL_BASH" -i)
  fi
  exec_nas "${EXEC_PREFIX[@]}" /usr/local/bin/nas-direnv-exec \
    "$WORKSPACE" "$NAS_ENV_OPS_FILE" "$PATH_PREFIX" "${AGENT_COMMAND[@]}"
  ```

  Preserve the existing shell rc behavior and wrapper PATH priority: generate a small rcfile that sources `.bashrc` and restores the wrapper PATH prefix afterwards; pass `--noprofile --rcfile <path> -i` as the shell argv. This rcfile must not source ENV_OPS_FILE again or evaluate direnv again: the helper has already applied each env prefix/suffix operation once. Generate path literals with `printf %q`, not unescaped string interpolation. Test shell startup ordering with a fixture `.bashrc` that changes PATH, and assert env operations are not duplicated. Do not install a direnv prompt hook.

  Update obsolete comments and timing labels (`nix-integration`, shell cache hits) to describe actual behavior. NixDetectStage only detects Nix sharing; its comment must stop promising devShell loading. There must be no nas invocation of `nix eval`/`print-dev-env`/`develop`/extra-package `shell` in entrypoint.sh.

- [ ] **6. Extend execution tests and verify.** Add real-direnv tests for the agent and interactive-shell argv paths; avoid Docker where invoking the packaged launcher with a shell can prove the property. For full entrypoint UID/mount/terminal coverage, add guarded cases to `src/docker/direnv_exec_integration_test.ts` using the current nas image only when it is available. Use unique temporary containers and unconditional cleanup. Assert RC evaluation UID equals the agent UID, host approval mount is read-only, and an unapproved RC cannot launch either payload. An old nas cache file must not be sourced.

  Run:

  ```bash
  env -u LD_PRELOAD bun run test:unit
  env -u LD_PRELOAD bun run check
  env -u LD_PRELOAD bun test src/config/load_integration_test.ts src/config/pkl_integration_test.ts src/docker/direnv_exec_integration_test.ts
  bash -n src/docker/embed/entrypoint.sh
  rg -n 'NIX_EXTRA_PACKAGES|serializeNixExtraPackages|nix-dev-env|nix develop|nix print-dev-env' src/stages/mount src/docker/embed
  ```

  Expected: unit/type checks pass; integration cases pass or identify their specific missing capability; the search finds no production path for retired behavior. Remaining `extraPackages` occurrences should be migration diagnostics and tests of old input. Commit this complete switchover and run the task reviewer.

## Task 3: Publish migration instructions and verify the complete change

**Files:** `docs-site/editorial/pages.md`, `docs-site/src/content/docs/configuration/development.md`, `src/config/templates/config.pkl`. Update other active documentation or guide facts only if they still promise automatic devShell loading. Historical specs/plans are records and must not be mass-rewritten.

**Interfaces:** The guide documents Task 2's `direnv.enable`, native host allow, and separate Nix sharing. Examples must evaluate against the final bundled schema.

- [ ] **1. Update the reader's task and write the guide.** Change the development page's editorial row to: choose the project environment, enable direnv, approve the actual RC on the host, verify the tool, then configure Docker if needed. Replace its introductory Nix/extra-packages promise with the new workflow:

  ```pkl
  direnv = new DirenvConfig {
    enable = true
  }
  ```

  ```sh
  # .envrc, when the project uses a flake devShell
  use flake
  ```

  ```sh
  direnv allow /absolute/path/to/project/.envrc
  nas
  ```

  Explain at the corresponding step: default false; RC absence is a no-op; unapproved/changed/denied RC and evaluation errors stop startup; new worktree paths need their own allow, keeping/reusing the worktree after the first error; host approval data is read-only; custom direnvrc is not automatically shared. Keep Nix store/daemon implications in the Nix subsection. Replace old extraPackages examples with defining tools in the project's devShell/.envrc. Explicitly tell existing users that `nix.enable` alone no longer loads the devShell, to remove extraPackages, regenerate schemas using `nas config init`, and re-trust edited config using the existing documented trust flow.

  Add a commented `direnv { enable = true }` example inside the template's `extendProfile`, so generated profiles keep the default false while the opt-in is discoverable. Preserve the Docker and rebuild sections except for links or context necessary for the new opening.

- [ ] **2. Validate documentation and packaging.** Evaluate each edited Pkl example in a temporary module that amends the actual schema and places the block inside a Profile. Run `env -u LD_PRELOAD bun run docs:build` and `git diff --check`. Verify `computeEmbedHash` includes the helper and the packaged Docker build context contains it. Check that the built UI/compiled CLI still find the unchanged asset directory convention; do not accept a source-checkout-only path.

- [ ] **3. Run the final repository checks once.** After task fixes, run formatting, lint, and check in order:

  ```bash
  env -u LD_PRELOAD bun run fmt
  env -u LD_PRELOAD bun run lint
  env -u LD_PRELOAD bun run check
  env -u LD_PRELOAD bun run test
  git diff --check
  ```

  The last test command is the final full-suite invocation required by AGENTS.md, not an iteration command. Record pass/fail/skip counts and which real-direnv/Docker cases ran. A Docker image build requiring network access may skip in NAS; do not claim that the rebuilt image was verified if it was not. If an actual failure occurs, investigate and fix it before completion; rerun only the affected checks unless a further full run is needed to resolve new concerns.

- [ ] **4. Commit and complete reviews.** Commit the guide/template changes and any formatting changes belonging to this task, run the task reviewer, then follow patched-superpowers for whole-diff review and the Forgejo human review. Use the recorded implementation-base, not main, as the review base. Do not merge or rewrite existing history without the corresponding user authorization.

## Plan self-review

- All spec outcomes map to Task 1 (approval/execution), Task 2 (schema/mounts/runtime/removal), or Task 3 (migration/documentation/final checks).
- Native allow is used only in isolated test fixtures; no production auto-allow or source-to-worktree approval transfer is proposed.
- Task 1's executable argv and flag names match Task 2's caller. The helper is included in both Docker asset hashing and Nix distribution copies.
- Source diagnostics reuse the existing Pkl masking implementation, while raw validation catches a retired field even after external evaluation. Legacy conversion has an explicit empty/nonempty policy.
- The required worktree recovery, deny status handling, inherited direnv state cleanup, custom XDG paths, agent UID, env operation order, and shell path are included in test requirements.
- Await written-plan approval before Task 1.
