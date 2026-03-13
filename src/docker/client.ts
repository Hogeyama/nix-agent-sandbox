/**
 * Docker CLI ラッパー
 */

import $ from "dax";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";

export interface DockerRunOptions {
  image: string;
  args: string[];
  envVars: Record<string, string>;
  command: string[];
  interactive: boolean;
}

/** 埋め込みファイル (Dockerfile + entrypoint.sh) の SHA-256 ハッシュを計算 */
export async function computeEmbedHash(): Promise<string> {
  const baseUrl = new URL("./embed/", import.meta.url);
  const parts: string[] = [];
  for (const name of ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"]) {
    parts.push(await Deno.readTextFile(new URL(name, baseUrl)));
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
}

/** docker image のラベル値を取得 */
export async function getImageLabel(
  tag: string,
  label: string,
): Promise<string | null> {
  try {
    const result = await $`docker inspect --format ${
      '{{index .Config.Labels "' + label + '"}}'
    } ${tag}`
      .quiet();
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

/** docker build を実行 */
export async function dockerBuild(
  contextDir: string,
  tag: string,
  labels?: Record<string, string>,
): Promise<void> {
  const labelArgs: string[] = [];
  if (labels) {
    for (const [key, value] of Object.entries(labels)) {
      labelArgs.push("--label", `${key}=${value}`);
    }
  }
  await $`docker build ${labelArgs} -t ${tag} ${contextDir}`.printCommand();
}

/** docker run を実行 */
export async function dockerRun(opts: DockerRunOptions): Promise<void> {
  const args: string[] = ["docker", "run", "--rm"];

  if (opts.interactive) {
    // TTY がある場合のみ -t を付ける (非 TTY 環境では -i のみ)
    const isTty = Deno.stdin.isTerminal();
    if (isTty) {
      args.push("-it");
    } else {
      args.push("-i");
    }
  }

  for (const [key, value] of Object.entries(opts.envVars)) {
    args.push("-e", `${key}=${value}`);
  }

  args.push(...opts.args);
  args.push(opts.image);
  args.push(...opts.command);

  const cmd = new Deno.Command(args[0], {
    args: args.slice(1),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await cmd.spawn().status;
  if (!status.success) {
    throw new Error(`docker run exited with code ${status.code}`);
  }
}

/** docker image を削除 */
export async function dockerRemoveImage(
  tag: string,
  options?: { force?: boolean },
): Promise<void> {
  const forceArgs = options?.force ? ["--force"] : [];
  await $`docker rmi ${forceArgs} ${tag}`.printCommand();
}

/** docker image が存在するか確認 */
export async function dockerImageExists(tag: string): Promise<boolean> {
  try {
    await $`docker image inspect ${tag}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/** docker network を作成 */
export async function dockerNetworkCreate(name: string): Promise<void> {
  await $`docker network create ${name}`.quiet();
}

/** docker network にコンテナを接続 */
export async function dockerNetworkConnect(
  networkName: string,
  containerName: string,
): Promise<void> {
  await $`docker network connect ${networkName} ${containerName}`.quiet();
}

/** docker network を削除 */
export async function dockerNetworkRemove(name: string): Promise<void> {
  await $`docker network rm ${name}`.quiet();
}

export interface DockerRunDetachedOptions {
  name: string;
  image: string;
  args: string[];
  envVars: Record<string, string>;
}

/** docker run をデタッチモードで実行 */
export async function dockerRunDetached(
  opts: DockerRunDetachedOptions,
): Promise<void> {
  const args: string[] = ["run", "-d", "--name", opts.name];
  for (const [key, value] of Object.entries(opts.envVars)) {
    args.push("-e", `${key}=${value}`);
  }
  args.push(...opts.args);
  args.push(opts.image);
  await $`docker ${args}`.quiet();
}

/** docker stop を実行 */
export async function dockerStop(containerName: string): Promise<void> {
  await $`docker stop ${containerName}`.quiet();
}

/** docker rm を実行 */
export async function dockerRm(containerName: string): Promise<void> {
  await $`docker rm ${containerName}`.quiet();
}

/** docker volume rm を実行 */
export async function dockerVolumeRemove(name: string): Promise<void> {
  await $`docker volume rm ${name}`.quiet();
}

/** docker exec を実行して結果を返す */
export async function dockerExec(
  containerName: string,
  command: string[],
): Promise<{ code: number; stdout: string }> {
  try {
    const result = await $`docker exec ${containerName} ${command}`.quiet();
    return { code: 0, stdout: result.stdout.trim() };
  } catch (err) {
    if (err && typeof err === "object" && "exitCode" in err) {
      return { code: (err as { exitCode: number }).exitCode, stdout: "" };
    }
    return { code: 1, stdout: "" };
  }
}

/** コンテナが実行中かどうかを確認 */
export async function dockerIsRunning(
  containerName: string,
): Promise<boolean> {
  try {
    const fmt = "{{.State.Running}}";
    const result = await $`docker inspect --format=${fmt} ${containerName}`
      .quiet();
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** コンテナのログを取得 */
export async function dockerLogs(
  containerName: string,
  options?: { tail?: number },
): Promise<string> {
  try {
    const tailArgs = options?.tail ? ["--tail", String(options.tail)] : [];
    const result = await $`docker logs ${tailArgs} ${containerName}`.quiet(
      "both",
    );
    // docker logs outputs to both stdout and stderr
    return (result.stdout + result.stderr).trim();
  } catch {
    return "(failed to retrieve container logs)";
  }
}
