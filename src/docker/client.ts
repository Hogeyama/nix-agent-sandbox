/**
 * Docker CLI ラッパー
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { resolveAssetDir } from "../lib/asset.ts";
import type { DockerLabels } from "./nas_resources.ts";

const EMBEDDED_ASSET_GROUPS = [
  {
    baseDir: resolveAssetDir("docker/embed", import.meta.url, "./embed/"),
    files: ["Dockerfile", "entrypoint.sh", "osc52-clip.sh"],
  },
  {
    baseDir: resolveAssetDir("docker/envoy", import.meta.url, "./envoy/"),
    files: ["envoy.template.yaml"],
  },
] as const;

export interface DockerRunOptions {
  image: string;
  args: string[];
  envVars: Record<string, string>;
  command: string[];
  interactive: boolean;
  name?: string;
  labels?: Record<string, string>;
}

type ForwardedSignal = "SIGINT" | "SIGTERM";

interface SignalTrap {
  add(signal: ForwardedSignal, handler: () => void): void;
  remove(signal: ForwardedSignal, handler: () => void): void;
}

export interface InteractiveCommandOptions {
  stdin?: "inherit" | "null" | "piped";
  stdout?: "inherit" | "null" | "piped";
  stderr?: "inherit" | "null" | "piped";
  errorLabel?: string;
  signalTrap?: SignalTrap;
}

const defaultSignalTrap: SignalTrap = {
  add(signal, handler) {
    process.on(signal, handler);
  },
  remove(signal, handler) {
    process.off(signal, handler);
  },
};

export class InterruptedCommandError extends Error {
  readonly exitCode = 130;

  constructor(command: string) {
    super(`${command} interrupted`);
    this.name = "InterruptedCommandError";
  }
}

export interface DockerContainerDetails {
  name: string;
  running: boolean;
  labels: DockerLabels;
  networks: string[];
  startedAt: string;
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
      parts.push(await readFile(path.join(group.baseDir, name), "utf8"));
    }
  }
  const data = new TextEncoder().encode(parts.join("\n"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(hash)).toString("hex");
}

/** docker image のラベル値を取得 */
export async function getImageLabel(
  tag: string,
  label: string,
): Promise<string | null> {
  try {
    const result =
      await $`docker inspect --format ${`{{index .Config.Labels "${label}"}}`} ${tag}`.quiet();
    const value = result.stdout.toString().trim();
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
  console.log(`$ docker build ${labelArgs.join(" ")} -t ${tag} ${contextDir}`);
  await $`docker build ${labelArgs} -t ${tag} ${contextDir}`;
}

/** docker run の引数リストを構築（docker コマンド自体を含む） */
export function buildDockerRunArgs(opts: DockerRunOptions): string[] {
  const args: string[] = ["docker", "run", "--rm"];

  if (opts.name) {
    args.push("--name", opts.name);
  }
  for (const [key, value] of Object.entries(opts.labels ?? {})) {
    args.push("--label", `${key}=${value}`);
  }

  if (opts.interactive) {
    // TTY がある場合のみ -t を付ける (非 TTY 環境では -i のみ)
    const isTty = process.stdin.isTTY ?? false;
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

  return args;
}

/** docker run を実行 */
export async function dockerRun(opts: DockerRunOptions): Promise<void> {
  const args = buildDockerRunArgs(opts);

  await runInteractiveCommand(args[0], args.slice(1), {
    errorLabel: "docker run",
  });
}

export async function runInteractiveCommand(
  command: string,
  args: string[],
  options: InteractiveCommandOptions = {},
): Promise<void> {
  const stdinOpt = options.stdin ?? "inherit";
  const stdoutOpt = options.stdout ?? "inherit";
  const stderrOpt = options.stderr ?? "inherit";
  const child = Bun.spawn([command, ...args], {
    stdin:
      stdinOpt === "null" ? "ignore" : stdinOpt === "piped" ? "pipe" : stdinOpt,
    stdout:
      stdoutOpt === "null"
        ? "ignore"
        : stdoutOpt === "piped"
          ? "pipe"
          : stdoutOpt,
    stderr:
      stderrOpt === "null"
        ? "ignore"
        : stderrOpt === "piped"
          ? "pipe"
          : stderrOpt,
  });
  const signalTrap = options.signalTrap ?? defaultSignalTrap;
  let interruptedBy: ForwardedSignal | null = null;
  const handlers = new Map<ForwardedSignal, () => void>();

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      interruptedBy = interruptedBy ?? signal;
      try {
        child.kill();
      } catch {
        // 子プロセスが先に終了していても終了判定は exited 側で扱う。
      }
    };
    handlers.set(signal, handler);
    signalTrap.add(signal, handler);
  }

  try {
    const code = await child.exited;
    if (interruptedBy !== null) {
      throw new InterruptedCommandError(command);
    }
    if (code !== 0) {
      throw new Error(
        `${options.errorLabel ?? command} exited with code ${code}`,
      );
    }
  } finally {
    for (const [signal, handler] of handlers.entries()) {
      signalTrap.remove(signal, handler);
    }
  }
}

/** docker image を削除 */
export async function dockerRemoveImage(
  tag: string,
  options?: { force?: boolean },
): Promise<void> {
  const forceArgs = options?.force ? ["--force"] : [];
  console.log(`$ docker rmi ${forceArgs.join(" ")} ${tag}`);
  await $`docker rmi ${forceArgs} ${tag}`;
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
export async function dockerNetworkCreateInternal(name: string): Promise<void> {
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
  await $`docker network connect ${aliasArgs} ${networkName} ${containerName}`.quiet();
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
  mounts?: Array<
    | string
    | {
        source: string;
        target: string;
        mode?: string;
        type?: "bind" | "volume";
      }
  >;
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
    if (typeof mount === "string") {
      args.push("--mount", mount);
      continue;
    }
    const mountType = mount.type ?? "bind";
    const segments = [
      `type=${mountType}`,
      `src=${mount.source}`,
      `dst=${mount.target}`,
    ];
    const mountMode = normalizeMountMode(mount.mode);
    if (mountMode) {
      segments.push(mountMode);
    }
    args.push("--mount", segments.join(","));
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
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).arrayBuffer().then((b) => new Uint8Array(b)),
    new Response(proc.stderr).arrayBuffer().then((b) => new Uint8Array(b)),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(formatDockerCommandFailure(args, code, stdout, stderr));
  }
}

function formatDockerCommandFailure(
  args: string[],
  code: number,
  stdout: Uint8Array,
  stderr: Uint8Array,
): string {
  const stdoutText = new TextDecoder().decode(stdout).trim();
  const stderrText = new TextDecoder().decode(stderr).trim();
  const lines = [`docker ${args.join(" ")} exited with code ${code}`];
  if (stderrText.length > 0) {
    lines.push(`stderr:\n${stderrText}`);
  }
  if (stdoutText.length > 0) {
    lines.push(`stdout:\n${stdoutText}`);
  }
  return lines.join("\n\n");
}

function normalizeMountMode(mode?: string): string | null {
  if (!mode || mode === "" || mode === "rw" || mode === "readwrite") {
    return null;
  }
  if (mode === "ro" || mode === "readonly") {
    return "readonly";
  }
  return mode;
}

export async function dockerContainerExists(
  containerName: string,
): Promise<boolean> {
  try {
    await $`docker inspect ${containerName}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/** docker stop を実行 */
export async function dockerStop(
  containerName: string,
  options?: { timeoutSeconds?: number },
): Promise<void> {
  const args: string[] = ["stop"];
  if (options?.timeoutSeconds !== undefined) {
    args.push("--time", String(options.timeoutSeconds));
  }
  args.push(containerName);
  await $`docker ${args}`.quiet();
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
    const result =
      await $`docker exec ${userArgs} ${containerName} ${command}`.quiet();
    return { code: 0, stdout: result.stdout.toString().trim() };
  } catch (err) {
    if (err && typeof err === "object" && "exitCode" in err) {
      return { code: (err as { exitCode: number }).exitCode, stdout: "" };
    }
    return { code: 1, stdout: "" };
  }
}

/** コンテナが実行中かどうかを確認 */
export async function dockerIsRunning(containerName: string): Promise<boolean> {
  try {
    const fmt = "{{.State.Running}}";
    const result =
      await $`docker inspect --format=${fmt} ${containerName}`.quiet();
    return result.stdout.toString().trim() === "true";
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
    const result = await $`docker logs ${tailArgs} ${containerName}`.quiet();
    // docker logs outputs to both stdout and stderr
    return (result.stdout.toString() + result.stderr.toString()).trim();
  } catch {
    return "(failed to retrieve container logs)";
  }
}

/** すべてのコンテナ名を取得 */
export async function dockerListContainerNames(): Promise<string[]> {
  const fmt = "{{.Names}}";
  const result = await $`docker ps -a --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout.toString());
}

/** すべての network 名を取得 */
export async function dockerListNetworkNames(): Promise<string[]> {
  const fmt = "{{.Name}}";
  const result = await $`docker network ls --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout.toString());
}

/** すべての volume 名を取得 */
export async function dockerListVolumeNames(): Promise<string[]> {
  const fmt = "{{.Name}}";
  const result = await $`docker volume ls --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout.toString());
}

/** コンテナ inspect を取得 */
export async function dockerInspectContainer(
  containerName: string,
): Promise<DockerContainerDetails> {
  const result = await $`docker inspect ${containerName}`.quiet();
  const parsed = JSON.parse(result.stdout.toString())[0];
  return {
    name: String(parsed.Name ?? containerName).replace(/^\//, ""),
    running: parsed.State?.Running === true,
    labels: parsed.Config?.Labels ?? {},
    networks: Object.keys(parsed.NetworkSettings?.Networks ?? {}),
    startedAt: parsed.State?.StartedAt ?? "",
  };
}

export async function dockerContainerIp(
  containerName: string,
): Promise<string | null> {
  try {
    const fmt =
      "{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}}{{break}}{{end}}{{end}}";
    const result =
      await $`docker inspect --format=${fmt} ${containerName}`.quiet();
    const ip = result.stdout.toString().trim();
    return ip.length > 0 ? ip : null;
  } catch {
    return null;
  }
}

/** network inspect を取得 */
export async function dockerInspectNetwork(
  networkName: string,
): Promise<DockerNetworkDetails> {
  const result = await $`docker network inspect ${networkName}`.quiet();
  const parsed = JSON.parse(result.stdout.toString())[0];
  const containers = Object.values(parsed.Containers ?? {})
    .map((entry) =>
      typeof entry === "object" && entry !== null && "Name" in entry
        ? String(entry.Name)
        : "",
    )
    .filter((name) => name.length > 0);
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
  const parsed = JSON.parse(result.stdout.toString())[0];
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
    await $`docker ps -a --filter volume=${volumeName} --format=${fmt}`.quiet();
  return splitNonEmptyLines(result.stdout.toString());
}

function splitNonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
