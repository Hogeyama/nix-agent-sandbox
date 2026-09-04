import type { EnsureRelayResult } from "./port_bind_relay.ts";

const MIN_EXEC_INTERVAL_MS = 2_000;
const COOL_OFF_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const CONTROL_WAIT_MS = 5_000;

export interface RelaySupervisor {
  ensure(): Promise<EnsureRelayResult>;
}

export interface RelaySupervisorOptions {
  exec: (cmd: string[]) => Promise<{ code: number; stderr: string }>;
  command: string[];
  isRelayConnected: () => boolean;
  waitForControl: (timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Decides whether to start the container-side relay, and how hard to keep
 * trying. A relay that connected and later died is an ordinary event, so only
 * a failed exec or a missing control connection spends the failure budget.
 */
export function makeRelaySupervisor(
  opts: RelaySupervisorOptions,
): RelaySupervisor {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  let inFlight: Promise<EnsureRelayResult> | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let consecutiveFailures = 0;
  let coolOffUntil = Number.NEGATIVE_INFINITY;

  const noteFailure = (): EnsureRelayResult => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      coolOffUntil = now() + COOL_OFF_MS;
      consecutiveFailures = 0;
    }
    return "unreachable";
  };

  const attempt = async (): Promise<EnsureRelayResult> => {
    if (opts.isRelayConnected()) {
      consecutiveFailures = 0;
      return "ready";
    }
    if (now() < coolOffUntil) return "unreachable";

    const sinceLast = now() - lastAttemptAt;
    if (sinceLast < MIN_EXEC_INTERVAL_MS) {
      await sleep(MIN_EXEC_INTERVAL_MS - sinceLast);
    }
    lastAttemptAt = now();

    const result = await opts.exec(opts.command);
    if (result.code !== 0) {
      if (isStoppedContainer(result.stderr)) return "container-not-running";
      return noteFailure();
    }
    if (opts.isRelayConnected()) {
      consecutiveFailures = 0;
      return "ready";
    }
    if (await opts.waitForControl(CONTROL_WAIT_MS)) {
      consecutiveFailures = 0;
      return "ready";
    }
    return noteFailure();
  };

  return {
    ensure: () => {
      if (inFlight) return inFlight;
      inFlight = attempt().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/** A stopped container is an expected state and does not spend the budget. */
function isStoppedContainer(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("no such container") || text.includes("is not running");
}
