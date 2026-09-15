import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  awaitOwnerExit,
  isReapableSessionId,
  runAcpReaperCommand,
} from "./acp_reaper.ts";

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test("isReapableSessionId: accepts only generated session ids", () => {
  expect(isReapableSessionId("sess_0123abcd")).toBe(true);
  expect(isReapableSessionId("sess_")).toBe(false);
  expect(isReapableSessionId("nas-proxy-shared")).toBe(false);
  expect(isReapableSessionId("sess_abc; rm -rf /")).toBe(false);
});

test("awaitOwnerExit: resolves when the owner closes the pipe", async () => {
  const input = new PassThrough();
  let resolved = false;
  const waiting = awaitOwnerExit(input).then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(resolved).toBe(false);
  input.end();
  await waiting;
  expect(resolved).toBe(true);
});

test("runAcpReaperCommand: refuses ids that could name foreign resources", async () => {
  await expect(
    runAcpReaperCommand(["nas-proxy-shared"], new PassThrough()),
  ).rejects.toThrow("requires a nas session id");
});

for (const ending of ["exit", "sigkill"] as const) {
  test(`spawnAcpSessionReaper: reaper runs after the owner ends by ${ending}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "nas-acp-reaper-"));
    try {
      const marker = join(dir, "reaped");
      const owner = join(dir, "owner.ts");
      await writeFile(
        owner,
        `import { spawnAcpSessionReaper } from ${JSON.stringify(
          new URL("./acp_reaper.ts", import.meta.url).pathname,
        )};
spawnAcpSessionReaper("sess_0123abcd", {
  command: "sh",
  args: ["-c", ${JSON.stringify(`cat >/dev/null; echo reaped > '${marker}'`)}],
});
if (process.argv[2] === "sigkill") process.kill(process.pid, "SIGKILL");
`,
      );
      const started = Date.now();
      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const child = spawn("bun", [owner, ending], { stdio: "ignore" });
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });

      if (ending === "exit") {
        expect(exit.code).toBe(0);
        // The reaper's pipe must not keep the owner alive.
        expect(Date.now() - started).toBeLessThan(5000);
      } else {
        expect(exit.signal).toBe("SIGKILL");
      }
      expect(await waitForFile(marker, 5000)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
