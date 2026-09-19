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
  expect(vm.title).toBe("POST api.anthropic.com:443");
  expect(vm.scopes.map((s) => s.value)).toEqual(["once", "host-port"]);
  expect(vm.reason.label).toBe("the matched rule asks for review");
});

test("network card shows a violation's label in place of its value", () => {
  const vm = cardViewModel("network", {
    sessionId: "s1",
    requestId: "r1",
    host: "api.github.com",
    port: 443,
    approvalScopes: ["once", "violation"],
    violations: [
      {
        pointer: "/query",
        value: "0b6f3c1e-2d4a-4f7b-9c8e-5a1d2e3f4a5b",
        label: "document:(unanalysable)",
      },
      { pointer: "/query", value: "argument:owner=other-org", label: null },
    ],
  });
  expect(vm.violations.map((v) => v.label)).toEqual([
    "/query = document:(unanalysable)",
    "/query = argument:owner=other-org",
  ]);
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
  expect(vm.title).toBe("bun run test");
  expect(vm.warning).toContain("changed");
  expect(vm.selectedScope).toBe("capability");
  expect(vm.scopes.map((s) => s.value)).toEqual(["once", "capability"]);
});

test("unknown domain returns null", () => {
  expect(cardViewModel("other", {})).toBeNull();
});
