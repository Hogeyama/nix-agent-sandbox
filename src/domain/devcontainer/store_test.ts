import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  acquireDevcontainerLock,
  ensureProtectedDirectory,
  readDevcontainerGlobalConfigSnapshot,
  readProtectedFile,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  writeProtectedFile,
} from "./store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nas-devcontainer-"));
  dirs.push(root);
  const uid = process.getuid!();
  const host: HostEnv = {
    home: root,
    user: "nas",
    uid,
    gid: process.getgid!(),
    isWSL: false,
    env: new Map([
      ["XDG_STATE_HOME", path.join(root, "state")],
      ["XDG_RUNTIME_DIR", path.join(root, "run")],
    ]),
  };
  return { root, uid, host };
}

test("private paths separate mountable state from registration and bound control socket length", async () => {
  const { host } = await fixture();
  const paths = resolveDevcontainerPaths(host, "/workspace");
  expect(paths.claudeDir.startsWith(`${paths.registrationDir}/`)).toBe(false);
  expect(paths.operationLock).toBe(
    resolveDevcontainerPaths(host, "/workspace").operationLock,
  );
  expect(
    Buffer.byteLength(
      resolveDevcontainerRuntimePaths(host, "/workspace").controlSocket,
    ),
  ).toBeLessThanOrEqual(107);
  expect(() =>
    resolveDevcontainerRuntimePaths(
      { ...host, env: new Map([["XDG_RUNTIME_DIR", `/${"a".repeat(100)}`]]) },
      "/workspace",
    ),
  ).toThrow("socket path");
});

test("private writes enforce modes and reject symlink, directories, loose permissions and excessive records", async () => {
  const { root, uid } = await fixture();
  const dir = path.join(root, "private");
  const file = path.join(dir, "record");
  await ensureProtectedDirectory(dir, uid);
  await writeProtectedFile(file, "first", uid);
  expect(await readProtectedFile(file, uid)).toBe("first");
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await writeProtectedFile(file, "second", uid);
  expect(await readProtectedFile(file, uid)).toBe("second");
  await symlink(file, path.join(dir, "alias"));
  await expect(
    readProtectedFile(path.join(dir, "alias"), uid),
  ).rejects.toThrow();
  await expect(
    writeProtectedFile(path.join(dir, "alias"), "oops", uid),
  ).rejects.toThrow();
  await expect(readProtectedFile(dir, uid)).rejects.toThrow();
  await chmod(file, 0o644);
  await expect(readProtectedFile(file, uid)).rejects.toThrow("permissions");
  await chmod(file, 0o600);
  await writeFile(file, "x".repeat(1_048_577));
  await expect(readProtectedFile(file, uid)).rejects.toThrow("large");
  await expect(readProtectedFile(file, uid + 1)).rejects.toThrow("owner");
});

test("directory creation rejects symlink ancestors without touching their destination", async () => {
  const { root, uid } = await fixture();
  const real = path.join(root, "real");
  await mkdir(real);
  await symlink(real, path.join(root, "alias"));
  await expect(
    ensureProtectedDirectory(path.join(root, "alias", "child"), uid),
  ).rejects.toThrow("symlink");
  expect(await Bun.file(path.join(real, "child")).exists()).toBe(false);
});

test("flock serializes holders with a timeout and preserves its inode", async () => {
  const { root, uid } = await fixture();
  const file = path.join(root, "operation.lock");
  const first = await acquireDevcontainerLock(file, uid);
  const inode = (await stat(file)).ino;
  try {
    await expect(acquireDevcontainerLock(file, uid, 20)).rejects.toThrow(
      "lock",
    );
  } finally {
    await first.release();
  }
  const second = await acquireDevcontainerLock(file, uid, 1000);
  await second.release();
  expect((await stat(file)).ino).toBe(inode);
  expect(await readFile(file, "utf8")).toBe("");
});

test("kernel releases a lifetime lock after owner process is killed", async () => {
  const { root, uid } = await fixture();
  const file = path.join(root, "lifetime.lock");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `import {acquireDevcontainerLock} from ${JSON.stringify(path.join(import.meta.dir, "store.ts"))}; await acquireDevcontainerLock(process.argv[1],process.getuid()); console.log("locked"); await new Promise(()=>{});`,
      file,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    await expect(acquireDevcontainerLock(file, uid, 20)).rejects.toThrow(
      "lock",
    );
    child.kill("SIGKILL");
    await child.exited;
    const lock = await acquireDevcontainerLock(file, uid, 1000);
    await lock.release();
  } finally {
    child.kill();
    await child.exited;
  }
});

test("private reads reject a writable parent even when file mode is private", async () => {
  const { root, uid } = await fixture();
  const file = path.join(root, "record");
  await writeProtectedFile(file, "private", uid);
  await chmod(root, 0o777);
  try {
    await expect(readProtectedFile(file, uid)).rejects.toThrow("directory");
  } finally {
    await chmod(root, 0o700);
  }
});

test("global config snapshots follow a Home Manager style read-only symlink", async () => {
  const { root } = await fixture();
  const storeTarget = path.join(root, "nix-store-global.pkl");
  const globalConfig = path.join(root, "global.pkl");
  await writeFile(storeTarget, 'amends "Schema.pkl"\n', { mode: 0o444 });
  await symlink(storeTarget, globalConfig);
  expect(await readDevcontainerGlobalConfigSnapshot(globalConfig)).toBe(
    'amends "Schema.pkl"\n',
  );
});

test("IDE sessions reject root host identities", async () => {
  const { host } = await fixture();
  const { requireHostUid } = await import("./store.ts");
  expect(() => requireHostUid({ ...host, uid: 0 })).toThrow("non-root");
});

test("config loading rejects generated schema and PklProject symlinks before trust/evaluation", async () => {
  const { root, uid } = await fixture();
  const workspace = path.join(root, "workspace");
  const nasDir = path.join(workspace, ".nas");
  await mkdir(nasDir, { recursive: true });
  await writeFile(path.join(nasDir, "config.pkl"), "untrusted");
  const target = path.join(root, "target");
  await writeFile(target, "unchanged");
  const { loadDevcontainerInputs } = await import("./store.ts");
  for (const name of ["Schema.pkl", "PklProject"]) {
    await symlink(target, path.join(nasDir, name));
    await expect(
      loadDevcontainerInputs(workspace, "claude", uid),
    ).rejects.toThrow("symlink");
    await rm(path.join(nasDir, name));
  }
  expect(await readFile(target, "utf8")).toBe("unchanged");
});

test("session generation fencing preserves current record on stale updates", async () => {
  const { host } = await fixture();
  const workspace = "/workspace";
  const {
    devcontainerWorkspaceId,
    readDevcontainerSession,
    writeDevcontainerSession,
  } = await import("./store.ts");
  const record = {
    version: 1 as const,
    workspaceId: devcontainerWorkspaceId(workspace),
    fingerprint: "fingerprint",
    sessionId: "current",
    containerId: null,
    phase: "preparing" as const,
    controlSocket: resolveDevcontainerRuntimePaths(host, workspace)
      .controlSocket,
    diagnostic: null,
  };
  await writeDevcontainerSession(host, workspace, record);
  await expect(
    writeDevcontainerSession(
      host,
      workspace,
      { ...record, phase: "stopped" },
      "stale",
    ),
  ).rejects.toThrow("generation changed");
  expect(await readDevcontainerSession(host, workspace)).toEqual(record);
  await expect(
    writeDevcontainerSession(
      host,
      workspace,
      { ...record, controlSocket: "/wrong/socket" },
      "current",
    ),
  ).rejects.toThrow("ownership mismatch");
});
