import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

/** Execute the production startup block with a fake relay; no root or Docker. */
async function runStartup(mode: string, shell = false, enabled = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-entrypoint-relay-"));
  const script = await readFile(
    new URL("./embed/entrypoint.sh", import.meta.url),
    "utf8",
  );
  const block = script.slice(
    script.indexOf("# Initial forwarding must"),
    script.indexOf("# --- エージェントコマンド ---"),
  );
  const relay = path.join(dir, "relay");
  const marker = path.join(dir, "started");
  await writeFile(
    relay,
    `#!/bin/bash
printf '%s %s' "$RELAY_IDENTITY" "$1" > "$NAS_TEST_MARKER"
case "$NAS_TEST_MODE" in
  success) printf 'ready\\n'; exec sleep 30 ;;
  failed) echo 'initial-failed test' >&2; exit 1 ;;
  eof) exit 0 ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        `
set -euo pipefail
EXEC_PREFIX=(env RELAY_IDENTITY=1000)
${block.replace("/usr/local/bin/bun /usr/local/lib/nas/port-relay.mjs", '"$NAS_TEST_RELAY"')}
printf agent-started
if [ -n "\${NAS_INITIAL_RELAY_PROCESS:-}" ]; then
  kill "$NAS_INITIAL_RELAY_PROCESS" 2>/dev/null || true
  wait "$NAS_INITIAL_RELAY_PROCESS" 2>/dev/null || true
fi
`,
      ],
      {
        env: {
          ...process.env,
          NAS_TEST_RELAY: relay,
          NAS_TEST_MARKER: marker,
          NAS_TEST_MODE: mode,
          NAS_PORT_RELAY_STARTUP: enabled ? "1" : "",
          NAS_SHELL_MODE: String(shell),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      code,
      stdout,
      stderr,
      marker: await readFile(marker, "utf8").catch(() => null),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("entrypoint starts one relay under the agent identity and waits for ready", async () => {
  expect(await runStartup("success")).toMatchObject({
    code: 0,
    stdout: "agent-started",
    marker: "1000 --wait-initial",
  });
});

for (const mode of ["failed", "eof"]) {
  test(`entrypoint ${mode} prevents agent execution`, async () => {
    const result = await runStartup(mode);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("agent-started");
    expect(result.stderr).toContain(
      "Initial port forwarding failed or timed out",
    );
  });
}

test("shell and empty initial configuration skip the relay", async () => {
  expect(await runStartup("failed", true)).toMatchObject({
    code: 0,
    stdout: "agent-started",
    marker: null,
  });
  expect(await runStartup("failed", false, false)).toMatchObject({
    code: 0,
    stdout: "agent-started",
    marker: null,
  });
});
