/**
 * Tests for hostexec-specific config validation.
 * Split from validate_test.ts — covers all "hostexec config:" test cases.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { assertMatch } from "@std/assert/match";
import { ConfigValidationError, validateConfig } from "./validate.ts";

// ---------------------------------------------------------------------------
// hostexec config tests (from tests/hostexec_config_test.ts)
// ---------------------------------------------------------------------------

Deno.test("hostexec config: validates secrets and rules", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          secrets: {
            github_token: { from: "env:GITHUB_TOKEN", required: true },
          },
          prompt: {
            notify: "desktop",
          },
          rules: [
            {
              id: "git-readonly",
              match: {
                argv0: "git",
                "arg-regex": "^(pull|fetch)\\b",
              },
              env: { GITHUB_TOKEN: "secret:github_token" },
              "inherit-env": { mode: "minimal", keys: ["SSH_AUTH_SOCK"] },
              cwd: { mode: "workspace-or-session-tmp" },
              approval: "prompt",
              fallback: "container",
            },
          ],
        },
      },
    },
  });

  assertEquals(
    config.profiles.test.hostexec?.secrets.github_token.from,
    "env:GITHUB_TOKEN",
  );
  assertEquals(config.profiles.test.hostexec?.rules[0].inheritEnv.keys, [
    "SSH_AUTH_SOCK",
  ]);
  assertEquals(config.profiles.test.hostexec?.prompt.notify, "desktop");
  assertEquals(
    config.profiles.test.hostexec?.rules[0].match.argRegex,
    "^(pull|fetch)\\b",
  );
});

Deno.test("hostexec config: rejects unknown secret references", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-readonly",
                match: { argv0: "git" },
                env: { GITHUB_TOKEN: "secret:missing" },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "unknown secret",
  );
});

Deno.test("hostexec config: rejects legacy profile secrets", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            secrets: {
              github_token: { from: "env:GITHUB_TOKEN", required: true },
            },
          } as never,
        },
      }),
    ConfigValidationError,
    "secrets has moved to hostexec.secrets",
  );
});

Deno.test("hostexec config: rejects missing rule id", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                match: { argv0: "git" },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "hostexec.rules[0].id",
  );
});

Deno.test("hostexec config: rejects invalid inherit-env mode", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-readonly",
                match: { argv0: "git" },
                "inherit-env": { mode: "all" as never },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "inherit-env.mode",
  );
});

Deno.test("hostexec config: rejects invalid notify backend", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              prompt: {
                notify: "dbus" as never,
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "hostexec.prompt.notify must be one of",
  );
});

Deno.test("hostexec config: allows argv0-only match for catch-all", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          rules: [{
            id: "git-any",
            match: { argv0: "git" },
          }],
        },
      },
    },
  });

  assertEquals(
    config.profiles.test.hostexec?.rules[0].match.argRegex,
    undefined,
  );
});

Deno.test("hostexec config: accepts once as default-scope", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          prompt: {
            "default-scope": "once",
          },
        },
      },
    },
  });
  assertEquals(config.profiles.test.hostexec?.prompt.defaultScope, "once");
});

Deno.test("hostexec config: rejects invalid default-scope", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              prompt: {
                "default-scope": "session" as never,
              },
            },
          },
        },
      }),
    ConfigValidationError,
    "hostexec.prompt.default-scope must be one of",
  );
});

Deno.test("hostexec config: rejects invalid arg-regex", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-any",
                match: { argv0: "git", "arg-regex": "[invalid" },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "arg-regex is not a valid regular expression",
  );
});

Deno.test("hostexec config: warns on identical match rules", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              { id: "git-a", match: { argv0: "git" } },
              { id: "git-b", match: { argv0: "git" } },
            ],
          },
        },
      },
    });
  } finally {
    console.log = origLog;
  }
  assertEquals(warnings.length, 1);
  assertMatch(warnings[0], /git-a.*git-b.*identical match/);
});

Deno.test("hostexec config: warns when catch-all shadows specific rule", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              { id: "git-any", match: { argv0: "git" } },
              {
                id: "git-pull",
                match: { argv0: "git", "arg-regex": "^pull" },
              },
            ],
          },
        },
      },
    });
  } finally {
    console.log = origLog;
  }
  assertMatch(
    warnings.find((w) => /shadows/.test(w)) ?? "",
    /git-any.*shadows.*git-pull/,
  );
});

Deno.test("hostexec config: no warning when specific rule comes before catch-all", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig({
      profiles: {
        test: {
          agent: "claude",
          hostexec: {
            rules: [
              {
                id: "git-pull",
                match: { argv0: "git", "arg-regex": "^pull" },
              },
              { id: "git-any", match: { argv0: "git" } },
            ],
          },
        },
      },
    });
  } finally {
    console.log = origLog;
  }
  const shadowWarnings = warnings.filter((w) => /shadows/.test(w));
  assertEquals(shadowWarnings.length, 0);
});

Deno.test("hostexec config: rejects relative argv0 with fallback container", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "gradlew",
                match: { argv0: "./gradlew" },
                fallback: "container",
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "relative argv0",
  );
});

Deno.test("hostexec config: allows relative argv0 with fallback deny", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        hostexec: {
          rules: [{
            id: "gradlew",
            match: { argv0: "./gradlew" },
            fallback: "deny",
          }],
        },
      },
    },
  });
  assertEquals(config.profiles.test.hostexec?.rules[0].fallback, "deny");
});

// ---------------------------------------------------------------------------
// Error aggregation: hostexec env superRefine collects multiple issues
// ---------------------------------------------------------------------------

Deno.test("hostexec config: collects multiple env errors in a single rule", () => {
  // hostexecSchema's transform calls ruleSchema.parse() and wraps ZodError
  // into ConfigValidationError, so only the first env issue surfaces.
  // But the env superRefine itself now collects all issues within a rule.
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              secrets: { tok: { from: "env:TOK" } },
              rules: [{
                id: "r1",
                match: { argv0: "git" },
                env: {
                  "BAD-KEY": "secret:tok",
                  "NO_PREFIX": "plain-value",
                  "UNKNOWN": "secret:nope",
                },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "BAD-KEY",
  );
});
