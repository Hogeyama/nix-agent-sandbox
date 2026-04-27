/**
 * forward_port_relay
 *
 * Per-port UDS listener that pipes connections to a host-side TCP service on
 * `127.0.0.1:<port>`. Used to expose ports declared by a session through a
 * filesystem-bound socket so they can be bind-mounted into containers without
 * binding the host on `0.0.0.0`.
 *
 * This module is intentionally I/O focused and free of stage / Effect wiring;
 * orchestration (when relays start, how container plans mount them) lives in
 * the caller.
 */

import { chmod, rm } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import * as path from "node:path";
import { ensureDir, safeRemove } from "../lib/fs_utils.ts";
import { logInfo } from "../log.ts";

export interface ForwardPortRelayHandle {
  close(): Promise<void>;
}

export interface SessionForwardPortRelays {
  socketPaths: ReadonlyMap<number, string>;
  close(): Promise<void>;
}

/**
 * Pure helper. Returns the canonical UDS path for a given session/port combo
 * under the supplied runtime dir. Performs no I/O.
 */
export function forwardPortSocketPath(
  runtimeDir: string,
  sessionId: string,
  port: number,
): string {
  return path.join(runtimeDir, "forward-ports", sessionId, `${port}.sock`);
}

/**
 * Start a single UDS listener at `socketPath` that pipes each accepted
 * connection to `127.0.0.1:hostPort`.
 *
 * - Removes any stale file at `socketPath` before listening.
 * - chmods the socket to 0o666 (matches auth-router's approach of letting
 *   non-root container processes connect).
 * - Tracks all in-flight pairs so `close()` can tear them down deterministically.
 * - `close()` is idempotent.
 */
export async function startForwardPortRelay(opts: {
  socketPath: string;
  hostPort: number;
}): Promise<ForwardPortRelayHandle> {
  const { socketPath, hostPort } = opts;

  await safeRemove(socketPath);

  const pairs = new Set<{ uds: Socket; tcp: Socket }>();

  // `allowHalfOpen: false` keeps UDS<->TCP teardown symmetric: when one side
  // ends we want the other side to fully close rather than linger half-open.
  const server: Server = createServer({ allowHalfOpen: false }, (uds) => {
    const tcp = createConnection({ host: "127.0.0.1", port: hostPort });
    const pair = { uds, tcp };
    pairs.add(pair);

    const destroyBoth = () => {
      try {
        uds.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        tcp.destroy();
      } catch {
        /* already destroyed */
      }
      pairs.delete(pair);
    };

    // 'error' is for visibility/diagnostics only — Node guarantees a 'close'
    // will follow, so we let the close handler own teardown. This avoids
    // double-running destroyBoth and keeps roles legible.
    uds.on("error", (err) => {
      logInfo(
        `[nas] forward-port relay: UDS socket error on ${socketPath}: ${err}`,
      );
    });
    tcp.on("error", (err) => {
      logInfo(
        `[nas] forward-port relay: TCP connect to 127.0.0.1:${hostPort} failed: ${err}`,
      );
    });

    // Whichever side closes first triggers symmetric teardown of the other.
    uds.once("close", destroyBoth);
    tcp.once("close", destroyBoth);

    uds.pipe(tcp);
    tcp.pipe(uds);
  });

  // Persistent server-level error handler. This must outlive the listen()
  // promise: after listening, the server can still emit 'error' (e.g. EMFILE
  // on accept) and Node will crash the process on an unhandled 'error'.
  // We log and let the runtime continue; existing pairs continue or get torn
  // down via their own handlers.
  const onServerError = (err: Error) => {
    logInfo(`[nas] forward-port relay: server error on ${socketPath}: ${err}`);
  };
  server.on("error", onServerError);

  await new Promise<void>((resolve, reject) => {
    // Listen-time errors must reject the bootstrap promise. We use 'once' so
    // this listener is consumed after the first error and the persistent
    // onServerError handler above is the one that survives long-term.
    const onListenError = (err: Error) => {
      reject(err);
    };
    server.once("error", onListenError);
    server.listen(socketPath, () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  // Permit non-root processes inside the agent container to connect.
  // chmod can fail (EPERM/EACCES/ENOSPC/etc.) AFTER listen() has succeeded; if
  // we let the error propagate naively the server stays bound and the socket
  // file lingers, so the caller (which only tracks handles it received) leaks
  // both. Tear down the listener and remove the socket file before re-raising.
  try {
    await chmod(socketPath, 0o666);
  } catch (chmodErr) {
    await new Promise<void>((resolve) => {
      server.close((closeErr) => {
        if (
          closeErr &&
          (closeErr as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
        ) {
          // Log but don't surface — the chmod error is the real cause and must
          // not be masked by best-effort cleanup failures.
          logInfo(
            `[nas] forward-port relay: server.close after chmod failure on ${socketPath}: ${closeErr}`,
          );
        }
        resolve();
      });
    });
    try {
      await safeRemove(socketPath);
    } catch (removeErr) {
      logInfo(
        `[nas] forward-port relay: safeRemove after chmod failure on ${socketPath}: ${removeErr}`,
      );
    }
    throw chmodErr;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    // 1. Stop accepting new connections. Idempotent: a second close() (e.g.
    // from session-level cleanup after the server already shut itself down)
    // surfaces ERR_SERVER_NOT_RUNNING which we intentionally swallow. All
    // other errors propagate.
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (!err) {
          resolve();
          return;
        }
        if ((err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(err);
      });
    });

    // 2. Tear down any in-flight connections.
    for (const { uds, tcp } of pairs) {
      try {
        uds.destroy();
      } catch {
        /* already destroyed */
      }
      try {
        tcp.destroy();
      } catch {
        /* already destroyed */
      }
    }
    pairs.clear();

    // 3. Remove the socket file. Best effort — file may already be gone.
    await safeRemove(socketPath);
  };

  return { close };
}

/**
 * Start one relay per port for a session.
 *
 * - Resets `<runtimeDir>/forward-ports/<sessionId>/` (rm -rf + mkdir 0o700) so
 *   stale sockets from a previous incarnation don't linger.
 * - Validates that the supplied ports are unique (duplicates would otherwise
 *   collide on the same socket path during the second `listen()`).
 * - Fast path: with `ports.length === 0`, performs no I/O and returns an empty
 *   map plus a no-op close.
 * - On partial failure during startup, closes any relays that did start before
 *   re-throwing, to avoid leaking listeners.
 *
 * `_relayFactory` is a test-only seam: callers in production should leave it
 * unset so the real `startForwardPortRelay` is used. Tests inject a stub to
 * deterministically exercise the partial-failure rollback path without racing
 * filesystem obstacles. Underscore-prefixed to signal "do not use in prod".
 */
export async function startSessionForwardPortRelays(opts: {
  runtimeDir: string;
  sessionId: string;
  ports: ReadonlyArray<number>;
  /** @internal test-only — see jsdoc above. */
  _relayFactory?: typeof startForwardPortRelay;
}): Promise<SessionForwardPortRelays> {
  const { runtimeDir, sessionId, ports } = opts;
  const relayFactory = opts._relayFactory ?? startForwardPortRelay;

  if (ports.length === 0) {
    return {
      socketPaths: new Map<number, string>(),
      close: async () => {
        /* no-op */
      },
    };
  }

  const seen = new Set<number>();
  for (const p of ports) {
    if (seen.has(p)) {
      throw new Error(
        `startSessionForwardPortRelays: duplicate port ${p} in ports list`,
      );
    }
    seen.add(p);
  }

  const sessionDir = path.join(runtimeDir, "forward-ports", sessionId);

  // Reset on each start: stale sockets / stale subdirs from a prior crashed
  // session must not survive into the new one.
  await rm(sessionDir, { recursive: true, force: true });
  await ensureDir(sessionDir, 0o700);

  const handles: ForwardPortRelayHandle[] = [];
  const socketPaths = new Map<number, string>();

  try {
    for (const port of ports) {
      const socketPath = forwardPortSocketPath(runtimeDir, sessionId, port);
      const handle = await relayFactory({
        socketPath,
        hostPort: port,
      });
      handles.push(handle);
      socketPaths.set(port, socketPath);
    }
  } catch (error) {
    // Roll back any relays that did manage to start so we don't leak listeners
    // / stray socket files.
    await Promise.allSettled(handles.map((h) => h.close()));
    try {
      await rm(sessionDir, { recursive: true, force: true });
    } catch {
      /* best effort: cleanup must not mask the original error */
    }
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(handles.map((h) => h.close()));
    await rm(sessionDir, { recursive: true, force: true });
  };

  return { socketPaths, close };
}
