/**
 * `nas hook` サブコマンド
 *
 * Agent hooks running *inside* the sandbox container call this to report
 * session lifecycle events to the host-side session store.
 *
 * The guiding principle is **"never fail the hook"**: every error path
 * (bad args, missing env, unreadable stdin, store write failure) must exit
 * 0 with at most a stderr warning. Agent runtimes treat a non-zero exit
 * from their hooks as a failure, and we must not fail agent turns because
 * our session store is unhappy.
 */

import {
  checkNotifySend,
  type NotifyBackend,
  resolveNotifyBackend,
} from "../lib/notify_utils.ts";
import {
  readSession,
  resolveSessionRuntimePaths,
  type SessionEventKind,
  type SessionRuntimePaths,
  updateSessionTurn,
} from "../sessions/store.ts";
import { getFlagValue } from "./helpers.ts";

/** Maximum length of the `message` field surfaced to the store. */
const MAX_MESSAGE_LEN = 200;

/** Hard cap on how long we wait for stdin before giving up. */
const STDIN_TIMEOUT_MS = 50;

type StdinReader = () => Promise<string>;

export interface RunHookDeps {
  /** Override stdin reader — tests feed a synchronous string. */
  stdinReader?: StdinReader;
  /** Override notification sender — tests capture calls instead of spawning. */
  notifySender?: (title: string, body: string) => void;
}

interface HookMatcher {
  path: string[];
  expected: string;
}

/**
 * Top-level `nas hook ...` handler.
 *
 * Exported for unit tests via the `deps` parameter. Callers in production
 * should pass no deps and get the real stdin reader.
 */
export async function runHookCommand(
  args: string[],
  deps: RunHookDeps = {},
): Promise<void> {
  const kindArg = getFlagValue(args, "--kind");
  const kind = parseHookKind(kindArg ?? undefined);
  if (kind === null) {
    console.error(
      `[nas] hook: invalid or missing --kind ` +
        `(expected start|attention|stop, got ${JSON.stringify(kindArg)})`,
    );
    return;
  }

  const whenMatchers = parseHookMatchers(args);
  if (whenMatchers === null) return;

  const sessionId = process.env.NAS_SESSION_ID;
  if (!sessionId || sessionId.length === 0) {
    console.error("[nas] hook: NAS_SESSION_ID is not set; skipping.");
    return;
  }

  if (!isSafeSessionId(sessionId)) {
    console.error(
      `[nas] hook: refusing unsafe NAS_SESSION_ID ` +
        `${JSON.stringify(sessionId)} (path traversal guard).`,
    );
    return;
  }

  // Read stdin best-effort. Any failure → empty payload, keep going.
  let payload: unknown;
  try {
    const reader = deps.stdinReader ?? defaultStdinReader;
    const raw = await reader();
    if (raw && raw.trim().length > 0) {
      payload = JSON.parse(raw);
    }
  } catch (err) {
    // Malformed JSON or stdin read failure — not fatal.
    console.error(
      `[nas] hook: ignoring stdin parse error: ${(err as Error).message}`,
    );
  }

  const message = extractHookMessage(payload);
  if (!payloadMatchesAll(payload, whenMatchers)) return;

  // Update the session store. Any failure is non-fatal.
  const paths = resolveSessionRuntimePaths();
  try {
    await updateSessionTurn(paths, sessionId, kind, message);
  } catch (err) {
    console.error(
      `[nas] hook: session store update failed: ${(err as Error).message}`,
    );
  }

  // Fire-and-forget desktop notification on attention (user-turn).
  if (kind === "attention") {
    fireAttentionNotification(paths, sessionId, message, deps.notifySender);
  }
}

function parseHookMatchers(args: string[]): HookMatcher[] | null {
  const matchers: HookMatcher[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--when") continue;

    if (i + 1 >= args.length) {
      console.error(
        "[nas] hook: missing value for --when " + "(expected path=value)",
      );
      return null;
    }

    const raw = args[i + 1];
    const matcher = parseHookMatcher(raw);
    if (matcher === null) {
      console.error(
        `[nas] hook: invalid --when ${JSON.stringify(raw)} ` +
          `(expected path=value)`,
      );
      return null;
    }
    matchers.push(matcher);
    i++;
  }
  return matchers;
}

function parseHookMatcher(raw: string): HookMatcher | null {
  const equalsIndex = raw.indexOf("=");
  if (equalsIndex <= 0) return null;

  const path = raw.slice(0, equalsIndex).split(".");
  if (path.some((segment) => segment.length === 0)) return null;

  return {
    path,
    expected: raw.slice(equalsIndex + 1),
  };
}

function payloadMatchesAll(payload: unknown, matchers: HookMatcher[]): boolean {
  return matchers.every((matcher) => payloadMatches(payload, matcher));
}

function payloadMatches(payload: unknown, matcher: HookMatcher): boolean {
  const value = readMatcherValue(payload, matcher.path);
  return typeof value === "string" && value === matcher.expected;
}

function readMatcherValue(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Map the `--kind` argument string to the store's `SessionEventKind`.
 * Exported for direct unit testing of the parser.
 */
export function parseHookKind(
  arg: string | undefined,
): SessionEventKind | null {
  if (arg === "start") return "start";
  if (arg === "attention") return "attention";
  if (arg === "stop") return "stop";
  return null;
}

/**
 * Pull a human-readable `message` out of an arbitrary hook payload.
 *
 * Tries, in order: `payload.message`, `payload.notification.message`,
 * `payload.Notification.message`. Returns `undefined` for non-object
 * payloads or missing fields. The result is truncated to
 * {@link MAX_MESSAGE_LEN} characters.
 *
 * Exported for direct unit testing.
 */
export function extractHookMessage(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;

  const candidates: unknown[] = [
    obj.message,
    readNestedMessage(obj.notification),
    readNestedMessage(obj.Notification),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate.length > MAX_MESSAGE_LEN
        ? candidate.slice(0, MAX_MESSAGE_LEN)
        : candidate;
    }
  }
  return undefined;
}

function readNestedMessage(value: unknown): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>).message;
}

/**
 * Reject session ids that could escape the session store directory.
 * We allow only "normal looking" ids here. The pipeline always
 * generates `sess_<hex>`, so this is a tight whitelist in practice.
 */
function isSafeSessionId(sessionId: string): boolean {
  if (sessionId.length === 0) return false;
  if (sessionId.startsWith(".")) return false;
  if (sessionId.includes("/")) return false;
  if (sessionId.includes("\\")) return false;
  if (sessionId.includes("..")) return false;
  return true;
}

/**
 * Best-effort, fire-and-forget desktop notification when an agent
 * signals "attention" (user-turn). Reads the session record to check
 * the `hookNotify` preference; defaults to "auto" for records that
 * predate the field. Never throws, never blocks the hook exit.
 */
function fireAttentionNotification(
  paths: SessionRuntimePaths,
  sessionId: string,
  message: string | undefined,
  notifySender?: (title: string, body: string) => void,
): void {
  // Intentionally not awaited — the hook must exit fast.
  void (async () => {
    try {
      const record = await readSession(paths, sessionId);
      const backend = resolveNotifyBackend(
        (record?.hookNotify as NotifyBackend) ?? "auto",
      );
      if (backend === "off") return;

      const title = `[nas] Your turn: ${sessionId}`;
      const body = message ?? "Agent is waiting for input.";

      if (notifySender) {
        notifySender(title, body);
        return;
      }

      checkNotifySend();
      // Simple fire-and-forget: no --wait, no --print-id.
      Bun.spawn(["notify-send", title, body], {
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      });
    } catch {
      // Never fail a hook.
    }
  })();
}

/**
 * Best-effort stdin read with a short timeout. Returns "" for TTY, empty
 * stdin, or timeout. Never throws.
 */
async function defaultStdinReader(): Promise<string> {
  // If stdin is a terminal, there's no payload to read.
  // `Bun.stdin` exposes a Blob-like `text()` method; we guard it.
  try {
    const stdin = Bun.stdin as unknown as {
      stream?: () => ReadableStream<Uint8Array>;
    };
    if (typeof stdin.stream !== "function") return "";
    const stream = stdin.stream();

    const readAll = (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let out = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) out += decoder.decode(value, { stream: true });
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      return out;
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(""), STDIN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([readAll, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    return "";
  }
}
