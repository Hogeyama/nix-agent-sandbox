/**
 * Tests for `createPendingActionHandlers`.
 *
 * The handler factory is the canonical pin for two contracts:
 *   - Network deny forwards the currently selected scope (with a
 *     `host-port` default), hostexec deny does not pass scope at all.
 *   - Approve/Deny round-trips wrap the client call in
 *     `pending.beginAction(key)` / `pending.endAction(key, error?)` so
 *     the per-card busy flag and error message stay in sync with the
 *     in-flight HTTP call.
 *
 * DOM bindings (button onClick → handler) are verified by `bun run
 * check`; this file does not simulate clicks.
 */

import { describe, expect, mock, test } from "bun:test";
import type { PendingActionStore } from "../stores/pendingActionStore";
import { createPendingActionStore } from "../stores/pendingActionStore";
import { pendingRequestKey } from "../stores/pendingRequestKey";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
  PendingStore,
} from "../stores/pendingStore";
import { createPendingStore } from "../stores/pendingStore";
import {
  createPendingActionHandlers,
  DEFAULT_NETWORK_SCOPE,
  type PendingActionClient,
} from "./createPendingActionHandlers";

function makeNetworkRow(
  overrides: Partial<NetworkPendingRow> = {},
): NetworkPendingRow {
  const sessionId = overrides.sessionId ?? "sess-1";
  const id = overrides.id ?? "req-1";
  return {
    key: pendingRequestKey("network", sessionId, id),
    id,
    sessionId,
    sessionShortId: "s_1",
    sessionName: null,
    verb: "GET",
    summary: "example.com:443",
    createdAtMs: 0,
    ...overrides,
  };
}

function makeHostExecRow(
  overrides: Partial<HostExecPendingRow> = {},
): HostExecPendingRow {
  const sessionId = overrides.sessionId ?? "sess-1";
  const id = overrides.id ?? "exec-1";
  return {
    key: pendingRequestKey("hostexec", sessionId, id),
    id,
    sessionId,
    sessionShortId: "s_1",
    sessionName: null,
    command: "git push",
    createdAtMs: 0,
    ...overrides,
  };
}

function makeFakePendingAction(): PendingActionStore & {
  beginAction: ReturnType<typeof mock>;
  endAction: ReturnType<typeof mock>;
  setScope: ReturnType<typeof mock>;
  reconcile: ReturnType<typeof mock>;
} {
  return {
    scopeFor: mock(() => undefined),
    busyFor: mock(() => false),
    errorFor: mock(() => null),
    setScope: mock(() => {}),
    beginAction: mock(() => {}),
    endAction: mock(() => {}),
    reconcile: mock(() => {}),
  } as PendingActionStore & {
    beginAction: ReturnType<typeof mock>;
    endAction: ReturnType<typeof mock>;
    setScope: ReturnType<typeof mock>;
    reconcile: ReturnType<typeof mock>;
  };
}

function makeFakePending(): PendingStore & {
  removeNetwork: ReturnType<typeof mock>;
  removeHostExec: ReturnType<typeof mock>;
} {
  return {
    network: () => [],
    hostexec: () => [],
    setNetwork: mock(() => {}),
    setHostExec: mock(() => {}),
    removeNetwork: mock(() => {}),
    removeHostExec: mock(() => {}),
  } as PendingStore & {
    removeNetwork: ReturnType<typeof mock>;
    removeHostExec: ReturnType<typeof mock>;
  };
}

function makeFakeClient(
  overrides: Partial<PendingActionClient> = {},
): PendingActionClient & {
  approveNetwork: ReturnType<typeof mock>;
  denyNetwork: ReturnType<typeof mock>;
  approveHostExec: ReturnType<typeof mock>;
  denyHostExec: ReturnType<typeof mock>;
} {
  return {
    approveNetwork: mock(async () => ({ ok: true })),
    denyNetwork: mock(async () => ({ ok: true })),
    approveHostExec: mock(async () => ({ ok: true })),
    denyHostExec: mock(async () => ({ ok: true })),
    ...overrides,
  } as PendingActionClient & {
    approveNetwork: ReturnType<typeof mock>;
    denyNetwork: ReturnType<typeof mock>;
    approveHostExec: ReturnType<typeof mock>;
    denyHostExec: ReturnType<typeof mock>;
  };
}

describe("createPendingActionHandlers — onApprove", () => {
  test("network row calls client.approveNetwork with (sessionId, requestId, scope)", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow({ sessionId: "sess-1", id: "req-1" });
    await handlers.onApprove(row, "host");

    expect(client.approveNetwork).toHaveBeenCalledTimes(1);
    expect(client.approveNetwork).toHaveBeenCalledWith(
      "sess-1",
      "req-1",
      "host",
    );
    expect(client.approveHostExec).not.toHaveBeenCalled();
  });

  test("hostexec row calls client.approveHostExec with (sessionId, requestId, scope)", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeHostExecRow({ sessionId: "sess-1", id: "exec-1" });
    await handlers.onApprove(row, "capability");

    expect(client.approveHostExec).toHaveBeenCalledTimes(1);
    expect(client.approveHostExec).toHaveBeenCalledWith(
      "sess-1",
      "exec-1",
      "capability",
    );
    expect(client.approveNetwork).not.toHaveBeenCalled();
  });
});

describe("createPendingActionHandlers — onDeny", () => {
  test("network row forwards the currently selected scope", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow({ sessionId: "sess-1", id: "req-1" });
    pendingAction.setScope(row.key, "host");
    await handlers.onDeny(row);

    expect(client.denyNetwork).toHaveBeenCalledTimes(1);
    expect(client.denyNetwork).toHaveBeenCalledWith("sess-1", "req-1", "host");
  });

  test("network row defaults to host-port when no scope has been chosen", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow({ sessionId: "sess-1", id: "req-1" });
    await handlers.onDeny(row);

    expect(client.denyNetwork).toHaveBeenCalledTimes(1);
    expect(client.denyNetwork).toHaveBeenCalledWith(
      "sess-1",
      "req-1",
      DEFAULT_NETWORK_SCOPE,
    );
    expect(DEFAULT_NETWORK_SCOPE).toBe("host-port");
  });

  test("hostexec row calls client.denyHostExec with exactly two arguments", async () => {
    // The hostexec deny endpoint does not destructure scope from its
    // body. Pin both that we hit the right client function and that
    // we do not pass a third argument by accident.
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeHostExecRow({ sessionId: "sess-1", id: "exec-1" });
    pendingAction.setScope(row.key, "capability");
    await handlers.onDeny(row);

    expect(client.denyHostExec).toHaveBeenCalledTimes(1);
    expect(client.denyHostExec).toHaveBeenCalledWith("sess-1", "exec-1");
    const call = client.denyHostExec.mock.calls[0] as unknown[];
    expect(call.length).toBe(2);
    expect(client.denyNetwork).not.toHaveBeenCalled();
  });
});

describe("createPendingActionHandlers — busy / error wiring", () => {
  test("on resolution, busy clears and no error is recorded", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow();
    await handlers.onApprove(row, "host-port");

    expect(pendingAction.busyFor(row.key)).toBe(false);
    expect(pendingAction.errorFor(row.key)).toBeNull();
  });

  test("on rejection, busy clears and error message is recorded", async () => {
    const client = makeFakeClient({
      denyNetwork: mock(async () => {
        throw new Error("network down");
      }),
    });
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow();
    await handlers.onDeny(row);

    expect(pendingAction.busyFor(row.key)).toBe(false);
    expect(pendingAction.errorFor(row.key)).toBe("network down");
  });

  test("a successful retry after an error clears the prior error message", async () => {
    let calls = 0;
    const client = makeFakeClient({
      approveNetwork: mock(async () => {
        calls += 1;
        if (calls === 1) throw new Error("first failure");
        return { ok: true };
      }),
    });
    const pendingAction = createPendingActionStore();
    const pending = createPendingStore();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow();
    await handlers.onApprove(row, "host-port");
    expect(pendingAction.errorFor(row.key)).toBe("first failure");

    await handlers.onApprove(row, "host-port");
    expect(pendingAction.busyFor(row.key)).toBe(false);
    expect(pendingAction.errorFor(row.key)).toBeNull();
  });
});

describe("createPendingActionHandlers — optimistic row removal", () => {
  // The handler pulls the row out of `pending` once the API resolves so
  // the UI does not have to wait for the next ~2s SSE poll to realise
  // the request was approved/denied. On rejection the row stays so the
  // user can retry; the failure path is covered by the busy/error suite
  // above and the `removeNetwork`/`removeHostExec` no-call assertions
  // here.

  test("network onApprove removes the row from PendingStore on success", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = makeFakePending();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow({ sessionId: "sess-1", id: "req-1" });
    await handlers.onApprove(row, "host-port");

    expect(pending.removeNetwork).toHaveBeenCalledTimes(1);
    expect(pending.removeNetwork).toHaveBeenCalledWith("req-1");
    expect(pending.removeHostExec).not.toHaveBeenCalled();
  });

  test("hostexec onDeny removes the row from PendingStore on success", async () => {
    const client = makeFakeClient();
    const pendingAction = createPendingActionStore();
    const pending = makeFakePending();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeHostExecRow({ sessionId: "sess-1", id: "exec-1" });
    await handlers.onDeny(row);

    expect(pending.removeHostExec).toHaveBeenCalledTimes(1);
    expect(pending.removeHostExec).toHaveBeenCalledWith("exec-1");
    expect(pending.removeNetwork).not.toHaveBeenCalled();
  });

  test("on API rejection the row is left in PendingStore so the user can retry", async () => {
    const client = makeFakeClient({
      approveNetwork: mock(async () => {
        throw new Error("boom");
      }),
    });
    const pendingAction = createPendingActionStore();
    const pending = makeFakePending();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row = makeNetworkRow();
    await handlers.onApprove(row, "host-port");

    expect(pending.removeNetwork).not.toHaveBeenCalled();
    expect(pending.removeHostExec).not.toHaveBeenCalled();
  });
});

describe("createPendingActionHandlers — bad key prefix", () => {
  // `domainOf` throws synchronously when `row.key` does not start with a
  // recognized domain prefix. The factory's contract is that this throw
  // surfaces immediately rather than silently routing to the wrong
  // endpoint, so neither the client nor `pending.beginAction` should be
  // touched on the way out. These two tests pin that defensive contract
  // for the approve and deny paths.

  test("onApprove rejects with `unrecognized key prefix` and touches no side effects", async () => {
    const client = makeFakeClient();
    const pendingAction = makeFakePendingAction();
    const pending = makeFakePending();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row: NetworkPendingRow = {
      ...makeNetworkRow({ sessionId: "sess", id: "req" }),
      key: "unknown|sess|req",
    };

    // `domainOf` throws synchronously, but the declared signature is
    // `Promise<void>`. Wrap in an async IIFE so the throw becomes a
    // rejection regardless of whether the implementation is structured
    // as `async function` or as a sync return of a Promise expression.
    await expect(
      (async () => handlers.onApprove(row, "host-port"))(),
    ).rejects.toThrow(/unrecognized key prefix/);

    expect(client.approveNetwork).not.toHaveBeenCalled();
    expect(client.approveHostExec).not.toHaveBeenCalled();
    expect(client.denyNetwork).not.toHaveBeenCalled();
    expect(client.denyHostExec).not.toHaveBeenCalled();
    expect(pendingAction.beginAction).not.toHaveBeenCalled();
    expect(pending.removeNetwork).not.toHaveBeenCalled();
    expect(pending.removeHostExec).not.toHaveBeenCalled();
  });

  test("onDeny rejects with `unrecognized key prefix` and touches no side effects", async () => {
    const client = makeFakeClient();
    const pendingAction = makeFakePendingAction();
    const pending = makeFakePending();
    const handlers = createPendingActionHandlers({
      client,
      pending,
      pendingAction,
    });

    const row: NetworkPendingRow = {
      ...makeNetworkRow({ sessionId: "sess", id: "req" }),
      key: "unknown|sess|req",
    };

    await expect((async () => handlers.onDeny(row))()).rejects.toThrow(
      /unrecognized key prefix/,
    );

    expect(client.approveNetwork).not.toHaveBeenCalled();
    expect(client.approveHostExec).not.toHaveBeenCalled();
    expect(client.denyNetwork).not.toHaveBeenCalled();
    expect(client.denyHostExec).not.toHaveBeenCalled();
    expect(pendingAction.beginAction).not.toHaveBeenCalled();
    expect(pending.removeNetwork).not.toHaveBeenCalled();
    expect(pending.removeHostExec).not.toHaveBeenCalled();
  });
});
