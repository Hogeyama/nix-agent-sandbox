/**
 * Light JSX tests for `PendingPane`.
 *
 * The pane is a thin presentation layer over the pending-action store;
 * the reduction semantics live in `reconcilePendingActionState_test.ts`
 * and the action plumbing lives in
 * `createPendingActionHandlers_test.ts`. This file only pins that
 * scope chips read `scopeFor(key)` and that the action buttons disable
 * while `busyFor(key)` is true.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AuditLogEntryRow } from "../stores/auditStore";
import { pendingRequestKey } from "../stores/pendingRequestKey";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";
import { PendingPane } from "./PendingPane";

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

type ScopeButton = {
  type: string;
  props: {
    class: string;
    classList: { selected: boolean };
    disabled: boolean;
    onClick: () => void;
    children: string;
  };
};

type ActionButton = {
  type: string;
  props: {
    class: string;
    disabled: boolean;
    onClick: () => unknown;
    children: string;
  };
};

type CardRoot = {
  type: string;
  props: {
    class: string;
    children: unknown[];
  };
};

type ContentTree = {
  props: {
    children: unknown[];
  };
};

/**
 * Walk the tree from `PendingPane(props)` down to the `<div class=
 * "content">` produced inside the `<Show>` body. The `<Show>` element
 * here has two static JSX siblings as its body (`<div class="pane-
 * header">` and `<div class="content">`), so the JSX runtime emits
 * `props.children` as an Array of the two child elements rather than
 * a function. The content div is at index 1.
 */
function contentOf(tree: unknown): ContentTree {
  const aside = tree as {
    props: {
      children: { props: { children: [unknown, ContentTree] } };
    };
  };
  return aside.props.children.props.children[1];
}

/**
 * Pull the card factory function out of a `For` block. The pane uses
 * two `For` blocks (network and hostexec) inside the content div; the
 * caller picks which one by index (0 = network, 1 = hostexec; the
 * section labels in between are non-`For` siblings, hence the offsets
 * below).
 */
function forBlocks(content: ContentTree): {
  network: (row: NetworkPendingRow) => CardRoot;
  hostexec: (row: HostExecPendingRow) => CardRoot;
} {
  const children = content.props.children as unknown[];
  // children layout: [section-label, For(network), section-label, For(hostexec)]
  const networkFor = children[1] as {
    props: { children: (row: NetworkPendingRow) => CardRoot };
  };
  const hostexecFor = children[3] as {
    props: { children: (row: HostExecPendingRow) => CardRoot };
  };
  return {
    network: networkFor.props.children,
    hostexec: hostexecFor.props.children,
  };
}

function makeProps(opts: {
  network?: NetworkPendingRow[];
  hostexec?: HostExecPendingRow[];
  scopeFor?: (key: string) => string | undefined;
  busyFor?: (key: string) => boolean;
  errorFor?: (key: string) => string | null;
  auditEntries?: AuditLogEntryRow[];
}) {
  const onApprove = mock(async () => undefined);
  const onDeny = mock(async () => undefined);
  const setScope = mock(() => undefined);
  return {
    props: {
      network: () => opts.network ?? [],
      hostexec: () => opts.hostexec ?? [],
      collapsed: () => false,
      onToggleCollapse: () => undefined,
      scopeFor: opts.scopeFor ?? (() => undefined),
      busyFor: opts.busyFor ?? (() => false),
      errorFor: opts.errorFor ?? (() => null),
      setScope,
      onApprove,
      onDeny,
      auditEntries: () => opts.auditEntries ?? [],
    },
    onApprove,
    onDeny,
    setScope,
  };
}

describe("PendingPane scope chip rendering", () => {
  test("network card reflects scopeFor(key) on the selected chip", () => {
    const row = makeNetworkRow();
    const { props } = makeProps({
      network: [row],
      scopeFor: (k) => (k === row.key ? "host" : undefined),
    });
    const tree = PendingPane(props) as unknown;
    const content = contentOf(tree);
    const blocks = forBlocks(content);
    const card = blocks.network(row);

    // scope-row is index 2; its `For` `children` is a function.
    const scopeRow = (card.props.children as unknown[])[2] as {
      props: {
        children: { props: { children: (opt: string) => ScopeButton } };
      };
    };
    const make = scopeRow.props.children.props.children;
    const onceBtn = make("once");
    const hostPortBtn = make("host-port");
    const hostBtn = make("host");

    expect(onceBtn.props.classList.selected).toBe(false);
    expect(hostPortBtn.props.classList.selected).toBe(false);
    expect(hostBtn.props.classList.selected).toBe(true);
  });

  test("network card defaults to host-port when scopeFor returns undefined", () => {
    // Default-scope policy is owned by the pane's view-side resolver
    // (not the reducer). Pin that the chip selection still reflects
    // the default when no user choice exists.
    const row = makeNetworkRow();
    const { props } = makeProps({ network: [row] });
    const tree = PendingPane(props) as unknown;
    const content = contentOf(tree);
    const blocks = forBlocks(content);
    const card = blocks.network(row);
    const scopeRow = (card.props.children as unknown[])[2] as {
      props: {
        children: { props: { children: (opt: string) => ScopeButton } };
      };
    };
    const make = scopeRow.props.children.props.children;
    expect(make("host-port").props.classList.selected).toBe(true);
    expect(make("once").props.classList.selected).toBe(false);
  });

  test("hostexec card defaults to capability when scopeFor returns undefined", () => {
    const row = makeHostExecRow();
    const { props } = makeProps({ hostexec: [row] });
    const tree = PendingPane(props) as unknown;
    const content = contentOf(tree);
    const blocks = forBlocks(content);
    const card = blocks.hostexec(row);
    const scopeRow = (card.props.children as unknown[])[2] as {
      props: {
        children: { props: { children: (opt: string) => ScopeButton } };
      };
    };
    const make = scopeRow.props.children.props.children;
    expect(make("capability").props.classList.selected).toBe(true);
    expect(make("once").props.classList.selected).toBe(false);
  });
});

describe("PendingPane audit accordion", () => {
  function auditDetailsOf(tree: unknown): {
    type: string;
    props: { class: string; children: unknown[] };
  } {
    const content = contentOf(tree);
    const children = content.props.children as unknown[];
    // children layout after the audit accordion was added:
    //   [section-label, For(network), section-label, For(hostexec), details]
    return children[4] as {
      type: string;
      props: { class: string; children: unknown[] };
    };
  }

  test("renders a <details> element so it is closed by default", () => {
    // Native <details> defaults to closed; PendingPane does not set the
    // `open` attribute, so use of <details> is the closed-by-default
    // contract. We pin the element type and the absence of `open`.
    const { props } = makeProps({});
    const tree = PendingPane(props) as unknown;
    const details = auditDetailsOf(tree);
    expect(details.type).toBe("details");
    expect((details.props as Record<string, unknown>).open).toBeUndefined();
  });

  test("falls back to an empty-state line when there are no entries", () => {
    const { props } = makeProps({ auditEntries: [] });
    const tree = PendingPane(props) as unknown;
    const details = auditDetailsOf(tree);
    // children: [summary, For(...)]
    const forBlock = details.props.children[1] as {
      props: {
        fallback: { props: { class: string; children: string } };
      };
    };
    expect(forBlock.props.fallback.props.class).toBe("audit-empty");
    expect(forBlock.props.fallback.props.children).toBe("no audit entries");
  });

  test("renders one row per audit entry via the For factory", () => {
    const entries: AuditLogEntryRow[] = [
      {
        id: "a1",
        timestamp: "2026-04-20T10:00:00.000Z",
        domain: "network",
        sessionId: "s1",
        requestId: "r1",
        decision: "allow",
        reason: "ok",
        scope: null,
        target: "example.com:443",
        command: null,
      },
    ];
    const { props } = makeProps({ auditEntries: entries });
    const tree = PendingPane(props) as unknown;
    const details = auditDetailsOf(tree);
    const forBlock = details.props.children[1] as {
      props: {
        each: AuditLogEntryRow[];
        children: (row: AuditLogEntryRow) => {
          props: { class: string; children: unknown[] };
        };
      };
    };
    expect(forBlock.props.each).toEqual(entries);
    const row = forBlock.props.children(entries[0] as AuditLogEntryRow);
    expect(row.props.class).toBe("audit-row");
  });
});

describe("PendingPane busy state", () => {
  test("network action buttons disable when busyFor(key) is true", () => {
    const row = makeNetworkRow();
    const { props } = makeProps({
      network: [row],
      busyFor: () => true,
    });
    const tree = PendingPane(props) as unknown;
    const content = contentOf(tree);
    const card = forBlocks(content).network(row);
    // action-row is index 3 under the article children.
    const actionRow = (card.props.children as unknown[])[3] as {
      props: { children: ActionButton[] };
    };
    const [allow, deny] = actionRow.props.children;
    expect(allow?.props.disabled).toBe(true);
    expect(deny?.props.disabled).toBe(true);
  });

  test("hostexec action buttons enable when busyFor(key) is false", () => {
    const row = makeHostExecRow();
    const { props } = makeProps({
      hostexec: [row],
      busyFor: () => false,
    });
    const tree = PendingPane(props) as unknown;
    const content = contentOf(tree);
    const card = forBlocks(content).hostexec(row);
    const actionRow = (card.props.children as unknown[])[3] as {
      props: { children: ActionButton[] };
    };
    const [approve, deny] = actionRow.props.children;
    expect(approve?.props.disabled).toBe(false);
    expect(deny?.props.disabled).toBe(false);
  });
});
