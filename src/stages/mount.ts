/**
 * マウント構成の組み立てステージ
 */

import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { configureClaude } from "../agents/claude.ts";
import { configureCopilot } from "../agents/copilot.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class MountStage implements Stage {
  name = "MountStage";

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    let result = { ...ctx };
    const args = [...result.dockerArgs];
    const envVars = { ...result.envVars };

    // ワークスペースマウント (ホスト側のディレクトリ名をコンテナ内でも使う)
    const containerWorkDir = `/${path.basename(result.workDir)}`;
    args.push("-v", `${result.workDir}:${containerWorkDir}`);
    args.push("-w", containerWorkDir);
    envVars["WORKSPACE"] = containerWorkDir;

    // ホストユーザーの UID/GID をコンテナに渡す (entrypoint で非 root ユーザー作成に使用)
    const uid = Deno.uid();
    const gid = Deno.gid();
    if (uid !== null && gid !== null) {
      envVars["NAS_UID"] = String(uid);
      envVars["NAS_GID"] = String(gid);
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

    // Docker socket マウント
    if (result.profile.docker.mountSocket) {
      args.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
    }

    // git 設定マウント (user.name / user.email などをコンテナに引き継ぐ)
    const gitConfigDir = `${Deno.env.get("HOME")}/.config/git`;
    if (await fileExists(gitConfigDir)) {
      args.push("-v", `${gitConfigDir}:/home/nas/.config/git:ro`);
    }

    // gcloud 設定マウント
    if (result.profile.gcloud.mountConfig) {
      const gcloudConfigDir = `${Deno.env.get("HOME")}/.config/gcloud`;
      if (await fileExists(gcloudConfigDir)) {
        args.push("-v", `${gcloudConfigDir}:/home/nas/.config/gcloud`);
      }
    }

    // GPG ソケットマウント
    // ソケットだけでは署名できない。gpg クライアントは署名時に以下を参照する:
    //   - S.gpg-agent: ホストの gpg-agent と通信し秘密鍵での署名操作を委譲する
    //   - pubring.kbx: 公開鍵リング。鍵IDの解決と署名対象の鍵の特定に必要
    //   - trustdb.gpg: 鍵の信頼度DB。これがないと "unusable public key" エラーになりうる
    //   - gpg.conf: default-key 等のユーザ設定
    //   - gpg-agent.conf: エージェントの動作設定(pinentry 等)
    if (result.profile.gpg.mountSocket) {
      const gpgSocketPath = await resolveGpgAgentSocket();
      if (gpgSocketPath && await fileExists(gpgSocketPath)) {
        args.push("-v", `${gpgSocketPath}:/home/nas/.gnupg/S.gpg-agent`);
        envVars["GPG_AGENT_INFO"] = "/home/nas/.gnupg/S.gpg-agent";
      }
      const home = Deno.env.get("HOME") ?? "/root";
      const gpgConf = `${home}/.gnupg/gpg.conf`;
      if (await fileExists(gpgConf)) {
        args.push("-v", `${gpgConf}:/home/nas/.gnupg/gpg.conf:ro`);
      }
      const gpgAgentConf = `${home}/.gnupg/gpg-agent.conf`;
      if (await fileExists(gpgAgentConf)) {
        args.push("-v", `${gpgAgentConf}:/home/nas/.gnupg/gpg-agent.conf:ro`);
      }
      const pubring = `${home}/.gnupg/pubring.kbx`;
      if (await fileExists(pubring)) {
        args.push("-v", `${pubring}:/home/nas/.gnupg/pubring.kbx:ro`);
      }
      const trustdb = `${home}/.gnupg/trustdb.gpg`;
      if (await fileExists(trustdb)) {
        args.push("-v", `${trustdb}:/home/nas/.gnupg/trustdb.gpg:ro`);
      }
    }

    // AWS 設定マウント
    if (result.profile.aws.mountConfig) {
      const awsConfigDir = `${Deno.env.get("HOME")}/.aws`;
      if (await fileExists(awsConfigDir)) {
        args.push("-v", `${awsConfigDir}:/home/nas/.aws`);
      }
    }

    // プロファイルの環境変数
    for (const [index, envEntry] of result.profile.env.entries()) {
      if ("key" in envEntry) {
        if (!ENV_VAR_NAME_RE.test(envEntry.key)) {
          throw new Error(
            `[nas] Invalid env var name from profile.env[${index}].key: ${envEntry.key}`,
          );
        }
        envVars[envEntry.key] = envEntry.val;
        continue;
      }

      const key = await runCommandForEnv(
        envEntry.keyCmd,
        `profile.env[${index}].key_cmd`,
      );
      if (!ENV_VAR_NAME_RE.test(key)) {
        throw new Error(
          `[nas] Invalid env var name from profile.env[${index}].key_cmd: ${key}`,
        );
      }
      const value = await runCommandForEnv(
        envEntry.valCmd,
        `profile.env[${index}].val_cmd`,
      );
      envVars[key] = value;
    }

    result = { ...result, dockerArgs: args, envVars };

    // エージェント固有の設定
    switch (result.profile.agent) {
      case "claude":
        result = configureClaude(result);
        break;
      case "copilot":
        result = configureCopilot(result);
        break;
    }

    await Promise.resolve();
    return result;
  }
}

async function resolveGpgAgentSocket(): Promise<string | null> {
  try {
    const cmd = new Deno.Command("gpgconf", { args: ["--list-dir", "agent-socket"], stdout: "piped", stderr: "null" });
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
    const cmd = new Deno.Command("readlink", { args: ["-f", path], stdout: "piped", stderr: "null" });
    const { code, stdout } = await cmd.output();
    if (code === 0) {
      const resolved = new TextDecoder().decode(stdout).trim();
      if (resolved) return resolved;
    }
  } catch { /* ignore */ }
  return null;
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
  for (const p of ["/nix/var/nix/profiles/default/bin/nix", "/root/.nix-profile/bin/nix"]) {
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

export function serializeNixExtraPackages(packages: string[]): string | null {
  const normalized = packages
    .map((pkg) => pkg.trim())
    .filter((pkg) => pkg.length > 0);
  if (normalized.length === 0) return null;
  return normalized.join("\n");
}
