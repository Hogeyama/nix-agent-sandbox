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
  for (const name of ["Dockerfile", "entrypoint.sh"]) {
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
    const result =
      await $`docker inspect --format ${"{{index .Config.Labels \"" + label + "\"}}"} ${tag}`
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
export async function dockerRemoveImage(tag: string): Promise<void> {
  await $`docker rmi ${tag}`.printCommand();
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
