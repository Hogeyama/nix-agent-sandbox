// strait: run a command under srt with a fixed network policy.
//
//   strait [--config strait.json] [--name NAME] [--debug] -- command [args...]
//   strait review ...        approve or deny held requests (review.ts)
//
// Invariants enforced here rather than left to configuration: TLS is always
// terminated, no host is exempt from it, the host list is fixed at port 443,
// every request passes decide(), and the proxy must prove it carries the
// SOCKS and non-TLS patches before the command starts.

import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  Approvals,
  notifier,
  removeSocket,
  serve,
  socketDir,
} from "./approval.ts";
import { readBody } from "./body.ts";
import { parseConfig, type StraitConfig } from "./config.ts";
import { HOSTEXEC_HOST, runOnHost } from "./hostexec.ts";
import {
  ANTHROPIC_HOST,
  decide,
  type FinalDecision,
  GITHUB_API_HOST,
  GITHUB_HOST,
  HOSTS,
  type Sentinels,
  wantsBody,
} from "./policy.ts";
import { reviewMain } from "./review.ts";
import { assertProxyPatched, assertRespondPatched } from "./selfcheck.ts";
import {
  claimNewSocket,
  claimSocket,
  isSessionId,
  sessionInfo,
} from "./session.ts";
import { findStatusLine, wrapStatusLine } from "./statusline.ts";

// Credentials read from the host environment and masked inside the sandbox.
// STRAIT_GIT_AUTH is derived from GH_TOKEN: git over HTTPS only accepts
// Basic auth, and srt substitutes a sentinel only where it appears verbatim,
// so the whole header value is masked as one credential.
const CREDENTIALS = [
  { env: "GH_TOKEN", host: GITHUB_API_HOST, key: "githubToken" },
  { env: "STRAIT_GIT_AUTH", host: GITHUB_HOST, key: "gitAuthorization" },
  {
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    host: ANTHROPIC_HOST,
    key: "anthropicOauth",
  },
  { env: "ANTHROPIC_API_KEY", host: ANTHROPIC_HOST, key: "anthropicApiKey" },
] as const satisfies ReadonlyArray<{
  env: string;
  host: string;
  key: keyof Sentinels;
}>;

function usage(): never {
  console.error(
    "usage: strait [--config strait.json] [--name NAME] [--debug] -- command [args...]\n" +
      "       strait review [--json] [--all] [SESSION]",
  );
  process.exit(2);
}

// Options end at "--" or at the first non-option argument. bun drops a "--"
// that directly follows the script path, so it cannot be required.
function parseArgs(argv: string[]) {
  let configPath = "strait.json";
  let debug = false;
  let name: string | undefined;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a === "--config" && i + 1 < argv.length) configPath = argv[++i];
    else if (a === "--name" && i + 1 < argv.length) name = argv[++i];
    else if (a === "--debug") debug = true;
    else if (a.startsWith("-")) usage();
    else break;
  }
  const command = argv.slice(i);
  if (command.length === 0) usage();
  // A session named like a review subcommand could not be selected there.
  if (
    name !== undefined &&
    (!isSessionId(name) || ["list", "show", "approve", "deny"].includes(name))
  ) {
    console.error(
      `strait: --name ${JSON.stringify(name)}: use letters, digits, _ and -, at most 32, not ending in -`,
    );
    process.exit(2);
  }
  return { configPath, debug, name, command };
}

// A missing config is an error, not an empty policy: a path that does not
// exist cannot be write-protected, so the sandboxed process could create it
// and choose the next launch's settings.
function loadConfig(path: string): StraitConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} not found; create it (see strait.example.json)`);
  }
  return parseConfig(text);
}

// The policy is only as strong as the files that define it. The sandboxed
// process could otherwise rewrite strait.json, strait's sources, the srt patch
// or the patched srt in node_modules, and the next launch would run its
// policy. These are appended after the user's list so config cannot drop them.
function protectedPaths(userDenyWrite: string[], configPath: string): string[] {
  const always = [
    resolve(configPath),
    resolve(import.meta.dir, ".."),
    resolve(".claude"),
  ];
  // srt on Linux applies denyWrite only to paths that exist at wrap time.
  if (!existsSync(always[2])) always.pop();
  else {
    // srt always protects these two and, when they are missing, has bwrap
    // create mount points for them, which fails inside a read-only .claude.
    // Only a path with no entry at all is created: a symlink, even a
    // dangling one, is left for srt, which resolves it itself.
    for (const d of ["commands", "agents"]) {
      const path = resolve(always[2], d);
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined) {
        mkdirSync(path);
      }
    }
  }
  return [...new Set([...userDenyWrite, ...always])];
}

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

async function main() {
  const argv = process.argv.slice(2);
  // `review` runs on the host next to the sessions; it starts no sandbox.
  // To sandbox a program called review, put it after `--`.
  if (argv[0] === "review") process.exit(await reviewMain(argv.slice(1)));
  const { configPath, debug, name, command: given } = parseArgs(argv);
  if (debug) process.env.SRT_DEBUG = "1";
  const config = loadConfig(configPath);

  if (process.env.GH_TOKEN) {
    const basic = Buffer.from(
      `x-access-token:${process.env.GH_TOKEN}`,
    ).toString("base64");
    process.env.STRAIT_GIT_AUTH = `Basic ${basic}`;
  }
  const present = CREDENTIALS.filter((c) => process.env[c.env]);
  // What a host command must not print back into the sandbox. The git value
  // is `Basic <base64>`, and output may carry either part.
  const secrets = () =>
    present.flatMap((c) => {
      const v = process.env[c.env] as string;
      return v.startsWith("Basic ") ? [v, v.slice("Basic ".length)] : [v];
    });
  if (config.hostExec) assertRespondPatched();

  // Created before wrapping: srt on Linux protects only paths that exist.
  const sockets = socketDir();
  const { id, path: socketPath } =
    name === undefined
      ? await claimNewSocket(sockets)
      : { id: name, path: await claimSocket(sockets, name) };
  const wrap = config.statusLine
    ? wrapStatusLine(
        given,
        findStatusLine(process.cwd(), process.env),
        resolve(import.meta.dir, "..", "strait-statusline"),
      )
    : { command: given, env: {} };
  const command = wrap.command;
  const session = sessionInfo(id, given);

  const approvals = new Approvals(session, undefined, notifier(session));
  await serve(approvals, socketPath);
  process.on("exit", () => removeSocket(socketPath));

  const sentinels: Sentinels = {};
  await SandboxManager.initialize({
    network: {
      allowedDomains: [
        ...HOSTS,
        ...(config.hostExec ? [HOSTEXEC_HOST] : []),
      ].map((h) => `${h}:443`),
      deniedDomains: [],
      strictAllowlist: true,
      tlsTerminate: {},
      filterRequest: async (request) => {
        const body = wantsBody(request.method, request.url)
          ? await readBody(request)
          : undefined;
        const decision = decide(
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body,
          },
          { githubRepos: config.githubRepos, hostExec: config.hostExec },
          sentinels,
        );
        if (decision.action !== "review") return decision;
        const { exec } = decision;
        const final = await approvals.hold(
          {
            method: request.method,
            url: request.url,
            reason: decision.reason,
            ...(exec ? { exec } : typeof body === "string" ? { body } : {}),
          },
          request.signal,
        );
        if (final.action !== "allow" || exec === undefined) return final;
        // srt patch `respond`: answered here, never sent upstream.
        const result = await runOnHost(exec, secrets(), request.signal);
        return {
          action: "respond",
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(result),
        } as unknown as FinalDecision;
      },
    },
    filesystem: {
      ...config.filesystem,
      denyWrite: protectedPaths(config.filesystem.denyWrite, configPath),
      // The approval socket must stay out of reach even where srt cannot
      // block AF_UNIX (no seccomp helper).
      denyRead: [...new Set([...config.filesystem.denyRead, sockets])],
    },
    credentials: {
      envVars: present.map((c) => ({
        name: c.env,
        mode: "mask" as const,
        injectHosts: [c.host],
      })),
    },
  });

  const port = SandboxManager.getProxyPort();
  if (port === undefined) throw new Error("srt did not start its proxy");
  await assertProxyPatched(port, SandboxManager.getProxyAuthToken());

  // git reads the sentinel from the masked env var inside the sandbox.
  const gitSetup = process.env.STRAIT_GIT_AUTH
    ? 'export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader; export GIT_CONFIG_VALUE_0="Authorization: $STRAIT_GIT_AUTH"; '
    : "";
  // The session ID, for the wrapped status line and for the agent to name
  // when it tells the user to approve something.
  const sessionEnv = Object.entries({ STRAIT_SESSION: id, ...wrap.env })
    .map(([k, v]) => `export ${k}=${shellQuote(v)}; `)
    .join("");
  // strait-hostexec sits next to the launcher, in the package or a checkout;
  // put it on the sandbox's PATH so an agent can call it by name.
  const straitDir = shellQuote(resolve(import.meta.dir, ".."));
  const pathSetup = config.hostExec ? `export PATH=${straitDir}:"$PATH"; ` : "";
  const inner = `${gitSetup}${sessionEnv}${pathSetup}exec ${command.map(shellQuote).join(" ")}`;
  const wrapped = await SandboxManager.wrapWithSandbox(inner);

  // srt mints a sentinel per masked credential while wrapping; learn which is
  // which by matching real values, which never leave this process.
  const realToKey = new Map<string, keyof Sentinels>(
    present.map((c) => [process.env[c.env] as string, c.key]),
  );
  for (const [
    sentinel,
    real,
  ] of SandboxManager.getSentinelRegistry().entries()) {
    const key = realToKey.get(real);
    if (key) sentinels[key] = sentinel;
  }
  const missing = present.filter((c) => sentinels[c.key] === undefined);
  if (missing.length > 0) {
    throw new Error(`srt did not mask ${missing.map((c) => c.env).join(", ")}`);
  }

  console.error(
    `strait: session ${id} (approve held requests with: strait review ${id})`,
  );
  const child = spawn(wrapped, { shell: true, stdio: "inherit" });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  child.on("exit", async (code, signal) => {
    SandboxManager.cleanupAfterCommand();
    await SandboxManager.reset().catch(() => {});
    process.exit(signal ? 1 : (code ?? 0));
  });
}

main().catch(async (e) => {
  console.error(`strait: ${e instanceof Error ? e.message : String(e)}`);
  await SandboxManager.reset().catch(() => {});
  process.exit(1);
});
