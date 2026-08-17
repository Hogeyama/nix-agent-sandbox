# Environment-Independent Bash Mask Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the generated Bash mask wrapper usable and fail-closed when a child process omits `NAS_MASK_FILTER` and `NAS_MASK_SOCKET`.

**Architecture:** At entrypoint installation time, serialize the already validated filter and socket paths into private, read-only assignments in the generated wrapper with Bash `printf '%q'`. Ordinary wrapper invocations use only those captured paths; the existing entrypoint re-entry and nested-supervision branches continue to bypass a new supervisor for their existing reasons.

**Tech Stack:** Bash entrypoint generation, Bun/TypeScript tests, Docker integration tests, Zig `nas-mask-filter` fixture.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-08-17-env-independent-bash-mask-filter-design.md`.
- Follow repository guidance in `AGENTS.md` and the `security-constraints`, `test-policy`, `effect-separation`, `post-change-checks`, and `verification-before-completion` skills.
- Preserve fail-closed status 121 with no requested-command output when the captured broker socket is unavailable.
- Preserve exactly one supervisor layer for nested Bash processes.
- Preserve the `/entrypoint.sh` TTY re-entry bypass and the `NAS_MASK_SUPERVISED` bypass.
- Do not add shell-wide enforcement, Hooks, `LD_PRELOAD`, Codex runtime changes, or model-request masking.
- Do not write secret values into the wrapper; only the non-secret filter binary and session socket paths may be captured.
- Use TDD: observe the stripped-environment regression test fail before changing the wrapper's runtime path selection.

## File Structure

- Modify `src/docker/embed/entrypoint.sh`: generate fixed private wrapper assignments and use them for supervision.
- Modify `src/stages/maskfs/mask_filter_integration_test.ts`: reconstruct the generated wrapper with installation-time paths and cover stripped env, unavailable socket, and nesting.
- Modify `src/stages/launch/integration_test.ts`: exercise entrypoint installation followed by an agent command that removes the public variables.
- Modify `docs/todo/codex.md`: mark item 4 fixed and record the bounded behavior.

---

### Task 1: Capture broker paths in the generated Bash wrapper

**Files:**
- Modify: `src/stages/maskfs/mask_filter_integration_test.ts:93-115,890-994,1073-1100`
- Modify: `src/stages/launch/integration_test.ts:730-855`
- Modify: `src/docker/embed/entrypoint.sh:297-347`
- Modify: `docs/todo/codex.md` (item 4 only)

**Interfaces:**
- Consumes: entrypoint installation variables `NAS_MASK_FILTER: string` and `NAS_MASK_SOCKET: string` after the existing non-empty guard.
- Produces: generated wrapper-private read-only shell variables `nas_mask_filter_path` and `nas_mask_socket_path`.
- Preserves: wrapper CLI and exit behavior; `nas-mask-filter --supervise --argv0 "$0" --socket <path> -- bash.real "$@"`.

- [ ] **Step 1: Split the wrapper template without changing runtime behavior**

Reshape the existing single heredoc into a header and body so tests can reconstruct the generated file around its installation-time assignments. At this step, do not emit fixed assignments in production and retain the existing public-variable guard and `exec` arguments:

```bash
  BASH_WRAPPER_TMP="$NAS_BASH_OVERRIDE/bash.tmp.$$"
  {
    cat << 'MASK_WRAPPER_HEADER'
#!/tmp/nas-bash-override/bash.real
MASK_WRAPPER_HEADER
    cat << 'MASK_WRAPPER_BODY'
if [ "${1:-}" = "/entrypoint.sh" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ -n "${NAS_MASK_SUPERVISED:-}" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ -z "${NAS_MASK_FILTER:-}" ] || [ -z "${NAS_MASK_SOCKET:-}" ]; then
  exit 121
fi
exec "$NAS_MASK_FILTER" --supervise --argv0 "$0" --socket "$NAS_MASK_SOCKET" -- \
  /tmp/nas-bash-override/bash.real "$@"
MASK_WRAPPER_BODY
  } > "$BASH_WRAPPER_TMP"
```

- [ ] **Step 2: Teach the wrapper fixture to accept installation-time paths**

Replace `writeWrapperScript()` with a fixture that extracts the header and body heredocs from Step 1 and emits the two assignment lines between them. Use the preserved Bash itself to produce the same `%q` serialization as production:

```ts
function quoteForBash(value: string): string {
  const proc = Bun.spawnSync(
    [realBashPath(), "-c", `printf '%q' "$1"`, "bash", value],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `failed to quote Bash word: ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
  return new TextDecoder().decode(proc.stdout);
}

function writeWrapperScript(filterPath: string, socketPath: string): string {
  const entry = fs.readFileSync(
    path.join(import.meta.dir, "../../docker/embed/entrypoint.sh"),
    "utf8",
  );
  const header = entry.match(
    /<< 'MASK_WRAPPER_HEADER'\n([\s\S]*?)\nMASK_WRAPPER_HEADER\n/,
  );
  const body = entry.match(
    /<< 'MASK_WRAPPER_BODY'\n([\s\S]*?)\nMASK_WRAPPER_BODY\n/,
  );
  if (!header || !body) throw new Error("MASK_WRAPPER heredocs not found");
  const script = [
    header[1],
    `readonly nas_mask_filter_path=${quoteForBash(filterPath)}`,
    `readonly nas_mask_socket_path=${quoteForBash(socketPath)}`,
    body[1],
  ]
    .join("\n")
    .replaceAll("/tmp/nas-bash-override/bash.real", realBashPath());
  const p = path.join(tmpDir, `wrapper-${secretsFileSeq++}.sh`);
  fs.writeFileSync(p, `${script}\n`, { mode: 0o755 });
  return p;
}
```

Update the existing nesting tests to call:

```ts
const wrapper = writeWrapperScript(binaryPath!, sockPath);
```

Keep their current environments and assertions, including `layers=1`.

- [ ] **Step 3: Replace the old stripped-env expectation with the desired masked behavior**

Replace `fails closed with no output when the broker env is stripped` with:

```ts
test.skipIf(!binaryPath)(
  "uses captured broker paths when the public environment is stripped",
  async () => {
    const sockPath = shortSockPath("stripped");
    const server = startServe(writeSecretsFile(["hunter2"]), sockPath);
    try {
      expect(await waitForSocket(sockPath)).toBe(true);
      const wrapper = writeWrapperScript(binaryPath!, sockPath);
      const proc = Bun.spawn(
        [
          wrapper,
          "-c",
          "printf 'stdout=hunter2\\n'; printf 'stderr=hunter2\\n' >&2",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {} },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(0);
      expect(stdout).toBe("stdout=*******\n");
      expect(stderr).toBe("stderr=*******\n");
    } finally {
      server.kill();
      await server.exited;
      fs.rmSync(sockPath, { force: true });
    }
  },
  15000,
);
```

- [ ] **Step 4: Add a stripped-env unavailable-socket test**

Immediately after the success case, add:

```ts
test.skipIf(!binaryPath)(
  "fails closed when the captured broker is unavailable under a stripped environment",
  async () => {
    const sockPath = shortSockPath("stripped-dead");
    const markerPath = path.join(tmpDir, `ran-${secretsFileSeq++}`);
    const wrapper = writeWrapperScript(binaryPath!, sockPath);
    const proc = Bun.spawn(
      [
        wrapper,
        "-c",
        `printf 'command-stdout\\n'; printf 'command-stderr\\n' >&2; touch "${markerPath}"`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {} },
    );
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).toBe(121);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(fs.existsSync(markerPath)).toBe(false);
  },
  15000,
);
```

- [ ] **Step 5: Add the full entrypoint regression test**

After `absolute /bin/bash masks command, login, and script invocations`, add this Docker test. The entrypoint receives both variables and installs the wrapper; only the later agent command removes them:

```ts
test.skipIf(!canBindMount)(
  "Integration: captured mask paths survive an agent child with stripped public variables",
  async () => {
    const fixtureDir = await makeTempDir("nas-e2e-mask-stripped-");
    const workDir = await makeTempDir("nas-e2e-mask-stripped-ws-");
    const containerFixtureDir = "/tmp/nas-mask-stripped-test";
    const secret = "codex-stripped-env-secret";
    const masked = "*".repeat(secret.length);
    let broker: MaskBroker | null = null;

    try {
      const filterPath = await writeMaskFilterFixture(fixtureDir);
      broker = await startMaskBroker(filterPath, [secret]);
      const result = await dockerRun(
        [
          "/usr/bin/env",
          "-u",
          "NAS_MASK_FILTER",
          "-u",
          "NAS_MASK_SOCKET",
          "/bin/bash",
          "-c",
          `printf 'codex=${secret}\\n'`,
        ],
        {
          workDir,
          envVars: {
            NAS_MASK_FILTER: `${containerFixtureDir}/nas-mask-filter`,
            NAS_MASK_SOCKET: broker.socketPath,
          },
          extraArgs: [
            "-v",
            `${fixtureDir}:${containerFixtureDir}:ro`,
            "-v",
            `${broker.socketDir}:${broker.socketDir}:ro`,
          ],
        },
      );
      expect(result.code).toEqual(0);
      expect(result.stdout).toContain(`codex=${masked}`);
      expect(result.stdout).not.toContain(secret);
    } finally {
      await broker?.stop();
      await rm(fixtureDir, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 6: Run the new tests and verify the production wrapper is still red**

Run:

```bash
bun test src/stages/maskfs/mask_filter_integration_test.ts --test-name-pattern 'captured broker paths|captured broker is unavailable|wrappers nest|second supervisor'
bun test src/stages/launch/integration_test.ts --test-name-pattern 'captured mask paths survive'
```

Expected: both stripped-environment success cases fail with exit 121 because the production wrapper body still selects its paths from the invocation environment. The unavailable-socket and nesting cases continue to pass.

- [ ] **Step 7: Generate and consume fixed private paths in entrypoint**

Add the two production assignment lines between the header and body heredocs, then remove the runtime public-variable guard and switch the supervisor to the private values:

```bash
  BASH_WRAPPER_TMP="$NAS_BASH_OVERRIDE/bash.tmp.$$"
  {
    cat << 'MASK_WRAPPER_HEADER'
#!/tmp/nas-bash-override/bash.real
MASK_WRAPPER_HEADER
    printf 'readonly nas_mask_filter_path=%q\n' "$NAS_MASK_FILTER"
    printf 'readonly nas_mask_socket_path=%q\n' "$NAS_MASK_SOCKET"
    cat << 'MASK_WRAPPER_BODY'
if [ "${1:-}" = "/entrypoint.sh" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
if [ -n "${NAS_MASK_SUPERVISED:-}" ]; then
  exec -a "$0" /tmp/nas-bash-override/bash.real "$@"
fi
exec "$nas_mask_filter_path" --supervise --argv0 "$0" \
  --socket "$nas_mask_socket_path" -- \
  /tmp/nas-bash-override/bash.real "$@"
MASK_WRAPPER_BODY
  } > "$BASH_WRAPPER_TMP"
```

Update the adjacent comment to say that the wrapper captures the validated non-secret paths at installation, so stripping the public variables no longer blocks Bash. Retain the explanation that a missing/dead captured socket fails closed with 121 and that ordinary invocations never fall back to `bash.real`.

- [ ] **Step 8: Run focused tests and confirm green behavior**

Run:

```bash
bun test src/stages/maskfs/mask_filter_integration_test.ts --test-name-pattern 'captured broker paths|captured broker is unavailable|wrappers nest|second supervisor'
bun test src/stages/launch/integration_test.ts --test-name-pattern 'captured mask paths survive|broker is unreachable|supervised marker'
```

Expected: all selected tests pass, or Docker-only cases are explicitly reported skipped when Docker/bind mounts are unavailable. No selected test fails.

- [ ] **Step 9: Update the Codex TODO item**

In item 4 of `docs/todo/codex.md`:

- change the heading suffix to `（2026-08-17 修正済み）`;
- retain the investigation and root-cause notes as historical context;
- replace `対応候補` with `対応` and state that entrypoint now embeds the validated filter/socket paths with `printf '%q'` into private read-only wrapper variables;
- state that a child missing the public variables now runs through the fixed broker and remains masked;
- retain the boundary that alternate shells are outside this fix; and
- replace `状態: **未修正**` with `状態: **修正済み**`, noting that a dead captured broker still suppresses output and exits 121.

- [ ] **Step 10: Run repository post-change checks**

Run the project-standard checks in this order:

```bash
bun run fmt
bun run lint
bun run check
bun test
```

Then, when Docker is available, run:

```bash
bun test src/stages/launch/integration_test.ts --test-name-pattern 'absolute /bin/bash|captured mask paths|supervised marker|shell re-entry'
```

Expected: formatting, linting, type checking, and unit tests pass; the selected Docker regression set passes or reports prerequisite skips, with no failures.

- [ ] **Step 11: Inspect the final diff for scope and security invariants**

Run:

```bash
git diff --check
git diff -- src/docker/embed/entrypoint.sh src/stages/maskfs/mask_filter_integration_test.ts src/stages/launch/integration_test.ts docs/todo/codex.md
```

Confirm all of the following from the diff:

- only binary/socket paths, never secret values, are embedded;
- public runtime env does not select the filter or socket;
- unavailable broker behavior remains exit 121 without command output;
- early branch ordering is unchanged;
- no alternate-shell enforcement or request masking was added; and
- item 4 does not claim broader protection than `/bin/bash` wrapper invocations.

- [ ] **Step 12: Commit the completed implementation**

```bash
git add src/docker/embed/entrypoint.sh \
  src/stages/maskfs/mask_filter_integration_test.ts \
  src/stages/launch/integration_test.ts \
  docs/todo/codex.md
git commit -m "fix(mask-filter): preserve broker paths in Bash wrapper"
```

The commit body must explain that Codex reconstructs child environments without the two public variables, and that installation-time path capture restores availability while preserving dead-broker fail-closed behavior.
