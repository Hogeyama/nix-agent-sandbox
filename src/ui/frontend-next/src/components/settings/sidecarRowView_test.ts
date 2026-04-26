/**
 * Tests for the pure helpers in `sidecarRowView.ts`.
 *
 * These cover the three contracts the page component relies on:
 *
 *   - `isSidecarContainer` returns true exactly for the three sidecar
 *     `nas.kind` labels (`dind` / `proxy` / `envoy`) and false for any
 *     other label, including `"agent"` and missing labels.
 *   - `formatUptime` produces the short relative-duration format across
 *     each range boundary, and renders `"-"` for `null`, future deltas,
 *     and unparseable input.
 *   - `normalizeSidecars` filters by kind, sorts deterministically by
 *     `kind` then `name`, and resolves duplicate names by keeping the
 *     last entry from the input.
 */

import { describe, expect, test } from "bun:test";
import type { ContainerInfoLike } from "../../stores/types";
import {
  formatUptime,
  isSidecarContainer,
  normalizeSidecars,
  SIDECAR_KINDS,
} from "./sidecarRowView";

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

describe("SIDECAR_KINDS", () => {
  test("contains exactly dind, proxy, envoy in declaration order", () => {
    // Pin the public constant so a silent rename is caught by tests.
    expect(SIDECAR_KINDS).toEqual(["dind", "proxy", "envoy"]);
  });
});

describe("isSidecarContainer", () => {
  test("returns true for each sidecar kind", () => {
    for (const kind of SIDECAR_KINDS) {
      expect(
        isSidecarContainer(makeContainer({ labels: { "nas.kind": kind } })),
      ).toBe(true);
    }
  });

  test("returns false for the agent kind", () => {
    expect(
      isSidecarContainer(makeContainer({ labels: { "nas.kind": "agent" } })),
    ).toBe(false);
  });

  test("returns false for an unrelated label", () => {
    expect(
      isSidecarContainer(makeContainer({ labels: { "nas.kind": "other" } })),
    ).toBe(false);
  });

  test("returns false when the nas.kind label is missing", () => {
    expect(isSidecarContainer(makeContainer({ labels: {} }))).toBe(false);
  });
});

describe("formatUptime", () => {
  const t0 = Date.parse("2026-04-27T10:00:00.000Z");

  test("returns '-' for null startedAt", () => {
    expect(formatUptime(null, t0)).toBe("-");
  });

  test("returns '-' for unparseable input", () => {
    expect(formatUptime("not-a-date", t0)).toBe("-");
  });

  test("returns '-' for future timestamps (negative delta)", () => {
    const future = new Date(t0 + 5_000).toISOString();
    expect(formatUptime(future, t0)).toBe("-");
  });

  test("0s when delta is exactly zero", () => {
    const same = new Date(t0).toISOString();
    expect(formatUptime(same, t0)).toBe("0s");
  });

  test("seconds range: 30s", () => {
    const started = new Date(t0 - 30_000).toISOString();
    expect(formatUptime(started, t0)).toBe("30s");
  });

  test("seconds range: 59s (boundary - 1)", () => {
    const started = new Date(t0 - 59_000).toISOString();
    expect(formatUptime(started, t0)).toBe("59s");
  });

  test("minutes range: exactly 60s -> 1m", () => {
    const started = new Date(t0 - 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("1m");
  });

  test("minutes range: 3m", () => {
    const started = new Date(t0 - 3 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("3m");
  });

  test("minutes range: 59m (boundary - 1)", () => {
    const started = new Date(t0 - 59 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("59m");
  });

  test("hours range: exactly 60m -> 1h", () => {
    const started = new Date(t0 - 60 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("1h");
  });

  test("hours range: 2h", () => {
    const started = new Date(t0 - 2 * 60 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("2h");
  });

  test("hours range: 23h (boundary - 1)", () => {
    const started = new Date(t0 - 23 * 60 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("23h");
  });

  test("days range: exactly 24h -> 1d", () => {
    const started = new Date(t0 - 24 * 60 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("1d");
  });

  test("days range: large value", () => {
    const started = new Date(t0 - 7 * 24 * 60 * 60_000).toISOString();
    expect(formatUptime(started, t0)).toBe("7d");
  });
});

describe("normalizeSidecars", () => {
  test("filters out non-sidecar containers (agent label dropped)", () => {
    const rows = normalizeSidecars([
      makeContainer({ name: "agent-1", labels: { "nas.kind": "agent" } }),
      makeContainer({ name: "dind-1", labels: { "nas.kind": "dind" } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("dind-1");
  });

  test("returns rows sorted by kind then name", () => {
    // Input deliberately scrambled; output must follow kind asc, name asc.
    const rows = normalizeSidecars([
      makeContainer({ name: "proxy-main", labels: { "nas.kind": "proxy" } }),
      makeContainer({ name: "dind-server", labels: { "nas.kind": "dind" } }),
      makeContainer({ name: "envoy-main", labels: { "nas.kind": "envoy" } }),
      makeContainer({ name: "dind-client", labels: { "nas.kind": "dind" } }),
    ]);
    expect(rows.map((r) => r.name)).toEqual([
      "dind-client",
      "dind-server",
      "envoy-main",
      "proxy-main",
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["dind", "dind", "envoy", "proxy"]);
  });

  test("propagates running and startedAt fields verbatim", () => {
    const rows = normalizeSidecars([
      makeContainer({
        name: "dind-1",
        running: false,
        startedAt: "2026-04-27T09:00:00.000Z",
        labels: { "nas.kind": "dind" },
      }),
    ]);
    expect(rows[0]?.running).toBe(false);
    expect(rows[0]?.startedAt).toBe("2026-04-27T09:00:00.000Z");
  });

  test("startedAt becomes null when omitted on the payload", () => {
    const rows = normalizeSidecars([
      makeContainer({ name: "dind-1", labels: { "nas.kind": "dind" } }),
    ]);
    expect(rows[0]?.startedAt).toBeNull();
  });

  test("startedAt becomes null when explicitly null on the payload", () => {
    const rows = normalizeSidecars([
      makeContainer({
        name: "dind-1",
        startedAt: null,
        labels: { "nas.kind": "dind" },
      }),
    ]);
    expect(rows[0]?.startedAt).toBeNull();
  });

  test("duplicate names: last entry wins", () => {
    const rows = normalizeSidecars([
      makeContainer({
        name: "dind-1",
        running: true,
        labels: { "nas.kind": "dind" },
      }),
      makeContainer({
        name: "dind-1",
        running: false,
        labels: { "nas.kind": "dind" },
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.running).toBe(false);
  });

  test("returns an empty array for an empty input", () => {
    expect(normalizeSidecars([])).toEqual([]);
  });

  test("returns an empty array when no item is a sidecar", () => {
    expect(
      normalizeSidecars([
        makeContainer({ labels: { "nas.kind": "agent" } }),
        makeContainer({ labels: {} }),
      ]),
    ).toEqual([]);
  });
});
