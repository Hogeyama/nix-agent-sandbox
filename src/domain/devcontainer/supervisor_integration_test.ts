import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
} from "./store.ts";
import { spawnDetachedDevcontainerSupervisor } from "./supervisor.ts";
import type { DevcontainerRegistration } from "./types.ts";

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await Bun.sleep(10);
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("detached spawn preserves argv and drops the parent session environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-devcontainer-detach-"));
  const workspace = path.join(root, "workspace with spaces");
  const home = path.join(root, "home");
  const marker = path.join(root, "child.json");
  const script = path.join(root, "child.ts");
  let pid: number | null = null;
  try {
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await writeFile(
      script,
      `import { writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const marker = args[1];
const lock = args[3];
const lockProbe = Bun.spawn(["flock", "-x", "-w", "2", lock, "true"], { stdout: "ignore", stderr: "ignore" });
const lockCode = await lockProbe.exited;
await writeFile(marker, JSON.stringify({ pid: process.pid, argv: args.slice(4), inherited: process.env.NAS_SESSION_ID ?? null, lockCode }));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      { mode: 0o600 },
    );
    const host: HostEnv = {
      home,
      user: "tester",
      uid: process.getuid?.() ?? 1000,
      gid: process.getgid?.() ?? 1000,
      isWSL: false,
      env: new Map([
        ["HOME", home],
        ["XDG_STATE_HOME", path.join(root, "state")],
        ["XDG_RUNTIME_DIR", path.join(root, "run")],
      ]),
    };
    const paths = resolveDevcontainerPaths(host, workspace);
    const runtimePaths = resolveDevcontainerRuntimePaths(host, workspace);
    const registration: DevcontainerRegistration = {
      version: 1,
      workspaceId: path.basename(paths.registrationDir),
      workspace,
      profileName: "claude",
      fingerprint: "fingerprint",
      configPath: path.join(workspace, ".devcontainer", "devcontainer.json"),
      composePath: paths.composeFile,
      stateRoot: path.dirname(paths.claudeDir),
      command: [
        "bash",
        "-c",
        'sleep 0.15; exec flock -x "$0" "$@"',
        runtimePaths.lifetimeLock,
        process.execPath,
        "run",
        script,
        "--marker",
        marker,
        "--lock",
        paths.operationLock,
      ],
    };
    const previous = process.env.NAS_SESSION_ID;
    process.env.NAS_SESSION_ID = "parent-session";
    try {
      const spawnedAt = Date.now();
      await withDevcontainerOperationLock(host, workspace, () =>
        spawnDetachedDevcontainerSupervisor(host, registration, "dc_detached"),
      );
      expect(Date.now() - spawnedAt).toBeGreaterThanOrEqual(100);
    } finally {
      if (previous === undefined) delete process.env.NAS_SESSION_ID;
      else process.env.NAS_SESSION_ID = previous;
    }
    const child = JSON.parse(await waitForFile(marker)) as {
      pid: number;
      argv: string[];
      inherited: string | null;
      lockCode: number;
    };
    pid = child.pid;
    expect(child.inherited).toBeNull();
    expect(child.lockCode).toBe(0);
    expect(child.argv).toEqual([
      "devcontainer",
      "_supervise",
      "--workspace",
      workspace,
      "--session",
      "dc_detached",
    ]);
    process.kill(pid, 0);
    const log = path.join(runtimePaths.runtimeDir, "dc_detached.log");
    expect((await stat(log)).mode & 0o777).toBe(0o600);
  } finally {
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(10);
        } catch {
          break;
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
