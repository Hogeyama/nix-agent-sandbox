/**
 * Docker CLI ラッパー
 */

import $ from "dax";
import { crypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import type { DockerLabels } from "./nas_resources.ts";

const EMBEDDED_ASSET_GROUPS = [
  {
    baseUrl: new URL("./embed/", import.meta.url),
    files: ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
  },
  {
    baseUrl: new URL("./envoy/", import.meta.url),
    files: ["envoy.template.yaml"],
  },
] as const;

export interface DockerRunOptions {
  image: string;
  args: string[];
  envVars: Record<string, string>;
  command: string[];
  interactive: boolean;
}

export interface DockerContainerDetails {
  name: string;
  running: boolean;
  labels: DockerLabels;
  networks: string[];
}

export interface DockerNetworkDetails {
  name: string;
  labels: DockerLabels;
  containers: string[];
}

export interface DockerVolumeDetails {
  name: string;
  labels: DockerLabels;
  containers: string[];
}

/** 埋め込みファイル (Dockerfile + entrypoint.sh) の SHA-256 ハッシュを計算 */
export async function computeEmbedHash(): Promise<string> {
  const parts: string[] = [];
  for (const group of EMBEDDED_ASSET_GROUPS) {
    for (const name of group.files) {
      parts.push(await Deno.readTextFile(new URL(name, group.baseUrl)));
    }
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
  await dockerNetworkCreateWithLabels(name);
}

/** docker network を --internal フラグ付きで作成（外部アクセス不可） */
export async function dockerNetworkCreateInternal(
  name: string,
): Promise<void> {
  await dockerNetworkCreateWithLabels(name, { internal: true });
}

/** docker network をラベル付きで作成 */
export async function dockerNetworkCreateWithLabels(
  name: string,
  options?: { internal?: boolean; labels?: DockerLabels },
): Promise<void> {
  const args: string[] = ["network", "create"];
  if (options?.internal) {
    args.push("--internal");
  }
  for (const [key, value] of Object.entries(options?.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  args.push(name);
  await $`docker ${args}`.quiet();
}

/** docker network からコンテナを切断 */
export async function dockerNetworkDisconnect(
  networkName: string,
  containerName: string,
): Promise<void> {
  await $`docker network disconnect ${networkName} ${containerName}`.quiet();
}

/** docker network にコンテナを接続 */
export async function dockerNetworkConnect(
  networkName: string,
  containerName: string,
  options?: { aliases?: string[] },
): Promise<void> {
  const aliasArgs: string[] = [];
  for (const alias of options?.aliases ?? []) {
    aliasArgs.push("--alias", alias);
  }
  await $`docker network connect ${aliasArgs} ${networkName} ${containerName}`
    .quiet();
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
  network?: string;
  mounts?: string[];
  publishedPorts?: string[];
  labels?: DockerLabels;
  entrypoint?: string;
  command?: string[];
}

/** docker run をデタッチモードで実行 */
export async function dockerRunDetached(
  opts: DockerRunDetachedOptions,
): Promise<void> {
  const args: string[] = ["run", "-d", "--name", opts.name];
  if (opts.network) {
    args.push("--network", opts.network);
  }
  for (const mount of opts.mounts ?? []) {
    args.push("--mount", mount);
  }
  for (const publishedPort of opts.publishedPorts ?? []) {
    args.push("-p", publishedPort);
  }
  for (const [key, value] of Object.entries(opts.envVars)) {
    args.push("-e", `${key}=${value}`);
  }
  for (const [key, value] of Object.entries(opts.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  if (opts.entrypoint) {
    args.push("--entrypoint", opts.entrypoint);
  }
  args.push(...opts.args);
  args.push(opts.image);
  args.push(...(opts.command ?? []));
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

/** docker volume を作成 */
export async function dockerVolumeCreate(
  name: string,
  labels?: DockerLabels,
): Promise<void> {
  const args: string[] = ["volume", "create"];
  for (const [key, value] of Object.entries(labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }
  args.push(name);
  await $`docker ${args}`.quiet();
}

/** docker exec を実行して結果を返す */
export async function dockerExec(
  containerName: string,
  command: string[],
  options?: { user?: string },
): Promise<{ code: number; stdout: string }> {
  const userArgs = options?.user ? ["-u", options.user] : [];
  try {
    const result = await $`docker exec ${userArgs} ${containerName} ${command}`
      .quiet();
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

/** すべてのコンテナ名を取得 */
export async function dockerListContainerNames(): Promise<string[]> {
  const fmt = "{{.Names}}";
  const result = await $`docker ps -a --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout);
}

/** すべての network 名を取得 */
export async function dockerListNetworkNames(): Promise<string[]> {
  const fmt = "{{.Name}}";
  const result = await $`docker network ls --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout);
}

/** すべての volume 名を取得 */
export async function dockerListVolumeNames(): Promise<string[]> {
  const fmt = "{{.Name}}";
  const result = await $`docker volume ls --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout);
}

/** コンテナ inspect を取得 */
export async function dockerInspectContainer(
  containerName: string,
): Promise<DockerContainerDetails> {
  const result = await $`docker inspect ${containerName}`.quiet();
  const parsed = JSON.parse(result.stdout)[0];
  return {
    name: String(parsed.Name ?? containerName).replace(/^\//, ""),
    running: parsed.State?.Running === true,
    labels: parsed.Config?.Labels ?? {},
    networks: Object.keys(parsed.NetworkSettings?.Networks ?? {}),
  };
}

/** network inspect を取得 */
export async function dockerInspectNetwork(
  networkName: string,
): Promise<DockerNetworkDetails> {
  const result = await $`docker network inspect ${networkName}`.quiet();
  const parsed = JSON.parse(result.stdout)[0];
  const containers = Object.values(parsed.Containers ?? {}).map((entry) =>
    typeof entry === "object" && entry !== null && "Name" in entry
      ? String(entry.Name)
      : ""
  ).filter((name) => name.length > 0);
  return {
    name: String(parsed.Name ?? networkName),
    labels: parsed.Labels ?? {},
    containers,
  };
}

/** volume inspect を取得 */
export async function dockerInspectVolume(
  volumeName: string,
): Promise<DockerVolumeDetails> {
  const result = await $`docker volume inspect ${volumeName}`.quiet();
  const parsed = JSON.parse(result.stdout)[0];
  return {
    name: String(parsed.Name ?? volumeName),
    labels: parsed.Labels ?? {},
    containers: await dockerListContainersUsingVolume(volumeName),
  };
}

/** volume を参照しているコンテナ名を取得 */
export async function dockerListContainersUsingVolume(
  volumeName: string,
): Promise<string[]> {
  const fmt = "{{.Names}}";
  const result =
    await $`docker ps -a --filter volume=${volumeName} --format=${fmt}`
      .quiet();
  return splitNonEmptyLines(result.stdout);
}

function splitNonEmptyLines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  );
}
