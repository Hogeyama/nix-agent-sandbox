import { expect, test } from "bun:test";
import { cardViewModel } from "./cards.js";

test("network card keeps method/target and filters unknown scopes", () => {
  const vm = cardViewModel("network", {
    sessionId: "s1",
    requestId: "r1",
    host: "api.anthropic.com",
    port: 443,
    method: "post",
    ruleId: "anthropic.messages",
    askReason: "rule",
    approvalScopes: ["once", "bogus", "host-port"],
    reviewContext: { path: "/v1/messages", bodySize: 1200 },
  });
  expect(vm.verb).toBe("POST");
  expect(vm.summary).toBe("api.anthropic.com:443");
  expect(vm.scopes.map((s) => s.value)).toEqual(["once", "host-port"]);
  expect(vm.reason.label).toBe("the matched rule asks for review");
  expect(vm.reviewContext.path).toBe("/v1/messages");
});

test("network card renders each violation as its own block", () => {
  const vm = cardViewModel("network", {
    sessionId: "s1",
    requestId: "r1",
    host: "api.github.com",
    port: 443,
    approvalScopes: ["once", "violation"],
    violations: [
      {
        at: "/query",
        pointer: "/query",
        value: "0b6f3c1e-2d4a-4f7b-9c8e-5a1d2e3f4a5b",
        label: "document:(unanalysable)",
        excerpt: '{"query":"..."}',
        count: 1,
      },
      {
        at: "/variables",
        pointer: "/variables/owner",
        value: "argument:owner=other-org",
        label: null,
        count: 2,
      },
    ],
  });
  // label は value (読めない UUID) の表示名として先頭に出る。
  expect(vm.violations[0].headline).toBe("document:(unanalysable)");
  expect(vm.violations[0].at).toBe("/query");
  // pointer がセレクタ (at) と同じなら再表示しない。
  expect(vm.violations[0].pointer).toBeNull();
  expect(vm.violations[0].excerpt).toBe('{"query":"..."}');
  expect(vm.violations[1].headline).toBe("argument:owner=other-org");
  expect(vm.violations[1].pointer).toBe("/variables/owner");
  expect(vm.violations[1].count).toBe(2);
});

test("network card falls back to once when scopes are empty", () => {
  const vm = cardViewModel("network", {
    sessionId: "s1",
    requestId: "r1",
    host: "h",
    port: 80,
    approvalScopes: [],
  });
  expect(vm.scopes.map((s) => s.value)).toEqual(["once"]);
});

test("hostexec card joins argv, surfaces integrity warning, defaults scope", () => {
  const vm = cardViewModel("hostexec", {
    sessionId: "s1",
    requestId: "r1",
    argv0: "bun",
    args: ["run", "test"],
    cwd: "/repo",
    ruleId: "dev-tools",
    integrityChanged: true,
    defaultScope: "capability",
  });
  expect(vm.summary).toBe("bun run test");
  expect(vm.warning).toContain("changed");
  expect(vm.selectedScope).toBe("capability");
  expect(vm.scopes.map((s) => s.value)).toEqual(["once", "capability"]);
  expect(vm.matchDetails.map((d) => d.label)).toContain("Rule");
});

test("unknown domain returns null", () => {
  expect(cardViewModel("other", {})).toBeNull();
});
