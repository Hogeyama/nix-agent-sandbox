import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { _closeAuditDb, appendAuditLog } from "../audit/store.ts";
import type { AuditLogEntry } from "../audit/types.ts";
import { formatAuditEntries, runAuditCommand } from "./audit.ts";

function makeEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "entry-1",
    timestamp: "2026-07-23T00:00:00.000Z",
    domain: "network",
    sessionId: "sess-1",
    requestId: "req-1",
    decision: "allow",
    reason: "review-rule",
    target: "api.anthropic.com:443",
    ...overrides,
  };
}

function makeEgressEntry(
  overrides: Partial<AuditLogEntry> = {},
): AuditLogEntry {
  return makeEntry({
    timestamp: "2026-07-23T00:00:01.000Z",
    requestId: "req-egress-1",
    decision: "deny",
    reason: "file-upload-blocked",
    phase: "egress",
    method: "POST",
    route: "/v1/files",
    egressAction: "block",
    target: undefined,
    ...overrides,
  });
}

test("formatAuditEntries preserves authorization entry formatting", () => {
  const authorizationEntry = makeEntry();

  expect(formatAuditEntries([authorizationEntry])).toEqual([
    "2026-07-23T00:00:00.000Z sess-1 network allow review-rule api.anthropic.com:443",
  ]);
});

test("formatAuditEntries returns no lines for empty input", () => {
  expect(formatAuditEntries([])).toEqual([]);
});

test("formatAuditEntries preserves hostexec entry formatting", () => {
  const hostexecEntry = makeEntry({
    domain: "hostexec",
    command: "git status",
    target: undefined,
  });

  expect(formatAuditEntries([hostexecEntry])).toEqual([
    "2026-07-23T00:00:00.000Z sess-1 hostexec allow review-rule git status",
  ]);
});

test("formatAuditEntries groups repeated egress entries across authorization entries", () => {
  const entries = [
    makeEgressEntry(),
    makeEntry({
      id: "authorization-1",
      timestamp: "2026-07-23T00:00:02.000Z",
      requestId: "req-authorization-1",
    }),
    makeEgressEntry({
      id: "egress-2",
      timestamp: "2026-07-23T00:00:03.000Z",
      requestId: "req-egress-2",
    }),
    makeEntry({
      id: "authorization-2",
      timestamp: "2026-07-23T00:00:04.000Z",
      requestId: "req-authorization-2",
    }),
    makeEgressEntry({
      id: "egress-3",
      timestamp: "2026-07-23T00:00:05.000Z",
      requestId: "req-egress-3",
    }),
  ];

  expect(formatAuditEntries(entries)).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network deny file-upload-blocked POST /v1/files block x3",
    "2026-07-23T00:00:02.000Z sess-1 network allow review-rule api.anthropic.com:443",
    "2026-07-23T00:00:04.000Z sess-1 network allow review-rule api.anthropic.com:443",
  ]);
});

describe("formatAuditEntries egress grouping boundaries", () => {
  const boundaryCases: Array<{
    name: string;
    overrides: Partial<AuditLogEntry>;
    expectedSuffix: string;
  }> = [
    {
      name: "session",
      overrides: { sessionId: "sess-2" },
      expectedSuffix:
        "sess-2 network deny file-upload-blocked POST /v1/files block",
    },
    {
      name: "method",
      overrides: { method: "GET" },
      expectedSuffix:
        "sess-1 network deny file-upload-blocked GET /v1/files block",
    },
    {
      name: "route",
      overrides: { route: "/v1/messages" },
      expectedSuffix:
        "sess-1 network deny file-upload-blocked POST /v1/messages block",
    },
    {
      name: "action",
      overrides: { egressAction: "schema-mask" },
      expectedSuffix:
        "sess-1 network deny file-upload-blocked POST /v1/files schema-mask",
    },
    {
      name: "reason",
      overrides: { reason: "different-reason" },
      expectedSuffix:
        "sess-1 network deny different-reason POST /v1/files block",
    },
  ];

  for (const { name, overrides, expectedSuffix } of boundaryCases) {
    test(`stops at a changed ${name}`, () => {
      const changedEntry = makeEgressEntry({
        id: `changed-${name}`,
        timestamp: "2026-07-23T00:00:02.000Z",
        requestId: `req-changed-${name}`,
        ...overrides,
      });

      expect(formatAuditEntries([makeEgressEntry(), changedEntry])).toEqual([
        "2026-07-23T00:00:01.000Z sess-1 network deny file-upload-blocked POST /v1/files block",
        `2026-07-23T00:00:02.000Z ${expectedSuffix}`,
      ]);
    });
  }
});

test("formatAuditEntries does not merge separated egress runs", () => {
  const first = makeEgressEntry();
  const different = makeEgressEntry({
    id: "different",
    timestamp: "2026-07-23T00:00:02.000Z",
    requestId: "req-different",
    route: "/v1/messages",
  });
  const repeatedFirst = makeEgressEntry({
    id: "repeated-first",
    timestamp: "2026-07-23T00:00:03.000Z",
    requestId: "req-repeated-first",
  });

  expect(formatAuditEntries([first, different, repeatedFirst])).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network deny file-upload-blocked POST /v1/files block",
    "2026-07-23T00:00:02.000Z sess-1 network deny file-upload-blocked POST /v1/messages block",
    "2026-07-23T00:00:03.000Z sess-1 network deny file-upload-blocked POST /v1/files block",
  ]);
});

test("formatAuditEntries omits a count for a single egress entry", () => {
  expect(formatAuditEntries([makeEgressEntry()])).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network deny file-upload-blocked POST /v1/files block",
  ]);
});

test("formatAuditEntries uses fallbacks for missing egress fields", () => {
  const entry = makeEgressEntry({
    method: undefined,
    route: undefined,
    egressAction: undefined,
  });

  expect(formatAuditEntries([entry])).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network deny file-upload-blocked  unknown ",
  ]);
});

test("runAuditCommand JSON mode returns repeated egress entries ungrouped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-json-"));
  const originalLog = console.log;
  const output: string[] = [];

  try {
    await appendAuditLog(makeEgressEntry(), dir);
    await appendAuditLog(
      makeEgressEntry({
        id: "egress-2",
        timestamp: "2026-07-23T00:00:02.000Z",
        requestId: "req-egress-2",
      }),
      dir,
    );
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };

    await runAuditCommand([
      "--json",
      "--audit-dir",
      dir,
      "--since",
      "2026-07-23",
    ]);

    const entries = JSON.parse(output.join("\n")) as AuditLogEntry[];
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).toEqual(["entry-1", "egress-2"]);
    expect(entries).toMatchObject([
      {
        phase: "egress",
        method: "POST",
        route: "/v1/files",
        egressAction: "block",
      },
      {
        phase: "egress",
        method: "POST",
        route: "/v1/files",
        egressAction: "block",
      },
    ]);
  } finally {
    console.log = originalLog;
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true });
  }
});
