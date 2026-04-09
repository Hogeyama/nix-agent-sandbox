import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { matchRule } from "./match.ts";
import type { MatchContext } from "./match.ts";
import type { HostExecRule } from "../config/types.ts";
import {
  DEFAULT_HOSTEXEC_CWD_CONFIG,
  DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
} from "../config/types.ts";

function makeRule(
  id: string,
  match: HostExecRule["match"],
  approval: HostExecRule["approval"] = "allow",
): HostExecRule {
  return {
    id,
    match,
    cwd: DEFAULT_HOSTEXEC_CWD_CONFIG,
    env: {},
    inheritEnv: DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
    approval,
    fallback: "container",
  };
}

test("matchRule: argv0 only matches", () => {
  const rules = [makeRule("git-any", { argv0: "git" })];
  const result = matchRule(rules, "git", ["status"]);
  expect(result?.rule.id).toEqual("git-any");
});

test("matchRule: argv0 mismatch returns null", () => {
  const rules = [makeRule("git-any", { argv0: "git" })];
  const result = matchRule(rules, "deno", ["eval"]);
  expect(result).toEqual(null);
});

test("matchRule: arg-regex matches first positional arg", () => {
  const rules = [
    makeRule("git-push", { argv0: "git", argRegex: "^push\\b" }),
    makeRule("git-any", { argv0: "git" }),
  ];
  const result = matchRule(rules, "git", ["push", "origin", "main"]);
  expect(result?.rule.id).toEqual("git-push");
});

test("matchRule: arg-regex mismatch falls through to catch-all", () => {
  const rules = [
    makeRule("git-push", { argv0: "git", argRegex: "^push\\b" }),
    makeRule("git-any", { argv0: "git" }),
  ];
  const result = matchRule(rules, "git", ["status"]);
  expect(result?.rule.id).toEqual("git-any");
});

test("matchRule: arg-regex for gpg sign flags", () => {
  const rules = [
    makeRule("gpg-sign", {
      argv0: "gpg",
      argRegex: "(^|\\s)(--sign|-[a-zA-Z]*s)(\\s|$)",
    }),
    makeRule("gpg-any", { argv0: "gpg" }),
  ];
  const result = matchRule(rules, "gpg", ["--sign", "file.txt"]);
  expect(result?.rule.id).toEqual("gpg-sign");
});

test("matchRule: arg-regex with short option", () => {
  const rules = [
    makeRule("gpg-sign", {
      argv0: "gpg",
      argRegex: "(^|\\s)(--sign|-[a-zA-Z]*s)(\\s|$)",
    }),
    makeRule("gpg-any", { argv0: "gpg" }),
  ];
  const result = matchRule(rules, "gpg", ["-as", "file.txt"]);
  expect(result?.rule.id).toEqual("gpg-sign");
});

test("matchRule: arg-regex mismatch falls through", () => {
  const rules = [
    makeRule("gpg-sign", {
      argv0: "gpg",
      argRegex: "(^|\\s)(--sign|-[a-zA-Z]*s)(\\s|$)",
    }),
    makeRule("gpg-any", { argv0: "gpg" }),
  ];
  const result = matchRule(rules, "gpg", ["--verify", "file.sig"]);
  expect(result?.rule.id).toEqual("gpg-any");
});

test("matchRule: multi-level subcommand via arg-regex", () => {
  const rules = [
    makeRule("deno-task-test", {
      argv0: "deno",
      argRegex: "^task\\s+test\\b",
    }),
    makeRule("deno-task-any", {
      argv0: "deno",
      argRegex: "^task\\b",
    }),
    makeRule("deno-any", { argv0: "deno" }),
  ];
  const result = matchRule(rules, "deno", [
    "task",
    "test",
    "--filter",
    "foo",
  ]);
  expect(result?.rule.id).toEqual("deno-task-test");
});

test("matchRule: arg-regex for task but not test falls through", () => {
  const rules = [
    makeRule("deno-task-test", {
      argv0: "deno",
      argRegex: "^task\\s+test\\b",
    }),
    makeRule("deno-task-any", {
      argv0: "deno",
      argRegex: "^task\\b",
    }),
  ];
  const result = matchRule(rules, "deno", ["task", "lint"]);
  expect(result?.rule.id).toEqual("deno-task-any");
});

test("matchRule: no rules returns null", () => {
  const result = matchRule([], "git", ["status"]);
  expect(result).toEqual(null);
});

test("matchRule: first matching rule wins", () => {
  const rules = [
    makeRule("gpg-sign", { argv0: "gpg", argRegex: "--sign" }, "prompt"),
    makeRule("gpg-verify", { argv0: "gpg", argRegex: "--verify" }, "allow"),
    makeRule("gpg-default", { argv0: "gpg" }, "deny"),
  ];
  const result = matchRule(rules, "gpg", ["--sign", "file.txt"]);
  expect(result?.rule.id).toEqual("gpg-sign");
  expect(result?.rule.approval).toEqual("prompt");
});

test("matchRule: no args with argv0-only rule", () => {
  const rules = [makeRule("true-any", { argv0: "true" })];
  const result = matchRule(rules, "true", []);
  expect(result?.rule.id).toEqual("true-any");
});

test("matchRule: relative argv0 rule requires relative invocation", () => {
  const rules = [makeRule("gradlew-any", { argv0: "./gradlew" })];
  const result = matchRule(rules, "./gradlew", ["test"]);
  expect(result?.rule.id).toEqual("gradlew-any");
});

test("matchRule: relative argv0 rule does not match PATH invocation", () => {
  const rules = [makeRule("gradlew-any", { argv0: "./gradlew" })];
  const result = matchRule(rules, "gradlew", ["test"]);
  expect(result).toEqual(null);
});

test("matchRule: absolute argv0 rule matches exact absolute invocation", () => {
  const rules = [makeRule("usr-bin-git", { argv0: "/usr/bin/git" })];
  const result = matchRule(rules, "/usr/bin/git", ["status"]);
  expect(result?.rule.id).toEqual("usr-bin-git");
});

test("matchRule: absolute argv0 rule does not match bare name invocation", () => {
  const rules = [makeRule("usr-bin-git", { argv0: "/usr/bin/git" })];
  const result = matchRule(rules, "git", ["status"]);
  expect(result).toEqual(null);
});

test("matchRule: absolute argv0 rule does not match different absolute path", () => {
  const rules = [makeRule("usr-bin-git", { argv0: "/usr/bin/git" })];
  const result = matchRule(rules, "/usr/local/bin/git", ["status"]);
  expect(result).toEqual(null);
});

test("matchRule: bare rule matches absolute invocation via basename", () => {
  const rules = [makeRule("git-any", { argv0: "git" })];
  const result = matchRule(rules, "/usr/bin/git", ["status"]);
  expect(result?.rule.id).toEqual("git-any");
});

test("matchRule: relative argv0 matches via cwd resolution (cd backend && ./gradlew)", () => {
  const rules = [makeRule("gradlew", { argv0: "./backend/gradlew" })];
  const context: MatchContext = {
    cwd: "/workspace/backend",
    workspaceRoot: "/workspace",
  };
  const result = matchRule(rules, "./gradlew", ["spotlessApply"], context);
  expect(result?.rule.id).toEqual("gradlew");
});

test("matchRule: relative argv0 still matches directly without context", () => {
  const rules = [makeRule("gradlew", { argv0: "./gradlew" })];
  const result = matchRule(rules, "./gradlew", ["test"]);
  expect(result?.rule.id).toEqual("gradlew");
});

test("matchRule: relative argv0 does not match when cwd resolves outside workspace", () => {
  const rules = [makeRule("gradlew", { argv0: "./backend/gradlew" })];
  const context: MatchContext = {
    cwd: "/other",
    workspaceRoot: "/workspace",
  };
  const result = matchRule(rules, "./gradlew", ["test"], context);
  expect(result).toEqual(null);
});

test("matchRule: relative argv0 no match without context when paths differ", () => {
  const rules = [makeRule("gradlew", { argv0: "./backend/gradlew" })];
  const result = matchRule(rules, "./gradlew", ["test"]);
  expect(result).toEqual(null);
});

test("matchRule: nested relative argv0 matches via cwd resolution", () => {
  const rules = [makeRule("mvnw", { argv0: "./services/api/mvnw" })];
  const context: MatchContext = {
    cwd: "/workspace/services/api",
    workspaceRoot: "/workspace",
  };
  const result = matchRule(rules, "./mvnw", ["clean"], context);
  expect(result?.rule.id).toEqual("mvnw");
});
