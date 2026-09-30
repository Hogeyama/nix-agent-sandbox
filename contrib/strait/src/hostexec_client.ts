// strait-hostexec: ask, from inside the sandbox, to run a command on the host.
//
//   strait-hostexec [--cwd DIR] [--env NAME=VALUE | --env NAME]... [--] cmd [args...]
//
// The command runs only after a human approves it with `strait review`, with
// PATH and HOME from the host plus exactly the variables given here
// (`--env NAME` copies this shell's value). The working directory defaults
// to the current one. Output comes back once the command ends; there is no
// stdin. Exit status is the command's, or 126 when the request is refused.

import { spawn } from "node:child_process";
import { HOSTEXEC_HOST, HOSTEXEC_PATH } from "./hostexec.ts";

export interface ClientArgs {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export function parseClientArgs(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ClientArgs | string {
  const out: ClientArgs = { argv: [], cwd, env: {} };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--cwd" && i + 1 < args.length) {
      out.cwd = args[++i] as string;
    } else if (a === "--env" && i + 1 < args.length) {
      const spec = args[++i] as string;
      const eq = spec.indexOf("=");
      if (eq === -1) {
        const v = env[spec];
        if (v === undefined) return `--env ${spec}: not set here`;
        out.env[spec] = v;
      } else {
        out.env[spec.slice(0, eq)] = spec.slice(eq + 1);
      }
    } else if (a.startsWith("-")) {
      return `unknown option ${a}`;
    } else break;
  }
  out.argv = args.slice(i);
  if (out.argv.length === 0) return "no command";
  return out;
}

async function main(): Promise<number> {
  const parsed = parseClientArgs(
    process.argv.slice(2),
    process.cwd(),
    process.env,
  );
  if (typeof parsed === "string") {
    console.error(`strait-hostexec: ${parsed}`);
    console.error(
      "usage: strait-hostexec [--cwd DIR] [--env NAME=VALUE | --env NAME]... [--] cmd [args...]",
    );
    return 2;
  }
  // curl, not fetch: srt points curl at its proxy and CA through the
  // environment, and probe.sh shows that path works inside the sandbox.
  // No --max-time: the request waits for a human, then for the command.
  const curl = spawn(
    "curl",
    [
      "-sS",
      "-X",
      "POST",
      "-H",
      "content-type: application/json",
      "--data-binary",
      "@-",
      "-w",
      "\n%{http_code}",
      `https://${HOSTEXEC_HOST}${HOSTEXEC_PATH}`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  curl.stdin.end(JSON.stringify(parsed));
  const chunks: Buffer[] = [];
  curl.stdout.on("data", (c: Buffer) => chunks.push(c));
  const code = await new Promise<number>((r) =>
    curl.on("close", (c) => r(c ?? 1)),
  );
  const text = Buffer.concat(chunks).toString("utf8");
  const nl = text.lastIndexOf("\n");
  const status = text.slice(nl + 1);
  const body = text.slice(0, nl);
  if (code !== 0 || status !== "200") {
    console.error(
      `strait-hostexec: refused (${status || `curl exit ${code}`}): ${body.trim()}`,
    );
    return 126;
  }
  const result = JSON.parse(body) as {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  };
  process.stdout.write(Buffer.from(result.stdout, "base64"));
  process.stderr.write(Buffer.from(result.stderr, "base64"));
  if (result.signal !== null) {
    console.error(`strait-hostexec: killed by ${result.signal}`);
    return 128 + 15;
  }
  return result.exitCode ?? 1;
}

if (import.meta.main) {
  main().then((code) => {
    process.exitCode = code;
  });
}
