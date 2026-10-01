// Running a command on the host for the sandbox, one approval per run.
//
// With `hostExec` on, the sandbox reaches a host that does not exist,
// HOSTEXEC_HOST, through srt's proxy like any other request. filterRequest
// never lets it upstream: strait holds it for review, runs the command on the
// host if a human approves, and answers with the result itself (srt patch
// `respond`). The request states everything the command gets, argv, working
// directory and environment, so the human reviews exactly what will run.

import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export const HOSTEXEC_HOST = "hostexec.strait.invalid";
export const HOSTEXEC_PATH = "/run";

/**
 * Taken from strait's own environment so that `nix` or `bun` resolve as they
 * would in the host shell. Nothing else is inherited: strait's environment
 * holds the real tokens it masks inside the sandbox.
 */
export const INHERITED_ENV = ["PATH", "HOME"] as const;

export interface ExecRequest {
  argv: string[];
  cwd: string;
  /** Added to INHERITED_ENV, overriding it. */
  env: Record<string, string>;
}

export interface ExecResult {
  exitCode: number | null;
  signal: string | null;
  /** base64. */
  stdout: string;
  /** base64. */
  stderr: string;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a request body, or return why it is not a valid request. */
export function parseExecRequest(text: string): ExecRequest | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "hostexec body is not JSON";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "hostexec body is not an object";
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (key !== "argv" && key !== "cwd" && key !== "env") {
      return `hostexec body has an unexpected member ${JSON.stringify(key)}`;
    }
  }
  const { argv, cwd, env } = r;
  // A NUL cannot reach exec, so a string holding one is not what would run.
  const text0 = (v: unknown): v is string =>
    typeof v === "string" && !v.includes("\0");
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(text0)) {
    return "hostexec argv must be a non-empty array of strings";
  }
  if (argv[0] === "") return "hostexec argv[0] is empty";
  if (!text0(cwd) || !isAbsolute(cwd)) {
    return "hostexec cwd must be an absolute path";
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    return "hostexec env must be an object";
  }
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name)) {
      return `hostexec env name ${JSON.stringify(name)} is not valid`;
    }
    if (!text0(value)) return `hostexec env ${name} must be a string`;
    vars[name] = value;
  }
  return { argv, cwd, env: vars };
}

/** The environment the command runs with. */
export function execEnv(
  req: ExecRequest,
  host: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const v = host[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...req.env };
}

/** How long a stopped command's processes get after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/**
 * Run the command with no stdin, collecting its output. `secrets` are
 * replaced in the output, so a command that prints a token (`gh auth token`)
 * does not hand the real value to the sandbox. The command is stopped if the
 * sandboxed client goes away, and is not started if it already has.
 */
export function runOnHost(
  req: ExecRequest,
  secrets: readonly string[],
  signal?: AbortSignal,
  graceMs = KILL_GRACE_MS,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      return resolve({
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: Buffer.from("strait: not run, the client went away\n").toString(
          "base64",
        ),
      });
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    // In a process group of its own, so that stopping it reaches what it
    // started too: a shell's or a build's children would otherwise outlive
    // it and keep running, maybe holding the output pipes open. A child
    // that makes its own group (setsid, a daemon) still escapes.
    const child = spawn(req.argv[0] as string, req.argv.slice(1), {
      cwd: req.cwd,
      env: execEnv(req, process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    own(child.pid);
    let stopped: Promise<void> | undefined;
    const stop = () => {
      stopped = stopGroup(child.pid, graceMs);
    };
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    let done = false;
    const finish = (r: Omit<ExecResult, "stdout" | "stderr">, extra = "") => {
      // A spawn failure can emit both "error" and "close".
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", stop);
      // The leader's exit does not end a stop: the rest of its group may
      // still be running.
      void (stopped ?? Promise.resolve()).then(() => {
        // Before then, strait's exit still kills the group; a run that ended
        // by itself leaves anything it put in the background alone, as a
        // shell would.
        if (child.pid !== undefined) owned.delete(child.pid);
        resolve({
          ...r,
          stdout: mask(Buffer.concat(out), secrets).toString("base64"),
          stderr: mask(
            Buffer.concat([...err, Buffer.from(extra)]),
            secrets,
          ).toString("base64"),
        });
      });
    };
    child.on("error", (e) =>
      finish({ exitCode: 127, signal: null }, `strait: ${e.message}\n`),
    );
    child.on("close", (code, sig) => finish({ exitCode: code, signal: sig }));
  });
}

/** Groups of runs not yet over, by process group ID. */
const owned = new Set<number>();
let exitHook = false;

/**
 * Have strait's own exit SIGKILL the group. A stop's grace period is a timer,
 * and process.exit does not wait for timers, so a group still running or
 * still being stopped would otherwise outlive strait: it no longer shares the
 * terminal's process group, so a Ctrl-C does not reach it either.
 */
function own(pgid: number | undefined): void {
  if (pgid === undefined) return;
  owned.add(pgid);
  if (exitHook) return;
  exitHook = true;
  process.on("exit", () => {
    for (const g of owned) {
      try {
        process.kill(-g, "SIGKILL");
      } catch {}
    }
  });
}

/**
 * SIGTERM the process group, then SIGKILL it if anything in it is still
 * there after `graceMs`. Resolves once the group is gone or killed.
 */
function stopGroup(pgid: number | undefined, graceMs: number): Promise<void> {
  // No pid: spawning failed, so there is nothing to stop.
  if (pgid === undefined) return Promise.resolve();
  const send = (sig: NodeJS.Signals | 0) => {
    try {
      process.kill(-pgid, sig);
      return true;
    } catch {
      return false;
    }
  };
  if (!send("SIGTERM")) return Promise.resolve();
  const deadline = Date.now() + graceMs;
  return new Promise((done) => {
    const poll = setInterval(() => {
      const there = send(0);
      if (there && Date.now() < deadline) return;
      // An unreaped zombie keeps the group alive until the deadline, when
      // SIGKILL does no harm. A group seen gone is not signalled again: its
      // ID may already belong to someone else.
      if (there) send("SIGKILL");
      clearInterval(poll);
      done();
    }, 50);
  });
}

export function mask(output: Buffer, secrets: readonly string[]): Buffer {
  // latin1 maps bytes one to one, so the replacement cannot corrupt output
  // that is not UTF-8.
  let s = output.toString("latin1");
  let changed = false;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    const raw = Buffer.from(secret).toString("latin1");
    if (s.includes(raw)) {
      s = s.replaceAll(raw, "[masked by strait]");
      changed = true;
    }
  }
  return changed ? Buffer.from(s, "latin1") : output;
}
