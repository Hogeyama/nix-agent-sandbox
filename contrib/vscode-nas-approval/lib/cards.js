const { pendingKey } = require("./watchState.js");

const KNOWN_NETWORK_SCOPES = ["once", "rule", "host-port", "host", "violation"];

// scope チップの表記と title ツールチップ。nas ui と同じ短い label を使う。
const NETWORK_SCOPE_CHIPS = {
  once: {
    label: "once",
    hint: "Applies to this request only. Nothing is remembered.",
  },
  rule: {
    label: "this rule",
    hint: "Remembered for this session, for this rule against this target.",
  },
  "host-port": {
    label: "host:port",
    hint: "Remembered for this session, for this rule against this host and port. Other rules still ask.",
  },
  host: {
    label: "host",
    hint: "Remembered for this session, for this rule against this host on any port. Other rules still ask.",
  },
  violation: {
    label: "these values",
    hint: "Remembered for this session, for this rule and the values this card is asking about.",
  },
};

const HOSTEXEC_SCOPE_LABELS = {
  once: "This request only",
  capability: "Matching command for this session",
};

// 確認が出ている理由。語彙は backend の DecisionReason。
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

// scope 選択の直下に出す「この承認が何を覚えるか」の説明文。
function networkApprovalEffect(violationCount, scope) {
  switch (scope) {
    case "rule":
      return "Approves this request and future matching requests in this session for the same rule and target.";
    case "host-port":
      return "Approves this request and future matching requests in this session for the same rule, host, and port.";
    case "host":
      return "Approves this request and future matching requests in this session for the same rule and host, on any port.";
    case "violation":
      return `Approves this request and future matching requests in this session for the same rule and the ${violationCount === 1 ? "violation" : "violations"} shown here.`;
    default:
      return "Approves this request only. Nothing is remembered.";
  }
}

function hostExecApprovalEffect(scope) {
  return scope === "once"
    ? "Approves this request only. Nothing is remembered."
    : "Approves all requests waiting on these exact conditions and remembers them for this session.";
}

// src/ui/frontend/src/stores/sessionId.ts の shortenSessionId と同じ規則。
function shortenSessionId(sessionId) {
  if (!sessionId) return "";
  return String(sessionId)
    .replace(/^(?:sess_|s_)/, "")
    .slice(0, 6);
}

// `label` は value がリクエスト固有の UUID (読む人に何も言わない) のときの
// 表示名。`at` は受理条件のセレクタ、`pointer` は違反ノードの位置で、
// 一致するとき pointer の再表示は情報にならない。
function violationView(v) {
  const at = v.at ?? "";
  const pointer = v.pointer ?? "";
  return {
    headline: v.label ?? v.value ?? v.kind ?? "violation",
    at,
    pointer: pointer === "" || pointer === at ? null : pointer,
    excerpt: v.excerpt ?? null,
    count: v.count ?? 1,
  };
}

function listOrNone(values, separator = ", ") {
  return values.length > 0 ? values.join(separator) : "none";
}

// hostexec の承認が効く条件の内訳。capability を載せない古い broker では
// 各フィールドが "not reported" に落ちる。
function hostExecMatchDetails(entry) {
  const capability = entry.capability;
  const bindings = capability
    ? listOrNone(
        (capability.envBindings ?? []).map((b) => `${b.key} ← ${b.source}`),
      )
    : "not reported";
  const inheritEnv = capability?.inheritEnv;
  const inherited = inheritEnv
    ? `${inheritEnv.mode}; ${listOrNone(inheritEnv.keys ?? [])}`
    : "not reported";
  return [
    {
      label: "Rule",
      value: entry.ruleId ?? capability?.ruleId ?? "not reported",
    },
    {
      label: "Working directory",
      value: entry.cwd ?? capability?.normalizedCwd ?? "not reported",
    },
    { label: "Environment bindings", value: bindings },
    { label: "Inherited environment", value: inherited },
  ];
}

// capability があるときは正規化済み argv を JSON quoting で繋ぎ、
// 引数の境界を残す。
function hostExecCommand(entry) {
  const capability = entry.capability;
  if (capability) {
    return (capability.normalizedArgv ?? [])
      .map((arg) => JSON.stringify(arg))
      .join(" ");
  }
  return [entry.argv0, ...(entry.args ?? [])].join(" ");
}

function networkCard(entry) {
  const violations = (entry.violations ?? []).map(violationView);
  const scopes = (entry.approvalScopes ?? [])
    .filter((s) => KNOWN_NETWORK_SCOPES.includes(s))
    .map((value) => ({
      value,
      label: NETWORK_SCOPE_CHIPS[value].label,
      hint: NETWORK_SCOPE_CHIPS[value].hint,
      effect: networkApprovalEffect(violations.length, value),
    }));
  if (scopes.length === 0) {
    scopes.push({
      value: "once",
      label: NETWORK_SCOPE_CHIPS.once.label,
      hint: NETWORK_SCOPE_CHIPS.once.hint,
      effect: networkApprovalEffect(violations.length, "once"),
    });
  }
  const reviewContext = entry.reviewContext?.path
    ? {
        path: entry.reviewContext.path,
        contentType: entry.reviewContext.contentType ?? null,
        bodySize: entry.reviewContext.bodySize ?? null,
      }
    : null;
  return {
    key: `network:${pendingKey(entry.sessionId, entry.requestId)}`,
    domain: "network",
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    sessionShortId: shortenSessionId(entry.sessionId),
    verb: (entry.method ?? "GET").toUpperCase(),
    summary: `${entry.host}:${entry.port}`,
    createdAt: entry.createdAt ?? null,
    ruleId: entry.ruleId ?? null,
    warning: null,
    reason: entry.askReason
      ? (ASK_REASONS[entry.askReason] ?? { label: entry.askReason, hint: "" })
      : null,
    reviewContext,
    violations,
    matchDetails: [],
    scopes,
    selectedScope: scopes[0].value,
  };
}

function hostExecCard(entry) {
  const scopes = ["once", "capability"].map((value) => ({
    value,
    label: HOSTEXEC_SCOPE_LABELS[value],
    hint: "",
    effect: hostExecApprovalEffect(value),
  }));
  return {
    key: `hostexec:${pendingKey(entry.sessionId, entry.requestId)}`,
    domain: "hostexec",
    sessionId: entry.sessionId,
    requestId: entry.requestId,
    sessionShortId: shortenSessionId(entry.sessionId),
    verb: "run",
    summary: hostExecCommand(entry),
    createdAt: entry.createdAt ?? null,
    ruleId: null, // chip には出さず matchDetails の行で示す
    warning:
      entry.integrityChanged === true
        ? "Target file changed since session start"
        : null,
    reason: null,
    reviewContext: null,
    violations: [],
    matchDetails: hostExecMatchDetails(entry),
    scopes,
    selectedScope: entry.defaultScope === "capability" ? "capability" : "once",
  };
}

function cardViewModel(domain, entry) {
  if (domain === "network") return networkCard(entry);
  if (domain === "hostexec") return hostExecCard(entry);
  return null;
}

module.exports = { cardViewModel };
