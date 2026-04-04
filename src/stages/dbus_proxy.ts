/**
 * D-Bus Proxy Stage (PlanStage)
 *
 * xdg-dbus-proxy を起動して、エージェントコンテナ内から
 * ホストの D-Bus セッションバスにフィルタ付きでアクセスできるようにする。
 */

import type {
  HostEnv,
  PlanStage,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";
import type { DbusRuleConfig } from "../config/types.ts";
import { logWarn } from "../log.ts";

const SOCKET_READY_TIMEOUT_MS = 5_000;
const SOCKET_READY_POLL_MS = 50;

// ---------------------------------------------------------------------------
// PlanStage
// ---------------------------------------------------------------------------

export function createDbusProxyStage(): PlanStage {
  return {
    kind: "plan",
    name: "DbusProxyStage",

    plan(input: StageInput): StagePlan | null {
      if (!input.profile.dbus.session.enable) {
        return null;
      }

      const uid = input.host.uid;
      if (uid === null) {
        logWarn(
          "[nas] dbus.session.enable requires a host UID to mount /run/user/$UID — skipping D-Bus proxy",
        );
        return {
          effects: [],
          dockerArgs: [],
          envVars: {},
          outputOverrides: { dbusProxyEnabled: false },
        };
      }

      const proxyBin = input.probes.xdgDbusProxyPath;
      if (!proxyBin) {
        logWarn(
          "[nas] xdg-dbus-proxy not found on PATH — skipping D-Bus proxy (install xdg-dbus-proxy to enable)",
        );
        return {
          effects: [],
          dockerArgs: [],
          envVars: {},
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
          effects: [],
          dockerArgs: [],
          envVars: {},
          outputOverrides: { dbusProxyEnabled: false },
        };
      }

      if (!sourceAddress.startsWith("unix:path=")) {
        logWarn(
          `[nas] Unsupported dbus source address: ${sourceAddress}. Only unix:path=... is supported — skipping D-Bus proxy`,
        );
        return {
          effects: [],
          dockerArgs: [],
          envVars: {},
          outputOverrides: { dbusProxyEnabled: false },
        };
      }

      // Compute session paths (pure computation).
      const runtimeDir = resolveRuntimeDir(input.host);
      const sessionsDir = `${runtimeDir}/sessions`;
      const sessionDir = `${sessionsDir}/${input.sessionId}`;
      const socketPath = `${sessionDir}/bus`;
      const pidFile = `${sessionDir}/proxy.pid`;

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
        effects: [
          {
            kind: "dbus-proxy",
            proxyBinaryPath: proxyBin,
            runtimeDir,
            sessionsDir,
            sessionDir,
            socketPath,
            pidFile,
            sourceAddress,
            args: commandArgs,
            timeoutMs: SOCKET_READY_TIMEOUT_MS,
            pollIntervalMs: SOCKET_READY_POLL_MS,
          },
        ],
        dockerArgs: [],
        envVars: {},
        outputOverrides: {
          dbusProxyEnabled: true,
          dbusSessionRuntimeDir: sessionDir,
          dbusSessionSocket: socketPath,
          dbusSessionSourceAddress: sourceAddress,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Resolve the D-Bus source address.
 * Prefers configured address, then probe result (from env), then default path.
 *
 * Note: When both configuredAddress and probeAddress are absent, the function
 * returns a default unix:path based on the uid. The caller validates whether
 * the returned address is usable (e.g. starts with "unix:path="), so null
 * is never actually returned in the current code path.
 */
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

/**
 * Resolve the dbus runtime directory path (pure, no I/O).
 * Uses HostEnv instead of directly accessing Deno.env / Deno.uid().
 */
export function resolveRuntimeDir(host: HostEnv): string {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  if (xdg && xdg.trim().length > 0) {
    return `${xdg}/nas/dbus`;
  }
  const uid = host.uid ?? "unknown";
  return `/tmp/nas-${uid}/dbus`;
}
