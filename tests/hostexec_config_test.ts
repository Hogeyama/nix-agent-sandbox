import { assertEquals, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  validateConfig,
} from "../src/config/validate.ts";

Deno.test("hostexec config: validates secrets and rules", () => {
  const config = validateConfig({
    profiles: {
      test: {
        agent: "claude",
        secrets: {
          github_token: { from: "env:GITHUB_TOKEN", required: true },
        },
        hostexec: {
          prompt: {
            notify: "desktop",
          },
          rules: [
            {
              id: "git-readonly",
              match: { argv0: "git", subcommands: ["pull", "fetch"] },
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
    config.profiles.test.secrets?.github_token.from,
    "env:GITHUB_TOKEN",
  );
  assertEquals(config.profiles.test.hostexec?.rules[0].inheritEnv.keys, [
    "SSH_AUTH_SOCK",
  ]);
  assertEquals(config.profiles.test.hostexec?.prompt.notify, "desktop");
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
                match: { argv0: "git", subcommands: ["pull"] },
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

Deno.test("hostexec config: rejects missing rule id", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                match: { argv0: "git", subcommands: ["pull"] },
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
                match: { argv0: "git", subcommands: ["pull"] },
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

Deno.test("hostexec config: allows omitted subcommands for any subcommand", () => {
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
    config.profiles.test.hostexec?.rules[0].match.subcommands,
    undefined,
  );
});

Deno.test("hostexec config: rejects empty subcommands array", () => {
  assertThrows(
    () =>
      validateConfig({
        profiles: {
          test: {
            agent: "claude",
            hostexec: {
              rules: [{
                id: "git-any",
                match: { argv0: "git", subcommands: [] },
              }],
            },
          },
        },
      }),
    ConfigValidationError,
    "match.subcommands",
  );
});
