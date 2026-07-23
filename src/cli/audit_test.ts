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

function makeRequestPolicyEntry(
  overrides: Partial<AuditLogEntry> = {},
): AuditLogEntry {
  return makeEntry({
    timestamp: "2026-07-23T00:00:01.000Z",
    requestId: "req-request-policy-1",
    reason: "masked-json",
    phase: "request-policy",
    ruleId: "anthropic.messages.create",
    method: "POST",
    route: "/v1/messages",
    requestPolicyKind: "json",
    requestPolicyResult: "rewrite",
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

test("formatAuditEntries groups repeated request-policy entries across authorization entries", () => {
  const entries = [
    makeRequestPolicyEntry(),
    makeEntry({
      id: "authorization-1",
      timestamp: "2026-07-23T00:00:02.000Z",
      requestId: "req-authorization-1",
    }),
    makeRequestPolicyEntry({
      id: "request-policy-2",
      timestamp: "2026-07-23T00:00:03.000Z",
      requestId: "req-request-policy-2",
    }),
    makeEntry({
      id: "authorization-2",
      timestamp: "2026-07-23T00:00:04.000Z",
      requestId: "req-authorization-2",
    }),
    makeRequestPolicyEntry({
      id: "request-policy-3",
      timestamp: "2026-07-23T00:00:05.000Z",
      requestId: "req-request-policy-3",
    }),
  ];

  expect(formatAuditEntries(entries)).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network allow masked-json POST /v1/messages anthropic.messages.create json rewrite x3",
    "2026-07-23T00:00:02.000Z sess-1 network allow review-rule api.anthropic.com:443",
    "2026-07-23T00:00:04.000Z sess-1 network allow review-rule api.anthropic.com:443",
  ]);
});

describe("formatAuditEntries request-policy grouping boundaries", () => {
  const boundaryCases: Array<{
    name: string;
    overrides: Partial<AuditLogEntry>;
    expectedSuffix: string;
  }> = [
    {
      name: "session",
      overrides: { sessionId: "sess-2" },
      expectedSuffix:
        "sess-2 network allow masked-json POST /v1/messages anthropic.messages.create json rewrite",
    },
    {
      name: "rule ID",
      overrides: { ruleId: "anthropic.files.create" },
      expectedSuffix:
        "sess-1 network allow masked-json POST /v1/messages anthropic.files.create json rewrite",
    },
    {
      name: "kind",
      overrides: { requestPolicyKind: "bodyless" },
      expectedSuffix:
        "sess-1 network allow masked-json POST /v1/messages anthropic.messages.create bodyless rewrite",
    },
    {
      name: "result",
      overrides: { requestPolicyResult: "block" },
      expectedSuffix:
        "sess-1 network allow masked-json POST /v1/messages anthropic.messages.create json block",
    },
    {
      name: "reason",
      overrides: { reason: "different-reason" },
      expectedSuffix:
        "sess-1 network allow different-reason POST /v1/messages anthropic.messages.create json rewrite",
    },
  ];

  for (const { name, overrides, expectedSuffix } of boundaryCases) {
    test(`stops at a changed ${name}`, () => {
      const changedEntry = makeRequestPolicyEntry({
        id: `changed-${name}`,
        timestamp: "2026-07-23T00:00:02.000Z",
        requestId: `req-changed-${name}`,
        ...overrides,
      });

      expect(
        formatAuditEntries([makeRequestPolicyEntry(), changedEntry]),
      ).toEqual([
        "2026-07-23T00:00:01.000Z sess-1 network allow masked-json POST /v1/messages anthropic.messages.create json rewrite",
        `2026-07-23T00:00:02.000Z ${expectedSuffix}`,
      ]);
    });
  }
});

test("formatAuditEntries does not merge separated request-policy runs", () => {
  const first = makeRequestPolicyEntry();
  const different = makeRequestPolicyEntry({
    id: "different",
    timestamp: "2026-07-23T00:00:02.000Z",
    requestId: "req-different",
    ruleId: "anthropic.files.create",
  });
  const repeatedFirst = makeRequestPolicyEntry({
    id: "repeated-first",
    timestamp: "2026-07-23T00:00:03.000Z",
    requestId: "req-repeated-first",
  });

  expect(formatAuditEntries([first, different, repeatedFirst])).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network allow masked-json POST /v1/messages anthropic.messages.create json rewrite",
    "2026-07-23T00:00:02.000Z sess-1 network allow masked-json POST /v1/messages anthropic.files.create json rewrite",
    "2026-07-23T00:00:03.000Z sess-1 network allow masked-json POST /v1/messages anthropic.messages.create json rewrite",
  ]);
});

test("formatAuditEntries omits a count for a single request-policy entry", () => {
  expect(formatAuditEntries([makeRequestPolicyEntry()])).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network allow masked-json POST /v1/messages anthropic.messages.create json rewrite",
  ]);
});

test("formatAuditEntries uses fallbacks for missing request-policy fields", () => {
  const entry = makeRequestPolicyEntry({
    method: undefined,
    route: undefined,
    ruleId: undefined,
    requestPolicyKind: undefined,
    requestPolicyResult: undefined,
  });

  expect(formatAuditEntries([entry])).toEqual([
    "2026-07-23T00:00:01.000Z sess-1 network allow masked-json  unknown   ",
  ]);
});

test("runAuditCommand JSON mode returns repeated request-policy entries ungrouped", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-cli-audit-json-"));
  const originalLog = console.log;
  const output: string[] = [];

  try {
    await appendAuditLog(makeRequestPolicyEntry(), dir);
    await appendAuditLog(
      makeRequestPolicyEntry({
        id: "request-policy-2",
        timestamp: "2026-07-23T00:00:02.000Z",
        requestId: "req-request-policy-2",
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
    expect(entries.map((entry) => entry.id)).toEqual([
      "entry-1",
      "request-policy-2",
    ]);
    expect(entries).toMatchObject([
      {
        phase: "request-policy",
        ruleId: "anthropic.messages.create",
        method: "POST",
        route: "/v1/messages",
        requestPolicyKind: "json",
        requestPolicyResult: "rewrite",
      },
      {
        phase: "request-policy",
        ruleId: "anthropic.messages.create",
        method: "POST",
        route: "/v1/messages",
        requestPolicyKind: "json",
        requestPolicyResult: "rewrite",
      },
    ]);
  } finally {
    console.log = originalLog;
    _closeAuditDb(dir);
    await rm(dir, { recursive: true, force: true });
  }
});
