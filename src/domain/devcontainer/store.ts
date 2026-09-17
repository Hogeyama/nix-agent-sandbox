import { open, readdir, realpath, stat } from "node:fs/promises";
import * as path from "node:path";
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
import {
  atomicWriteFile,
  ensureDir,
  readTextFile,
} from "../../lib/fs_utils.ts";
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
} from "./types.ts";

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
  const stateRoot = path.join(root, "state", id);
  return {
    registrationDir,
    registrationFile: path.join(registrationDir, "registration.json"),
    composeFile: path.join(registrationDir, "compose.json"),
    operationLock: path.join(registrationDir, "operation.lock"),
    stateRoot,
    vscodeDir: path.join(stateRoot, "vscode"),
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
  return {
    runtimeDir,
    sessionFile: path.join(runtimeDir, "session.json"),
    lifetimeLock: path.join(runtimeDir, "lifetime.lock"),
  };
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
): Promise<string> {
  const canonical = await realpath(workspace);
  if (!(await stat(canonical)).isDirectory())
    throw new DevcontainerError("workspace must be a directory");
  return canonical;
}

/** flock attaches to this process's open file description, not a PID file.
 * The child inherits it as fd 0; its exit leaves the parent's descriptor locked.
 * Closing the descriptor (including process death) releases the kernel lock.
 */
export async function acquireDevcontainerLock(
  file: string,
  timeoutMs = 120_000,
): Promise<{ release: () => Promise<void> }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new DevcontainerError("invalid lock timeout");
  await ensureDir(path.dirname(file));
  const handle = await open(file, "a+", 0o600);
  try {
    const child = Bun.spawn(
      ["flock", "-x", "-w", String(timeoutMs / 1000), "0"],
      { stdin: handle.fd, stdout: "ignore", stderr: "ignore" },
    );
    if ((await child.exited) !== 0)
      throw new DevcontainerError(
        `devcontainer lock unavailable within ${timeoutMs}ms: ${file}`,
      );
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
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
    timeoutMs,
  );
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/** loadConfig owns the existing trust gate. No env keyCmd/valCmd is evaluated here. */
export async function loadDevcontainerInputs(
  workspace: string,
  profileName: string,
): Promise<DevcontainerInputs> {
  const found = await findExistingConfig(workspace);
  if (!found)
    throw new DevcontainerError(
      "create and trust a nas config before devcontainer init",
    );
  await readdir(found.nasDir);
  const before = await computeConfigTrustHash(found.nasDir);
  const globalFile = path.join(getGlobalConfigDir(), "global.pkl");
  const global = await readFileOrNull(globalFile);
  const config = await loadConfig({ startDir: workspace });
  const resolved = resolveProfile(config, profileName);
  const after = await computeConfigTrustHash(found.nasDir);
  const globalAfter = await readFileOrNull(globalFile);
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
    !["workspaceId", "fingerprint", "sessionId"].every(
      (k) => typeof value[k] === "string",
    ) ||
    !["starting", "ready", "stopping", "stopped", "failed"].includes(
      String(value.phase),
    ) ||
    !(value.pid === null || Number.isSafeInteger(value.pid)) ||
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
  const bytes = await readTextFile(paths.registrationFile);
  if (bytes === null) return null;
  const registration = parseDevcontainerRegistration(bytes);
  if (
    registration.workspace !== workspace ||
    registration.workspaceId !== devcontainerWorkspaceId(workspace) ||
    registration.configPath !==
      path.join(workspace, ".devcontainer", "devcontainer.json") ||
    registration.composePath !== paths.composeFile ||
    registration.stateRoot !== paths.stateRoot
  )
    throw new DevcontainerError("registration ownership mismatch");
  return registration;
}

export async function readDevcontainerSession(
  host: HostEnv,
  workspace: string,
): Promise<DevcontainerSessionRecord | null> {
  const bytes = await readTextFile(
    resolveDevcontainerRuntimePaths(host, workspace).sessionFile,
  );
  if (bytes === null) return null;
  const record = parseDevcontainerSession(bytes);
  if (record.workspaceId !== devcontainerWorkspaceId(workspace))
    throw new DevcontainerError("session ownership mismatch");
  return record;
}

export async function writeDevcontainerSession(
  host: HostEnv,
  workspace: string,
  record: DevcontainerSessionRecord,
): Promise<void> {
  const paths = resolveDevcontainerRuntimePaths(host, workspace);
  parseDevcontainerSession(JSON.stringify(record));
  if (record.workspaceId !== devcontainerWorkspaceId(workspace))
    throw new DevcontainerError("session ownership mismatch");
  await atomicWriteFile(paths.sessionFile, `${JSON.stringify(record)}\n`);
}

export { type DevcontainerInputs, devcontainerWorkspaceId } from "./types.ts";
