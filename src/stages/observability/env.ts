/**
 * Builder for the OTLP env vars injected into agent containers.
 *
 * Pure: takes the agent type, session identity, and the host-side receiver
 * port, and returns the env map (or null when the agent does not participate
 * in observability).
 *
 * Per ADR (and the agent SDKs' actual env surfaces):
 *   - claude  → CLAUDE_CODE_ENABLE_TELEMETRY=1, CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
 *               plus the OTLP-common envs.
 *   - copilot → COPILOT_OTEL_ENABLED=true plus the OTLP-common envs.
 *   - codex   → no env injected. The codex CLI is intentionally out of scope
 *               for this ADR: returning `null` here keeps codex containers
 *               free of OTLP envs even if the receiver was acquired.
 *
 * Common envs:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  http://127.0.0.1:<port>
 *   OTEL_EXPORTER_OTLP_PROTOCOL  http/json   (the receiver only accepts JSON)
 *   OTEL_RESOURCE_ATTRIBUTES     nas.session.id=<sessionId>,nas.profile=<profileName>,nas.agent=<agent>
 *   OTEL_METRIC_EXPORT_INTERVAL  5000        (5s, matched to the UI SSE polling cadence)
 *   OTEL_TRACES_EXPORTER         otlp        (Claude Code 2.x adds no trace
 *                                              exporter unless this is set
 *                                              explicitly — endpoint alone
 *                                              is not enough)
 */

import type { AgentType } from "../../config/types.ts";

export interface BuildObservabilityEnvArgs {
  readonly agent: AgentType;
  readonly sessionId: string;
  readonly profileName: string;
  readonly port: number;
}

/**
 * Escape a single attribute value per the OTEL `OTEL_RESOURCE_ATTRIBUTES`
 * grammar. The list separator is `,` and the key/value separator is `=`,
 * so any literal `,`, `=`, or `\` in the value must be backslash-escaped.
 *
 * The replacement order matters: backslash itself must be escaped first,
 * otherwise the escapes inserted for `,` / `=` would be re-escaped.
 */
function encodeAttributeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(",", "\\,")
    .replaceAll("=", "\\=");
}

function buildResourceAttributes(args: BuildObservabilityEnvArgs): string {
  const sessionId = encodeAttributeValue(args.sessionId);
  const profileName = encodeAttributeValue(args.profileName);
  const agent = encodeAttributeValue(args.agent);
  return `nas.session.id=${sessionId},nas.profile=${profileName},nas.agent=${agent}`;
}

function buildCommonEnv(
  args: BuildObservabilityEnvArgs,
): Record<string, string> {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${args.port}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_RESOURCE_ATTRIBUTES: buildResourceAttributes(args),
    OTEL_METRIC_EXPORT_INTERVAL: "5000",
    // Claude Code 2.x reads `OTEL_TRACES_EXPORTER` and only registers the
    // OTLP trace exporter when this is explicitly set. Without it the SDK
    // builds zero exporters for the trace signal, the endpoint is unused,
    // and `traces` / `spans` stay empty no matter what `CLAUDE_CODE_*`
    // flags are on. Confirmed empirically against claude 2.1.123. Metrics
    // and logs are intentionally not wired here — the receiver only
    // accepts `/v1/traces`, so enabling those exporters would just spam
    // 404s into Claude's debug log.
    OTEL_TRACES_EXPORTER: "otlp",
  };
}

/**
 * Build the env map to inject into the agent container, or `null` for
 * agents that do not participate in observability.
 *
 * The switch arms each enumerate their AgentType explicitly — there is no
 * default fall-through that could leak common OTLP envs to an agent (codex)
 * for which we have no contract.
 */
export function buildObservabilityEnv(
  args: BuildObservabilityEnvArgs,
): Record<string, string> | null {
  switch (args.agent) {
    case "claude":
      return {
        ...buildCommonEnv(args),
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      };
    case "copilot":
      return {
        ...buildCommonEnv(args),
        COPILOT_OTEL_ENABLED: "true",
      };
    case "codex":
      return null;
  }
}

/**
 * Pure predicate: does {@link buildObservabilityEnv} produce an env map for
 * the given agent? Equivalent to `buildObservabilityEnv(...) !== null` but
 * independent of session identity / port — callable from the planner before
 * any resource is acquired.
 */
export function agentSupportsObservability(agent: AgentType): boolean {
  switch (agent) {
    case "claude":
    case "copilot":
      return true;
    case "codex":
      return false;
  }
}
