/**
 * Tests for `selectPendingTarget`.
 *
 * Pins the three-tier resolution rule (focused card → network[0] →
 * hostexec[0]) and the collapsed-pane no-op contract. Uses structural
 * doubles for `Element` so the tests run without a DOM.
 */

import { describe, expect, test } from "bun:test";
import { pendingRequestKey } from "../stores/pendingRequestKey";
import type {
  HostExecPendingRow,
  NetworkPendingRow,
} from "../stores/pendingStore";
import { selectPendingTarget } from "./selectedPendingKey";

function makeNetworkRow(
  sessionId: string,
  requestId: string,
): NetworkPendingRow {
  return {
    key: pendingRequestKey("network", sessionId, requestId),
    id: requestId,
    sessionId,
    sessionShortId: sessionId.slice(0, 4),
    sessionName: null,
    verb: "GET",
    summary: "example.com:443",
    createdAtMs: 1000,
  };
}

function makeHostExecRow(
  sessionId: string,
  requestId: string,
): HostExecPendingRow {
  return {
    key: pendingRequestKey("hostexec", sessionId, requestId),
    id: requestId,
    sessionId,
    sessionShortId: sessionId.slice(0, 4),
    sessionName: null,
    command: "ls -la",
    createdAtMs: 1000,
  };
}

function makeEl(opts: { closestKey: string | null }): Element {
  return {
    closest: (_selector: string) =>
      opts.closestKey !== null
        ? ({
            getAttribute: (name: string) =>
              name === "data-pending-key" ? opts.closestKey : null,
          } as unknown as Element)
        : null,
  } as unknown as Element;
}

describe("selectPendingTarget", () => {
  test("returns the network row matching the focused card's data-pending-key", () => {
    const a = makeNetworkRow("s1", "r1");
    const b = makeNetworkRow("s1", "r2");
    const result = selectPendingTarget({
      activeElement: makeEl({ closestKey: b.key }),
      network: [a, b],
      hostexec: [],
      collapsed: false,
    });
    expect(result).toEqual({ kind: "network", row: b });
  });

  test("returns the hostexec row matching the focused card's data-pending-key", () => {
    const net = makeNetworkRow("s1", "r1");
    const h = makeHostExecRow("s2", "r9");
    const result = selectPendingTarget({
      activeElement: makeEl({ closestKey: h.key }),
      network: [net],
      hostexec: [h],
      collapsed: false,
    });
    expect(result).toEqual({ kind: "hostexec", row: h });
  });

  test("falls back to network[0] when focus is outside any pending card", () => {
    const head = makeNetworkRow("s1", "r1");
    const tail = makeNetworkRow("s1", "r2");
    const result = selectPendingTarget({
      activeElement: makeEl({ closestKey: null }),
      network: [head, tail],
      hostexec: [makeHostExecRow("s2", "r9")],
      collapsed: false,
    });
    expect(result).toEqual({ kind: "network", row: head });
  });

  test("falls back to hostexec[0] when focus is outside and network is empty", () => {
    const head = makeHostExecRow("s2", "r9");
    const tail = makeHostExecRow("s2", "r10");
    const result = selectPendingTarget({
      activeElement: makeEl({ closestKey: null }),
      network: [],
      hostexec: [head, tail],
      collapsed: false,
    });
    expect(result).toEqual({ kind: "hostexec", row: head });
  });

  test("returns null when both queues are empty", () => {
    const result = selectPendingTarget({
      activeElement: makeEl({ closestKey: null }),
      network: [],
      hostexec: [],
      collapsed: false,
    });
    expect(result).toBeNull();
  });

  test("falls back to network[0] when the focused key is stale (matches no row)", () => {
    const head = makeNetworkRow("s1", "r1");
    const result = selectPendingTarget({
      activeElement: makeEl({
        closestKey: pendingRequestKey("network", "s9", "gone"),
      }),
      network: [head],
      hostexec: [makeHostExecRow("s2", "r9")],
      collapsed: false,
    });
    expect(result).toEqual({ kind: "network", row: head });
  });

  test("returns null when collapsed, regardless of focus or queue contents", () => {
    const focused = makeNetworkRow("s1", "r1");
    const result = selectPendingTarget({
      activeElement: makeEl({ closestKey: focused.key }),
      network: [focused, makeNetworkRow("s1", "r2")],
      hostexec: [makeHostExecRow("s2", "r9")],
      collapsed: true,
    });
    expect(result).toBeNull();
  });

  test("returns null when activeElement is null and both queues are empty", () => {
    const result = selectPendingTarget({
      activeElement: null,
      network: [],
      hostexec: [],
      collapsed: false,
    });
    expect(result).toBeNull();
  });

  test("falls back to network[0] when activeElement is null", () => {
    const head = makeNetworkRow("s1", "r1");
    const result = selectPendingTarget({
      activeElement: null,
      network: [head],
      hostexec: [],
      collapsed: false,
    });
    expect(result).toEqual({ kind: "network", row: head });
  });
});
