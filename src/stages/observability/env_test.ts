/**
 * buildObservabilityEnv unit tests — covers the agent fan-out and the
 * OTEL_RESOURCE_ATTRIBUTES escape rules.
 */

import { expect, test } from "bun:test";
import {
  agentSupportsObservability,
  buildCodexTraceExporterConfig,
  buildObservabilityEnv,
} from "./env.ts";

test("buildObservabilityEnv: claude includes CLAUDE_CODE_* and the OTLP common envs", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "sess_abc123",
    profileName: "dev",
    port: 41234,
  });
  expect(env).toEqual({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:41234",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_RESOURCE_ATTRIBUTES:
      "nas.session.id=sess_abc123,nas.profile=dev,nas.agent=claude",
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    OTEL_TRACES_EXPORTER: "otlp",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
  });
});

test("buildObservabilityEnv: claude sets OTEL_LOG_TOOL_DETAILS=1 so tool spans carry tool_input/etc.", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env?.OTEL_LOG_TOOL_DETAILS).toEqual("1");
});

test("buildObservabilityEnv: copilot does not set OTEL_LOG_TOOL_DETAILS (claude-only)", () => {
  const env = buildObservabilityEnv({
    agent: "copilot",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env?.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
});

test("buildObservabilityEnv: codex does not set OTEL_LOG_TOOL_DETAILS (env not used)", () => {
  // codex returns null entirely; this just pins the contract that the flag
  // does not leak via some shared common-env path.
  const env = buildObservabilityEnv({
    agent: "codex",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env).toBeNull();
});

test("buildObservabilityEnv: copilot includes COPILOT_OTEL_* and the OTLP common envs", () => {
  const env = buildObservabilityEnv({
    agent: "copilot",
    sessionId: "sess_xyz",
    profileName: "p",
    port: 53000,
  });
  expect(env).toEqual({
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:53000",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_RESOURCE_ATTRIBUTES:
      "nas.session.id=sess_xyz,nas.profile=p,nas.agent=copilot",
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    OTEL_TRACES_EXPORTER: "otlp",
    COPILOT_OTEL_ENABLED: "true",
    COPILOT_OTEL_CAPTURE_CONTENT: "true",
  });
});

test("buildObservabilityEnv: copilot sets COPILOT_OTEL_CAPTURE_CONTENT=true so spans carry tool args / messages", () => {
  const env = buildObservabilityEnv({
    agent: "copilot",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env?.COPILOT_OTEL_CAPTURE_CONTENT).toEqual("true");
});

test("buildObservabilityEnv: claude does not set COPILOT_OTEL_CAPTURE_CONTENT (copilot-only)", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env?.COPILOT_OTEL_CAPTURE_CONTENT).toBeUndefined();
});

test("buildObservabilityEnv: codex returns null (configured via argv, not env)", () => {
  const env = buildObservabilityEnv({
    agent: "codex",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env).toBeNull();
});

test("buildCodexTraceExporterConfig: renders OTLP/HTTP JSON traces endpoint", () => {
  expect(buildCodexTraceExporterConfig({ port: 4318 })).toEqual(
    'otel.trace_exporter={otlp-http={endpoint="http://127.0.0.1:4318/v1/traces",protocol="json"}}',
  );
});

test("agentSupportsObservability: all supported agents include codex", () => {
  expect(agentSupportsObservability("claude")).toEqual(true);
  expect(agentSupportsObservability("copilot")).toEqual(true);
  expect(agentSupportsObservability("codex")).toEqual(true);
});

test("buildObservabilityEnv: port is rendered into the endpoint URL", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "p",
    port: 1,
  });
  expect(env?.OTEL_EXPORTER_OTLP_ENDPOINT).toEqual("http://127.0.0.1:1");
});

test("buildObservabilityEnv: protocol is always http/json (receiver only accepts JSON)", () => {
  const claude = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  const copilot = buildObservabilityEnv({
    agent: "copilot",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(claude?.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual("http/json");
  expect(copilot?.OTEL_EXPORTER_OTLP_PROTOCOL).toEqual("http/json");
});

test("buildObservabilityEnv: OTEL_METRIC_EXPORT_INTERVAL is 5000 (5s, matched to UI SSE polling)", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "p",
    port: 4318,
  });
  expect(env?.OTEL_METRIC_EXPORT_INTERVAL).toEqual("5000");
});

// ---------------------------------------------------------------------------
// OTEL_RESOURCE_ATTRIBUTES escape rules
//
// The grammar uses `,` as item separator and `=` as key/value separator.
// Backslash escapes are mandatory for all three special characters in any
// value. We pin the escape behavior because a profile name (or, in the
// future, any user-controlled attribute) is a plausible injection vector
// into peer attributes if escapes leak.
// ---------------------------------------------------------------------------

test("buildObservabilityEnv: escapes commas in profileName", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "a,b",
    port: 4318,
  });
  expect(env?.OTEL_RESOURCE_ATTRIBUTES).toEqual(
    "nas.session.id=s,nas.profile=a\\,b,nas.agent=claude",
  );
});

test("buildObservabilityEnv: escapes equals signs in profileName", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "k=v",
    port: 4318,
  });
  expect(env?.OTEL_RESOURCE_ATTRIBUTES).toEqual(
    "nas.session.id=s,nas.profile=k\\=v,nas.agent=claude",
  );
});

test("buildObservabilityEnv: escapes backslashes in profileName before applying other escapes", () => {
  // Order matters: if we escaped `,` before `\`, the inserted `\,` would be
  // re-encoded into `\\,` on the second pass. Pin the literal output to
  // ensure the order is correct.
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "a\\b",
    port: 4318,
  });
  expect(env?.OTEL_RESOURCE_ATTRIBUTES).toEqual(
    "nas.session.id=s,nas.profile=a\\\\b,nas.agent=claude",
  );
});

test("buildObservabilityEnv: escapes commas + equals + backslash combined in profileName", () => {
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "s",
    profileName: "x=1,y=\\z",
    port: 4318,
  });
  expect(env?.OTEL_RESOURCE_ATTRIBUTES).toEqual(
    "nas.session.id=s,nas.profile=x\\=1\\,y\\=\\\\z,nas.agent=claude",
  );
});

test("buildObservabilityEnv: applies escape rules to sessionId as well", () => {
  // Production sessionIds are `sess_<hex>`, which is escape-safe. The
  // defensive escape is exercised here so that a future change to the
  // sessionId format cannot silently break the resource-attrs encoding.
  const env = buildObservabilityEnv({
    agent: "claude",
    sessionId: "id,with=both\\specials",
    profileName: "p",
    port: 4318,
  });
  expect(env?.OTEL_RESOURCE_ATTRIBUTES).toEqual(
    "nas.session.id=id\\,with\\=both\\\\specials,nas.profile=p,nas.agent=claude",
  );
});
