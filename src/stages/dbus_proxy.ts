import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import type { DbusRuleConfig } from "../config/types.ts";
import {
  type DbusSessionPaths,
  gcDbusRuntime,
  resolveDbusRuntimePaths,
  resolveDbusSessionPaths,
} from "../dbus/registry.ts";

const SOCKET_READY_TIMEOUT_MS = 5_000;
const SOCKET_READY_POLL_MS = 50;

export class DbusProxyStage implements Stage {
  name = "DbusProxyStage";

  private sessionPaths: DbusSessionPaths | null = null;
  private child: Deno.ChildProcess | null = null;
  private stderrText = "";
  private stderrCapture: Promise<void> | null = null;

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    if (!ctx.profile.dbus.session.enable) {
      return ctx;
    }

    const uid = Deno.uid();
    if (uid === null) {
      throw new Error(
        "[nas] dbus.session.enable requires a host UID to mount /run/user/$UID",
      );
    }

    const proxyBin = await resolveProxyBinary();
    if (!proxyBin) {
      throw new Error(
        "[nas] dbus.session.enable requires xdg-dbus-proxy on the host PATH",
      );
    }

    const sourceAddress = resolveSourceAddress(
      ctx.profile.dbus.session.sourceAddress,
      uid,
    );
    if (!sourceAddress) {
      throw new Error(
        "[nas] dbus.session.enable requires DBUS_SESSION_BUS_ADDRESS or a reachable /run/user/$UID/bus",
      );
    }

    validateSupportedSourceAddress(sourceAddress);
    await ensureSourceReachable(sourceAddress);

    try {
      const runtimePaths = await resolveDbusRuntimePaths();
      await gcDbusRuntime(runtimePaths);

      const sessionPaths = resolveDbusSessionPaths(runtimePaths, ctx.sessionId);
      this.sessionPaths = sessionPaths;
      await Deno.mkdir(sessionPaths.sessionDir, {
        recursive: true,
        mode: 0o700,
      });
      await Deno.chmod(sessionPaths.sessionDir, 0o700).catch(() => {});

      const commandArgs = buildProxyArgs(
        sourceAddress,
        sessionPaths.socketPath,
        ctx.profile.dbus.session.see,
        ctx.profile.dbus.session.talk,
        ctx.profile.dbus.session.own,
        ctx.profile.dbus.session.calls,
        ctx.profile.dbus.session.broadcasts,
      );

      const command = new Deno.Command(proxyBin, {
        args: commandArgs,
        stdout: "null",
        stderr: "piped",
      });
      const child = command.spawn();
      this.child = child;
      this.stderrText = "";
      this.stderrCapture = this.captureStderr(child);
      await Deno.writeTextFile(sessionPaths.pidFile, `${child.pid}\n`, {
        create: true,
        mode: 0o600,
      });

      await waitForSocketReady(
        sessionPaths.socketPath,
        child,
        () => this.stderrText,
      );

      return {
        ...ctx,
        dbusProxyEnabled: true,
        dbusSessionRuntimeDir: sessionPaths.sessionDir,
        dbusSessionSocket: sessionPaths.socketPath,
        dbusSessionSourceAddress: sourceAddress,
      };
    } catch (error) {
      await this.teardown(ctx);
      throw error;
    }
  }

  async teardown(_ctx: ExecutionContext): Promise<void> {
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // noop
      }
      await this.child.status.catch(() => {});
      this.child = null;
    }
    if (this.stderrCapture) {
      await this.stderrCapture.catch(() => {});
      this.stderrCapture = null;
    }
    if (this.sessionPaths) {
      await Deno.remove(this.sessionPaths.sessionDir, { recursive: true })
        .catch(
          () => {},
        );
      this.sessionPaths = null;
    }
  }

  private async captureStderr(child: Deno.ChildProcess): Promise<void> {
    if (!child.stderr) return;
    try {
      this.stderrText = await new Response(child.stderr).text();
    } catch {
      this.stderrText = "";
    } finally {
      await child.stderr.cancel().catch(() => {});
    }
  }
}

export function resolveSourceAddress(
  configuredAddress: string | undefined,
  uid: number,
): string | null {
  if (configuredAddress) return configuredAddress;
  const fromEnv = Deno.env.get("DBUS_SESSION_BUS_ADDRESS")?.trim();
  if (fromEnv) return fromEnv;
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

async function resolveProxyBinary(): Promise<string | null> {
  try {
    const result = await new Deno.Command("which", {
      args: ["xdg-dbus-proxy"],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!result.success) return null;
    const binary = new TextDecoder().decode(result.stdout).trim();
    return binary === "" ? null : binary;
  } catch {
    return null;
  }
}

function validateSupportedSourceAddress(address: string): void {
  if (!address.startsWith("unix:path=")) {
    throw new Error(
      `[nas] Unsupported dbus source address: ${address}. Only unix:path=... is supported`,
    );
  }
}

async function ensureSourceReachable(address: string): Promise<void> {
  const socketPath = address.slice("unix:path=".length);
  const stat = await Deno.stat(socketPath).catch(() => null);
  if (!stat) {
    throw new Error(`[nas] DBus session bus socket not found: ${socketPath}`);
  }
  if (!stat.isSocket) {
    throw new Error(
      `[nas] DBus session bus path is not a socket: ${socketPath}`,
    );
  }
}

async function waitForSocketReady(
  socketPath: string,
  child: Deno.ChildProcess,
  getStderr: () => string,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < SOCKET_READY_TIMEOUT_MS) {
    const stat = await Deno.stat(socketPath).catch(() => null);
    if (stat?.isSocket) {
      return;
    }

    const status = await Promise.race([
      child.status.then((status) => ({ done: true as const, status })),
      sleep(SOCKET_READY_POLL_MS).then(() => ({ done: false as const })),
    ]);
    if (status.done) {
      const stderrText = getStderr().trim();
      const detail = stderrText ? `\n${stderrText}` : "";
      throw new Error(
        `[nas] xdg-dbus-proxy exited before creating socket (${status.status.code})${detail}`,
      );
    }
  }

  const stderrText = getStderr().trim();
  const detail = stderrText ? `\n${stderrText}` : "";
  throw new Error(
    `[nas] Timed out waiting for xdg-dbus-proxy socket: ${socketPath}${detail}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
