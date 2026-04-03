/**
 * マウント構成の組み立てステージ
 */

import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { logInfo } from "../log.ts";
import { configureClaude } from "../agents/claude.ts";
import { configureCopilot } from "../agents/copilot.ts";
import { configureCodex } from "../agents/codex.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell-safe single-quoting (escape embedded single quotes) */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Encode prefix/suffix ops as shell commands for container-runtime evaluation */
export function encodeDynamicEnvOps(
  ops: ReadonlyArray<{
    mode: "prefix" | "suffix";
    key: string;
    value: string;
    separator: string;
  }>,
): string {
  return ops.map((op) => {
    const fn = op.mode === "prefix" ? "__nas_pfx" : "__nas_sfx";
    return `${fn} ${shellQuote(op.key)} ${shellQuote(op.value)} ${
      shellQuote(op.separator)
    }`;
  }).join("\n");
}
const DEFAULT_CONTAINER_USER = "nas";
const RESERVED_EXTRA_MOUNT_DESTINATIONS = ["/nix"] as const;

type MountDestinationKind = "file" | "directory";

interface RegisteredMountDestination {
  path: string;
  kind: MountDestinationKind;
  allowNestedFiles: boolean;
}

export class MountStage implements Stage {
  name = "MountStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    let result = { ...ctx };
    const args = [...result.dockerArgs];
    const envVars = { ...result.envVars };
    const containerUser = resolveContainerUser();
    const containerHome = `/home/${containerUser}`;
    envVars["NAS_USER"] = containerUser;
    envVars["NAS_HOME"] = containerHome;
    envVars["NAS_LOG_LEVEL"] = result.logLevel;

    // ワークスペースマウント (ホスト側の絶対パスをコンテナ内でも使う)
    // mountDir が設定されている場合はそれをマウントし、workDir は PWD としてのみ使う
    const mountSource = path.resolve(result.mountDir ?? result.workDir);
    const containerWorkDir = path.resolve(result.workDir);
    args.push("-v", `${mountSource}:${mountSource}`);
    args.push("-w", containerWorkDir);
    envVars["WORKSPACE"] = containerWorkDir;
    const extraMountDestinations: RegisteredMountDestination[] = [
      ...RESERVED_EXTRA_MOUNT_DESTINATIONS.map((reservedPath) => ({
        path: path.normalize(reservedPath),
        kind: "directory" as const,
        allowNestedFiles: false,
      })),
      {
        path: path.normalize(mountSource),
        kind: "directory",
        allowNestedFiles: true,
      },
    ];

    // ホストユーザーの UID/GID をコンテナに渡す (entrypoint で非 root ユーザー作成に使用)
    const uid = Deno.uid();
    const gid = Deno.gid();
    if (uid !== null && gid !== null) {
      envVars["NAS_UID"] = String(uid);
      envVars["NAS_GID"] = String(gid);
    }
    if (result.dbusProxyEnabled) {
      if (uid === null) {
        throw new Error(
          "[nas] dbus.session.enable requires a host UID to mount /run/user/$UID",
        );
      }
      extraMountDestinations.push({
        path: path.normalize(`/run/user/${uid}`),
        kind: "directory",
        allowNestedFiles: false,
      });
    }

    // Nix ソケットマウント (ホストの nix daemon にソケット経由で接続)
    if (result.nixEnabled && result.profile.nix.mountSocket) {
      const hasHostNix = await fileExists("/nix");
      if (hasHostNix) {
        args.push("-v", "/nix:/nix");
        // ホストの nix.conf の実体パスを解決してコンテナに渡す
        // (NixOS では /etc/nix/nix.conf がシンボリックリンクで /nix/store 内を指す)
        const nixConfPath = await resolveRealPath("/etc/nix/nix.conf");
        if (nixConfPath) {
          // /nix 配下はすでにマウント済みなのでそのまま使える。
          // 非NixOSなど /etc 配下の場合は個別に readonly マウントする。
          if (!nixConfPath.startsWith("/nix/")) {
            const containerNixConfPath = "/tmp/nas-host-nix.conf";
            args.push("-v", `${nixConfPath}:${containerNixConfPath}:ro`);
            envVars["NIX_CONF_PATH"] = containerNixConfPath;
          } else {
            envVars["NIX_CONF_PATH"] = nixConfPath;
          }
        }
        envVars["NIX_REMOTE"] = "daemon";
        envVars["NIX_ENABLED"] = "true";

        // nix print-dev-env キャッシュ用ディレクトリをマウント (ホスト側に永続化)
        const xdgCache = Deno.env.get("XDG_CACHE_HOME") ||
          `${Deno.env.get("HOME")}/.cache`;
        const nasCacheDir = `${xdgCache}/nas`;
        await Deno.mkdir(nasCacheDir, { recursive: true }).catch((e) =>
          logInfo(`[nas] Mount: failed to create nas cache dir: ${e}`)
        );
        args.push("-v", `${nasCacheDir}:${containerHome}/.cache/nas`);

        // ホストの ~/.cache/nix もマウント (Nix が書き込みアクセスを要求する場合)
        const hostNixCache = `${xdgCache}/nix`;
        await Deno.mkdir(hostNixCache, { recursive: true }).catch((e) =>
          logInfo(`[nas] Mount: failed to create nix cache dir: ${e}`)
        );
        args.push("-v", `${hostNixCache}:${containerHome}/.cache/nix`);
        const nixExtraPackages = serializeNixExtraPackages(
          result.profile.nix.extraPackages,
        );
        if (nixExtraPackages) {
          envVars["NIX_EXTRA_PACKAGES"] = nixExtraPackages;
        }

        // ホストの nix バイナリの実体パスを取得してコンテナに渡す
        // (NixOS では /nix/var/nix/profiles/default/bin に nix がないため)
        const nixBinPath = await resolveNixBinPath();
        if (nixBinPath) {
          envVars["NIX_BIN_PATH"] = nixBinPath;
        }
      }
    }

    // git 設定マウント (user.name / user.email などをコンテナに引き継ぐ)
    const gitConfigDir = `${Deno.env.get("HOME")}/.config/git`;
    if (await fileExists(gitConfigDir)) {
      args.push("-v", `${gitConfigDir}:${containerHome}/.config/git:ro`);
    }

    // gcloud 設定マウント
    if (result.profile.gcloud.mountConfig) {
      const gcloudConfigDir = `${Deno.env.get("HOME")}/.config/gcloud`;
      if (await fileExists(gcloudConfigDir)) {
        args.push("-v", `${gcloudConfigDir}:${containerHome}/.config/gcloud`);
      }
    }

    // GPG ソケットマウント
    // ソケットだけでは署名できない。gpg クライアントは署名時に以下を参照する:
    //   - S.gpg-agent: ホストの gpg-agent と通信し秘密鍵での署名操作を委譲する
    //   - pubring.kbx: 公開鍵リング。鍵IDの解決と署名対象の鍵の特定に必要
    //   - trustdb.gpg: 鍵の信頼度DB。これがないと "unusable public key" エラーになりうる
    //   - gpg.conf: default-key 等のユーザ設定
    //   - gpg-agent.conf: エージェントの動作設定(pinentry 等)
    if (result.profile.gpg.forwardAgent) {
      const gpgSocketPath = await resolveGpgAgentSocket();
      if (gpgSocketPath && await fileExists(gpgSocketPath)) {
        args.push("-v", `${gpgSocketPath}:${containerHome}/.gnupg/S.gpg-agent`);
        envVars["GPG_AGENT_INFO"] = `${containerHome}/.gnupg/S.gpg-agent`;
      }
      const home = Deno.env.get("HOME") ?? "/root";
      const gpgConf = `${home}/.gnupg/gpg.conf`;
      if (await fileExists(gpgConf)) {
        args.push("-v", `${gpgConf}:${containerHome}/.gnupg/gpg.conf:ro`);
      }
      const gpgAgentConf = `${home}/.gnupg/gpg-agent.conf`;
      if (await fileExists(gpgAgentConf)) {
        args.push(
          "-v",
          `${gpgAgentConf}:${containerHome}/.gnupg/gpg-agent.conf:ro`,
        );
      }
      const pubring = `${home}/.gnupg/pubring.kbx`;
      if (await fileExists(pubring)) {
        args.push("-v", `${pubring}:${containerHome}/.gnupg/pubring.kbx:ro`);
      }
      const trustdb = `${home}/.gnupg/trustdb.gpg`;
      if (await fileExists(trustdb)) {
        args.push("-v", `${trustdb}:${containerHome}/.gnupg/trustdb.gpg:ro`);
      }
    }

    // AWS 設定マウント
    if (result.profile.aws.mountConfig) {
      const awsConfigDir = `${Deno.env.get("HOME")}/.aws`;
      if (await fileExists(awsConfigDir)) {
        args.push("-v", `${awsConfigDir}:${containerHome}/.aws`);
      }
    }

    // 追加マウント
    for (const [index, extraMount] of result.profile.extraMounts.entries()) {
      const normalizedSrc = resolveHostMountPath(
        extraMount.src,
        result.workDir,
      );
      if (!await fileExists(normalizedSrc)) {
        console.error(
          `[nas] Skipping profile.extra-mounts[${index}] because src does not exist: ${normalizedSrc}`,
        );
        continue;
      }
      const srcInfo = await Deno.stat(normalizedSrc);

      const normalizedDst = resolveContainerMountPath(
        extraMount.dst,
        containerHome,
        containerWorkDir,
      );
      const conflict = findConflictingMountDestination(
        extraMountDestinations,
        normalizedDst,
        srcInfo.isDirectory ? "directory" : "file",
      );
      if (conflict) {
        throw new Error(
          `[nas] profile.extra-mounts[${index}].dst conflicts with existing mount destination: ${normalizedDst}`,
        );
      }
      extraMountDestinations.push({
        path: normalizedDst,
        kind: srcInfo.isDirectory ? "directory" : "file",
        allowNestedFiles: false,
      });

      const modeSuffix = extraMount.mode === "ro" ? ":ro" : "";
      args.push("-v", `${normalizedSrc}:${normalizedDst}${modeSuffix}`);
    }

    // プロファイルの環境変数
    // prefix/suffix で envVars に未登録のキーはコンテナ既定値を参照する必要があるため、
    // 実行時に評価されるシェルコマンド (NAS_ENV_OPS) として渡す。
    const dynamicEnvOps: Array<
      {
        mode: "prefix" | "suffix";
        key: string;
        value: string;
        separator: string;
      }
    > = [];

    for (const [index, envEntry] of result.profile.env.entries()) {
      const key = "key" in envEntry ? envEntry.key : await runCommandForEnv(
        envEntry.keyCmd,
        `profile.env[${index}].key_cmd`,
      );
      if (!ENV_VAR_NAME_RE.test(key)) {
        const source = "key" in envEntry ? "key" : "key_cmd";
        throw new Error(
          `[nas] Invalid env var name from profile.env[${index}].${source}: ${key}`,
        );
      }
      const rawValue = "val" in envEntry
        ? envEntry.val
        : await runCommandForEnv(
          envEntry.valCmd,
          `profile.env[${index}].val_cmd`,
        );
      const value = expandContainerPath(rawValue, containerHome);
      switch (envEntry.mode) {
        case "prefix":
          if (key in envVars) {
            envVars[key] = `${value}${envEntry.separator}${envVars[key]}`;
          } else {
            dynamicEnvOps.push({
              mode: "prefix",
              key,
              value,
              separator: envEntry.separator!,
            });
          }
          break;
        case "suffix":
          if (key in envVars) {
            envVars[key] = `${envVars[key]}${envEntry.separator}${value}`;
          } else {
            dynamicEnvOps.push({
              mode: "suffix",
              key,
              value,
              separator: envEntry.separator!,
            });
          }
          break;
        default: // "set"
          envVars[key] = value;
          // set はそれ以前の dynamic ops を上書きする
          for (let i = dynamicEnvOps.length - 1; i >= 0; i--) {
            if (dynamicEnvOps[i].key === key) {
              dynamicEnvOps.splice(i, 1);
            }
          }
          break;
      }
    }

    if (dynamicEnvOps.length > 0) {
      envVars["NAS_ENV_OPS"] = encodeDynamicEnvOps(dynamicEnvOps);
    }

    result = { ...result, dockerArgs: args, envVars };

    if (result.dbusProxyEnabled) {
      if (uid === null || !result.dbusSessionRuntimeDir) {
        throw new Error(
          "[nas] dbus.session.enable requires an initialized DBus proxy runtime",
        );
      }
      const containerRuntimeDir = `/run/user/${uid}`;
      args.push("-v", `${result.dbusSessionRuntimeDir}:${containerRuntimeDir}`);
      envVars["XDG_RUNTIME_DIR"] = containerRuntimeDir;
      envVars["DBUS_SESSION_BUS_ADDRESS"] =
        `unix:path=${containerRuntimeDir}/bus`;
      result = { ...result, dockerArgs: args, envVars };
    }

    // ホスト側が tmux 内の場合、コンテナに伝える (OSC 52 clipboard shim が使用)
    const hostTmux = Deno.env.get("TMUX");
    if (hostTmux) {
      envVars["NAS_HOST_TMUX"] = "1";
      result = { ...result, envVars };
    }

    // エージェント固有の設定
    switch (result.profile.agent) {
      case "claude":
        result = configureClaude(result);
        break;
      case "copilot":
        result = configureCopilot(result);
        break;
      case "codex":
        result = configureCodex(result);
        break;
    }

    await Promise.resolve();
    return result;
  }
}

async function resolveGpgAgentSocket(): Promise<string | null> {
  try {
    const cmd = new Deno.Command("gpgconf", {
      args: ["--list-dir", "agent-socket"],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const socketPath = new TextDecoder().decode(stdout).trim();
      if (socketPath) return socketPath;
    }
  } catch { /* gpgconf not available */ }

  // フォールバック
  const uid = Deno.uid();
  if (uid !== null) {
    const runUserSocket = `/run/user/${uid}/gnupg/S.gpg-agent`;
    if (await fileExists(runUserSocket)) return runUserSocket;
  }
  const home = Deno.env.get("HOME") ?? "/root";
  return `${home}/.gnupg/S.gpg-agent`;
}

async function resolveRealPath(path: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command("readlink", {
      args: ["-f", path],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const resolved = new TextDecoder().decode(stdout).trim();
      if (resolved) return resolved;
    }
  } catch { /* ignore */ }
  return null;
}

function expandHostPath(rawPath: string): string {
  const home = Deno.env.get("HOME");
  if (!home) return rawPath;
  if (rawPath === "~") return home;
  if (rawPath.startsWith("~/")) return path.join(home, rawPath.slice(2));
  return rawPath;
}

function expandContainerPath(rawPath: string, containerHome: string): string {
  if (rawPath === "~") return containerHome;
  if (rawPath.startsWith("~/")) {
    return path.join(containerHome, rawPath.slice(2));
  }
  return rawPath;
}

function resolveHostMountPath(rawPath: string, baseDir: string): string {
  const expandedPath = expandHostPath(rawPath);
  return path.normalize(
    path.isAbsolute(expandedPath)
      ? path.resolve(expandedPath)
      : path.resolve(baseDir, expandedPath),
  );
}

function resolveContainerMountPath(
  rawPath: string,
  containerHome: string,
  containerWorkDir: string,
): string {
  const expandedPath = expandContainerPath(rawPath, containerHome);
  return path.normalize(
    path.isAbsolute(expandedPath)
      ? path.resolve(expandedPath)
      : path.resolve(containerWorkDir, expandedPath),
  );
}

function resolveContainerUser(): string {
  const user = Deno.env.get("USER")?.trim();
  if (user) return user;
  return DEFAULT_CONTAINER_USER;
}

async function runCommandForEnv(
  command: string,
  sourceName: string,
): Promise<string> {
  const cmd = new Deno.Command("sh", {
    args: ["-c", command],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const stderrText = new TextDecoder().decode(stderr).trim();
    throw new Error(
      `[nas] Failed to execute ${sourceName}: ${
        stderrText || `exit code ${code}`
      }`,
    );
  }

  const output = new TextDecoder().decode(stdout).trim();
  if (!output) {
    throw new Error(`[nas] ${sourceName} returned empty output`);
  }
  return output;
}

async function resolveNixBinPath(): Promise<string | null> {
  // NixOS: /run/current-system/sw/bin/nix → /nix/store/.../bin/nix
  const resolved = await resolveRealPath("/run/current-system/sw/bin/nix");
  if (resolved?.startsWith("/nix/store/")) return resolved;

  // fallback: check common profile paths
  for (
    const p of [
      "/nix/var/nix/profiles/default/bin/nix",
      "/root/.nix-profile/bin/nix",
    ]
  ) {
    if (await fileExists(p)) return p;
  }
  return null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function findConflictingMountDestination(
  existingDestinations: RegisteredMountDestination[],
  candidatePath: string,
  candidateKind: MountDestinationKind,
): RegisteredMountDestination | null {
  for (const existing of existingDestinations) {
    if (existing.path === candidatePath) {
      return existing;
    }
    if (isParentPath(existing.path, candidatePath)) {
      if (!(existing.allowNestedFiles && candidateKind === "file")) {
        return existing;
      }
    }
    if (isParentPath(candidatePath, existing.path)) {
      return existing;
    }
  }
  return null;
}

function isParentPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative !== "" && relative !== "." && !relative.startsWith("..") &&
    !path.isAbsolute(relative);
}

export function serializeNixExtraPackages(packages: string[]): string | null {
  const normalized = packages
    .map((pkg) => pkg.trim())
    .filter((pkg) => pkg.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join("\n");
}
