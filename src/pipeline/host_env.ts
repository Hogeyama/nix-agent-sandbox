/**
 * HostEnv builder and ProbeResults resolver
 *
 * buildHostEnv() は CLI 層の起動時に 1 回だけ呼ばれ、ホスト環境情報を収集する。
 * resolveProbes() は pipeline 開始時に 1 回だけ呼ばれ、probe を並列解決する。
 */

import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import * as path from "node:path";
import type { HostEnv, ProbeResults } from "./types.ts";

// ---------------------------------------------------------------------------
// buildHostEnv
// ---------------------------------------------------------------------------

/**
 * ホスト環境情報を収集して HostEnv を構築する。
 *
 * 実際に Deno.env, Deno.uid(), Deno.gid() 等を呼ぶ副作用関数。
 * CLI 層で 1 回だけ呼ぶ想定。
 */
export function buildHostEnv(): HostEnv {
  const envObj = { ...process.env } as Record<string, string>;
  const env = new Map(Object.entries(envObj));
  const home = envObj.HOME ?? "/root";
  const user = envObj.USER ?? "";
  const info = userInfo();
  const uid = info.uid;
  const gid = info.gid >= 0 ? info.gid : null;
  const isWSL = Boolean(envObj.WSL_DISTRO_NAME);

  return { home, user, uid, gid, isWSL, env };
}

// ---------------------------------------------------------------------------
// resolveProbes
// ---------------------------------------------------------------------------

/**
 * Pipeline 開始時に並列で probe を解決し、ProbeResults を返す。
 *
 * 各 probe は独立しているため Promise.all で並列実行する。
 */
export async function resolveProbes(hostEnv: HostEnv): Promise<ProbeResults> {
  const [
    hasHostNix,
    auditDir,
    xdgDbusProxyPath,
    dbusSessionAddress,
    gpgAgentSocket,
  ] = await Promise.all([
    probeHasHostNix(),
    Promise.resolve(resolveAuditDirFromEnv(hostEnv)),
    probeXdgDbusProxy(),
    Promise.resolve(probeDbusSessionAddress(hostEnv)),
    probeGpgAgentSocket(hostEnv),
  ]);

  return {
    hasHostNix,
    auditDir,
    xdgDbusProxyPath,
    dbusSessionAddress,
    gpgAgentSocket,
  };
}

// ---------------------------------------------------------------------------
// Individual probes
// ---------------------------------------------------------------------------

/** /nix ディレクトリの存在チェック (NixDetectStage 用) */
async function probeHasHostNix(): Promise<boolean> {
  try {
    await stat("/nix");
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * resolveAuditDir 相当 — XDG_DATA_HOME / HOME から audit ディレクトリを解決する。
 * src/audit/store.ts の resolveAuditDir() と同じロジック。
 */
function resolveAuditDirFromEnv(hostEnv: HostEnv): string {
  const xdgData = hostEnv.env.get("XDG_DATA_HOME");
  if (xdgData && xdgData.trim().length > 0) {
    return path.join(xdgData.trim(), "nas", "audit");
  }
  const home = hostEnv.env.get("HOME");
  if (!home) {
    throw new Error(
      "Cannot resolve audit directory: neither XDG_DATA_HOME nor HOME is set",
    );
  }
  return path.join(home, ".local/share", "nas", "audit");
}

/** xdg-dbus-proxy バイナリの探索 (which コマンド) */
async function probeXdgDbusProxy(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["which", "xdg-dbus-proxy"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const binary = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code !== 0) return null;
    return binary === "" ? null : binary;
  } catch {
    return null;
  }
}

/**
 * D-Bus セッションアドレスの解決。
 * DBUS_SESSION_BUS_ADDRESS 環境変数を返す。未設定なら null。
 *
 * 注: sourceAddress のフォールバック (unix:path=/run/user/$UID/bus) は
 * DbusProxyStage の plan() 側で行う (uid が必要なため)。
 */
function probeDbusSessionAddress(hostEnv: HostEnv): string | null {
  const addr = hostEnv.env.get("DBUS_SESSION_BUS_ADDRESS")?.trim();
  return addr && addr.length > 0 ? addr : null;
}

/** gpgconf --list-dir agent-socket でソケットパスを解決する */
async function probeGpgAgentSocket(hostEnv: HostEnv): Promise<string | null> {
  try {
    const proc = Bun.spawn(["gpgconf", "--list-dir", "agent-socket"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const socketPath = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code === 0) {
      if (socketPath) return socketPath;
    }
  } catch {
    // gpgconf not available
  }

  // フォールバック: /run/user/$UID/gnupg/S.gpg-agent
  if (hostEnv.uid !== null) {
    const runUserSocket = `/run/user/${hostEnv.uid}/gnupg/S.gpg-agent`;
    try {
      await stat(runUserSocket);
      return runUserSocket;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }

  return `${hostEnv.home}/.gnupg/S.gpg-agent`;
}
