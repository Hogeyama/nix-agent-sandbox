import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";
import { Context, Effect, Layer } from "effect";
import pkg from "../../../package.json";
import { readFileOrNull } from "../../config/init.ts";
import {
  findExistingConfig,
  loadConfig,
  resolveProfile,
} from "../../config/load.ts";
import { getGlobalConfigDir } from "../../config/paths.ts";
import { computeConfigTrustHash } from "../../config/trust.ts";
import { computeEmbedHash } from "../../docker/client.ts";
import { resolveNasCommand } from "../../lib/notify_utils.ts";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  DevcontainerError,
  type DevcontainerInputs,
  type DevcontainerPaths,
  type DevcontainerRegistration,
  type DevcontainerRuntimePaths,
  type DevcontainerSessionRecord,
  devcontainerWorkspaceId,
  emptyDevcontainerInputs,
} from "./types.ts";

const MAX_RECORD_BYTES = 1_048_576;
export function resolveDevcontainerPaths(
  host: HostEnv,
  workspace: string,
): DevcontainerPaths {
  const stateHome =
    host.env.get("XDG_STATE_HOME") || path.join(host.home, ".local", "state");
  if (!path.isAbsolute(stateHome))
    throw new DevcontainerError("XDG_STATE_HOME must be absolute");
  const root = path.join(stateHome, "nas", "devcontainer");
  const id = devcontainerWorkspaceId(workspace);
  const registrationDir = path.join(root, "registrations", id);
  const dedicated = path.join(root, "state", id);
  return {
    registrationDir,
    registrationFile: path.join(registrationDir, "registration.json"),
    composeFile: path.join(registrationDir, "compose.json"),
    operationLock: path.join(registrationDir, "operation.lock"),
    claudeDir: path.join(dedicated, "claude"),
    claudeJson: path.join(dedicated, "claude.json"),
    vscodeDir: path.join(dedicated, "vscode"),
  };
}
export function resolveDevcontainerRuntimePaths(
  host: HostEnv,
  workspace: string,
): DevcontainerRuntimePaths {
  const root = resolveRuntimeSubdir(host, "devcontainer");
  if (!path.isAbsolute(root))
    throw new DevcontainerError("runtime directory must be absolute");
  const runtimeDir = path.join(
    root,
    devcontainerWorkspaceId(workspace).slice(0, 24),
  );
  const controlSocket = path.join(runtimeDir, "control.sock");
  if (Buffer.byteLength(controlSocket) > 107)
    throw new DevcontainerError(
      "devcontainer control socket path exceeds Linux's 107-byte limit",
    );
  return {
    runtimeDir,
    controlSocket,
    sessionFile: path.join(runtimeDir, "session.json"),
    lifetimeLock: path.join(runtimeDir, "lifetime.lock"),
  };
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
export async function protectedPathStat(file: string): Promise<Stats | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
/** Inspect every existing component; never traverse a symlink into a protected tree. */
export async function assertNoSymlinks(file: string): Promise<void> {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const st = await protectedPathStat(current);
    if (!st) return;
    if (st.isSymbolicLink())
      throw new DevcontainerError(`symlink is not allowed: ${current}`);
    if (current !== absolute && !st.isDirectory())
      throw new DevcontainerError(`non-directory path component: ${current}`);
  }
}
function checkOwner(st: Stats, file: string, uid: number): void {
  if (st.uid !== uid) throw new DevcontainerError(`owner mismatch: ${file}`);
}
function checkFile(
  st: Stats,
  file: string,
  uid: number,
  privateFile: boolean,
): void {
  checkOwner(st, file, uid);
  if (!st.isFile() || st.nlink !== 1)
    throw new DevcontainerError(
      `expected a regular, singly linked file: ${file}`,
    );
  if (privateFile && (st.mode & 0o777) !== 0o600)
    throw new DevcontainerError(`unsafe file permissions: ${file}`);
  if (st.size > MAX_RECORD_BYTES)
    throw new DevcontainerError(`record too large: ${file}`);
}
export async function ensureProtectedDirectory(
  dir: string,
  uid: number,
): Promise<boolean> {
  await assertNoSymlinks(dir);
  const existing = await protectedPathStat(dir);
  if (existing) {
    checkOwner(existing, dir, uid);
    if (!existing.isDirectory() || (existing.mode & 0o777) !== 0o700)
      throw new DevcontainerError(
        `unsafe directory permissions or type: ${dir}`,
      );
    return false;
  }
  const parent = path.dirname(dir);
  if (!(await protectedPathStat(parent)))
    await ensureProtectedDirectory(parent, uid);
  try {
    await mkdir(dir, { mode: 0o700 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await ensureProtectedDirectory(dir, uid);
    return false;
  }
}
async function checkPrivateParent(file: string, uid: number): Promise<void> {
  const parent = path.dirname(file);
  const st = await protectedPathStat(parent);
  if (!st) return;
  checkOwner(st, parent, uid);
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700)
    throw new DevcontainerError(`unsafe directory permissions: ${parent}`);
}
export async function readProtectedFile(
  file: string,
  uid: number,
  privateFile = true,
): Promise<string | null> {
  await assertNoSymlinks(file);
  if (privateFile) await checkPrivateParent(file, uid);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  try {
    checkFile(await handle.stat(), file, uid, privateFile);
    // Bounded read also handles a concurrently growing regular file.
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECORD_BYTES)
      throw new DevcontainerError(`record too large: ${file}`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function writeProtectedFile(
  file: string,
  bytes: string,
  uid: number,
  exclusive = false,
): Promise<void> {
  if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES)
    throw new DevcontainerError(`record too large: ${file}`);
  await assertNoSymlinks(file);
  await checkPrivateParent(file, uid);
  const existing = await protectedPathStat(file);
  if (existing) {
    checkFile(existing, file, uid, true);
    if (exclusive) throw new DevcontainerError(`file already exists: ${file}`);
  }
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${crypto.randomUUID()}.tmp`,
  );
  const handle = await open(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    if (exclusive) {
      await link(temp, file);
      await unlink(temp);
    } else await rename(temp, file);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
/** flock attaches to this process's open file description, not a PID file.
 * The child inherits it as fd 0; its exit leaves the parent's descriptor locked.
 * Closing the descriptor (including process death) releases the kernel lock.
 */
export async function acquireDevcontainerLock(
  file: string,
  uid: number,
  timeoutMs = 120_000,
): Promise<{ release: () => Promise<void> }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new DevcontainerError("invalid lock timeout");
  await ensureProtectedDirectory(path.dirname(file), uid);
  await assertNoSymlinks(file);
  const handle = await open(
    file,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    checkFile(await handle.stat(), file, uid, true);
    const child = Bun.spawn(
      ["flock", "-x", "-w", String(timeoutMs / 1000), "0"],
      { stdin: handle.fd, stdout: "ignore", stderr: "ignore" },
    );
    const code = await child.exited;
    if (code !== 0)
      throw new DevcontainerError(
        `devcontainer lock unavailable within ${timeoutMs}ms: ${file}`,
      );
    let released = false;
    return {
      release: async () => {
        if (!released) {
          released = true;
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
export async function withDevcontainerOperationLock<A>(
  host: HostEnv,
  workspace: string,
  body: () => Promise<A>,
  timeoutMs = 120_000,
): Promise<A> {
  const lock = await acquireDevcontainerLock(
    resolveDevcontainerPaths(host, workspace).operationLock,
    requireHostUid(host),
    timeoutMs,
  );
  try {
    return await body();
  } finally {
    await lock.release();
  }
}
export function requireHostUid(host: HostEnv): number {
  if (
    host.uid === null ||
    host.gid === null ||
    host.uid <= 0 ||
    host.gid < 0 ||
    host.user.trim() === "root"
  )
    throw new DevcontainerError(
      "devcontainer requires a non-root host identity with UID and GID",
    );
  return host.uid;
}
export async function canonicalizeWorkspace(
  workspace: string,
  uid: number,
): Promise<string> {
  await assertNoSymlinks(workspace);
  const canonical = await realpath(workspace);
  const st = await lstat(canonical);
  checkOwner(st, canonical, uid);
  if (!st.isDirectory())
    throw new DevcontainerError("workspace must be a directory");
  return canonical;
}

/** loadConfig owns the existing trust gate. No env keyCmd/valCmd is evaluated here. */
export async function loadDevcontainerInputs(
  workspace: string,
  profileName: string,
  uid: number,
): Promise<DevcontainerInputs> {
  const found = await findExistingConfig(workspace);
  if (!found)
    throw new DevcontainerError(
      "create and trust a nas config before devcontainer init",
    );
  await assertNoSymlinks(found.nasDir);
  for (const entry of await readdir(found.nasDir)) {
    if (entry.endsWith(".pkl") || entry === "PklProject")
      await readProtectedFile(path.join(found.nasDir, entry), uid, false);
  }
  const before = await computeConfigTrustHash(found.nasDir);
  const global = await readDevcontainerGlobalConfigSnapshot(
    path.join(getGlobalConfigDir(), "global.pkl"),
  );
  const config = await loadConfig({ startDir: workspace });
  const resolved = resolveProfile(config, profileName);
  const after = await computeConfigTrustHash(found.nasDir);
  const globalAfter = await readDevcontainerGlobalConfigSnapshot(
    path.join(getGlobalConfigDir(), "global.pkl"),
  );
  if (
    before !== after ||
    (global !== globalAfter &&
      !(global === null && globalAfter === 'amends "Schema.pkl"\n'))
  )
    throw new DevcontainerError("nas config changed while loading");
  const { execPath, prefix } = resolveNasCommand();
  return {
    profile: resolved.profile,
    profileName: resolved.name,
    trustHash: devcontainerWorkspaceId(JSON.stringify([after, globalAfter])),
    configDir: found.nasDir,
    implementation: `${pkg.version}+${process.env.NAS_GIT_REVISION ?? "dev"}`,
    embedHash: await computeEmbedHash(),
    command: [execPath, ...prefix],
  };
}

/** Global config is user input, not a nas-owned private record; Home Manager may symlink it. */
export async function readDevcontainerGlobalConfigSnapshot(
  file: string,
): Promise<string | null> {
  return await readFileOrNull(file);
}

function recordObject(bytes: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DevcontainerError("invalid devcontainer record");
  return value as Record<string, unknown>;
}
export function parseDevcontainerRegistration(
  bytes: string,
): DevcontainerRegistration {
  const value = recordObject(bytes);
  if (
    value.version !== 1 ||
    ![
      "workspaceId",
      "workspace",
      "profileName",
      "fingerprint",
      "configPath",
      "composePath",
      "stateRoot",
    ].every((k) => typeof value[k] === "string") ||
    !Array.isArray(value.command) ||
    !value.command.length ||
    !value.command.every((v) => typeof v === "string")
  )
    throw new DevcontainerError("invalid devcontainer registration");
  return value as unknown as DevcontainerRegistration;
}
export function parseDevcontainerSession(
  bytes: string,
): DevcontainerSessionRecord {
  const value = recordObject(bytes);
  if (
    value.version !== 1 ||
    !["workspaceId", "fingerprint", "sessionId", "controlSocket"].every(
      (k) => typeof value[k] === "string",
    ) ||
    ![
      "preparing",
      "starting",
      "ready",
      "stopping",
      "stopped",
      "failed",
    ].includes(String(value.phase)) ||
    ![value.containerId, value.diagnostic].every(
      (v) => v === null || typeof v === "string",
    )
  )
    throw new DevcontainerError("invalid devcontainer session record");
  return value as unknown as DevcontainerSessionRecord;
}
export async function readDevcontainerRegistration(
  host: HostEnv,
  workspace: string,
): Promise<DevcontainerRegistration | null> {
  const paths = resolveDevcontainerPaths(host, workspace);
  const bytes = await readProtectedFile(
    paths.registrationFile,
    requireHostUid(host),
  );
  if (bytes === null) return null;
  const registration = parseDevcontainerRegistration(bytes);
  if (
    registration.workspace !== workspace ||
    registration.workspaceId !== devcontainerWorkspaceId(workspace) ||
    registration.configPath !==
      path.join(workspace, ".devcontainer", "devcontainer.json") ||
    registration.composePath !== paths.composeFile ||
    registration.stateRoot !== path.dirname(paths.claudeDir)
  )
    throw new DevcontainerError("registration ownership mismatch");
  return registration;
}
export async function readDevcontainerSession(
  host: HostEnv,
  workspace: string,
): Promise<DevcontainerSessionRecord | null> {
  const paths = resolveDevcontainerRuntimePaths(host, workspace);
  const bytes = await readProtectedFile(
    paths.sessionFile,
    requireHostUid(host),
  );
  if (bytes === null) return null;
  const record = parseDevcontainerSession(bytes);
  if (
    record.workspaceId !== devcontainerWorkspaceId(workspace) ||
    record.controlSocket !== paths.controlSocket
  )
    throw new DevcontainerError("session ownership mismatch");
  return record;
}
/** Caller holds the workspace operation lock; expectedSessionId provides generation fencing. */
export async function writeDevcontainerSession(
  host: HostEnv,
  workspace: string,
  record: DevcontainerSessionRecord,
  expectedSessionId?: string,
): Promise<void> {
  const uid = requireHostUid(host);
  const paths = resolveDevcontainerRuntimePaths(host, workspace);
  parseDevcontainerSession(JSON.stringify(record));
  if (
    record.workspaceId !== devcontainerWorkspaceId(workspace) ||
    record.controlSocket !== paths.controlSocket
  )
    throw new DevcontainerError("session ownership mismatch");
  if (
    expectedSessionId !== undefined &&
    (await readDevcontainerSession(host, workspace))?.sessionId !==
      expectedSessionId
  )
    throw new DevcontainerError("session generation changed");
  await ensureProtectedDirectory(paths.runtimeDir, uid);
  await writeProtectedFile(
    paths.sessionFile,
    `${JSON.stringify(record)}\n`,
    uid,
  );
}

/** D1: injectable I/O operations; D2 registration sequencing lives in service.ts. */
export class DevcontainerStoreOps extends Context.Tag(
  "nas/DevcontainerStoreOps",
)<
  DevcontainerStoreOps,
  {
    readonly canonicalize: (workspace: string) => Effect.Effect<string, Error>;
    readonly stat: (file: string) => Effect.Effect<Stats | null, Error>;
    readonly read: (
      file: string,
      privateFile?: boolean,
    ) => Effect.Effect<string | null, Error>;
    readonly write: (
      file: string,
      bytes: string,
      exclusive?: boolean,
    ) => Effect.Effect<void, Error>;
    readonly directory: (dir: string) => Effect.Effect<boolean, Error>;
    readonly list: (dir: string) => Effect.Effect<readonly string[], Error>;
    readonly remove: (
      file: string,
      directory?: boolean,
    ) => Effect.Effect<void, Error>;
    readonly lock: (
      file: string,
      timeoutMs?: number,
    ) => Effect.Effect<{ release: () => Promise<void> }, Error>;
    readonly inputs: (
      workspace: string,
      profileName: string,
    ) => Effect.Effect<DevcontainerInputs, Error>;
    readonly canonicalSource: (source: string) => Effect.Effect<string, Error>;
  }
>() {}
export function devcontainerIo<A>(
  run: () => Promise<A>,
): Effect.Effect<A, Error> {
  return Effect.tryPromise({
    try: run,
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}
export function makeDevcontainerStoreOpsLive(
  host: HostEnv,
): Layer.Layer<DevcontainerStoreOps> {
  const uid = requireHostUid(host);
  return Layer.succeed(
    DevcontainerStoreOps,
    DevcontainerStoreOps.of({
      canonicalize: (w) => devcontainerIo(() => canonicalizeWorkspace(w, uid)),
      stat: (p) =>
        devcontainerIo(async () => {
          await assertNoSymlinks(p);
          return protectedPathStat(p);
        }),
      read: (p, privateFile = true) =>
        devcontainerIo(() => readProtectedFile(p, uid, privateFile)),
      write: (p, b, exclusive = false) =>
        devcontainerIo(() => writeProtectedFile(p, b, uid, exclusive)),
      directory: (p) => devcontainerIo(() => ensureProtectedDirectory(p, uid)),
      list: (p) => devcontainerIo(() => readdir(p)),
      remove: (p, dir = false) =>
        devcontainerIo(async () => {
          await assertNoSymlinks(p);
          if (dir) await rmdir(p);
          else await unlink(p);
        }),
      lock: (p, timeout) =>
        devcontainerIo(() => acquireDevcontainerLock(p, uid, timeout)),
      inputs: (w, n) => devcontainerIo(() => loadDevcontainerInputs(w, n, uid)),
      canonicalSource: (p) =>
        devcontainerIo(() => canonicalizePotentialPath(p)),
    }),
  );
}
/** Resolve an existing ancestor so absent credential paths still compare canonically. */
export async function canonicalizePotentialPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(
      await canonicalizePotentialPath(parent),
      path.basename(file),
    );
  }
}
export function makeDevcontainerStoreOpsFake(
  overrides: Partial<Context.Tag.Service<DevcontainerStoreOps>> = {},
): Layer.Layer<DevcontainerStoreOps> {
  return Layer.succeed(
    DevcontainerStoreOps,
    DevcontainerStoreOps.of({
      canonicalize: (w) => Effect.succeed(w),
      stat: () => Effect.succeed(null),
      read: () => Effect.succeed(null),
      write: () => Effect.void,
      directory: () => Effect.succeed(false),
      list: () => Effect.succeed([]),
      remove: () => Effect.void,
      lock: () => Effect.succeed({ release: async () => {} }),
      inputs: (workspace, profileName) =>
        Effect.succeed(emptyDevcontainerInputs(workspace, profileName)),
      canonicalSource: (p) => Effect.succeed(p),
      ...overrides,
    }),
  );
}

export { type DevcontainerInputs, devcontainerWorkspaceId } from "./types.ts";
