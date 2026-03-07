/**
 * GitHub Copilot CLI エージェント対応
 */

import type { ExecutionContext } from "../pipeline/context.ts";

/** Copilot CLI 固有のマウントと環境変数を追加 */
export function configureCopilot(ctx: ExecutionContext): ExecutionContext {
  const args = [...ctx.dockerArgs];
  const envVars = { ...ctx.envVars };
  const containerHome = ctx.envVars["NAS_HOME"] ?? resolveContainerHome();

  // gh auth token で GitHub トークンを取得
  const token = getGhToken();
  if (token) {
    envVars["GITHUB_TOKEN"] = token;
  }

  const home = Deno.env.get("HOME") ?? "/root";
  const xdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
  const xdgStateHome = Deno.env.get("XDG_STATE_HOME");

  // Copilot が実際に使うパスを決定（XDG 未設定時は $HOME/.copilot）
  const hostCopilotConfigDir = xdgConfigHome
    ? `${xdgConfigHome}/.copilot`
    : `${home}/.copilot`;
  const hostCopilotStateDir = xdgStateHome
    ? `${xdgStateHome}/.copilot`
    : `${home}/.copilot`;

  const containerCopilotConfigDir = remapToContainer(
    hostCopilotConfigDir,
    home,
    containerHome,
  );
  const containerCopilotStateDir = remapToContainer(
    hostCopilotStateDir,
    home,
    containerHome,
  );

  // XDG_CONFIG_HOME をコンテナに渡す（ホストで設定されている場合のみ）
  if (xdgConfigHome) {
    const containerConfigHome = remapToContainer(
      xdgConfigHome,
      home,
      containerHome,
    );
    envVars["XDG_CONFIG_HOME"] = containerConfigHome;
  }

  // XDG_STATE_HOME をコンテナに渡す（ホストで設定されている場合のみ）
  if (xdgStateHome) {
    const containerStateHome = remapToContainer(
      xdgStateHome,
      home,
      containerHome,
    );
    envVars["XDG_STATE_HOME"] = containerStateHome;
  }

  // config ディレクトリをマウント
  try {
    Deno.statSync(hostCopilotConfigDir);
    args.push("-v", `${hostCopilotConfigDir}:${containerCopilotConfigDir}`);
  } catch {
    // ディレクトリが無い場合はスキップ
  }

  // state ディレクトリをマウント（config と同じ場合は重複を避ける）
  if (hostCopilotStateDir !== hostCopilotConfigDir) {
    try {
      Deno.statSync(hostCopilotStateDir);
      args.push("-v", `${hostCopilotStateDir}:${containerCopilotStateDir}`);
    } catch {
      // ディレクトリが無い場合はスキップ
    }
  }

  // Copilot v1.0.2 で config.json が ~/.copilot へシンボリックリンクになるケースをカバー
  const hostLegacyCopilotDir = `${home}/.copilot`;
  if (
    hostLegacyCopilotDir !== hostCopilotConfigDir &&
    hostLegacyCopilotDir !== hostCopilotStateDir
  ) {
    try {
      Deno.statSync(hostLegacyCopilotDir);
      const containerLegacyCopilotDir = remapToContainer(
        hostLegacyCopilotDir,
        home,
        containerHome,
      );
      args.push("-v", `${hostLegacyCopilotDir}:${containerLegacyCopilotDir}`);
    } catch {
      // ディレクトリが無い場合はスキップ
    }
  }

  // copilot バイナリのマウント (実体パスを解決してマウント)
  const copilotBin = findBinaryResolved("copilot");
  if (copilotBin) {
    args.push("-v", `${copilotBin}:/usr/local/bin/copilot:ro`);
  }

  return {
    ...ctx,
    dockerArgs: args,
    envVars,
    agentCommand: copilotBin
      ? ["copilot"]
      : ["bash", "-c", "echo 'copilot binary not found'; exit 1"],
  };
}

/** gh auth token を取得 */
function getGhToken(): string | null {
  try {
    const cmd = new Deno.Command("gh", {
      args: ["auth", "token"],
      stdout: "piped",
      stderr: "null",
    });
    const output = cmd.outputSync();
    if (output.success) {
      return new TextDecoder().decode(output.stdout).trim();
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * ホストのパスをコンテナ内パスにリマップする。
 * $HOME 配下のパスはコンテナ内の $HOME 配下に変換し、それ以外はそのまま返す。
 */
function remapToContainer(
  hostPath: string,
  hostHome: string,
  containerHome: string,
): string {
  if (hostPath.startsWith(hostHome + "/")) {
    return `${containerHome}/` + hostPath.slice(hostHome.length + 1);
  }
  return hostPath;
}

/** ホスト上のバイナリの実体パスを取得 (シンボリックリンク解決) */
function findBinaryResolved(name: string): string | null {
  try {
    const cmd = new Deno.Command("which", {
      args: [name],
      stdout: "piped",
      stderr: "null",
    });
    const output = cmd.outputSync();
    if (output.success) {
      const binPath = new TextDecoder().decode(output.stdout).trim();
      return Deno.realPathSync(binPath);
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveContainerHome(): string {
  const user = Deno.env.get("USER")?.trim();
  return `/home/${user || "nas"}`;
}
