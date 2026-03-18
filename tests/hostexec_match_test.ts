import { assertEquals } from "@std/assert";
import { matchRule } from "../src/hostexec/match.ts";
import type { HostExecRule } from "../src/config/types.ts";
import {
  DEFAULT_HOSTEXEC_CWD_CONFIG,
  DEFAULT_HOSTEXEC_INHERIT_ENV_CONFIG,
} from "../src/config/types.ts";

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

Deno.test("matchRule: argv0 only matches", () => {
  const rules = [makeRule("git-any", { argv0: "git" })];
  const result = matchRule(rules, "git", ["status"]);
  assertEquals(result?.rule.id, "git-any");
});

Deno.test("matchRule: argv0 mismatch returns null", () => {
  const rules = [makeRule("git-any", { argv0: "git" })];
  const result = matchRule(rules, "deno", ["eval"]);
  assertEquals(result, null);
});

Deno.test("matchRule: arg-regex matches first positional arg", () => {
  const rules = [
    makeRule("git-push", { argv0: "git", argRegex: "^push\\b" }),
    makeRule("git-any", { argv0: "git" }),
  ];
  const result = matchRule(rules, "git", ["push", "origin", "main"]);
  assertEquals(result?.rule.id, "git-push");
});

Deno.test("matchRule: arg-regex mismatch falls through to catch-all", () => {
  const rules = [
    makeRule("git-push", { argv0: "git", argRegex: "^push\\b" }),
    makeRule("git-any", { argv0: "git" }),
  ];
  const result = matchRule(rules, "git", ["status"]);
  assertEquals(result?.rule.id, "git-any");
});

Deno.test("matchRule: arg-regex for gpg sign flags", () => {
  const rules = [
    makeRule("gpg-sign", {
      argv0: "gpg",
      argRegex: "(^|\\s)(--sign|-[a-zA-Z]*s)(\\s|$)",
    }),
    makeRule("gpg-any", { argv0: "gpg" }),
  ];
  const result = matchRule(rules, "gpg", ["--sign", "file.txt"]);
  assertEquals(result?.rule.id, "gpg-sign");
});

Deno.test("matchRule: arg-regex with short option", () => {
  const rules = [
    makeRule("gpg-sign", {
      argv0: "gpg",
      argRegex: "(^|\\s)(--sign|-[a-zA-Z]*s)(\\s|$)",
    }),
    makeRule("gpg-any", { argv0: "gpg" }),
  ];
  const result = matchRule(rules, "gpg", ["-as", "file.txt"]);
  assertEquals(result?.rule.id, "gpg-sign");
});

Deno.test("matchRule: arg-regex mismatch falls through", () => {
  const rules = [
    makeRule("gpg-sign", {
      argv0: "gpg",
      argRegex: "(^|\\s)(--sign|-[a-zA-Z]*s)(\\s|$)",
    }),
    makeRule("gpg-any", { argv0: "gpg" }),
  ];
  const result = matchRule(rules, "gpg", ["--verify", "file.sig"]);
  assertEquals(result?.rule.id, "gpg-any");
});

Deno.test("matchRule: multi-level subcommand via arg-regex", () => {
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
  assertEquals(result?.rule.id, "deno-task-test");
});

Deno.test("matchRule: arg-regex for task but not test falls through", () => {
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
  assertEquals(result?.rule.id, "deno-task-any");
});

Deno.test("matchRule: no rules returns null", () => {
  const result = matchRule([], "git", ["status"]);
  assertEquals(result, null);
});

Deno.test("matchRule: first matching rule wins", () => {
  const rules = [
    makeRule("gpg-sign", { argv0: "gpg", argRegex: "--sign" }, "prompt"),
    makeRule("gpg-verify", { argv0: "gpg", argRegex: "--verify" }, "allow"),
    makeRule("gpg-default", { argv0: "gpg" }, "deny"),
  ];
  const result = matchRule(rules, "gpg", ["--sign", "file.txt"]);
  assertEquals(result?.rule.id, "gpg-sign");
  assertEquals(result?.rule.approval, "prompt");
});

Deno.test("matchRule: no args with argv0-only rule", () => {
  const rules = [makeRule("true-any", { argv0: "true" })];
  const result = matchRule(rules, "true", []);
  assertEquals(result?.rule.id, "true-any");
});
