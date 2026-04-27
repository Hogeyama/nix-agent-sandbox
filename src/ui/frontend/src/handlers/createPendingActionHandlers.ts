/**
 * Factory for the Approve/Deny callbacks used by `PendingPane`.
 *
 * Both callbacks read the composite `key` off the row to decide which
 * REST endpoint to hit (network vs hostexec) and to address the
 * per-card busy / error state in the `pendingActionStore`. The branch
 * is derived purely from `row.key`'s domain prefix; no separate lookup
 * or domain field is required.
 *
 * The factory takes a `client` subset interface rather than the full
 * `api/client.ts` module so the unit tests can substitute spies without
 * depending on `globalThis.fetch`.
 */

import type { PendingActionStore } from "../stores/pendingActionStore";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";

/**
 * Default scopes per domain. Network defaults to `host-port`, matching
 * the Network pane convention; hostexec defaults to `capability`,
 * matching the HostExec pane convention. These are applied when the
 * user has not interacted with the scope chips before pressing
 * Allow/Approve or Deny.
 */
export const DEFAULT_NETWORK_SCOPE = "host-port";
export const DEFAULT_HOSTEXEC_SCOPE = "capability";

export interface PendingActionClient {
  approveNetwork(
    sessionId: string,
    requestId: string,
    scope?: string,
  ): Promise<unknown>;
  denyNetwork(
    sessionId: string,
    requestId: string,
    scope?: string,
  ): Promise<unknown>;
  approveHostExec(
    sessionId: string,
    requestId: string,
    scope?: string,
  ): Promise<unknown>;
  denyHostExec(sessionId: string, requestId: string): Promise<unknown>;
}

export interface PendingActionHandlers {
  onApprove(
    row: NetworkPendingRow | HostExecPendingRow,
    scope: string,
  ): Promise<void>;
  onDeny(row: NetworkPendingRow | HostExecPendingRow): Promise<void>;
}

export interface CreatePendingActionHandlersDeps {
  client: PendingActionClient;
  pending: PendingActionStore;
}

/**
 * Domain prefix of the composite key. `network|...` rows hit the
 * network endpoints; `hostexec|...` rows hit the hostexec endpoints.
 * Any other prefix means the caller violated the row contract; the
 * factory throws so the bug surfaces immediately rather than silently
 * routing to the wrong endpoint.
 */
function domainOf(key: string): "network" | "hostexec" {
  if (key.startsWith("network|")) return "network";
  if (key.startsWith("hostexec|")) return "hostexec";
  throw new Error(`pendingActionHandlers: unrecognized key prefix: ${key}`);
}

export function createPendingActionHandlers(
  deps: CreatePendingActionHandlersDeps,
): PendingActionHandlers {
  const { client, pending } = deps;

  async function runWithBusy(
    key: string,
    op: () => Promise<unknown>,
  ): Promise<void> {
    pending.beginAction(key);
    try {
      await op();
      pending.endAction(key);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      pending.endAction(key, message);
    }
  }

  return {
    onApprove(row, scope) {
      const domain = domainOf(row.key);
      if (domain === "network") {
        return runWithBusy(row.key, () =>
          client.approveNetwork(row.sessionId, row.id, scope),
        );
      }
      return runWithBusy(row.key, () =>
        client.approveHostExec(row.sessionId, row.id, scope),
      );
    },
    onDeny(row) {
      const domain = domainOf(row.key);
      if (domain === "network") {
        // The currently selected scope (or the network default when the
        // user has not interacted with the chips) is forwarded to the
        // backend, which validates it and widens / narrows the deny
        // rule accordingly.
        const scope = pending.scopeFor(row.key) ?? DEFAULT_NETWORK_SCOPE;
        return runWithBusy(row.key, () =>
          client.denyNetwork(row.sessionId, row.id, scope),
        );
      }
      // Hostexec deny intentionally omits scope: the backend route does
      // not destructure it (`src/ui/routes/api.ts` `/hostexec/deny`).
      return runWithBusy(row.key, () =>
        client.denyHostExec(row.sessionId, row.id),
      );
    },
  };
}
