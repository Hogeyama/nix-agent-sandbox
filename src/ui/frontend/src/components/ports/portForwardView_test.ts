import { expect, test } from "bun:test";
import type {
  ForwardOwner,
  ManagedForward,
} from "../../../../../network/port_forward_model";
import {
  addForwardNotice,
  forwardRow,
  removeForwardNotice,
  sessionForwardRows,
} from "./portForwardView";

test("only local forwarding links to the host browser", () => {
  const base = {
    hostPort: 8080,
    containerPort: 3000,
    owners: ["config"] as ForwardOwner[],
    createdAt: "2026-09-08T00:00:00Z",
    state: "active" as const,
  };

  expect(forwardRow({ ...base, direction: "local" }).href).toBe(
    "http://localhost:8080",
  );
  expect(forwardRow({ ...base, direction: "remote" }).href).toBeNull();
});

test("labels expose direction, endpoints, owners, and state", () => {
  const entry: ManagedForward = {
    direction: "remote",
    hostPort: 5432,
    containerPort: 15432,
    owners: ["config", "internal"],
    createdAt: "2026-09-08T00:00:00Z",
    state: "failed",
    error: "listener is already in use",
  };

  expect(forwardRow(entry)).toEqual({
    directionLabel: "Remote",
    listenLabel: "container localhost:15432",
    targetLabel: "host localhost:5432",
    href: null,
    ownerLabel: "config, internal",
    stateLabel: "failed — listener is already in use",
  });
});

test("legacy bindings and forwards fall back to dynamic active rows", () => {
  const rows = sessionForwardRows({
    sessionId: "legacy-session",
    bindings: [
      {
        hostPort: 8080,
        containerPort: 3000,
        createdAt: "2026-09-08T00:00:00Z",
      },
    ],
    forwards: [
      {
        hostPort: 5432,
        containerPort: 15432,
        createdAt: "2026-09-08T00:00:00Z",
      },
    ],
  });

  expect(
    rows.map((entry) => [entry.direction, entry.owners, entry.state]),
  ).toEqual([
    ["local", ["dynamic"], "active"],
    ["remote", ["dynamic"], "active"],
  ]);
});

test("probe notices describe the target separately from forwarding state", () => {
  const entry: ManagedForward = {
    direction: "remote",
    hostPort: 5432,
    containerPort: 15432,
    owners: ["dynamic"],
    createdAt: "2026-09-08T00:00:00Z",
    state: "active",
  };

  expect(addForwardNotice({ entry, probe: "no-answer" })).toBe(
    "Target probe: no answer from host 127.0.0.1:5432 yet",
  );
  expect(addForwardNotice({ entry, probe: "ok" })).toBeNull();
});

test("removal notices distinguish retained ownership from listener teardown", () => {
  expect(
    removeForwardNotice({
      removed: true,
      retainedInternal: true,
      listenerClosed: false,
    }),
  ).toBe(
    "User ownership removed. Internal forwarding remains and its listener stayed open.",
  );
  expect(
    removeForwardNotice({
      removed: true,
      retainedInternal: false,
      listenerClosed: false,
    }),
  ).toBe("Forward removed, but listener closure was not confirmed.");
});
