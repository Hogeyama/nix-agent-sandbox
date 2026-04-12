/**
 * D-Bus Proxy Stage (EffectStage)
 *
 * xdg-dbus-proxy を起動して、エージェントコンテナ内から
 * ホストの D-Bus セッションバスにフィルタ付きでアクセスできるようにする。
 */

import { Effect, type Scope } from "effect";
import type { DbusRuleConfig } from "../config/types.ts";
import { logWarn } from "../log.ts";
import type {
  EffectStage,
  EffectStageResult,
  HostEnv,
  StageInput,
} from "../pipeline/types.ts";
import { FsService } from "../services/fs.ts";
import { ProcessService } from "../services/process.ts";

const SOCKET_READY_TIMEOUT_MS = 5_000;
const SOCKET_READY_POLL_MS = 50;

// ---------------------------------------------------------------------------
// DbusProxyPlan
// ---------------------------------------------------------------------------

export interface DbusProxyPlan {
  readonly proxyBinaryPath: string;
  readonly runtimeDir: string;
  readonly sessionsDir: string;
  readonly sessionDir: string;
  readonly socketPath: string;
  readonly args: string[];
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly outputOverrides: EffectStageResult;
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createDbusProxyStage(): EffectStage<
  FsService | ProcessService
> {
  return {
    kind: "effect",
    name: "DbusProxyStage",

    run(
      input: StageInput,
    ): Effect.Effect<
      EffectStageResult,
      unknown,
      Scope.Scope | FsService | ProcessService
    > {
      const plan = planDbusProxy(input);
      if (plan === null) {
        return Effect.succeed({});
      }
      if (plan.proxyBinaryPath === "") {
        return Effect.succeed(plan.outputOverrides);
      }
      return runDbusProxy(plan);
    },
  };
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

function planDbusProxy(input: StageInput): DbusProxyPlan | null {
  if (!input.profile.dbus.session.enable) {
    return null;
  }

  const uid = input.host.uid;
  if (uid === null) {
    logWarn(
      "[nas] dbus.session.enable requires a host UID to mount /run/user/$UID — skipping D-Bus proxy",
    );
    return {
      proxyBinaryPath: "",
      runtimeDir: "",
      sessionsDir: "",
      sessionDir: "",
      socketPath: "",
      args: [],
      timeoutMs: 0,
      pollIntervalMs: 0,
      outputOverrides: { dbusProxyEnabled: false },
    };
  }

  const proxyBin = input.probes.xdgDbusProxyPath;
  if (!proxyBin) {
    logWarn(
      "[nas] xdg-dbus-proxy not found on PATH — skipping D-Bus proxy (install xdg-dbus-proxy to enable)",
    );
    return {
      proxyBinaryPath: "",
      runtimeDir: "",
      sessionsDir: "",
      sessionDir: "",
      socketPath: "",
      args: [],
      timeoutMs: 0,
      pollIntervalMs: 0,
      outputOverrides: { dbusProxyEnabled: false },
    };
  }

  const sourceAddress = resolveSourceAddress(
    input.profile.dbus.session.sourceAddress,
    input.probes.dbusSessionAddress,
    uid,
  );
  if (!sourceAddress) {
    logWarn(
      "[nas] DBUS_SESSION_BUS_ADDRESS not set and /run/user/$UID/bus not found — skipping D-Bus proxy",
    );
    return {
      proxyBinaryPath: "",
      runtimeDir: "",
      sessionsDir: "",
      sessionDir: "",
      socketPath: "",
      args: [],
      timeoutMs: 0,
      pollIntervalMs: 0,
      outputOverrides: { dbusProxyEnabled: false },
    };
  }

  if (!sourceAddress.startsWith("unix:path=")) {
    logWarn(
      `[nas] Unsupported dbus source address: ${sourceAddress}. Only unix:path=... is supported — skipping D-Bus proxy`,
    );
    return {
      proxyBinaryPath: "",
      runtimeDir: "",
      sessionsDir: "",
      sessionDir: "",
      socketPath: "",
      args: [],
      timeoutMs: 0,
      pollIntervalMs: 0,
      outputOverrides: { dbusProxyEnabled: false },
    };
  }

  const runtimeDir = resolveRuntimeDir(input.host);
  const sessionsDir = `${runtimeDir}/sessions`;
  const sessionDir = `${sessionsDir}/${input.sessionId}`;
  const socketPath = `${sessionDir}/bus`;

  const commandArgs = buildProxyArgs(
    sourceAddress,
    socketPath,
    input.profile.dbus.session.see,
    input.profile.dbus.session.talk,
    input.profile.dbus.session.own,
    input.profile.dbus.session.calls,
    input.profile.dbus.session.broadcasts,
  );

  return {
    proxyBinaryPath: proxyBin,
    runtimeDir,
    sessionsDir,
    sessionDir,
    socketPath,
    args: commandArgs,
    timeoutMs: SOCKET_READY_TIMEOUT_MS,
    pollIntervalMs: SOCKET_READY_POLL_MS,
    outputOverrides: {
      dbusProxyEnabled: true,
      dbusSessionRuntimeDir: sessionDir,
      dbusSessionSocket: socketPath,
      dbusSessionSourceAddress: sourceAddress,
    },
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runDbusProxy(
  plan: DbusProxyPlan,
): Effect.Effect<
  EffectStageResult,
  unknown,
  Scope.Scope | FsService | ProcessService
> {
  return Effect.gen(function* () {
    const fs = yield* FsService;
    const proc = yield* ProcessService;

    yield* fs.mkdir(plan.runtimeDir, { recursive: true, mode: 0o755 });
    yield* fs.mkdir(plan.sessionsDir, { recursive: true, mode: 0o700 });
    yield* fs.mkdir(plan.sessionDir, { recursive: true, mode: 0o700 });

    yield* Effect.acquireRelease(
      proc.spawn(plan.proxyBinaryPath, plan.args),
      (handle) => Effect.sync(() => handle.kill()),
    );

    yield* proc.waitForFileExists(
      plan.socketPath,
      plan.timeoutMs,
      plan.pollIntervalMs,
    );

    return plan.outputOverrides;
  });
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

export function resolveSourceAddress(
  configuredAddress: string | undefined,
  probeAddress: string | null,
  uid: number,
): string | null {
  if (configuredAddress) return configuredAddress;
  if (probeAddress) return probeAddress;
  return `unix:path=/run/user/${uid}/bus`;
}

export function buildProxyArgs(
  sourceAddress: string,
  socketPath: string,
  see: string[],
  talk: string[],
  own: string[],
  calls: DbusRuleConfig[],
  broadcasts: DbusRuleConfig[],
): string[] {
  const args = [sourceAddress, socketPath, "--filter"];
  for (const name of see) {
    args.push(`--see=${name}`);
  }
  for (const name of talk) {
    args.push(`--talk=${name}`);
  }
  for (const name of own) {
    args.push(`--own=${name}`);
  }
  for (const rule of calls) {
    args.push(`--call=${rule.name}=${rule.rule}`);
  }
  for (const rule of broadcasts) {
    args.push(`--broadcast=${rule.name}=${rule.rule}`);
  }
  return args;
}

export function resolveRuntimeDir(host: HostEnv): string {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return `${xdg}/nas/dbus`;
  }
  const uid = host.uid ?? "unknown";
  return `/tmp/nas-${uid}/dbus`;
}
