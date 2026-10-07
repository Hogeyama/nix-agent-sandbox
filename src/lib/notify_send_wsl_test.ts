/**
 * Unit tests for scripts/notify-send-wsl
 *
 * Spawns the shell script with a fake powershell.exe on PATH and asserts:
 *   1. stdout emits "0" (notification ID) then "wsl-notify-only" in order.
 *   2. exec replaces the shell process: the fake powershell.exe PID matches
 *      the spawned child PID, which is only possible when exec is used.
 */
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../../scripts/notify-send-wsl", import.meta.url),
);

async function withFakePs(
  extra: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-notify-wsl-test-"));
  const originalPath = process.env.PATH ?? "";
  try {
    await writeFile(
      `${dir}/powershell.exe`,
      `#!/usr/bin/env bash\n${extra}printf 'wsl-notify-only\\n'\n`,
    );
    await chmod(`${dir}/powershell.exe`, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
    await fn(dir);
  } finally {
    process.env.PATH = originalPath;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("notify-send-wsl: emits notification ID then wsl-notify-only on stdout", async () => {
  await withFakePs("", async () => {
    const child = Bun.spawn([SCRIPT, "--print-id", "Test Title", "Test Body"], {
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toEqual("0");
    expect(lines[lines.length - 1]).toEqual("wsl-notify-only");
  });
});

test("notify-send-wsl: exec replaces shell process with powershell.exe", async () => {
  // The fake powershell.exe writes $$ (its own PID) to a file.
  // With `exec`, the fake script runs in the same process as the original
  // bash shell, so $$ == child.pid.  Without `exec`, bash would fork a
  // child process and $$ would differ from child.pid.
  await withFakePs("", async (dir) => {
    const pidFile = `${dir}/ps-pid.txt`;
    await writeFile(
      `${dir}/powershell.exe`,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$$" > "${pidFile}"\nprintf 'wsl-notify-only\\n'\n`,
    );
    await chmod(`${dir}/powershell.exe`, 0o755);

    const child = Bun.spawn([SCRIPT, "--print-id", "Title", "Body"], {
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
    const childPid = child.pid;
    await new Response(child.stdout).text();
    await child.exited;

    const psPid = parseInt((await readFile(pidFile, "utf8")).trim(), 10);
    expect(psPid).toEqual(childPid);
  });
});
