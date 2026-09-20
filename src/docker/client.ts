/**
 * Docker CLI ラッパー
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { resolveAssetDir } from "../lib/asset.ts";
import {
  type PreparationCommandResult,
  preparationSignal,
  runPreparationCommand,
} from "../lib/preparation_commands.ts";
import { diagnosticsUseStderr, logError, logInfo } from "../log.ts";
import { takeAcpStreams } from "./acp_connection.ts";
import type { DockerLabels } from "./nas_resources.ts";
import { runProtocolCommand } from "./protocol_command.ts";
import { containerRemovalWarning } from "./removal_outcome.ts";

/**
 * The files the sandbox image is built from.
 *
 * Every COPY source in the Dockerfile belongs here, because the hash of these
 * files is the image's identity: one left out lets a stale image survive the
 * change. One image serves every profile, so this list is not per-feature —
 * a devcontainer script is part of the image a codex session runs too.
 *
 * @internal exported so the Dockerfile can be checked against it.
 */
export const EMBEDDED_ASSET_NAMES = [
  "Dockerfile",
  "entrypoint.sh",
  "direnv-exec.sh",
  "devcontainer-env.sh",
  "devcontainer-exec.sh",
  "devcontainer-idle.sh",
  "devcontainer-claude.sh",
  "devcontainer-codex.sh",
  "direnv-bootstrap.sh",
  "direnv-lib.sh",
  "nix-direnv.sh",
  "nix-direnv.LICENSE",
  "local-proxy.mjs",
] as const;

const EMBEDDED_ASSET_GROUPS = [
  {
    baseDir: resolveAssetDir("docker/embed", import.meta.url, "./embed/"),
    files: EMBEDDED_ASSET_NAMES,
  },
] as const;

export interface DockerRunOptions {
  image: string;
  args: string[];
  envVars: Record<string, string>;
  command: string[];
  interactive: boolean;
  mode?: "terminal" | "acp";
  signal?: AbortSignal;
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
  diagnostic?: boolean;
  signalTrap?: SignalTrap;
}

export interface DockerCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** @internal Allows unit tests to substitute a short-lived fake process. */
  readonly executable?: string;
}

export interface DockerCommandResult {
  readonly stdout: string;
  readonly stderr: string;
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
  id: string;
  running: boolean;
  labels: DockerLabels;
  networks: string[];
  networkMode: string;
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

/** 埋め込みビルドアセットの SHA-256 ハッシュを計算 */
export async function computeEmbedHash(): Promise<string> {
  const parts: string[] = [];
  for (const group of EMBEDDED_ASSET_GROUPS) {
    for (const name of group.files) {
      const file = path.join(group.baseDir, name);
      try {
        parts.push(await readFile(file, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Every profile computes this hash, so an asset the installation did
        // not ship takes down sessions that have nothing to do with it. Say
        // that the install is incomplete instead of surfacing a bare ENOENT.
        throw new Error(
          `[nas] embedded build asset is missing: ${file}\nThe installed asset directory is incomplete. Rebuild or reinstall nas (NAS_ASSET_DIR overrides the location).`,
        );
      }
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
  options?: DockerCommandOptions,
): Promise<string | null> {
  if (preparationSignal()) {
    const result = await runPreparationCommand("docker", [
      "inspect",
      "--format",
      `{{index .Config.Labels "${label}"}}`,
      tag,
    ]);
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }
  try {
    const format = `{{index .Config.Labels "${label}"}}`;
    const result = options
      ? await runDockerCommand(["inspect", "--format", format, tag], options)
      : await $`docker inspect --format ${format} ${tag}`.quiet();
    const value = result.stdout.toString().trim();
    return value || null;
  } catch (error) {
    if (options && isBoundedCommandFailure(error)) throw error;
    return null;
  }
}

/** docker build を実行 */
export async function dockerBuild(
  contextDir: string,
  tag: string,
  labels?: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const labelArgs: string[] = [];
  if (labels) {
    for (const [key, value] of Object.entries(labels)) {
      labelArgs.push("--label", `${key}=${value}`);
    }
  }
  logInfo(`$ docker build ${labelArgs.join(" ")} -t ${tag} ${contextDir}`);
  if (preparationSignal()) {
    const result = await runPreparationCommand(
      "docker",
      ["build", ...labelArgs, "-t", tag, contextDir],
      { diagnostic: true, signal },
    );
    if (result.exitCode !== 0)
      throw new Error(`docker build exited with code ${result.exitCode}`);
    return;
  }
  await runInteractiveCommand(
    "docker",
    ["build", ...labelArgs, "-t", tag, contextDir],
    { stdin: "null", diagnostic: true },
  );
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
    const isTty = opts.mode !== "acp" && (process.stdin.isTTY ?? false);
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

  if (opts.mode === "acp") {
    try {
      await runProtocolCommand(args[0], args.slice(1), {
        signal: opts.signal,
        ...takeAcpStreams(),
      });
    } finally {
      // Killing the attached docker CLI does not reliably stop PID 1.
      // The session-owned container must be removed before pipeline resources.
      if (opts.name) {
        let warning: string | undefined;
        try {
          const result = await $`docker rm -f ${opts.name}`.quiet().nothrow();
          warning = containerRemovalWarning(opts.name, {
            exitCode: result.exitCode,
            stderr: result.stderr.toString(),
          });
        } catch (error) {
          warning = containerRemovalWarning(opts.name, { error });
        }
        // A failed finalizer must be visible without replacing the payload's exit.
        // logError always uses stderr or the explicitly selected diagnostic file.
        if (warning) logError(warning);
      }
    }
    return;
  }
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
      options.diagnostic && diagnosticsUseStderr()
        ? 2
        : stdoutOpt === "null"
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

/** docker image を pull する */
export async function dockerPull(
  tag: string,
  signal?: AbortSignal,
): Promise<void> {
  if (preparationSignal()) {
    const result = await runPreparationCommand("docker", ["pull", tag], {
      diagnostic: true,
      signal,
    });
    if (result.exitCode !== 0)
      throw new Error(`docker pull exited with code ${result.exitCode}`);
    return;
  }
  await runInteractiveCommand("docker", ["pull", tag], {
    stdin: "null",
    diagnostic: true,
  });
}

/** ローカルになければ pull する */
export async function dockerEnsureImage(
  tag: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (await dockerImageExists(tag, signal && { signal })) return false;
  logInfo(`[nas] Pulling image ${tag} ...`);
  await dockerPull(tag, signal);
  return true;
}

/** docker image が存在するか確認 */
export async function dockerImageExists(
  tag: string,
  options?: DockerCommandOptions,
): Promise<boolean> {
  if (preparationSignal()) {
    return (
      (
        await runPreparationCommand("docker", ["image", "inspect", tag], {
          signal: options?.signal,
        })
      ).exitCode === 0
    );
  }
  try {
    if (options) await runDockerCommand(["image", "inspect", tag], options);
    else await $`docker image inspect ${tag}`.quiet();
    return true;
  } catch (error) {
    if (options && isBoundedCommandFailure(error)) throw error;
    return false;
  }
}

function isBoundedCommandFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("timed out") || error.message.includes("aborted"))
  );
}

/** The deadline is an abort signal, so the preparation runner owns the kill. */
export async function runDockerCommand(
  args: readonly string[],
  options: DockerCommandOptions = {},
): Promise<DockerCommandResult> {
  const deadline =
    options.timeoutMs === undefined
      ? undefined
      : AbortSignal.timeout(options.timeoutMs);
  const signals = [options.signal, deadline].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
  let result: PreparationCommandResult;
  try {
    result = await runPreparationCommand(options.executable ?? "docker", args, {
      signal,
      graceMs: 250,
    });
  } catch (error) {
    if (deadline?.aborted)
      throw new Error(`docker command timed out after ${options.timeoutMs}ms`);
    if (signal?.aborted) throw new Error("docker command aborted");
    throw error;
  }
  if (result.exitCode !== 0)
    throw new Error(
      formatDockerCommandFailure(
        [...args],
        result.exitCode,
        result.stdout,
        result.stderr,
      ),
    );
  return { stdout: result.stdout, stderr: result.stderr };
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
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(formatDockerCommandFailure(args, code, stdout, stderr));
  }
}

function formatDockerCommandFailure(
  args: string[],
  code: number,
  stdout: string,
  stderr: string,
): string {
  const stdoutText = stdout.trim();
  const stderrText = stderr.trim();
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

/**
 * Start a command inside a container and return once Docker has accepted it.
 * Under `-d` the CLI exits immediately, so the exit code reports whether the
 * exec was created, not what the command did; stderr distinguishes a stopped
 * container from a missing executable.
 */
export async function dockerExecDetached(
  containerName: string,
  command: string[],
  options?: { user?: string; env?: Record<string, string> },
): Promise<{ code: number; stderr: string }> {
  const userArgs = options?.user ? ["-u", options.user] : [];
  const envArgs = Object.entries(options?.env ?? {}).flatMap(([key, value]) => [
    "-e",
    `${key}=${value}`,
  ]);
  try {
    await $`docker exec -d ${userArgs} ${envArgs} ${containerName} ${command}`.quiet();
    return { code: 0, stderr: "" };
  } catch (err) {
    const code =
      err && typeof err === "object" && "exitCode" in err
        ? (err as { exitCode: number }).exitCode
        : 1;
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr)
        : "";
    return { code, stderr };
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
  const result = await $`docker ps --format=${fmt}`.quiet();
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
    id: String(parsed.Id ?? ""),
    running: parsed.State?.Running === true,
    labels: parsed.Config?.Labels ?? {},
    networks: Object.keys(parsed.NetworkSettings?.Networks ?? {}),
    networkMode: String(parsed.HostConfig?.NetworkMode ?? ""),
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

export async function dockerContainerIpOnNetwork(
  containerName: string,
  networkName: string,
): Promise<string | null> {
  try {
    const fmt = `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`;
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
