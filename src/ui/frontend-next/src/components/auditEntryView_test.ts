/**
 * Tests for `formatAuditEntry`.
 *
 * The format is local-TZ `YYYY/MM/DD HH:mm:ss`; tests must not bake in
 * a specific TZ. Strategy:
 *   - Pin the format **shape** with a regex.
 *   - Pin the value by re-running the same algorithm against the same
 *     fixture and asserting equality (round-trip), so the test passes
 *     in any host TZ.
 *   - Pin the unparseable fallback by asserting the raw input is
 *     returned unchanged.
 */

import { describe, expect, test } from "bun:test";
import { formatAuditEntry, summaryFor } from "./auditEntryView";

const SHAPE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;

function localFormat(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

describe("formatAuditEntry", () => {
  test("formatted output matches the YYYY/MM/DD HH:mm:ss shape", () => {
    expect(formatAuditEntry({ timestamp: "2026-04-20T10:23:45.000Z" })).toMatch(
      SHAPE,
    );
  });

  test("output equals the local-TZ algorithm applied to the same input", () => {
    const iso = "2026-04-20T10:23:45.000Z";
    expect(formatAuditEntry({ timestamp: iso })).toBe(localFormat(iso));
  });

  test("output is TZ-sensitive across different inputs (round-trip)", () => {
    // A second fixture catches the case where the implementation accidentally
    // bakes in a fixed offset: re-running the same algorithm on a different
    // ISO must still match.
    const iso = "2025-12-31T23:59:59.000Z";
    expect(formatAuditEntry({ timestamp: iso })).toBe(localFormat(iso));
  });

  test("unparseable timestamp returns the raw input", () => {
    expect(formatAuditEntry({ timestamp: "not-a-date" })).toBe("not-a-date");
    expect(formatAuditEntry({ timestamp: "" })).toBe("");
  });

  test("nowMs argument is accepted but does not change the output", () => {
    const iso = "2026-04-20T10:23:45.000Z";
    expect(formatAuditEntry({ timestamp: iso }, 1_700_000_000_000)).toBe(
      localFormat(iso),
    );
  });
});

describe("summaryFor", () => {
  function makeRow(
    target: string | null = null,
    command: string | null = null,
  ) {
    return {
      id: "x",
      timestamp: "2026-04-20T10:00:00.000Z",
      domain: "network" as const,
      sessionId: "s",
      requestId: "r",
      decision: "allow" as const,
      reason: "ok",
      scope: null,
      target,
      command,
    };
  }

  test("network rows render the target", () => {
    expect(summaryFor(makeRow("example.com:443", null))).toBe(
      "example.com:443",
    );
  });

  test("hostexec rows render the command", () => {
    expect(summaryFor(makeRow(null, "git push"))).toBe("git push");
  });

  test("falls back to empty string when both target and command are null", () => {
    expect(summaryFor(makeRow(null, null))).toBe("");
  });
});
