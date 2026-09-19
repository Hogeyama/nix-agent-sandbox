const { pendingKey } = require("./watchState.js");

const KNOWN_NETWORK_SCOPES = ["once", "rule", "host-port", "host", "violation"];

const NETWORK_SCOPE_LABELS = {
  once: "This request only",
  rule: "Same rule and target, this session",
  "host-port": "Same rule, host and port, this session",
  host: "Same rule and host, this session",
  violation: "Matching violations, this session",
};

const HOSTEXEC_SCOPES = [
  { value: "once", label: "This request only" },
  { value: "capability", label: "Matching command for this session" },
];

// src/ui/frontend/src/components/pendingCardView.ts の ASK_REASONS と同じ語彙。
const ASK_REASONS = {
  rule: {
    label: "the matched rule asks for review",
    hint: "A rule matched this request and its action for a match is review.",
  },
  indeterminate: {
    label: "the rule could not be decided on this body",
    hint: "A rule matched, but its body condition could not be settled on this request.",
  },
  "scope-fallback": {
    label: "no rule in this scope matched",
    hint: "This host has a scope, but no rule in it matched; the scope's fallback is review.",
  },
  "network-fallback": {
    label: "no scope covers this host",
    hint: "No scope claims this host; the document's fallback is review.",
  },
};

function networkCard(entry) {
  const scopes = (entry.approvalScopes ?? [])
    .filter((s) => KNOWN_NETWORK_SCOPES.includes(s))
    .map((value) => ({ value, label: NETWORK_SCOPE_LABELS[value] }));
  if (scopes.length === 0)
    scopes.push({ value: "once", label: NETWORK_SCOPE_LABELS.once });
  // `label`, when present, stands in for a value that is only a per-request
  // identity (a UUID) and would tell the reader nothing.
  const violations = (entry.violations ?? []).map((v) => ({
    label:
      [v.pointer, v.label ?? v.value].filter(Boolean).join(" = ") ||
      "violation",
  }));
  const meta = [];
  if (entry.reviewContext?.path) {
    meta.push({
      label: "Request",
      value: `${entry.reviewContext.path} · body ${entry.reviewContext.bodySize ?? "?"}B`,
    });
  }
  if (entry.ruleId) meta.push({ label: "Rule", value: entry.ruleId });
  return {
    key: `network:${pendingKey(entry.sessionId, entry.requestId)}`,
    domain: "network",
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    title: `${(entry.method ?? "GET").toUpperCase()} ${entry.host}:${entry.port}`,
    createdAt: entry.createdAt ?? null,
    meta,
    warning: null,
    reason: entry.askReason
      ? (ASK_REASONS[entry.askReason] ?? { label: entry.askReason, hint: "" })
      : null,
    violations,
    scopes,
    selectedScope: scopes[0].value,
  };
}

function hostExecCard(entry) {
  const meta = [];
  if (entry.cwd) meta.push({ label: "Working directory", value: entry.cwd });
  if (entry.ruleId) meta.push({ label: "Rule", value: entry.ruleId });
  if (entry.capability?.envBindings?.length) {
    meta.push({
      label: "Environment bindings",
      value: entry.capability.envBindings
        .map((b) => `${b.key} ← ${b.source}`)
        .join(", "),
    });
  }
  return {
    key: `hostexec:${pendingKey(entry.sessionId, entry.requestId)}`,
    domain: "hostexec",
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    title: [entry.argv0, ...(entry.args ?? [])].join(" "),
    createdAt: entry.createdAt ?? null,
    meta,
    warning:
      entry.integrityChanged === true
        ? "Target file changed since session start"
        : null,
    reason: null,
    violations: [],
    scopes: HOSTEXEC_SCOPES,
    selectedScope: entry.defaultScope === "capability" ? "capability" : "once",
  };
}

function cardViewModel(domain, entry) {
  if (domain === "network") return networkCard(entry);
  if (domain === "hostexec") return hostExecCard(entry);
  return null;
}

module.exports = { cardViewModel };
