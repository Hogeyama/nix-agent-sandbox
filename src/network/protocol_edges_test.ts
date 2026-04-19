/**
 * Edge cases for protocol parsers that the main protocol_test.ts omits.
 * These cover rejection paths (invalid authority shapes, invalid ports,
 * invalid IPv4 literals) that gate approval decisions, so silent parse
 * bugs here would let dangerous hosts through.
 */

import { expect, test } from "bun:test";
import {
  denyReasonForTarget,
  normalizeTarget,
  parseAllowlistEntry,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// normalizeTarget — authority parsing edges
// ---------------------------------------------------------------------------

test("normalizeTarget: empty authority throws", () => {
  expect(() => normalizeTarget({ method: "CONNECT", authority: "" })).toThrow();
  expect(() =>
    normalizeTarget({ method: "CONNECT", authority: "   " }),
  ).toThrow();
});

test("normalizeTarget: IPv6 authority with port", () => {
  expect(
    normalizeTarget({ method: "CONNECT", authority: "[2001:db8::1]:443" }),
  ).toEqual({ host: "2001:db8::1", port: 443 });
});

test("normalizeTarget: bracketed IPv6 without closing ']' throws", () => {
  expect(() =>
    normalizeTarget({ method: "CONNECT", authority: "[2001:db8::1" }),
  ).toThrow(/IPv6/);
});

test("normalizeTarget: bracketed IPv6 with garbage after ']' throws", () => {
  expect(() =>
    normalizeTarget({ method: "CONNECT", authority: "[2001:db8::1]foo" }),
  ).toThrow(/IPv6/);
});

test("normalizeTarget: GET with absolute http:// URL defaults to port 80", () => {
  const target = normalizeTarget({
    method: "GET",
    url: "http://example.com/foo",
  });
  expect(target).toEqual({ host: "example.com", port: 80 });
});

// ---------------------------------------------------------------------------
// parseAllowlistEntry — port validation
// ---------------------------------------------------------------------------

test("parseAllowlistEntry: non-digit port segment is treated as host (bare IPv6 tolerance)", () => {
  // Only /^\d+$/ is treated as a port; anything else is assumed to be part
  // of the host. This tolerance lets unbracketed IPv6 strings pass through.
  expect(parseAllowlistEntry("example.com:abc")).toEqual({
    host: "example.com:abc",
    port: null,
  });
  expect(parseAllowlistEntry("example.com:-1")).toEqual({
    host: "example.com:-1",
    port: null,
  });
});

test("parseAllowlistEntry: port 0 throws (digits matched, parsePort rejects)", () => {
  expect(() => parseAllowlistEntry("example.com:0")).toThrow(/port/);
});

test("parseAllowlistEntry: port above 65535 throws", () => {
  expect(() => parseAllowlistEntry("example.com:70000")).toThrow(/port/);
});

test("parseAllowlistEntry: bracketed IPv6 with port", () => {
  expect(parseAllowlistEntry("[2001:db8::1]:443")).toEqual({
    host: "[2001:db8::1]",
    port: 443,
  });
});

test("parseAllowlistEntry: bracketed IPv6 without closing bracket throws", () => {
  expect(() => parseAllowlistEntry("[2001:db8::1")).toThrow(/invalid entry/);
});

test("parseAllowlistEntry: bracketed IPv6 with garbage after ']' throws", () => {
  expect(() => parseAllowlistEntry("[::1]garbage")).toThrow(/invalid entry/);
});

// ---------------------------------------------------------------------------
// denyReasonForTarget — IPv4 bad literal fallback
// ---------------------------------------------------------------------------

test("denyReasonForTarget: hostname is not denied", () => {
  expect(denyReasonForTarget({ host: "example.com", port: 443 })).toEqual(null);
});

test("denyReasonForTarget: localhost is always blocked", () => {
  expect(denyReasonForTarget({ host: "localhost", port: 80 })).toEqual(
    "blocked-special-host",
  );
});

test("denyReasonForTarget: public IPv4 is allowed", () => {
  expect(denyReasonForTarget({ host: "8.8.8.8", port: 53 })).toEqual(null);
});

test("denyReasonForTarget: 127.0.0.1 is blocked as private IP", () => {
  expect(denyReasonForTarget({ host: "127.0.0.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
});

test("denyReasonForTarget: RFC1918 ranges are blocked", () => {
  expect(denyReasonForTarget({ host: "10.0.0.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "192.168.1.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
  expect(denyReasonForTarget({ host: "172.20.1.1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
});

test("denyReasonForTarget: IPv6 loopback is blocked", () => {
  expect(denyReasonForTarget({ host: "::1", port: 80 })).toEqual(
    "blocked-private-ip",
  );
});

test("denyReasonForTarget: public IPv6 is allowed", () => {
  expect(denyReasonForTarget({ host: "2001:db8::1", port: 80 })).toEqual(null);
});
