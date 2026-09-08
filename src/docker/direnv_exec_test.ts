import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createDirenvLauncherFixture } from "./direnv_exec_fixture.ts";

interface Fixture {
  launcher: string;
  root: string;
  workspace: string;
  opsFile: string;
  callsFile: string;
  payloadMarker: string;
  payloadArgs: string;
  env: Record<string, string>;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "nas-direnv-exec-"));
  try {
    const workspace = path.join(root, "workspace");
    const fakeBin = path.join(root, "bin");
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const config = path.join(root, "config");
    const cache = path.join(root, "cache");
    await Promise.all(
      [workspace, fakeBin, home, data, config, cache].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );

    const callsFile = path.join(root, "direnv-calls");
    const payloadMarker = path.join(root, "payload-ran");
    const payloadArgs = path.join(root, "payload-args");
    const opsFile = path.join(root, "env-ops.sh");
    await writeFile(opsFile, "");

    const fakeDirenv = path.join(fakeBin, "direnv");
    await writeFile(
      fakeDirenv,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "$DIRENV_CALLS"
case "$1" in
  status)
    if [ "\${FAKE_STATUS_FAIL:-false}" = true ]; then exit 29; fi
    printf '%s\\n' "$FAKE_STATUS_JSON"
    ;;
  exec)
    shift 2
    exec "$@"
    ;;
  *) exit 99 ;;
esac
`,
    );
    await chmod(fakeDirenv, 0o755);

    const env = {
      ...process.env,
      HOME: home,
      XDG_DATA_HOME: data,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      NAS_DIRENV_ENABLED: "true",
      NAS_REAL_BASH: "/bin/bash",
      DIRENV_CALLS: callsFile,
      FAKE_STATUS_JSON: JSON.stringify({ state: { foundRC: null } }),
    } as Record<string, string>;

    const launcher = await createDirenvLauncherFixture(
      root,
      fakeDirenv,
      Bun.which("jq")!,
    );
    await run({
      launcher,
      root,
      workspace,
      opsFile,
      callsFile,
      payloadMarker,
      payloadArgs,
      env,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function launch(
  fixture: Fixture,
  command: string[],
  envOverrides: Record<string, string> = {},
) {
  const proc = Bun.spawn(
    [
      "bash",
      fixture.launcher,
      fixture.workspace,
      fixture.opsFile,
      "",
      ...command,
    ],
    {
      env: { ...fixture.env, ...envOverrides },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("disabled mode launches the payload without invoking direnv", async () => {
  await withFixture(async (fixture) => {
    const result = await launch(
      fixture,
      ["/bin/bash", "-c", `printf ran > "$PAYLOAD_MARKER"`],
      {
        NAS_DIRENV_ENABLED: "false",
        FAKE_STATUS_FAIL: "true",
        PAYLOAD_MARKER: fixture.payloadMarker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(await readFile(fixture.payloadMarker, "utf8")).toBe("ran");
    expect(await Bun.file(fixture.callsFile).exists()).toBe(false);
  });
});

test("a failing direnv status command does not launch the payload", async () => {
  await withFixture(async (fixture) => {
    const result = await launch(
      fixture,
      ["/bin/bash", "-c", `printf ran > "$PAYLOAD_MARKER"`],
      {
        FAKE_STATUS_FAIL: "true",
        PAYLOAD_MARKER: fixture.payloadMarker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("direnv status failed");
    expect(await Bun.file(fixture.payloadMarker).exists()).toBe(false);
  });
});

test("malformed direnv status does not launch the payload", async () => {
  await withFixture(async (fixture) => {
    const result = await launch(
      fixture,
      ["/bin/bash", "-c", `printf ran > "$PAYLOAD_MARKER"`],
      {
        FAKE_STATUS_JSON: JSON.stringify({ state: {} }),
        PAYLOAD_MARKER: fixture.payloadMarker,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Invalid direnv status");
    expect(await Bun.file(fixture.payloadMarker).exists()).toBe(false);
  });
});

test("payload arguments remain separate literal argv entries", async () => {
  await withFixture(async (fixture) => {
    const payload = path.join(fixture.root, "capture-args");
    await writeFile(
      payload,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$PAYLOAD_ARGS"
`,
    );
    await chmod(payload, 0o755);
    const args = [
      "two words",
      "single'quote",
      'double"quote',
      "$(touch should-not-exist); * ? [abc]",
    ];

    const result = await launch(fixture, [payload, ...args], {
      PAYLOAD_ARGS: fixture.payloadArgs,
    });

    expect(result.exitCode).toBe(0);
    expect(
      (await readFile(fixture.payloadArgs, "utf8")).split("\n").slice(0, -1),
    ).toEqual(args);
    expect(
      await Bun.file(path.join(fixture.workspace, "should-not-exist")).exists(),
    ).toBe(false);
  });
});

test("payload exit status is preserved", async () => {
  await withFixture(async (fixture) => {
    const proc = Bun.spawn(
      [
        "bash",
        fixture.launcher,
        fixture.workspace,
        fixture.opsFile,
        "",
        "bash",
        "-c",
        "exit 37",
      ],
      { env: fixture.env, stdout: "pipe", stderr: "pipe" },
    );

    expect(await proc.exited).toBe(37);
  });
});

test("approval dependencies ignore workspace commands in PATH", async () => {
  await withFixture(async (fixture) => {
    const hostileBin = path.join(fixture.workspace, "bin");
    const hostileMarker = path.join(fixture.workspace, "spoof-ran");
    await mkdir(hostileBin);
    for (const command of ["direnv", "jq"]) {
      await writeFile(
        path.join(hostileBin, command),
        '#!/bin/bash\nprintf spoofed > "$SPOOF_MARKER"\nexit 0\n',
        { mode: 0o755 },
      );
    }
    const result = await launch(fixture, ["/bin/true"], {
      PATH: `${hostileBin}:${fixture.env.PATH}`,
      FAKE_STATUS_FAIL: "true",
      SPOOF_MARKER: hostileMarker,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("direnv status failed");
    expect(await readFile(fixture.callsFile, "utf8")).toBe("status\n");
    expect(await Bun.file(hostileMarker).exists()).toBe(false);
  });
});
