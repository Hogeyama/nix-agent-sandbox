/**
 * `nas hook` サブコマンド
 *
 * Agent hooks running *inside* the sandbox container call this to report
 * session lifecycle events to the host-side session store.
 *
 * The guiding principle is **"never fail the hook"**: every error path
 * (bad args, missing env, unreadable stdin, store write failure, desktop
 * notification failure) must exit 0 with at most a stderr warning. Agent
 * runtimes treat a non-zero exit from their hooks as a failure, and we
 * must not fail agent turns because our session store is unhappy.
 */

import {
  resolveSessionRuntimePaths,
  type SessionEventKind,
  updateSessionTurn,
} from "../sessions/store.ts";
import {
  type DesktopNotificationOptions,
  tryDesktopNotification,
} from "../lib/notify_utils.ts";
import { getFlagValue, removeFirstOccurrence } from "./helpers.ts";

/** Maximum length of the `message` field surfaced to the store / notifier. */
const MAX_MESSAGE_LEN = 200;

/** Default URL used when opening the dashboard from a desktop notification. */
const DEFAULT_UI_URL = "http://localhost:3939/";

/** Hard cap on how long we wait for stdin before giving up. */
const STDIN_TIMEOUT_MS = 50;

type Notifier = (options: DesktopNotificationOptions) => Promise<boolean>;
type StdinReader = () => Promise<string>;

export interface RunHookNotificationDeps {
  /** Override stdin reader — tests feed a synchronous string. */
  stdinReader?: StdinReader;
  /** Override desktop notification — tests inject a spy. */
  notifier?: Notifier;
}

/**
 * Top-level `nas hook ...` dispatcher. Only `notification` is defined
 * today. Unknown subcommands print a usage line to stderr and exit 0.
 */
export async function runHookCommand(nasArgs: string[]): Promise<void> {
  const sub = nasArgs.find((arg) => !arg.startsWith("-"));
  if (sub === "notification") {
    const rest = removeFirstOccurrence(nasArgs, "notification");
    await runHookNotification(rest);
    return;
  }
  console.error(
    `[nas] Unknown hook subcommand: ${sub ?? "(none)"}. ` +
      `Usage: nas hook notification --kind start|attention|stop`,
  );
  // Never fail a hook, even on a typo.
  return;
}

/**
 * Implement `nas hook notification --kind ...`.
 *
 * Exported for unit tests via the `deps` parameter. Callers in production
 * (via `runHookCommand`) should pass no deps and get the real stdin/notifier.
 */
export async function runHookNotification(
  args: string[],
  deps: RunHookNotificationDeps = {},
): Promise<void> {
  const kindArg = getFlagValue(args, "--kind");
  const kind = parseHookKind(kindArg ?? undefined);
  if (kind === null) {
    console.error(
      `[nas] hook notification: invalid or missing --kind ` +
        `(expected start|attention|stop, got ${JSON.stringify(kindArg)})`,
    );
    return;
  }

  const sessionId = process.env["NAS_SESSION_ID"];
  if (!sessionId || sessionId.length === 0) {
    console.error(
      "[nas] hook notification: NAS_SESSION_ID is not set; skipping.",
    );
    return;
  }

  if (!isSafeSessionId(sessionId)) {
    console.error(
      `[nas] hook notification: refusing unsafe NAS_SESSION_ID ` +
        `${JSON.stringify(sessionId)} (path traversal guard).`,
    );
    return;
  }

  // Read stdin best-effort. Any failure → empty payload, keep going.
  let payload: unknown = undefined;
  try {
    const reader = deps.stdinReader ?? defaultStdinReader;
    const raw = await reader();
    if (raw && raw.trim().length > 0) {
      payload = JSON.parse(raw);
    }
  } catch (err) {
    // Malformed JSON or stdin read failure — not fatal.
    console.error(
      `[nas] hook notification: ignoring stdin parse error: ${
        (err as Error).message
      }`,
    );
  }

  const message = extractHookMessage(payload);

  // Update the session store. Any failure is non-fatal, but if the
  // store update fails we skip the desktop notification too: the store
  // is the source of truth the UI reads, so a notification we cannot
  // correlate to a persisted turn transition would only be noise.
  let storeOk = false;
  try {
    const paths = await resolveSessionRuntimePaths();
    await updateSessionTurn(paths, sessionId, kind, message);
    storeOk = true;
  } catch (err) {
    console.error(
      `[nas] hook notification: session store update failed: ${
        (err as Error).message
      }`,
    );
  }

  if (storeOk && kind === "attention") {
    const notifier = deps.notifier ?? tryDesktopNotification;
    try {
      await notifier({
        title: "nas: attention needed",
        body: message ?? "Agent needs your input",
        uiUrl: DEFAULT_UI_URL,
      });
    } catch (err) {
      console.error(
        `[nas] hook notification: desktop notification failed: ${
          (err as Error).message
        }`,
      );
    }
  }
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
    obj["message"],
    readNestedMessage(obj["notification"]),
    readNestedMessage(obj["Notification"]),
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
  return (value as Record<string, unknown>)["message"];
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

