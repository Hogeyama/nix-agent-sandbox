/**
 * Docker CLI ラッパー
 */

import $ from "dax";

export interface DockerRunOptions {
  image: string;
  args: string[];
  envVars: Record<string, string>;
  command: string[];
  interactive: boolean;
}

/** docker build を実行 */
export async function dockerBuild(
  contextDir: string,
  tag: string,
): Promise<void> {
  await $`docker build -t ${tag} ${contextDir}`.printCommand();
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

/** docker image が存在するか確認 */
export async function dockerImageExists(tag: string): Promise<boolean> {
  try {
    await $`docker image inspect ${tag}`.quiet();
    return true;
  } catch {
    return false;
  }
}
