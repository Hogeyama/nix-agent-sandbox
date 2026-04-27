/**
 * Tests for `createSidecarsStore`.
 *
 * Pin the contract the SSE dispatch and the Sidecars settings page rely
 * on: an initial empty rows accessor, kind-based filtering on snapshot
 * application, last-write-wins on duplicate names, deterministic sort
 * order, and an empty snapshot fully clearing prior rows.
 */

import { describe, expect, test } from "bun:test";
import { createSidecarsStore } from "./sidecarsStore";
import type { ContainerInfoLike } from "./types";

function makeContainer(
  overrides: Partial<ContainerInfoLike> = {},
): ContainerInfoLike {
  return {
    name: "default",
    running: true,
    labels: { "nas.kind": "dind" },
    ...overrides,
  };
}

describe("createSidecarsStore", () => {
  test("rows() is empty on a fresh store", () => {
    const store = createSidecarsStore();
    expect(store.rows()).toEqual([]);
  });

  test("setSidecars filters out non-sidecar kinds (agent dropped)", () => {
    const store = createSidecarsStore();
    store.setSidecars([
      makeContainer({ name: "agent-1", labels: { "nas.kind": "agent" } }),
      makeContainer({ name: "dind-1", labels: { "nas.kind": "dind" } }),
    ]);
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.name).toBe("dind-1");
  });

  test("setSidecars updates the value for an existing name (last write wins)", () => {
    const store = createSidecarsStore();
    store.setSidecars([
      makeContainer({
        name: "dind-1",
        running: true,
        labels: { "nas.kind": "dind" },
      }),
    ]);
    expect(store.rows()[0]?.running).toBe(true);
    store.setSidecars([
      makeContainer({
        name: "dind-1",
        running: false,
        labels: { "nas.kind": "dind" },
      }),
    ]);
    expect(store.rows()).toHaveLength(1);
    expect(store.rows()[0]?.running).toBe(false);
  });

  test("setSidecars with an empty snapshot clears prior rows", () => {
    const store = createSidecarsStore();
    store.setSidecars([
      makeContainer({ name: "dind-1", labels: { "nas.kind": "dind" } }),
    ]);
    expect(store.rows()).toHaveLength(1);
    store.setSidecars([]);
    expect(store.rows()).toEqual([]);
  });

  test("setSidecars returns rows sorted by kind then name", () => {
    const store = createSidecarsStore();
    store.setSidecars([
      makeContainer({ name: "proxy-main", labels: { "nas.kind": "proxy" } }),
      makeContainer({ name: "dind-server", labels: { "nas.kind": "dind" } }),
      makeContainer({ name: "envoy-main", labels: { "nas.kind": "envoy" } }),
      makeContainer({ name: "dind-client", labels: { "nas.kind": "dind" } }),
    ]);
    expect(store.rows().map((r) => r.name)).toEqual([
      "dind-client",
      "dind-server",
      "envoy-main",
      "proxy-main",
    ]);
  });

  test("setSidecars carries the running flag and startedAt through", () => {
    const store = createSidecarsStore();
    store.setSidecars([
      makeContainer({
        name: "dind-1",
        running: false,
        startedAt: "2026-04-27T09:00:00.000Z",
        labels: { "nas.kind": "dind" },
      }),
    ]);
    const row = store.rows()[0];
    expect(row?.running).toBe(false);
    expect(row?.startedAt).toBe("2026-04-27T09:00:00.000Z");
  });
});
