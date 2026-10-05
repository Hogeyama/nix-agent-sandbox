import { describe, expect, test } from "bun:test";
import {
  graphqlParts,
  pendingSnapshot,
  sameRecord,
  shellWord,
  startInbox,
  takeToken,
  timestamp,
  visible,
  visibleJson,
} from "./app.js";

const TOKEN = "a".repeat(64);
const NOW = 1_790_000_000_000;
const request = (overrides = {}) => {
  const { n = "1", ...value } = {
    session: "k3f9",
    cwd: "/workspace/project",
    command: ["claude"],
    method: "POST",
    url: "https://api.github.com/graphql",
    reason: "GraphQL mutation requires approval",
    body: '{"query":"mutation { example }"}',
    since: NOW - 1000,
    expiresAt: NOW + 239000,
    ...overrides,
  };
  return { ...value, ref: `${value.session}-${n}.x7mq4ndp` };
};
const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// The tiny DOM is intentionally text-only: an HTML injection fails.
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.scrollTop = 0;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this._text = "";
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return (
      this._text + this.children.map((child) => child.textContent).join("")
    );
  }
  set innerHTML(_value) {
    throw new Error("HTML rendering is forbidden");
  }
  set outerHTML(_value) {
    throw new Error("HTML rendering is forbidden");
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this._text = "";
    this.children = children;
  }
  setAttribute(key, value) {
    this.attributes.set(key, value);
  }
  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }
  removeEventListener(type, handler) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== handler),
    );
  }
  click({ force = false } = {}) {
    if (this.disabled && !force) return;
    for (const handler of this.listeners.get("click") ?? []) handler();
  }
}

function harness({
  pending = [request()],
  inheritedEnv = [],
  token = TOKEN,
  fetch: fetchOverride,
} = {}) {
  const ids = [
    "request-list",
    "count",
    "empty",
    "status",
    "refresh",
    "request-details",
    "details-scroll",
    "fields",
    "body-note",
    "selection-help",
    "actions",
  ];
  const document = new Element("document");
  const nodes = new Map(ids.map((id) => [id, new Element("div", document)]));
  nodes.get("refresh").disabled = true;
  document.getElementById = (id) => nodes.get(id);
  document.createElement = (tagName) => new Element(tagName, document);
  let currentTime = NOW;
  const location = {
    hash: token ? `#${token}` : "",
    pathname: "/",
    search: "",
  };
  const events = [];
  const calls = [];
  const intervals = new Map();
  const timeouts = new Map();
  let timerId = 0;
  let nextPending = pending;
  let decisionResponse = response({ ok: true });
  const history = {
    replaceState(...args) {
      events.push(["replaceState", ...args]);
      location.hash = "";
    },
  };
  const fetch = async (path, options) => {
    events.push(["fetch", path]);
    calls.push({ path, options });
    if (fetchOverride) return fetchOverride(path, options);
    return path === "/api/pending"
      ? response({ pending: nextPending, inheritedEnv })
      : decisionResponse;
  };
  const app = startInbox({
    document,
    location,
    history,
    fetch,
    now: () => currentTime,
    setInterval(fn, ms) {
      const id = ++timerId;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(fn, ms) {
      const id = ++timerId;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
  });
  return {
    app,
    document,
    location,
    events,
    calls,
    intervals,
    timeouts,
    node: (id) => nodes.get(id),
    listButton: (index = 0) =>
      nodes.get("request-list").children[index].children[0],
    deny: () => nodes.get("actions").children[0],
    approve: () => nodes.get("actions").children[1],
    setPending(value) {
      nextPending = value;
    },
    setDecisionResponse(value) {
      decisionResponse = value;
    },
    setNow(value) {
      currentTime = value;
    },
  };
}

const decisions = (h) =>
  h.calls.filter((call) => call.path === "/api/decision");

describe("hostile request display", () => {
  test("shell words are bare, single-quoted, or $'...' with every backslash an escape", () => {
    expect(shellWord("printf")).toBe("printf");
    expect(shellWord("--opt=a/b.c")).toBe("--opt=a/b.c");
    expect(shellWord("")).toBe("''");
    expect(shellWord('say "hi"')).toBe(`'say "hi"'`);
    expect(shellWord("C:\\path")).toBe("'C:\\path'");
    expect(shellWord("日本語 😀")).toBe("'日本語 😀'");
    expect(shellWord("it's")).toBe("$'it\\'s'");
    expect(shellWord("a\\b\nc")).toBe("$'a\\\\b\\nc'");
    expect(shellWord("\t\r\u0000\u001b\u0085\u202e\u2028\ud800\u{e0001}")).toBe(
      "$'\\t\\r\\x00\\x1b\\x85\\u202e\\u2028\\ud800\\U000e0001'",
    );
    // A literal escape from the data has its backslash doubled.
    expect(shellWord("\\u202e\n")).toBe("$'\\\\u202e\\n'");
    expect(shellWord("\u202e")).not.toBe(shellWord("\\u202e"));
  });
  test("timestamps are local dates", () => {
    expect(timestamp(NOW)).toBe(new Date(NOW).toLocaleString());
    expect(timestamp(Number.MAX_SAFE_INTEGER)).toBe("Date unavailable");
  });
  test("JSON-quoted text keeps JSON's escapes and escapes what JSON leaves raw", () => {
    expect(visibleJson('say "hi"\n\\')).toBe('"say \\"hi\\"\\n\\\\"');
    expect(visibleJson("\u202e\u2028\u0085")).toBe(
      '"\\u{202e}\\u{2028}\\u{85}"',
    );
    // A literal escape from the data has its backslash doubled by JSON.
    expect(visibleJson("\\u{202e}")).toBe('"\\\\u{202e}"');
    expect(visibleJson("\u202e")).not.toBe(visibleJson("\\u{202e}"));
  });
  test("controls, bidi formats, separators and lone surrogates are visible", () => {
    expect(
      visible(
        "a\n\r\t\u0000\u001b\u007f\u0085\u200b\u202e\u2066\u2069\u2028\u2029\ud800-\udfffz",
      ),
    ).toBe(
      "a\\u{a}\\u{d}\\u{9}\\u{0}\\u{1b}\\u{7f}\\u{85}\\u{200b}\\u{202e}\\u{2066}\\u{2069}\\u{2028}\\u{2029}\\u{d800}-\\u{dfff}z",
    );
  });
  test("literal escapes stay distinct; ordinary Unicode and markup stay text", () => {
    expect(
      visible("\\u{202e} \\n <img src=x onerror=alert(1)> 日本語 😀"),
    ).toBe("\\\\u{202e} \\\\n <img src=x onerror=alert(1)> 日本語 😀");
    expect(visible("\u202e")).not.toBe(visible("\\u{202e}"));
  });
  test("every C0 and C1 control is escaped", () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code > 0x1f && code < 0x7f) continue;
      expect(visible(String.fromCharCode(code))).toBe(
        `\\u{${code.toString(16)}}`,
      );
    }
  });
});

describe("immutable pending snapshots", () => {
  test("copies and freezes all identity and display fields", () => {
    const original = request();
    const [snapshot] = pendingSnapshot({ pending: [original] });
    original.url = "https://attacker.invalid";
    expect(snapshot.url).toBe("https://api.github.com/graphql");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(sameRecord(snapshot, { ...snapshot })).toBe(true);
    for (const field of [
      "ref",
      "session",
      "cwd",
      "command",
      "method",
      "url",
      "reason",
      "body",
      "since",
      "expiresAt",
    ]) {
      expect(sameRecord(snapshot, { ...snapshot, [field]: "different" })).toBe(
        false,
      );
    }
  });
  test("rejects malformed identities, timestamps, bodies and duplicate identities", () => {
    for (const override of [
      { session: "ends-" },
      { n: "x" },
      { command: "claude" },
      { exec: { argv: [], cwd: "/w", env: {} }, body: undefined },
      { exec: { argv: ["ls"], cwd: "/w", env: { A: 1 } }, body: undefined },
      { exec: { argv: ["ls"], cwd: "/w", env: {} } },
      { since: NaN },
      { since: -1 },
      { expiresAt: NOW - 2000 },
      { body: null },
      { url: {} },
      { since: 1.5 },
    ])
      expect(() => pendingSnapshot({ pending: [request(override)] })).toThrow();
    expect(() =>
      pendingSnapshot({ pending: [{ ...request(), ref: "forged" }] }),
    ).toThrow();
    // The session shown must be the one the decision goes to.
    expect(() =>
      pendingSnapshot({
        pending: [{ ...request(), ref: "other-1.x7mq4ndp" }],
      }),
    ).toThrow();
    expect(() =>
      pendingSnapshot({ pending: [request(), request()] }),
    ).toThrow();
    expect(() => pendingSnapshot({ pending: {} })).toThrow();
  });
});

describe("launch token and polling", () => {
  test("removes the fragment before fetching and sends only a Bearer token", async () => {
    const h = harness();
    await tick();
    expect(h.events[0]).toEqual(["replaceState", null, "", "/"]);
    expect(h.location.hash).toBe("");
    expect(h.calls[0]).toEqual({
      path: "/api/pending",
      options: {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      },
    });
    expect([...h.intervals.values()][0].ms).toBe(2000);
    expect(h.node("fields").textContent).not.toContain(TOKEN);
    h.app.stop();
  });
  test("missing or invalid tokens never make requests or start polling", async () => {
    for (const token of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      `${TOKEN}&other=value`,
    ]) {
      const h = harness({ token });
      await h.app.refresh();
      expect(h.calls).toHaveLength(0);
      expect(h.intervals.size).toBe(0);
      expect(h.node("refresh").disabled).toBe(true);
      expect(h.node("status").textContent).toContain("reopen its launch link");
      expect(h.location.hash).toBe("");
    }
  });
  test("fails closed if the fragment cannot be removed", () => {
    expect(
      takeToken(
        { hash: `#${TOKEN}`, pathname: "/" },
        {
          replaceState() {
            throw new Error("blocked");
          },
        },
      ),
    ).toBe("");
  });
  test("polls do not overlap and hidden tabs do not poll", async () => {
    const loading = deferred();
    const h = harness({ fetch: () => loading.promise });
    await h.app.refresh();
    await h.app.refresh();
    expect(h.calls).toHaveLength(1);
    loading.resolve(response({ pending: [request()] }));
    await tick();
    h.document.hidden = true;
    await h.app.refresh();
    expect(h.calls).toHaveLength(1);
    h.app.stop();
  });
});

describe("review and one-request decisions", () => {
  test("selects the initial request and renders hostile strings as inert visible text", async () => {
    const hostile = "<script>alert(1)</script>\n\u202e\\n\ud800";
    const h = harness({
      pending: [
        request({ url: hostile, cwd: hostile, reason: hostile, body: hostile }),
      ],
    });
    await tick();
    expect(h.node("request-details").hidden).toBe(false);
    expect(h.document.activeElement).toBe(h.listButton());
    expect(decisions(h)).toHaveLength(0);
    const button = h.listButton();
    button.click();
    expect(h.listButton()).toBe(button);
    expect(button.attributes.get("aria-pressed")).toBe("true");
    expect(h.node("fields").textContent).toContain(visible(hostile));
    expect(h.node("fields").textContent).not.toContain("\u202e");
    expect(h.node("actions").children).toHaveLength(2);
    expect(decisions(h)).toHaveLength(0);
    h.app.stop();
  });
  test("an empty inbox focuses the oldest new request, including after the last decision", async () => {
    const h = harness({ pending: [] });
    try {
      await tick();
      expect(h.node("actions").children).toHaveLength(0);
      expect(h.document.activeElement).toBeUndefined();
      const oldest = request({ session: "older", since: NOW - 3000 });
      h.setPending([request(), oldest]);
      await h.app.refresh();
      expect(h.node("request-details").hidden).toBe(false);
      expect(h.node("fields").textContent).toContain(oldest.ref);
      expect(h.document.activeElement).toBe(h.listButton(1));
      expect(decisions(h)).toHaveLength(0);

      h.deny().click();
      await tick();
      h.approve().click();
      await tick();
      expect(h.node("request-list").children).toHaveLength(0);
      expect(h.node("request-details").hidden).toBe(true);

      const next = request({ n: "2" });
      h.setPending([next]);
      await h.app.refresh();
      expect(h.node("fields").textContent).toContain(next.ref);
      expect(h.document.activeElement).toBe(h.listButton());
      expect(decisions(h)).toHaveLength(2);
    } finally {
      h.app.stop();
    }
  });
  test("new requests do not replace an existing selection or reset its scroll", async () => {
    const h = harness();
    try {
      await tick();
      const approve = h.approve();
      h.node("details-scroll").scrollTop = 300;
      h.node("refresh").focus();
      h.setPending([request(), request({ n: "2", since: NOW - 3000 })]);
      await h.app.refresh();
      expect(h.approve()).toBe(approve);
      expect(h.listButton().attributes.get("aria-pressed")).toBe("true");
      expect(h.document.activeElement).toBe(h.node("refresh"));
      expect(h.node("details-scroll").scrollTop).toBe(300);
      expect(decisions(h)).toHaveLength(0);
    } finally {
      h.app.stop();
    }
  });
  test("a host command is shown one argument per line, never as a plain request", async () => {
    const hostile = "a b\n\u202e";
    const h = harness({
      pending: [
        request({
          method: "POST",
          url: "https://hostexec.strait.invalid/run",
          body: undefined,
          exec: { argv: ["rm", hostile], cwd: "/w/x", env: { K: "v" } },
        }),
      ],
      inheritedEnv: ["PATH", "HOME"],
    });
    await tick();
    const row = h.listButton().textContent;
    expect(row).toContain("Host command");
    expect(row).toContain("rm $'a b\\n\\u202e'");
    h.listButton().click();
    const fields = h.node("fields").textContent;
    expect(fields).toContain("Command, run on the host");
    expect(fields).toContain("rm $'a b\\n\\u202e'");
    expect(fields).toContain("/w/x");
    expect(fields).toContain("PATH, HOME from the host, plus:\nK=v");
    expect(fields).not.toContain("Body (captured raw string)");
    expect(fields).not.toContain("Session command");
    const tips = new Map(
      h
        .node("fields")
        .children.filter((child) => child.tagName === "dt")
        .map((term) => [term.textContent, term.attributes.get("title")]),
    );
    expect(tips.get("Command, run on the host")).toContain("Shell words");
    expect(tips.get("Command directory")).toContain("backslashes are doubled");
    expect(tips.get("Since")).toBeUndefined();
    expect(h.node("body-note").textContent).toContain(
      "runs this command on the host",
    );
    h.app.stop();
  });
  test("a GraphQL body shows its query as lines and its variables as indented JSON", async () => {
    const body = JSON.stringify({
      query: "mutation($b: String!) {\n\tadd(body: $b) {\n\t\tid\n\t}\n}",
      variables: { b: 'LGTM\n"ok"\u202e' },
    });
    const h = harness({ pending: [request({ body })] });
    await tick();
    h.listButton().click();
    const fields = h.node("fields").textContent;
    expect(fields).toContain(
      "GraphQL query" +
        "mutation($b: String!) {\n\tadd(body: $b) {\n\t\tid\n\t}\n}",
    );
    expect(fields).toContain(
      'GraphQL variables{\n  "b": "LGTM\\n\\"ok\\"\\u{202e}"\n}',
    );
    expect(fields).toContain(visible(body));
    expect(fields).not.toContain("\u202e");
    expect(h.node("body-note").textContent).toContain("decoded");
    h.app.stop();
  });
  test("GraphQL tabs stay distinct from literal escapes and other controls remain visible", () => {
    const query = '\tquery { field(arg: """\n\ttext\\u{9}\u202e\r\0\n""") }';
    expect(graphqlParts(JSON.stringify({ query })).query).toEqual([
      '\tquery { field(arg: """',
      "\ttext\\\\u{9}\\u{202e}\\u{d}\\u{0}",
      '""") }',
    ]);
    // The exception belongs only to the decoded query display.
    expect(visible("\t")).toBe("\\u{9}");
  });
  test("a body that is not a GraphQL object is shown raw only", () => {
    for (const body of ["", "[]", "null", '{"q":1}', '{"query":1}', "{"]) {
      expect(graphqlParts(body)).toBeNull();
    }
    expect(
      graphqlParts('{"query":"a\\r\\nb\\u202e","operationName":"O","x":[1]}'),
    ).toEqual({
      query: ["a", "b\\u{202e}"],
      operationName: '"O"',
      rest: ["{", '  "x": [', "    1", "  ]", "}"],
    });
  });
  test("unknown and captured-empty bodies are distinct", async () => {
    const h = harness({
      pending: [request({ body: undefined }), request({ n: "2", body: "" })],
    });
    await tick();
    h.listButton().click();
    expect(h.node("fields").textContent).toContain("Unavailable");
    expect(h.node("body-note").textContent).toContain("does not mean");
    h.listButton(1).click();
    expect(h.node("fields").textContent).not.toContain("Unavailable");
    expect(h.node("body-note").textContent).toContain("empty string");
    h.app.stop();
  });
  test("switching requests resets detail scrolling while unchanged polls retain it", async () => {
    const h = harness({ pending: [request(), request({ n: "2" })] });
    try {
      await tick();
      h.listButton().click();
      h.node("details-scroll").scrollTop = 300;
      await h.app.refresh();
      expect(h.node("details-scroll").scrollTop).toBe(300);
      h.listButton(1).click();
      expect(h.node("details-scroll").scrollTop).toBe(0);
    } finally {
      h.app.stop();
    }
  });
  test("approval sends exactly the selected immutable identity and selects the next request", async () => {
    const holding = deferred();
    const first = request();
    const second = request({ n: "2" });
    const h = harness({ pending: [first, second] });
    await tick();
    h.listButton(1).click();
    const approve = h.approve();
    h.setDecisionResponse(holding.promise);
    approve.click();
    approve.click({ force: true });
    expect(decisions(h)).toHaveLength(1);
    expect(JSON.parse(decisions(h)[0].options.body)).toEqual({
      ref: second.ref,
      approve: true,
    });
    holding.resolve(response({ ok: true }));
    await tick();
    expect(h.node("actions").children).toHaveLength(2);
    expect(h.node("request-details").hidden).toBe(false);
    expect(h.node("status").textContent).toContain(
      "does not mean the upstream operation succeeded",
    );
    expect(h.listButton().attributes.get("aria-pressed")).toBe("true");
    expect(h.document.activeElement).toBe(h.listButton());
    expect(h.node("fields").textContent).toContain(first.ref);
    approve.click({ force: true });
    expect(decisions(h)).toHaveLength(1);
    h.app.stop();
  });
  test.each([
    true,
    false,
  ])("decision %s focuses the oldest unexpired request across sessions", async (approve) => {
    const holding = deferred();
    const newest = request({ n: "2", since: NOW - 100 });
    const expired = request({ n: "3", since: NOW - 5000, expiresAt: NOW + 1 });
    const oldest = request({ session: "another", since: NOW - 3000 });
    const h = harness({ pending: [request(), newest, expired, oldest] });
    try {
      await tick();
      h.listButton().click();
      h.node("details-scroll").scrollTop = 400;
      h.setDecisionResponse(holding.promise);
      (approve ? h.approve() : h.deny()).click();
      h.setNow(NOW + 2);
      holding.resolve(response({ ok: true }));
      await tick();
      expect(h.node("fields").textContent).toContain(oldest.ref);
      expect(h.listButton(2).attributes.get("aria-pressed")).toBe("true");
      expect(h.document.activeElement).toBe(h.listButton(2));
      expect(h.node("details-scroll").scrollTop).toBe(0);
      expect(decisions(h)).toHaveLength(1);
      h.approve().click();
      await tick();
      expect(JSON.parse(decisions(h)[1].options.body).ref).toBe(oldest.ref);
      expect(h.node("fields").textContent).toContain(newest.ref);
    } finally {
      h.app.stop();
    }
  });
  test("denial sends approve false for just one request", async () => {
    const h = harness();
    await tick();
    h.listButton().click();
    h.deny().click();
    await tick();
    expect(JSON.parse(decisions(h)[0].options.body).approve).toBe(false);
    expect(h.node("status").textContent).toBe("Denied one request.");
    expect(h.node("actions").children).toHaveLength(0);
    expect(h.node("request-details").hidden).toBe(true);
    h.app.stop();
  });
  test("a button detached by selecting another record cannot decide either record", async () => {
    const h = harness({ pending: [request(), request({ n: "2" })] });
    await tick();
    h.listButton().click();
    const oldApprove = h.approve();
    h.listButton(1).click();
    oldApprove.click({ force: true });
    expect(decisions(h)).toHaveLength(0);
    h.app.stop();
  });
  test("unchanged refresh retains the selection and list button", async () => {
    const h = harness();
    await tick();
    h.listButton().click();
    const approve = h.approve();
    const listButton = h.listButton();
    h.setPending([{ ...request() }]);
    await h.app.refresh();
    expect(h.approve()).toBe(approve);
    expect(h.listButton()).toBe(listButton);
    expect(approve.disabled).toBe(false);
    h.app.stop();
  });
  test("any changed selected field clears and disables the old decision buttons", async () => {
    for (const override of [
      { url: "https://api.github.com/user" },
      { reason: "changed" },
      { body: "changed" },
      { cwd: "/elsewhere" },
      { command: ["other"] },
      { expiresAt: NOW + 1000 },
    ]) {
      const h = harness();
      await tick();
      h.listButton().click();
      const oldApprove = h.approve();
      h.setPending([request(override)]);
      await h.app.refresh();
      expect(oldApprove.disabled).toBe(true);
      oldApprove.click({ force: true });
      expect(decisions(h)).toHaveLength(0);
      expect(h.node("actions").children).toHaveLength(0);
      expect(h.node("selection-help").textContent).toContain(
        "changed, expired or is no longer pending",
      );
      h.app.stop();
    }
  });
  test("disappearance does not switch the action target to another request", async () => {
    const h = harness({ pending: [request(), request({ n: "2" })] });
    await tick();
    h.listButton().click();
    const approve = h.approve();
    h.setPending([request({ n: "2" })]);
    await h.app.refresh();
    approve.click({ force: true });
    expect(decisions(h)).toHaveLength(0);
    expect(h.node("actions").children).toHaveLength(0);
    h.app.stop();
  });
  test("expired requests cannot be decided, even before the timer fires", async () => {
    const h = harness();
    await tick();
    h.listButton().click();
    const approve = h.approve();
    h.setNow(NOW + 240000);
    approve.click();
    expect(decisions(h)).toHaveLength(0);
    expect(h.node("actions").children).toHaveLength(0);
    expect(h.node("status").textContent).toContain("expired");
    h.app.stop();
  });
  test("expiry timer disables the displayed approval", async () => {
    const h = harness();
    await tick();
    h.listButton().click();
    const approve = h.approve();
    h.setNow(NOW + 240000);
    [...h.timeouts.values()][0].fn();
    expect(approve.disabled).toBe(true);
    approve.click({ force: true });
    expect(decisions(h)).toHaveLength(0);
    h.app.stop();
  });
  test("a refresh failure clears approval authority", async () => {
    let fail = false;
    const h = harness({
      fetch: async () => {
        if (fail) throw new Error("network lost");
        return response({ pending: [request()] });
      },
    });
    await tick();
    h.listButton().click();
    const approve = h.approve();
    fail = true;
    await h.app.refresh();
    approve.click({ force: true });
    expect(decisions(h)).toHaveLength(0);
    expect(h.node("actions").children).toHaveLength(0);
    expect(h.node("status").textContent).toContain("Could not refresh");
    h.app.stop();
  });
  test("stale and failed decision responses never retry or retain a selection", async () => {
    for (const reply of [
      response({ error: "stale" }, 409),
      response({ error: "failed" }, 500),
      response({ ok: false }),
    ]) {
      const h = harness({ pending: [request(), request({ n: "2" })] });
      await tick();
      const focused = h.document.activeElement;
      h.listButton().click();
      h.setDecisionResponse(reply);
      h.approve().click();
      await tick();
      expect(decisions(h)).toHaveLength(1);
      expect(h.node("actions").children).toHaveLength(0);
      expect(h.document.activeElement).toBe(focused);
      expect(h.node("status").textContent).not.toContain(
        "Approved one request",
      );
      h.app.stop();
    }
  });
  test("a refresh started before a decision cannot restore its old pending state", async () => {
    const loading = deferred();
    let pendingCalls = 0;
    const h = harness({
      fetch: async (path) => {
        if (path === "/api/decision") return response({ ok: true });
        pendingCalls += 1;
        return pendingCalls === 1
          ? response({ pending: [request()] })
          : loading.promise;
      },
    });
    await tick();
    h.listButton().click();
    const refresh = h.app.refresh();
    h.approve().click();
    await tick();
    loading.resolve(response({ pending: [request()] }));
    await refresh;
    expect(h.node("request-list").children).toHaveLength(0);
    expect(h.node("actions").children).toHaveLength(0);
    expect(h.node("status").textContent).toContain("Approved one request");
    h.app.stop();
  });
});

describe("static asset safety", () => {
  test("uses only self-hosted static assets and no inline handlers or styles", async () => {
    const html = await Bun.file(
      new URL("./index.html", import.meta.url),
    ).text();
    const css = await Bun.file(new URL("./style.css", import.meta.url)).text();
    const script = await Bun.file(new URL("./app.js", import.meta.url)).text();
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('href="/style.css"');
    expect(html).not.toMatch(
      /\son\w+=|\sstyle=|<style\b|autofocus|https?:\/\//i,
    );
    expect(css).toContain("direction: ltr");
    expect(css).toContain("unicode-bidi: isolate");
    expect(script).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage/,
    );
  });
});
