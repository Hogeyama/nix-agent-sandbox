// This module deliberately uses textContent, native buttons, and no dependencies.
// Data from a held request is hostile, including the reason and working directory.
export function visible(value) {
  return value.replace(/[\\\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, (character) =>
    character === "\\"
      ? "\\\\"
      : `\\u{${character.codePointAt(0).toString(16)}}`,
  );
}

export function timestamp(value) {
  const date = new Date(value);
  const iso = Number.isNaN(date.getTime())
    ? "Date unavailable"
    : date.toISOString();
  return `${iso} (${value} epoch ms)`;
}

// `<session>-<n>.<incarnation>`, as core/approval.ts and core/session.ts make it.
const REF =
  /^([A-Za-z0-9](?:[A-Za-z0-9_-]{0,30}[A-Za-z0-9_])?)-\d+\.[2-9a-km-np-z]{8}$/;
const STRINGS = ["ref", "session", "cwd", "method", "url", "reason"];
const keyOf = (record) => record.ref;
const isStrings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
// Records are built field by field in one order, so equal JSON is equal data.
export const sameRecord = (left, right) =>
  Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));

function execSnapshot(exec) {
  if (
    !exec ||
    typeof exec !== "object" ||
    !isStrings(exec.argv) ||
    exec.argv.length === 0 ||
    typeof exec.cwd !== "string" ||
    !exec.env ||
    typeof exec.env !== "object" ||
    Array.isArray(exec.env) ||
    !Object.values(exec.env).every((value) => typeof value === "string")
  ) {
    throw new Error("Invalid host command");
  }
  return Object.freeze({
    argv: Object.freeze([...exec.argv]),
    cwd: exec.cwd,
    env: Object.freeze(Object.fromEntries(Object.entries(exec.env))),
  });
}

// Copy into immutable snapshots. Reject malformed or ambiguous lists wholesale.
export function pendingSnapshot(payload) {
  if (!payload || !Array.isArray(payload.pending))
    throw new Error("Invalid pending response");
  const keys = new Set();
  return payload.pending.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !STRINGS.every((field) => typeof value[field] === "string") ||
      REF.exec(value.ref)?.[1] !== value.session ||
      !isStrings(value.command) ||
      (value.body !== undefined && typeof value.body !== "string") ||
      (value.body !== undefined && value.exec !== undefined) ||
      !Number.isSafeInteger(value.since) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.since < 0 ||
      value.expiresAt <= value.since
    ) {
      throw new Error("Invalid pending request");
    }
    const record = Object.freeze({
      ref: value.ref,
      session: value.session,
      cwd: value.cwd,
      command: Object.freeze([...value.command]),
      method: value.method,
      url: value.url,
      reason: value.reason,
      ...(value.exec !== undefined ? { exec: execSnapshot(value.exec) } : {}),
      ...(value.body !== undefined ? { body: value.body } : {}),
      since: value.since,
      expiresAt: value.expiresAt,
    });
    const key = keyOf(record);
    if (keys.has(key)) throw new Error("Duplicate pending request");
    keys.add(key);
    return record;
  });
}

/** The host environment names a host command inherits, from the server. */
export function inheritedEnv(payload) {
  return isStrings(payload?.inheritedEnv) ? [...payload.inheritedEnv] : [];
}

// Lines of text, each escaped on its own. One argument per line, JSON-quoted: a joined command line would hide where
// each argument ends.
export function execLines(exec, inherited) {
  const env = Object.entries(exec.env);
  return {
    argv: exec.argv.map(
      (arg, index) => `argv[${index}] ${JSON.stringify(arg)}`,
    ),
    env: [
      `${inherited.length ? inherited.join(", ") : "Nothing"} from the host${env.length ? ", plus:" : ", nothing else"}`,
      ...env.map(([key, value]) => `${key}=${JSON.stringify(value)}`),
    ],
  };
}

export function takeToken(location, history) {
  const fragment = location.hash;
  // Do this before requests, listeners or any rendering. Never retain in storage.
  try {
    history.replaceState(null, "", location.pathname);
  } catch {
    return "";
  }
  return /^#[0-9a-f]{64}$/.test(fragment) ? fragment.slice(1) : "";
}

export function startInbox({
  document,
  location,
  history,
  fetch,
  now = Date.now,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  const token = takeToken(location, history);
  const element = (id) => document.getElementById(id);
  const list = element("request-list");
  const count = element("count");
  const empty = element("empty");
  const status = element("status");
  const refreshButton = element("refresh");
  const detail = element("request-details");
  const detailScroll = element("details-scroll");
  const fields = element("fields");
  const bodyNote = element("body-note");
  const help = element("selection-help");
  const actions = element("actions");
  let records = new Map();
  let inherited = [];
  let selected = null;
  let refreshing = false;
  let deciding = false;
  let stopped = false;
  let revision = 0;
  let interval;
  let expiryTimer;
  let listSignature = "";
  let renderedButtons = new Map();

  function clearSelection(message = "Choose a pending request.") {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    // Old handlers also test the selection object, so detached buttons cannot act.
    if (selected) for (const button of selected.buttons) button.disabled = true;
    selected = null;
    actions.replaceChildren();
    fields.replaceChildren();
    detail.hidden = true;
    help.hidden = false;
    help.textContent = message;
    bodyNote.textContent = "";
  }

  function renderList() {
    count.textContent = String(records.size);
    empty.hidden = records.size !== 0;
    empty.textContent =
      "No requests are waiting. This inbox checks again every two seconds.";
    const signature = JSON.stringify([...records.values(), deciding]);
    // Selection and unchanged polls do not replace the focused native list button.
    if (signature === listSignature) {
      for (const [key, button] of renderedButtons) {
        button.setAttribute(
          "aria-pressed",
          String(key === (selected && keyOf(selected.record))),
        );
      }
      return;
    }
    listSignature = signature;
    renderedButtons = new Map();
    const items = [];
    for (const record of records.values()) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "request";
      button.disabled = deciding;
      button.setAttribute(
        "aria-pressed",
        String(sameRecord(selected?.record, record)),
      );
      for (const [className, text] of [
        ["request-method", record.exec ? "Host command" : record.method],
        [
          "request-url",
          record.exec
            ? record.exec.argv.map((a) => JSON.stringify(a)).join(" ")
            : record.url,
        ],
        ["request-context", record.cwd],
        ["request-identity", `Session ${record.session} · ${record.ref}`],
      ]) {
        const line = document.createElement("span");
        line.className = `${className} untrusted`;
        line.textContent = visible(text);
        button.append(line);
      }
      button.addEventListener("click", () => select(record));
      renderedButtons.set(keyOf(record), button);
      item.append(button);
      items.push(item);
    }
    list.replaceChildren(...items);
  }

  function select(record) {
    if (stopped || deciding || !sameRecord(records.get(keyOf(record)), record))
      return;
    clearSelection();
    if (record.expiresAt <= now()) {
      records.delete(keyOf(record));
      status.textContent =
        "This request has expired. Choose another pending request.";
      renderList();
      return;
    }
    const selection = { record, buttons: [] };
    selected = selection;
    help.hidden = true;
    detail.hidden = false;
    const exec = record.exec && execLines(record.exec, inherited);
    for (const [label, value] of [
      ...(exec
        ? [
            ["Command, run on the host", exec.argv],
            ["Command directory", record.exec.cwd],
            ["Command environment", exec.env],
          ]
        : []),
      ["Method", record.method],
      ["URL", record.url],
      ["Policy reason", record.reason],
      ...(exec
        ? []
        : [
            [
              "Body (captured raw string)",
              record.body ??
                "Unavailable: strait did not capture this request body.",
            ],
          ]),
      ["Session", record.session],
      [
        "Session command",
        record.command.map((a) => JSON.stringify(a)).join(" "),
      ],
      ["Session directory", record.cwd],
      ["Reference", record.ref],
      ["Since", timestamp(record.since)],
      ["Expires at", timestamp(record.expiresAt)],
    ]) {
      const term = document.createElement("dt");
      const definition = document.createElement("dd");
      const text = document.createElement("pre");
      term.textContent = label;
      text.className = "untrusted";
      // An array is lines that strait split, not ones the request contains.
      text.textContent = Array.isArray(value)
        ? value.map(visible).join("\n")
        : visible(value);
      definition.append(text);
      fields.append(term, definition);
    }
    bodyNote.textContent = record.exec
      ? "Approving runs this command on the host, outside the sandbox."
      : record.body === undefined
        ? "An unavailable body does not mean the request body is empty."
        : record.body === ""
          ? "The captured body is an empty string (0 characters)."
          : "The captured body is shown without JSON or GraphQL transformations.";
    for (const [approve, label, className] of [
      [false, "Deny request", "deny"],
      [true, "Approve once", "approve"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = label;
      // Bind the immutable snapshot shown above, never a mutable current ID.
      button.addEventListener("click", () => decide(selection, approve));
      selection.buttons.push(button);
      actions.append(button);
    }
    expiryTimer = setTimeout(
      () => {
        if (selected !== selection) return;
        clearSelection(
          "This request expired. Select a pending request to review it.",
        );
        records.delete(keyOf(record));
        status.textContent =
          "The selected request expired; no decision was sent.";
        renderList();
      },
      Math.min(record.expiresAt - now(), 2_147_483_647),
    );
    detailScroll.scrollTop = 0;
    renderList();
  }

  function selectOldest() {
    let oldest;
    for (const record of records.values()) {
      if (record.expiresAt <= now()) continue;
      if (!oldest || record.since < oldest.since) oldest = record;
    }
    if (!oldest) return;
    select(oldest);
    if (selected?.record === oldest) renderedButtons.get(keyOf(oldest)).focus();
  }

  async function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  }

  async function refresh() {
    if (!token || stopped || refreshing || deciding || document.hidden) return;
    refreshing = true;
    refreshButton.disabled = true;
    const startingRevision = revision;
    try {
      const response = await api("/api/pending", {});
      if (!response.ok) throw new Error("Pending request failed");
      const payload = await response.json();
      const snapshot = pendingSnapshot(payload);
      if (stopped || startingRevision !== revision) return;
      inherited = inheritedEnv(payload);
      records = new Map(
        snapshot
          .filter((record) => record.expiresAt > now())
          .map((record) => [keyOf(record), record]),
      );
      if (
        selected &&
        !sameRecord(records.get(keyOf(selected.record)), selected.record)
      ) {
        clearSelection(
          "The selected request changed, expired or is no longer pending. Select a request again to review it.",
        );
        status.textContent = "Selection cleared; no decision was sent.";
      } else {
        status.textContent = records.size
          ? `${records.size} request${records.size === 1 ? "" : "s"} waiting for review.`
          : "Up to date. No requests are waiting.";
      }
      renderList();
    } catch {
      if (stopped || startingRevision !== revision) return;
      clearSelection(
        "Pending requests could not be verified. Decisions are disabled until the inbox refreshes.",
      );
      records.clear();
      renderList();
      empty.textContent = "Pending requests are unavailable.";
      status.textContent =
        "Could not refresh the inbox. If the host server stopped, relaunch strait review web on the host and reopen its launch link.";
    } finally {
      refreshing = false;
      refreshButton.disabled = stopped || deciding || !token;
    }
  }

  async function decide(selection, approve) {
    if (
      stopped ||
      deciding ||
      selected !== selection ||
      !sameRecord(records.get(keyOf(selection.record)), selection.record)
    )
      return;
    const record = selection.record;
    if (record.expiresAt <= now()) {
      clearSelection("This request expired. No decision was sent.");
      records.delete(keyOf(record));
      renderList();
      status.textContent = "This request has expired; no decision was sent.";
      return;
    }
    deciding = true;
    revision += 1; // Any pending refresh predates this decision and must not replace state.
    refreshButton.disabled = true;
    clearSelection("Sending this one decision…");
    renderList();
    status.textContent = approve
      ? "Sending approval for one request…"
      : "Sending denial for one request…";
    let resolved = false;
    try {
      const response = await api("/api/decision", {
        ref: record.ref,
        approve,
      });
      if (response.status === 409) {
        status.textContent =
          "This request is stale or no longer pending. No new approval was recorded. Select a pending request to review it.";
      } else {
        if (!response.ok || (await response.json()).ok !== true)
          throw new Error("Decision unconfirmed");
        resolved = true;
        status.textContent = approve
          ? "Approved one request. This does not mean the upstream operation succeeded."
          : "Denied one request.";
      }
    } catch {
      status.textContent =
        "Could not confirm the decision. It may already have been handled. Refresh and review the pending requests before trying again.";
    } finally {
      records.delete(keyOf(record));
      deciding = false;
      clearSelection();
      renderList();
      refreshButton.disabled = stopped || refreshing;
      if (resolved && !stopped) selectOldest();
      // The next regular poll refreshes the list; decisions are never retried.
    }
  }

  const onRefresh = () => {
    void refresh();
  };
  if (!token) {
    clearSelection(
      "Reopen the launch link printed by strait review web on the host.",
    );
    renderList();
    empty.textContent = "A host launch link is required.";
    status.textContent =
      "Missing or invalid access token. Relaunch strait review web on the host and reopen its launch link. Reloading this token-free page cannot reconnect.";
  } else {
    refreshButton.addEventListener("click", onRefresh);
    document.addEventListener("visibilitychange", onRefresh);
    interval = setInterval(onRefresh, 2000);
    void refresh();
  }
  return {
    refresh,
    stop() {
      stopped = true;
      revision += 1;
      if (interval !== undefined) clearInterval(interval);
      clearSelection();
      refreshButton.disabled = true;
      refreshButton.removeEventListener("click", onRefresh);
      document.removeEventListener("visibilitychange", onRefresh);
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  startInbox({
    document,
    location: window.location,
    history: window.history,
    fetch: window.fetch.bind(window),
  });
}
