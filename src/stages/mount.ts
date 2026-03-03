/**
 * マウント構成の組み立てステージ
 */

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

    // ワークスペースマウント
    args.push("-v", `${result.workDir}:/workspace`);
    args.push("-w", "/workspace");

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
