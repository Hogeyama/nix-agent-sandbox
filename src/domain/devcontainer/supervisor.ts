import { constants } from "node:fs";
import { chmod, lstat, open, unlink } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import * as path from "node:path";
import { runDockerCommand } from "../../docker/client.ts";
import {
  NAS_KIND_AGENT,
  NAS_KIND_LABEL,
  NAS_MANAGED_LABEL,
  NAS_MANAGED_VALUE,
  NAS_SESSION_ID_LABEL,
} from "../../docker/nas_resources.ts";
import type { HostEnv } from "../../pipeline/types.ts";
import { makeDevcontainerClient } from "./service.ts";
import {
  acquireDevcontainerLock,
  canonicalizeWorkspace,
  ensureProtectedDirectory,
  readDevcontainerRegistration,
  readDevcontainerSession,
  requireHostUid,
  resolveDevcontainerRuntimePaths,
  withDevcontainerOperationLock,
  writeDevcontainerSession,
  writeProtectedFile,
} from "./store.ts";
import {
  DevcontainerError,
  type DevcontainerRegistration,
  type DevcontainerSessionRecord,
  type DevcontainerStatus,
  projectDevcontainerStatus,
} from "./types.ts";

const STARTUP_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 2_000;
const POLL_MS = 50;
const MAX_CONTROL_BYTES = 16_384;

type ControlAction = "status" | "stop";

interface ControlRequest {
  readonly version: 1;
  readonly action: ControlAction;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly challenge: string;
}

interface ControlResponse {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly challenge: string;
  readonly accepted: boolean;
  readonly status: DevcontainerSessionRecord;
}

export interface DevcontainerRuntimeOutcome {
  readonly ok: boolean;
  readonly diagnostic?: string;
}

export interface DevcontainerSupervisorOptions {
  readonly startupTimeoutMs?: number;
  readonly spawn?: typeof spawnDetachedDevcontainerSupervisor;
  readonly request?: typeof requestDevcontainerControl;
  readonly inspect?: typeof inspectOwnedDevcontainer;
  readonly cleanup?: typeof cleanupOwnedDevcontainer;
  readonly verify?: (workspace: string) => Promise<DevcontainerRegistration>;
}

function sessionRecord(
  registration: DevcontainerRegistration,
  sessionId: string,
  phase: DevcontainerSessionRecord["phase"],
  diagnostic: string | null = null,
): DevcontainerSessionRecord {
  return {
    version: 1,
    workspaceId: registration.workspaceId,
    fingerprint: registration.fingerprint,
    sessionId,
    containerId: null,
    phase,
    controlSocket: "",
    diagnostic,
  };
}

function withSocket(
  host: HostEnv,
  workspace: string,
  record: DevcontainerSessionRecord,
): DevcontainerSessionRecord {
  return {
    ...record,
    controlSocket: resolveDevcontainerRuntimePaths(host, workspace)
      .controlSocket,
  };
}

function sameGeneration(
  actual: DevcontainerSessionRecord | null,
  expected: DevcontainerSessionRecord,
): actual is DevcontainerSessionRecord {
  return (
    actual?.workspaceId === expected.workspaceId &&
    actual.sessionId === expected.sessionId &&
    actual.fingerprint === expected.fingerprint &&
    actual.controlSocket === expected.controlSocket
  );
}

function active(phase: DevcontainerSessionRecord["phase"]): boolean {
  return phase === "preparing" || phase === "starting" || phase === "ready";
}

function safeDiagnostic(error: unknown, prefix: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw
    .split(/\r?\n/, 1)[0]
    ?.split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  return `${prefix}: ${(firstLine || "unknown error").slice(0, 500)}`;
}

async function lifetimeIsFree(
  host: HostEnv,
  workspace: string,
): Promise<boolean> {
  const runtime = resolveDevcontainerRuntimePaths(host, workspace);
  try {
    const lock = await acquireDevcontainerLock(
      runtime.lifetimeLock,
      requireHostUid(host),
      0,
    );
    await lock.release();
    return true;
  } catch (error) {
    if (
      error instanceof DevcontainerError &&
      error.message.includes("lock unavailable")
    )
      return false;
    throw error;
  }
}

function statusOf(
  registration: DevcontainerRegistration,
  session: DevcontainerSessionRecord | null,
): DevcontainerStatus {
  return projectDevcontainerStatus(registration, session);
}

function parseControlResponse(
  bytes: string,
  registration: DevcontainerRegistration,
  sessionId: string,
  challenge: string,
): ControlResponse {
  const value = JSON.parse(bytes) as Partial<ControlResponse>;
  if (
    value.version !== 1 ||
    value.workspaceId !== registration.workspaceId ||
    value.sessionId !== sessionId ||
    value.challenge !== challenge ||
    value.accepted !== true ||
    !value.status ||
    value.status.workspaceId !== registration.workspaceId ||
    value.status.sessionId !== sessionId
  )
    throw new DevcontainerError("invalid devcontainer supervisor response");
  return value as ControlResponse;
}

/** Challenge-response client. A stale socket or another generation cannot answer successfully. */
export async function requestDevcontainerControl(
  registration: DevcontainerRegistration,
  session: DevcontainerSessionRecord,
  action: ControlAction,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<DevcontainerSessionRecord> {
  const challenge = crypto.randomUUID();
  const request: ControlRequest = {
    version: 1,
    action,
    workspaceId: registration.workspaceId,
    sessionId: session.sessionId,
    challenge,
  };
  return await new Promise((resolve, reject) => {
    const socket = connect({ path: session.controlSocket });
    let bytes = "";
    let done = false;
    const finish = (error?: Error, value?: DevcontainerSessionRecord) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as DevcontainerSessionRecord);
    };
    const timer = setTimeout(
      () =>
        finish(
          new DevcontainerError("devcontainer supervisor did not respond"),
        ),
      timeoutMs,
    );
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      bytes += chunk.toString("utf8");
      if (Buffer.byteLength(bytes) > MAX_CONTROL_BYTES)
        return finish(
          new DevcontainerError(
            "devcontainer supervisor response is too large",
          ),
        );
      const newline = bytes.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(
          undefined,
          parseControlResponse(
            bytes.slice(0, newline),
            registration,
            session.sessionId,
            challenge,
          ).status,
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

interface OwnedInspection {
  readonly id: string;
  readonly running: boolean;
  readonly labels: Record<string, string>;
}

async function inspectContainer(id: string): Promise<OwnedInspection | null> {
  try {
    const result = await runDockerCommand(["inspect", id], {
      timeoutMs: 10_000,
    });
    const parsed = (
      JSON.parse(Buffer.from(result.stdout).toString()) as Array<{
        Id?: unknown;
        State?: { Running?: unknown };
        Config?: { Labels?: unknown };
      }>
    )[0];
    if (!parsed || typeof parsed.Id !== "string")
      throw new DevcontainerError("invalid Docker inspection response");
    return {
      id: parsed.Id,
      running: parsed.State?.Running === true,
      labels:
        parsed.Config?.Labels && typeof parsed.Config.Labels === "object"
          ? (parsed.Config.Labels as Record<string, string>)
          : {},
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("No such object") ||
      message.includes("No such container")
    )
      return null;
    throw error;
  }
}

function assertOwned(
  registration: DevcontainerRegistration,
  session: DevcontainerSessionRecord,
  inspection: OwnedInspection,
): void {
  if (
    inspection.id !== session.containerId ||
    inspection.labels[NAS_MANAGED_LABEL] !== NAS_MANAGED_VALUE ||
    inspection.labels[NAS_KIND_LABEL] !== NAS_KIND_AGENT ||
    inspection.labels[NAS_SESSION_ID_LABEL] !== session.sessionId ||
    inspection.labels["devcontainer.local_folder"] !== registration.workspace ||
    inspection.labels["devcontainer.config_file"] !== registration.configPath
  )
    throw new DevcontainerError("devcontainer container ownership mismatch");
}

/** Rechecks the exact recorded ID and all ownership labels. */
export async function inspectOwnedDevcontainer(
  registration: DevcontainerRegistration,
  session: DevcontainerSessionRecord,
): Promise<boolean> {
  if (!session.containerId) return false;
  const inspection = await inspectContainer(session.containerId);
  if (!inspection) return false;
  assertOwned(registration, session, inspection);
  return inspection.running;
}

/** Stops/removes only the exact ID after an ownership-label inspection. */
export async function cleanupOwnedDevcontainer(
  registration: DevcontainerRegistration,
  session: DevcontainerSessionRecord,
): Promise<void> {
  if (!session.containerId) return;
  const inspection = await inspectContainer(session.containerId);
  if (!inspection) return;
  assertOwned(registration, session, inspection);
  if (inspection.running)
    await runDockerCommand(["stop", session.containerId], {
      timeoutMs: 15_000,
    });
  await runDockerCommand(["rm", session.containerId], { timeoutMs: 10_000 });
}

/** Spawn through setsid using the registration's argv, with a private per-generation log. */
export async function spawnDetachedDevcontainerSupervisor(
  host: HostEnv,
  registration: DevcontainerRegistration,
  sessionId: string,
  deadlineAt: number,
): Promise<void> {
  const uid = requireHostUid(host);
  const runtime = resolveDevcontainerRuntimePaths(host, registration.workspace);
  await ensureProtectedDirectory(runtime.runtimeDir, uid);
  const logFile = path.join(runtime.runtimeDir, `${sessionId}.log`);
  await writeProtectedFile(logFile, "", uid, true);
  const handle = await open(
    logFile,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    const env = { ...process.env };
    delete env.NAS_SESSION_ID;
    const child = Bun.spawn(
      [
        "setsid",
        ...registration.command,
        "devcontainer",
        "_supervise",
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
    const handoffDeadline = Math.min(
      deadlineAt,
      Date.now() + CONTROL_TIMEOUT_MS,
    );
    while (await lifetimeIsFree(host, registration.workspace)) {
      if (Date.now() >= handoffDeadline)
        throw new DevcontainerError(
          "devcontainer supervisor did not claim its lifetime lock",
        );
      await Bun.sleep(POLL_MS);
    }
  } finally {
    await handle.close();
  }
}

async function waitForGeneration(
  host: HostEnv,
  registration: DevcontainerRegistration,
  initial: DevcontainerSessionRecord,
  deadlineAt: number,
  request: typeof requestDevcontainerControl,
  inspect: typeof inspectOwnedDevcontainer,
  recoverIfLifetimeFree: boolean,
): Promise<DevcontainerSessionRecord> {
  let lastError: unknown;
  while (Date.now() < deadlineAt) {
    try {
      const status = await request(registration, initial, "status");
      if (!sameGeneration(status, initial))
        throw new DevcontainerError(
          "devcontainer supervisor generation changed",
        );
      if (status.phase === "ready") {
        if (!(await inspect(registration, status)))
          throw new DevcontainerError("devcontainer container is not running");
        return status;
      }
      if (status.phase === "failed" || status.phase === "stopped")
        return status;
    } catch (error) {
      lastError = error;
      const current = await readDevcontainerSession(
        host,
        registration.workspace,
      );
      if (sameGeneration(current, initial)) {
        if (current.phase === "failed" || current.phase === "stopped")
          return current;
      } else if (current !== null) {
        throw new DevcontainerError(
          "devcontainer supervisor generation changed",
        );
      }
      if (
        recoverIfLifetimeFree &&
        (await lifetimeIsFree(host, registration.workspace))
      )
        throw new DevcontainerError("devcontainer supervisor is not running");
    }
    await Bun.sleep(Math.min(POLL_MS, Math.max(1, deadlineAt - Date.now())));
  }
  throw new DevcontainerError(
    lastError instanceof Error
      ? `devcontainer startup deadline exceeded: ${lastError.message}`
      : "devcontainer startup deadline exceeded",
  );
}

async function writeTerminal(
  host: HostEnv,
  registration: DevcontainerRegistration,
  expected: DevcontainerSessionRecord,
  phase: "failed" | "stopped",
  diagnostic: string | null,
): Promise<DevcontainerSessionRecord | null> {
  return await withDevcontainerOperationLock(
    host,
    registration.workspace,
    async () => {
      const current = await readDevcontainerSession(
        host,
        registration.workspace,
      );
      if (!sameGeneration(current, expected)) return current;
      const next = { ...current, phase, containerId: null, diagnostic };
      await writeDevcontainerSession(
        host,
        registration.workspace,
        next,
        expected.sessionId,
      );
      return next;
    },
  );
}

export function makeDevcontainerSupervisorClient(
  host: HostEnv,
  options: DevcontainerSupervisorOptions = {},
) {
  const timeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  const spawn = options.spawn ?? spawnDetachedDevcontainerSupervisor;
  const request = options.request ?? requestDevcontainerControl;
  const inspect = options.inspect ?? inspectOwnedDevcontainer;
  const cleanup = options.cleanup ?? cleanupOwnedDevcontainer;
  const verify = options.verify ?? makeDevcontainerClient(host).verify;

  const canonical = (workspace: string) =>
    canonicalizeWorkspace(workspace, requireHostUid(host));

  const recover = async (
    registration: DevcontainerRegistration,
    session: DevcontainerSessionRecord,
    stopped: boolean,
  ): Promise<DevcontainerSessionRecord> => {
    if (!(await lifetimeIsFree(host, registration.workspace)))
      throw new DevcontainerError("devcontainer supervisor is still running");
    try {
      await cleanup(registration, session);
    } catch (error) {
      const diagnostic = safeDiagnostic(error, "orphan cleanup failed");
      await withDevcontainerOperationLock(
        host,
        registration.workspace,
        async () => {
          const current = await readDevcontainerSession(
            host,
            registration.workspace,
          );
          if (!sameGeneration(current, session)) return;
          await writeDevcontainerSession(
            host,
            registration.workspace,
            { ...current, phase: "failed", diagnostic },
            session.sessionId,
          );
        },
      );
      throw new DevcontainerError(diagnostic);
    }
    return (
      (await writeTerminal(
        host,
        registration,
        session,
        stopped ? "stopped" : "failed",
        stopped ? null : "devcontainer supervisor stopped unexpectedly",
      )) ?? session
    );
  };

  const status = async (
    requested: string,
  ): Promise<DevcontainerStatus | null> => {
    const workspace = await canonical(requested);
    const registration = await readDevcontainerRegistration(host, workspace);
    if (!registration) return null;
    const session = await readDevcontainerSession(host, workspace);
    if (!session || !active(session.phase))
      return statusOf(registration, session);
    try {
      const observed = await request(registration, session, "status");
      if (
        observed.phase === "ready" &&
        !(await inspect(registration, observed))
      )
        throw new DevcontainerError("devcontainer container is not running");
      return statusOf(registration, observed);
    } catch (error) {
      if (!(await lifetimeIsFree(host, workspace)))
        return {
          ...statusOf(registration, session),
          phase: "failed",
          diagnostic: safeDiagnostic(error, "supervisor status unavailable"),
        };
      const recovered = await recover(registration, session, false);
      return statusOf(registration, recovered);
    }
  };

  const up = async (requested: string): Promise<DevcontainerStatus> => {
    const deadlineAt = Date.now() + timeoutMs;
    const workspace = await canonical(requested);
    for (let attempt = 0; attempt < 2; attempt++) {
      let registration!: DevcontainerRegistration;
      let target!: DevcontainerSessionRecord;
      let spawned = false;
      await withDevcontainerOperationLock(
        host,
        workspace,
        async () => {
          registration = await verify(workspace);
          const current = await readDevcontainerSession(host, workspace);
          if (
            current &&
            current.fingerprint === registration.fingerprint &&
            active(current.phase)
          ) {
            target = current;
            return;
          }
          if (current?.containerId)
            throw new DevcontainerError(
              "previous devcontainer cleanup is incomplete; run devcontainer down",
            );
          if (!(await lifetimeIsFree(host, workspace)))
            throw new DevcontainerError(
              "previous devcontainer supervisor is still exiting",
            );
          const next = withSocket(
            host,
            workspace,
            sessionRecord(
              registration,
              `dc_${crypto.randomUUID().replaceAll("-", "")}`,
              "preparing",
            ),
          );
          await writeDevcontainerSession(host, workspace, next);
          try {
            await spawn(host, registration, next.sessionId, deadlineAt);
          } catch (error) {
            const failed = {
              ...next,
              phase: "failed" as const,
              diagnostic: safeDiagnostic(error, "supervisor spawn failed"),
            };
            await writeDevcontainerSession(
              host,
              workspace,
              failed,
              next.sessionId,
            );
            throw error;
          }
          target = next;
          spawned = true;
        },
        Math.max(0, deadlineAt - Date.now()),
      );
      try {
        const ready = await waitForGeneration(
          host,
          registration,
          target,
          deadlineAt,
          request,
          inspect,
          !spawned,
        );
        if (ready.phase !== "ready")
          throw new DevcontainerError(
            ready.diagnostic || `devcontainer entered ${ready.phase}`,
          );
        return statusOf(registration, ready);
      } catch (error) {
        if (spawned || !(await lifetimeIsFree(host, workspace))) throw error;
        await recover(registration, target, false);
      }
    }
    throw new DevcontainerError(
      "devcontainer could not establish a live generation",
    );
  };

  const down = async (
    requested: string,
  ): Promise<DevcontainerStatus | null> => {
    const deadlineAt = Date.now() + timeoutMs;
    const workspace = await canonical(requested);
    const registration = await readDevcontainerRegistration(host, workspace);
    if (!registration) return null;
    let target: DevcontainerSessionRecord | null = null;
    await withDevcontainerOperationLock(host, workspace, async () => {
      const current = await readDevcontainerSession(host, workspace);
      if (!current || (current.phase === "stopped" && !current.containerId))
        return;
      target = current;
      if (active(current.phase)) {
        await writeDevcontainerSession(
          host,
          workspace,
          { ...current, phase: "stopping", diagnostic: null },
          current.sessionId,
        );
      }
    });
    if (!target)
      return statusOf(
        registration,
        await readDevcontainerSession(host, workspace),
      );
    const generation = target as DevcontainerSessionRecord;
    let stopAccepted = false;
    let stopError: unknown;
    while (Date.now() < deadlineAt) {
      const current = await readDevcontainerSession(host, workspace);
      if (!sameGeneration(current, generation))
        return statusOf(registration, current);
      if (current.phase === "stopped") return statusOf(registration, current);
      if (!stopAccepted) {
        try {
          await request(registration, generation, "stop");
          stopAccepted = true;
        } catch (error) {
          stopError = error;
        }
      }
      if (await lifetimeIsFree(host, workspace)) {
        const recovered = await recover(registration, current, true);
        return statusOf(registration, recovered);
      }
      await Bun.sleep(Math.min(POLL_MS, Math.max(1, deadlineAt - Date.now())));
    }
    throw new DevcontainerError(
      stopError instanceof Error
        ? `devcontainer shutdown deadline exceeded: ${stopError.message}`
        : "devcontainer shutdown deadline exceeded",
    );
  };

  return { up, down, status };
}

function parseControlRequest(
  bytes: string,
  registration: DevcontainerRegistration,
  sessionId: string,
): ControlRequest {
  const value = JSON.parse(bytes) as Partial<ControlRequest>;
  if (
    value.version !== 1 ||
    (value.action !== "status" && value.action !== "stop") ||
    value.workspaceId !== registration.workspaceId ||
    value.sessionId !== sessionId ||
    typeof value.challenge !== "string" ||
    value.challenge.length < 16 ||
    value.challenge.length > 128
  )
    throw new DevcontainerError("invalid devcontainer supervisor request");
  return value as ControlRequest;
}

async function removeOwnedSocket(file: string, uid: number): Promise<void> {
  try {
    const st = await lstat(file);
    if (st.uid !== uid || !st.isSocket())
      throw new DevcontainerError("unsafe devcontainer control socket");
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function handleControlConnection(
  socket: Socket,
  registration: DevcontainerRegistration,
  expected: DevcontainerSessionRecord,
  host: HostEnv,
  stop: () => void,
): void {
  let bytes = "";
  socket.on("data", (chunk) => {
    bytes += chunk.toString("utf8");
    if (Buffer.byteLength(bytes) > MAX_CONTROL_BYTES) return socket.destroy();
    const newline = bytes.indexOf("\n");
    if (newline < 0) return;
    socket.pause();
    void (async () => {
      try {
        const request = parseControlRequest(
          bytes.slice(0, newline),
          registration,
          expected.sessionId,
        );
        const current = await readDevcontainerSession(
          host,
          registration.workspace,
        );
        if (!sameGeneration(current, expected))
          throw new DevcontainerError(
            "devcontainer session generation changed",
          );
        const response: ControlResponse = {
          version: 1,
          workspaceId: registration.workspaceId,
          sessionId: expected.sessionId,
          challenge: request.challenge,
          accepted: true,
          status: current,
        };
        socket.end(`${JSON.stringify(response)}\n`);
        if (request.action === "stop") setTimeout(stop, 0);
      } catch {
        socket.destroy();
      }
    })();
  });
  socket.once("error", () => socket.destroy());
}

export interface ServeDevcontainerSupervisorOptions {
  readonly host: HostEnv;
  readonly workspace: string;
  readonly sessionId: string;
  readonly deadlineAt?: number;
  readonly runRuntime: (
    registration: DevcontainerRegistration,
    signal: AbortSignal,
    deadlineAt: number,
  ) => Promise<DevcontainerRuntimeOutcome>;
  /** Test seam for the registration gate; production always uses the domain verifier. */
  readonly verifyRegistration?: (
    workspace: string,
  ) => Promise<DevcontainerRegistration>;
}

/** Internal detached-process body. It owns the lifetime lock and protected UDS. */
export async function serveDevcontainerSupervisor(
  options: ServeDevcontainerSupervisorOptions,
): Promise<void> {
  const { host, sessionId } = options;
  const deadlineAt = options.deadlineAt ?? Date.now() + STARTUP_TIMEOUT_MS;
  const uid = requireHostUid(host);
  const workspace = await canonicalizeWorkspace(options.workspace, uid);
  const runtime = resolveDevcontainerRuntimePaths(host, workspace);
  const lifetime = await acquireDevcontainerLock(runtime.lifetimeLock, uid, 0);
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("devcontainer stop requested"));
  const signal = () => stop();
  let server: Server | null = null;
  const connections = new Set<Socket>();
  try {
    const [claimedRegistration, claimedSession] =
      await withDevcontainerOperationLock(host, workspace, async () => {
        const registration = await readDevcontainerRegistration(
          host,
          workspace,
        );
        const session = await readDevcontainerSession(host, workspace);
        if (
          !registration ||
          !session ||
          session.sessionId !== sessionId ||
          session.phase !== "preparing" ||
          session.fingerprint !== registration.fingerprint ||
          session.controlSocket !== runtime.controlSocket
        )
          throw new DevcontainerError(
            "supervisor does not own the preparing generation",
          );
        return [registration, session] as const;
      });
    try {
      const [ownedRegistration, ownedSession] =
        await withDevcontainerOperationLock(host, workspace, async () => {
          const registration = await (
            options.verifyRegistration ?? makeDevcontainerClient(host).verify
          )(workspace);
          const expected = await readDevcontainerSession(host, workspace);
          if (
            !expected ||
            expected.sessionId !== sessionId ||
            expected.phase !== "preparing" ||
            expected.fingerprint !== registration.fingerprint ||
            expected.controlSocket !== runtime.controlSocket
          )
            throw new DevcontainerError(
              "supervisor does not own the preparing generation",
            );
          return [registration, expected] as const;
        });
      await ensureProtectedDirectory(runtime.runtimeDir, uid);
      await removeOwnedSocket(runtime.controlSocket, uid);
      server = createServer((socket) => {
        connections.add(socket);
        socket.once("close", () => connections.delete(socket));
        handleControlConnection(
          socket,
          ownedRegistration,
          ownedSession,
          host,
          stop,
        );
      });
      await listen(server, runtime.controlSocket);
      await chmod(runtime.controlSocket, 0o600);
      process.on("SIGINT", signal);
      process.on("SIGTERM", signal);
      try {
        const outcome = await options.runRuntime(
          ownedRegistration,
          controller.signal,
          deadlineAt,
        );
        if (!outcome.ok)
          throw new DevcontainerError(
            outcome.diagnostic || "devcontainer runtime failed",
          );
      } finally {
        process.off("SIGINT", signal);
        process.off("SIGTERM", signal);
      }
    } catch (error) {
      const diagnostic = safeDiagnostic(
        error,
        "devcontainer preparation failed",
      );
      await markSupervisorFailure(
        host,
        claimedRegistration,
        claimedSession,
        diagnostic,
      );
      const current = await readDevcontainerSession(host, workspace);
      if (
        sameGeneration(current, claimedSession) &&
        current.phase === "stopped"
      )
        return;
      throw new DevcontainerError(diagnostic);
    }
  } finally {
    if (server) {
      for (const socket of connections) socket.destroy();
      if (server.listening) await closeServer(server);
    }
    await removeOwnedSocket(runtime.controlSocket, uid).catch(() => {});
    await lifetime.release();
  }
}

/** Generation-fenced outer failure owner for errors before Compose starts. */
export async function markSupervisorFailure(
  host: HostEnv,
  registration: DevcontainerRegistration,
  expected: DevcontainerSessionRecord,
  diagnostic: string,
): Promise<void> {
  await withDevcontainerOperationLock(
    host,
    registration.workspace,
    async () => {
      const current = await readDevcontainerSession(
        host,
        registration.workspace,
      );
      if (!sameGeneration(current, expected) || current.phase === "stopped")
        return;
      if (current.phase === "failed" && current.diagnostic) return;
      await writeDevcontainerSession(
        host,
        registration.workspace,
        { ...current, phase: "failed", diagnostic: diagnostic.slice(0, 1000) },
        expected.sessionId,
      );
    },
  );
}
