/**
 * Tests for hostexec-specific config validation.
 * Split from validate_test.ts — covers all "hostexec config:" test cases.
 *
 * Pkl の型検査で保証される構造・型・enum のテストは除去済み。
 * ここではセマンティック検証（secret 参照、overlapping rules 等）のみテストする。
 */

import { expect, test } from "bun:test";
import type { Config, HostExecConfig, Profile } from "./types.ts";
import {
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_NIX_CONFIG,
  DEFAULT_OBSERVABILITY_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
} from "./types.ts";
import { validateConfig } from "./validate.ts";

// ---------------------------------------------------------------------------
// Helper: minimal valid Config / Profile
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    session: DEFAULT_SESSION_CONFIG,
    nix: DEFAULT_NIX_CONFIG,
    docker: DEFAULT_DOCKER_CONFIG,
    network: DEFAULT_NETWORK_CONFIG,
    dbus: DEFAULT_DBUS_CONFIG,
    display: DEFAULT_DISPLAY_CONFIG,
    extraMounts: [],
    env: [],
    hook: DEFAULT_HOOK_CONFIG,
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<Config> & { profiles?: Record<string, Profile> } = {},
): Config {
  return {
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
    profiles: { test: makeProfile() },
    ...overrides,
  };
}

function makeHostexec(overrides: Partial<HostExecConfig> = {}): HostExecConfig {
  return {
    prompt: {
      enable: true,
      timeoutSeconds: 300,
      defaultScope: "capability",
      notify: "auto",
    },
    secrets: {},
    rules: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hostexec config: secret 参照検証
// ---------------------------------------------------------------------------

test("hostexec config: validates secrets and rules", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: makeHostexec({
            secrets: {
              github_token: { from: "env:GITHUB_TOKEN", required: true },
            },
            prompt: {
              enable: true,
              timeoutSeconds: 300,
              defaultScope: "capability",
              notify: "desktop",
            },
            rules: [
              {
                id: "git-readonly",
                match: {
                  argv0: "git",
                  argRegex: "^(pull|fetch)\\b",
                },
                env: { GITHUB_TOKEN: "secret:github_token" },
                inheritEnv: { mode: "minimal", keys: ["SSH_AUTH_SOCK"] },
                cwd: { mode: "workspace-or-session-tmp", allow: [] },
                approval: "prompt",
              },
            ],
          }),
        }),
      },
    }),
  );

  expect(config.profiles.test.hostexec?.secrets.github_token.from).toEqual(
    "env:GITHUB_TOKEN",
  );
  expect(config.profiles.test.hostexec?.rules[0].inheritEnv.keys).toEqual([
    "SSH_AUTH_SOCK",
  ]);
  expect(config.profiles.test.hostexec?.prompt.notify).toEqual("desktop");
  expect(config.profiles.test.hostexec?.rules[0].match.argRegex).toEqual(
    "^(pull|fetch)\\b",
  );
});

test("hostexec config: rejects unknown secret references", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "git-readonly",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: { GITHUB_TOKEN: "secret:missing" },
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow("unknown secret");
});

test("hostexec config: warns on identical match rules", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "git-a",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
                {
                  id: "git-b",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    );
  } finally {
    console.log = origLog;
  }
  expect(warnings.length).toEqual(1);
  expect(warnings[0]).toMatch(/git-a.*git-b.*identical match/);
});

test("hostexec config: warns when catch-all shadows specific rule", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "git-any",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
                {
                  id: "git-pull",
                  match: { argv0: "git", argRegex: "^pull" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    );
  } finally {
    console.log = origLog;
  }
  expect(warnings.find((w) => /shadows/.test(w)) ?? "").toMatch(
    /git-any.*shadows.*git-pull/,
  );
});

test("hostexec config: no warning when specific rule comes before catch-all", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "git-pull",
                  match: { argv0: "git", argRegex: "^pull" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
                {
                  id: "git-any",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    );
  } finally {
    console.log = origLog;
  }
  const shadowWarnings = warnings.filter((w) => /shadows/.test(w));
  expect(shadowWarnings.length).toEqual(0);
});

// ---------------------------------------------------------------------------
// hostexec env key validation (F4)
// ---------------------------------------------------------------------------

test("hostexec config: accepts valid env key names", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: makeHostexec({
            secrets: { tok: { from: "env:TOK", required: true } },
            rules: [
              {
                id: "r1",
                match: { argv0: "git" },
                cwd: { mode: "workspace-or-session-tmp", allow: [] },
                env: { GITHUB_TOKEN: "secret:tok", _MY_VAR: "secret:tok" },
                inheritEnv: { mode: "minimal", keys: [] },
                approval: "prompt",
              },
            ],
          }),
        }),
      },
    }),
  );
  expect(Object.keys(config.profiles.test.hostexec!.rules[0].env)).toEqual([
    "GITHUB_TOKEN",
    "_MY_VAR",
  ]);
});

test("hostexec config: rejects env key starting with digit", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              secrets: { tok: { from: "env:TOK", required: true } },
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: { "1BAD": "secret:tok" },
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow("not a valid environment variable name");
});

test("hostexec config: rejects env key with special characters", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              secrets: { tok: { from: "env:TOK", required: true } },
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: { "MY-VAR": "secret:tok" },
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow("not a valid environment variable name");
});

// ---------------------------------------------------------------------------
// hostexec cwd.allow cross-field constraint (F5)
// ---------------------------------------------------------------------------

test("hostexec config: accepts cwd.allow with mode=allowlist", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: makeHostexec({
            rules: [
              {
                id: "r1",
                match: { argv0: "git" },
                cwd: { mode: "allowlist", allow: ["/home/user/projects"] },
                env: {},
                inheritEnv: { mode: "minimal", keys: [] },
                approval: "prompt",
              },
            ],
          }),
        }),
      },
    }),
  );
  expect(config.profiles.test.hostexec!.rules[0].cwd.allow).toEqual([
    "/home/user/projects",
  ]);
});

test("hostexec config: accepts empty cwd.allow with any mode", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: makeHostexec({
            rules: [
              {
                id: "r1",
                match: { argv0: "git" },
                cwd: { mode: "workspace-only", allow: [] },
                env: {},
                inheritEnv: { mode: "minimal", keys: [] },
                approval: "prompt",
              },
            ],
          }),
        }),
      },
    }),
  );
  expect(config.profiles.test.hostexec!.rules[0].cwd.mode).toEqual(
    "workspace-only",
  );
});

test("hostexec config: rejects non-empty cwd.allow when mode is not allowlist", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git" },
                  cwd: {
                    mode: "workspace-or-session-tmp",
                    allow: ["/some/path"],
                  },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow(
    'cwd.allow is non-empty but cwd.mode is "workspace-or-session-tmp"',
  );
});

test("hostexec config: rejects non-empty cwd.allow when mode is workspace-only", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-only", allow: ["/tmp"] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow('must be "allowlist"');
});

// ---------------------------------------------------------------------------
// hostexec argRegex syntax validation (F7)
// ---------------------------------------------------------------------------

test("hostexec config: accepts valid argRegex", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: makeHostexec({
            rules: [
              {
                id: "r1",
                match: { argv0: "git", argRegex: "^(pull|fetch)\\b" },
                cwd: { mode: "workspace-or-session-tmp", allow: [] },
                env: {},
                inheritEnv: { mode: "minimal", keys: [] },
                approval: "prompt",
              },
            ],
          }),
        }),
      },
    }),
  );
  expect(config.profiles.test.hostexec!.rules[0].match.argRegex).toEqual(
    "^(pull|fetch)\\b",
  );
});

test("hostexec config: accepts rule without argRegex", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: makeHostexec({
            rules: [
              {
                id: "r1",
                match: { argv0: "git" },
                cwd: { mode: "workspace-or-session-tmp", allow: [] },
                env: {},
                inheritEnv: { mode: "minimal", keys: [] },
                approval: "prompt",
              },
            ],
          }),
        }),
      },
    }),
  );
  expect(
    config.profiles.test.hostexec!.rules[0].match.argRegex,
  ).toBeUndefined();
});

test("hostexec config: rejects invalid argRegex syntax", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git", argRegex: "(unclosed" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow("not a valid regular expression");
});

test("hostexec config: rejects argRegex with invalid escape", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git", argRegex: "[invalid" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow("not a valid regular expression");
});

// ---------------------------------------------------------------------------
// hostexec env: multiple errors collected
// ---------------------------------------------------------------------------

test("hostexec config: collects multiple env errors in a single rule", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: makeHostexec({
              secrets: { tok: { from: "env:TOK", required: true } },
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {
                    NO_PREFIX: "plain-value",
                    UNKNOWN: "secret:nope",
                  },
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                },
              ],
            }),
          }),
        },
      }),
    ),
  ).toThrow("NO_PREFIX");
});
