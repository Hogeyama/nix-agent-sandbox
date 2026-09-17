import { expect, test } from "bun:test";
import type { HostExecPendingEntry } from "../hostexec/types.ts";
import { toHostExecPendingItem } from "./hostexec.ts";

function entry(
  overrides: Partial<HostExecPendingEntry> = {},
): HostExecPendingEntry {
  return {
    version: 1,
    sessionId: "sess_a1",
    requestId: "req_7",
    approvalKey: "gcloud",
    ruleId: "gcloud",
    argv0: "gcloud",
    args: ["auth", "print-access-token"],
    cwd: "/home/u/proj",
    state: "pending",
    createdAt: "2026-09-16T04:12:03.114Z",
    updatedAt: "2026-09-16T04:12:03.114Z",
    ...overrides,
  };
}

test("toHostExecPendingItem carries createdAt, as the network payload does", () => {
  expect(toHostExecPendingItem(entry()).structured).toEqual({
    sessionId: "sess_a1",
    requestId: "req_7",
    ruleId: "gcloud",
    cwd: "/home/u/proj",
    argv0: "gcloud",
    args: ["auth", "print-access-token"],
    createdAt: "2026-09-16T04:12:03.114Z",
  });
});

test("toHostExecPendingItem renders the display line with the full argv", () => {
  expect(toHostExecPendingItem(entry()).displayLine).toEqual(
    "sess_a1 req_7 gcloud /home/u/proj gcloud auth print-access-token",
  );
});

test("toHostExecPendingItem marks an entry whose target changed since start", () => {
  expect(
    toHostExecPendingItem(entry({ integrityChanged: true })).displayLine,
  ).toEndWith(" [CHANGED-SINCE-START]");
});

test("toHostExecPendingItem carries capability metadata for card UIs", () => {
  const capability = {
    ruleId: "gcloud",
    argv0: "gcloud",
    normalizedArgv: ["gcloud", "auth", "print-access-token"],
    normalizedCwd: "/home/u/proj",
    envBindings: [{ key: "GCLOUD_TOKEN", source: "op://x/y" }],
    inheritEnv: { mode: "minimal" as const, keys: ["HOME"] },
  };
  const item = toHostExecPendingItem(
    entry({ integrityChanged: true, defaultScope: "capability", capability }),
  );
  expect(item.structured).toMatchObject({
    integrityChanged: true,
    defaultScope: "capability",
    capability,
  });
});
