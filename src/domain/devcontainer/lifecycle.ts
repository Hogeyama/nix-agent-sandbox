import { constants, open, readdir, readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { runDockerCommand } from "../../docker/client.ts";
import {
  atomicWriteFile,
  ensureDir,
  readTextFile,
} from "../../lib/fs_utils.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import {
  computeDevcontainerFingerprint,
  renderDevcontainerConfig,
} from "./config.ts";
import { validateDevcontainerProfile } from "./policy.ts";
import {
  acquireDevcontainerLock,
  canonicalizeWorkspace,
  loadDevcontainerInputs,
  readDevcontainerRegistration,
  readDevcontainerSession,
  requireHostUid,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
} from "./store.ts";
import {
  DevcontainerError,
  type DevcontainerRegistration,
  type DevcontainerSessionRecord,
  type DevcontainerStatus,
  devcontainerWorkspaceId,
  projectDevcontainerStatus,
} from "./types.ts";

const STARTUP_TIMEOUT_MS = 120_000;
const POLL_MS = 50;
const SHUTDOWN_GRACE_MS = 30_000;
/** Time the detached runtime gets to take the lifetime lock and claim the session. */
const CLAIM_GRACE_MS = 10_000;

export interface DevcontainerLifecycleOptions {
  readonly startupTimeoutMs?: number;
  readonly docker?: typeof runDockerCommand;
  readonly spawn?: typeof spawnDetachedDevcontainerRuntime;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Reads /proc/<pid>/cmdline; overridden by tests that own no such process. */
  readonly readProcCmdline?: (pid: number) => Promise<string | null>;
  /** Config-backed registration check; overridden by tests with no nas config. */
  readonly verifyRegistration?: (
    workspace: string,
  ) => Promise<DevcontainerRegistration>;
}

function active(phase: DevcontainerSessionRecord["phase"]): boolean {
  return phase === "starting" || phase === "ready";
}

/** Keep diagnostics single-line and control-character free; they reach the terminal. */
function safeDiagnostic(error: unknown, prefix: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = (raw.split(/\r?\n/, 1)[0] ?? "")
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  return `${prefix}: ${(firstLine || "unknown error").slice(0, 500)}`;
}

/** The runtime holds this lock for its whole life, so a free lock means it is gone. */
export async function devcontainerRuntimeIsRunning(
  host: HostEnv,
  workspace: string,
): Promise<boolean> {
  const runtime = resolveDevcontainerRuntimePaths(host, workspace);
  try {
    const lock = await acquireDevcontainerLock(runtime.lifetimeLock, 0);
    await lock.release();
    return false;
  } catch (error) {
    if (
      error instanceof DevcontainerError &&
      error.message.includes("lock unavailable")
    )
      return true;
    throw error;
  }
}

/** Spawn through setsid using the registration's argv, with a private per-session log. */
export async function spawnDetachedDevcontainerRuntime(
  host: HostEnv,
  registration: DevcontainerRegistration,
  sessionId: string,
  deadlineAt: number,
): Promise<void> {
  const runtime = resolveDevcontainerRuntimePaths(host, registration.workspace);
  await ensureDir(runtime.runtimeDir);
  const handle = await open(
    path.join(runtime.runtimeDir, `${sessionId}.log`),
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    0o600,
  );
  try {
    const env = { ...process.env };
    delete env.NAS_SESSION_ID;
    const child = Bun.spawn(
      [
        "setsid",
        ...registration.command,
        "devcontainer",
        "_serve",
        "--workspace",
        registration.workspace,
        "--session",
        sessionId,
        "--deadline-at",
        String(deadlineAt),
      ],
      { stdin: "ignore", stdout: handle.fd, stderr: handle.fd, env },
    );
    child.unref();
  } finally {
    await handle.close();
  }
}

async function readProcCmdlineFile(pid: number): Promise<string | null> {
  try {
    return await readFile(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

export function makeDevcontainerLifecycle(
  host: HostEnv,
  options: DevcontainerLifecycleOptions = {},
) {
  const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const docker = options.docker ?? runDockerCommand;
  const spawn = options.spawn ?? spawnDetachedDevcontainerRuntime;
  const signalProcess =
    options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const readProcCmdline = options.readProcCmdline ?? readProcCmdlineFile;

  /** A recycled PID must never be signalled: the argv has to still be ours. */
  const isDevcontainerRuntimePid = async (
    pid: number,
    sessionId: string,
  ): Promise<boolean> => {
    const cmdline = await readProcCmdline(pid);
    return cmdline?.includes("_serve") === true && cmdline.includes(sessionId);
  };

  const composeContainerId = async (
    registration: DevcontainerRegistration,
  ): Promise<string | null> => {
    if ((await readTextFile(registration.composePath)) === null) return null;
    const result = await docker(
      ["compose", "-f", registration.composePath, "ps", "-q", "agent"],
      { timeoutMs: 10_000 },
    );
    return result.stdout.trim() || null;
  };

  const composeDown = async (
    registration: DevcontainerRegistration,
  ): Promise<void> => {
    if ((await readTextFile(registration.composePath)) === null) return;
    await docker(["compose", "-f", registration.composePath, "down"], {
      timeoutMs: 60_000,
    });
  };

  /** Registration plus the exact inputs it was generated from; init is the only writer. */
  const verifyLive = async (
    workspace: string,
  ): Promise<DevcontainerRegistration> => {
    const registration = await readDevcontainerRegistration(host, workspace);
    if (!registration)
      throw new DevcontainerError(
        "workspace is not registered; run devcontainer init",
      );
    const bytes = await readTextFile(registration.configPath);
    const inputs = await loadDevcontainerInputs(
      workspace,
      registration.profileName,
    );
    const errors = validateDevcontainerProfile(inputs.profile);
    if (errors.length) throw new DevcontainerError(errors.join("\n"));
    if (
      bytes === null ||
      computeDevcontainerFingerprint(bytes, inputs, host) !==
        registration.fingerprint
    )
      throw new DevcontainerError(
        "devcontainer fingerprint changed; stop the session and run init again",
      );
    return registration;
  };
  const verify = options.verifyRegistration ?? verifyLive;

  const init = async (
    requested: string,
    profileName: string,
  ): Promise<DevcontainerRegistration> => {
    requireHostUid(host);
    const workspace = await canonicalizeWorkspace(requested);
    return await withDevcontainerOperationLock(host, workspace, async () => {
      const paths = resolveDevcontainerPaths(host, workspace);
      const registration = await readDevcontainerRegistration(host, workspace);
      const configDir = path.join(workspace, ".devcontainer");
      if (await pathExists(path.join(workspace, ".devcontainer.json")))
        throw new DevcontainerError(
          "existing .devcontainer.json is not managed by nas",
        );
      if (await pathExists(configDir)) {
        const entries = await readdir(configDir);
        if (
          !registration ||
          entries.some((entry) => entry !== "devcontainer.json")
        )
          throw new DevcontainerError(
            "existing .devcontainer is not managed by nas",
          );
      }
      const session = await readDevcontainerSession(host, workspace);
      if (session && active(session.phase))
        throw new DevcontainerError(
          "session must be stopped before init; run devcontainer down",
        );
      const inputs = await loadDevcontainerInputs(workspace, profileName);
      const errors = validateDevcontainerProfile(inputs.profile);
      if (errors.length) throw new DevcontainerError(errors.join("\n"));

      const record: DevcontainerRegistration = {
        version: 1,
        workspaceId: devcontainerWorkspaceId(workspace),
        workspace,
        profileName: inputs.profileName,
        fingerprint: "",
        configPath: path.join(configDir, "devcontainer.json"),
        composePath: paths.composeFile,
        stateRoot: paths.stateRoot,
        command: inputs.command,
      };
      const bytes = `${JSON.stringify(
        renderDevcontainerConfig(record, host.user.trim() || "nas"),
        null,
        2,
      )}\n`;
      const complete = {
        ...record,
        fingerprint: computeDevcontainerFingerprint(bytes, inputs, host),
      };
      const previousConfig = registration
        ? await readFile(record.configPath, "utf8").catch(() => null)
        : null;
      await ensureDir(paths.vscodeDir);
      await atomicWriteFile(record.configPath, bytes);
      try {
        await atomicWriteFile(
          paths.registrationFile,
          `${JSON.stringify(complete, null, 2)}\n`,
        );
      } catch (error) {
        // A config that does not match its registration would make every later
        // up fail the fingerprint check with no way to re-init, so restore the
        // pair the workspace had before this init.
        if (previousConfig === null)
          await rm(record.configPath, { force: true });
        else await atomicWriteFile(record.configPath, previousConfig);
        throw error;
      }
      return complete;
    });
  };

  const observe = async (
    registration: DevcontainerRegistration,
    session: DevcontainerSessionRecord | null,
  ): Promise<DevcontainerStatus> => {
    if (!session || !active(session.phase))
      return projectDevcontainerStatus(registration, session);
    if (!(await devcontainerRuntimeIsRunning(host, registration.workspace)))
      return {
        ...projectDevcontainerStatus(registration, session),
        phase: "failed",
        diagnostic: "devcontainer runtime is not running",
      };
    if (session.phase === "ready" && !(await composeContainerId(registration)))
      return {
        ...projectDevcontainerStatus(registration, session),
        phase: "failed",
        diagnostic: "devcontainer container is not running",
      };
    return projectDevcontainerStatus(registration, session);
  };

  const status = async (
    requested: string,
  ): Promise<DevcontainerStatus | null> => {
    const workspace = await canonicalizeWorkspace(requested);
    const registration = await readDevcontainerRegistration(host, workspace);
    if (!registration) return null;
    return await observe(
      registration,
      await readDevcontainerSession(host, workspace),
    );
  };

  const up = async (requested: string): Promise<DevcontainerStatus> => {
    const deadlineAt = Date.now() + timeoutMs;
    const workspace = await canonicalizeWorkspace(requested);
    const registration = await withDevcontainerOperationLock(
      host,
      workspace,
      async () => {
        const verified = await verify(workspace);
        const current = await readDevcontainerSession(host, workspace);
        const running = await devcontainerRuntimeIsRunning(host, workspace);
        if (running) {
          // Another up is preparing this workspace, or a ready session exists.
          if (current?.fingerprint !== verified.fingerprint)
            throw new DevcontainerError(
              "a devcontainer for another configuration is still running; run devcontainer down",
            );
          return verified;
        }
        // A container ID that outlived its runtime means teardown never
        // finished, whichever phase recorded it: a killed runtime leaves the
        // record active, one whose compose down failed leaves it failed. Both
        // leave a container this up would otherwise start a second one over.
        if (current?.containerId)
          throw new DevcontainerError(
            "previous devcontainer cleanup is incomplete; run devcontainer down",
          );
        const sessionId = `dc_${crypto.randomUUID().replaceAll("-", "")}`;
        await writeDevcontainerSession(host, workspace, {
          version: 1,
          workspaceId: verified.workspaceId,
          fingerprint: verified.fingerprint,
          sessionId,
          containerId: null,
          phase: "starting",
          pid: null,
          diagnostic: null,
        });
        await spawn(host, verified, sessionId, deadlineAt);
        return verified;
      },
      Math.max(0, deadlineAt - Date.now()),
    );

    const claimBy = Date.now() + CLAIM_GRACE_MS;
    while (Date.now() < deadlineAt) {
      const session = await readDevcontainerSession(host, workspace);
      if (session?.phase === "ready")
        return await observe(registration, session);
      if (session && !active(session.phase))
        throw new DevcontainerError(
          session.diagnostic || `devcontainer entered ${session.phase}`,
        );
      // Before the claim the runtime may not hold the lifetime lock yet, so an
      // unlocked workspace does not yet mean the runtime is gone.
      if (
        (session?.pid !== null || Date.now() > claimBy) &&
        !(await devcontainerRuntimeIsRunning(host, workspace))
      )
        throw new DevcontainerError(
          session?.diagnostic ?? "devcontainer runtime exited before ready",
        );
      await Bun.sleep(POLL_MS);
    }
    throw new DevcontainerError("devcontainer startup deadline exceeded");
  };

  const down = async (
    requested: string,
  ): Promise<DevcontainerStatus | null> => {
    const deadlineAt = Date.now() + SHUTDOWN_GRACE_MS;
    const workspace = await canonicalizeWorkspace(requested);
    const registration = await readDevcontainerRegistration(host, workspace);
    if (!registration) return null;
    const session = await readDevcontainerSession(host, workspace);
    const pid = session?.pid ?? null;
    if (
      session &&
      pid !== null &&
      (await isDevcontainerRuntimePid(pid, session.sessionId))
    )
      signalProcess(pid, "SIGTERM");
    while (
      Date.now() < deadlineAt &&
      (await devcontainerRuntimeIsRunning(host, workspace))
    )
      await Bun.sleep(POLL_MS);
    if (await devcontainerRuntimeIsRunning(host, workspace))
      throw new DevcontainerError("devcontainer shutdown deadline exceeded");
    // Teardown and the stopped record run under the operation lock: without it
    // an up that starts between the two would have its Compose service removed
    // and its session record overwritten by this down.
    return await withDevcontainerOperationLock(host, workspace, async () => {
      const current = await readDevcontainerSession(host, workspace);
      if (
        current &&
        current.sessionId !== (session?.sessionId ?? "") &&
        active(current.phase)
      )
        return projectDevcontainerStatus(registration, current);
      // The runtime removes its own container; this clears the Compose network
      // and any container left behind by a killed runtime.
      await composeDown(registration);
      const stopped: DevcontainerSessionRecord = {
        version: 1,
        workspaceId: registration.workspaceId,
        fingerprint: registration.fingerprint,
        sessionId: session?.sessionId ?? "",
        containerId: null,
        phase: "stopped",
        pid: null,
        diagnostic: null,
      };
      if (session) await writeDevcontainerSession(host, workspace, stopped);
      return projectDevcontainerStatus(registration, session ? stopped : null);
    });
  };

  return { init, up, down, status, verify };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface ServeDevcontainerRuntimeOptions {
  readonly host: HostEnv;
  readonly workspace: string;
  readonly sessionId: string;
  readonly deadlineAt: number;
  readonly runRuntime: (
    registration: DevcontainerRegistration,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<{ ok: boolean; diagnostic?: string }>;
  readonly verifyRegistration?: (
    workspace: string,
  ) => Promise<DevcontainerRegistration>;
}

/**
 * Body of the detached `devcontainer _serve` process.
 *
 * It exists to hold the preparation pipeline's Effect scope — the network and
 * hostexec brokers, the mask filesystem, and the port-bind relays all live as
 * long as this process does. The lifetime lock it holds is what `up`, `down`,
 * and `status` use to decide whether that scope is still alive.
 */
export async function serveDevcontainerRuntime(
  options: ServeDevcontainerRuntimeOptions,
): Promise<void> {
  const { host, sessionId } = options;
  const workspace = await canonicalizeWorkspace(options.workspace);
  const runtime = resolveDevcontainerRuntimePaths(host, workspace);
  const lifetime = await acquireDevcontainerLock(runtime.lifetimeLock, 0);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("devcontainer stop requested"));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const registration = await (
      options.verifyRegistration ?? makeDevcontainerLifecycle(host).verify
    )(workspace);
    await withDevcontainerOperationLock(host, workspace, async () => {
      const session = await readDevcontainerSession(host, workspace);
      if (
        !session ||
        session.sessionId !== sessionId ||
        session.phase !== "starting" ||
        session.fingerprint !== registration.fingerprint
      )
        throw new DevcontainerError(
          "runtime does not own the starting session",
        );
      await writeDevcontainerSession(host, workspace, {
        ...session,
        pid: process.pid,
      });
    });
    const outcome = await options.runRuntime(
      registration,
      controller.signal,
      options.deadlineAt,
    );
    if (!outcome.ok)
      throw new DevcontainerError(
        outcome.diagnostic || "devcontainer runtime failed",
      );
  } catch (error) {
    await markDevcontainerFailure(
      host,
      workspace,
      sessionId,
      safeDiagnostic(error, "devcontainer preparation failed"),
    );
    throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await lifetime.release();
  }
}

/** Only the owning session may publish a failure; a later session must not be overwritten. */
export async function markDevcontainerFailure(
  host: HostEnv,
  workspace: string,
  sessionId: string,
  diagnostic: string,
): Promise<void> {
  await withDevcontainerOperationLock(host, workspace, async () => {
    const current = await readDevcontainerSession(host, workspace);
    if (!current || current.sessionId !== sessionId) return;
    if (current.phase === "stopped" || current.phase === "failed") return;
    await writeDevcontainerSession(host, workspace, {
      ...current,
      phase: "failed",
      diagnostic,
    });
  });
}
