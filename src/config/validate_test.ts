/**
 * Tests for validateConfig function: semantic validation only.
 *
 * Pkl の型検査で保証される構造・型・enum・デフォルト値のテストは除去済み。
 * ここではクロスフィールド制約や実行時セマンティクスの検証のみテストする。
 *
 * See also:
 *   - validate_hostexec_test.ts — hostexec-specific validation
 */

import { expect, test } from "bun:test";
import type { Config, Profile } from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPG_CONFIG,
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
    gcloud: DEFAULT_GCLOUD_CONFIG,
    aws: DEFAULT_AWS_CONFIG,
    gpg: DEFAULT_GPG_CONFIG,
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

// ---------------------------------------------------------------------------
// profiles が存在し空でないこと
// ---------------------------------------------------------------------------

test("validate: profiles is required", () => {
  expect(() => validateConfig({ profiles: {} } as Config)).toThrow(
    "at least one entry",
  );
});

test("validate: empty profiles throws", () => {
  expect(() => validateConfig(makeConfig({ profiles: {} }))).toThrow(
    "at least one entry",
  );
});

// ---------------------------------------------------------------------------
// default profile が profiles に存在すること
// ---------------------------------------------------------------------------

test("validate: default profile exists", () => {
  const config = validateConfig(
    makeConfig({ default: "test", profiles: { test: makeProfile() } }),
  );
  expect(config.default).toEqual("test");
});

test("validate: default profile not in profiles throws", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        default: "missing",
        profiles: { test: makeProfile() },
      }),
    ),
  ).toThrow('default profile "missing" not found');
});

test("validate: no default is ok", () => {
  const config = validateConfig(makeConfig());
  expect(config.default).toEqual(undefined);
});

// ---------------------------------------------------------------------------
// allowlist/denylist ホストリスト形式検証
// ---------------------------------------------------------------------------

test("validate: network.allowlist accepts valid entries", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            allowlist: ["github.com", "api.anthropic.com"],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.allowlist).toEqual([
    "github.com",
    "api.anthropic.com",
  ]);
});

test("validate: network.allowlist accepts wildcard prefix", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            allowlist: ["*.github.com", "api.anthropic.com"],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.allowlist).toEqual([
    "*.github.com",
    "api.anthropic.com",
  ]);
});

test("validate: network.allowlist rejects wildcard in middle", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              allowlist: ["git*hub.com"],
            },
          }),
        },
      }),
    ),
  ).toThrow("contains wildcard");
});

test("validate: network.allowlist rejects trailing wildcard", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              allowlist: ["github.*"],
            },
          }),
        },
      }),
    ),
  ).toThrow("contains wildcard");
});

test("validate: network.prompt.denylist rejects wildcard in middle", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              prompt: {
                ...DEFAULT_NETWORK_CONFIG.prompt,
                denylist: ["ev*il.com"],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("contains wildcard");
});

test("validate: network.allowlist accepts host:port entries", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            allowlist: ["example.com:443", "*.api.com:8080", "plain.com"],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.allowlist).toEqual([
    "example.com:443",
    "*.api.com:8080",
    "plain.com",
  ]);
});

// ---------------------------------------------------------------------------
// allowlist/denylist の重複検出
// ---------------------------------------------------------------------------

test("validate: allowlist and denylist overlap throws", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              allowlist: ["example.com"],
              prompt: {
                ...DEFAULT_NETWORK_CONFIG.prompt,
                denylist: ["example.com"],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("appears in both network.allowlist and network.prompt.denylist");
});

test("validate: allowlist=*.example.com and denylist=sub.example.com is allowed", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            allowlist: ["*.example.com"],
            prompt: {
              ...DEFAULT_NETWORK_CONFIG.prompt,
              denylist: ["sub.example.com"],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.allowlist).toEqual(["*.example.com"]);
  expect(config.profiles.test.network.prompt.denylist).toEqual([
    "sub.example.com",
  ]);
});

test("validate: allowlist=sub.example.com and denylist=*.example.com is allowed", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            allowlist: ["sub.example.com"],
            prompt: {
              ...DEFAULT_NETWORK_CONFIG.prompt,
              denylist: ["*.example.com"],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.allowlist).toEqual(["sub.example.com"]);
  expect(config.profiles.test.network.prompt.denylist).toEqual([
    "*.example.com",
  ]);
});

test("validate: allowlist/denylist overlap with matching port", () => {
  // same host:port in both -> overlap
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              allowlist: ["example.com:443"],
              prompt: {
                ...DEFAULT_NETWORK_CONFIG.prompt,
                denylist: ["example.com:443"],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("appears in both");

  // same host but different ports -> no overlap
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            allowlist: ["example.com:443"],
            prompt: {
              ...DEFAULT_NETWORK_CONFIG.prompt,
              denylist: ["example.com:80"],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.allowlist).toEqual(["example.com:443"]);
});

test("validate: multiple allowlist/denylist overlaps are reported", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              allowlist: ["a.com", "b.com", "c.com"],
              prompt: {
                ...DEFAULT_NETWORK_CONFIG.prompt,
                denylist: ["a.com", "c.com"],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("appears in both");
});

// ---------------------------------------------------------------------------
// forwardPorts の予約ポート(18080)・重複検出
// ---------------------------------------------------------------------------

test("validate: forwardPorts rejects reserved port 18080", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              proxy: { forwardPorts: [18080] },
            },
          }),
        },
      }),
    ),
  ).toThrow(/18080.*reserved/);
});

test("validate: forwardPorts rejects duplicate ports", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              proxy: { forwardPorts: [8080, 3000, 8080] },
            },
          }),
        },
      }),
    ),
  ).toThrow(/duplicate.*8080/);
});

test("validate: forwardPorts accepts valid ports", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          network: {
            ...DEFAULT_NETWORK_CONFIG,
            proxy: { forwardPorts: [8080, 5432] },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.network.proxy.forwardPorts).toEqual([8080, 5432]);
});

// ---------------------------------------------------------------------------
// env の mode/separator 相互依存
// ---------------------------------------------------------------------------

test("validate: env prefix mode with separator is valid", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          env: [
            { key: "PATH", val: "/opt/bin", mode: "prefix", separator: ":" },
          ],
        }),
      },
    }),
  );
  expect(config.profiles.test.env[0]).toEqual({
    key: "PATH",
    val: "/opt/bin",
    mode: "prefix",
    separator: ":",
  });
});

test("validate: env suffix mode with separator is valid", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          env: [
            {
              key: "LD_LIBRARY_PATH",
              val: "/opt/lib",
              mode: "suffix",
              separator: ":",
            },
          ],
        }),
      },
    }),
  );
  expect(config.profiles.test.env[0]).toEqual({
    key: "LD_LIBRARY_PATH",
    val: "/opt/lib",
    mode: "suffix",
    separator: ":",
  });
});

test("validate: env prefix without separator throws", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            env: [{ key: "PATH", val: "/opt/bin", mode: "prefix" }],
          }),
        },
      }),
    ),
  ).toThrow("separator is required");
});

test("validate: env suffix without separator throws", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            env: [{ key: "PATH", val: "/opt/bin", mode: "suffix" }],
          }),
        },
      }),
    ),
  ).toThrow("separator is required");
});

test("validate: env set mode with separator throws", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            env: [{ key: "FOO", val: "bar", mode: "set", separator: ":" }],
          }),
        },
      }),
    ),
  ).toThrow("separator is only allowed");
});

test("validate: env prefix with empty separator allowed", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          env: [{ key: "FLAGS", val: "-Wall", mode: "prefix", separator: "" }],
        }),
      },
    }),
  );
  expect(config.profiles.test.env[0].separator).toEqual("");
});

// ---------------------------------------------------------------------------
// Multiple profiles: errors reference correct name
// ---------------------------------------------------------------------------

test("validate: errors from multiple profiles are reported together", () => {
  let caught: Error | undefined;
  try {
    validateConfig(
      makeConfig({
        profiles: {
          alpha: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              proxy: { forwardPorts: [18080] },
            },
          }),
          beta: makeProfile({
            network: {
              ...DEFAULT_NETWORK_CONFIG,
              proxy: { forwardPorts: [18080] },
            },
          }),
        },
      }),
    );
  } catch (e) {
    caught = e as Error;
  }
  expect(caught).toBeDefined();
  const msg = caught!.message;
  expect(msg.includes('profile "alpha"')).toEqual(true);
  expect(msg.includes('profile "beta"')).toEqual(true);
});

// ---------------------------------------------------------------------------
// hostexec env: secret 参照検証
// ---------------------------------------------------------------------------

test("validate: hostexec env rejects unknown secret references", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: {
              prompt: {
                enable: true,
                timeoutSeconds: 300,
                defaultScope: "capability",
                notify: "auto",
              },
              secrets: {},
              rules: [
                {
                  id: "git-readonly",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: { GITHUB_TOKEN: "secret:missing" },
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
              ],
            },
          }),
        },
      }),
    ),
  ).toThrow("unknown secret");
});

test("validate: hostexec env rejects non-secret references", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: {
              prompt: {
                enable: true,
                timeoutSeconds: 300,
                defaultScope: "capability",
                notify: "auto",
              },
              secrets: { tok: { from: "env:TOK", required: true } },
              rules: [
                {
                  id: "r1",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: { NO_PREFIX: "plain-value" },
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
              ],
            },
          }),
        },
      }),
    ),
  ).toThrow("must use secret:<name> reference");
});

test("validate: hostexec env accepts valid secret references", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          hostexec: {
            prompt: {
              enable: true,
              timeoutSeconds: 300,
              defaultScope: "capability",
              notify: "auto",
            },
            secrets: {
              github_token: { from: "env:GITHUB_TOKEN", required: true },
            },
            rules: [
              {
                id: "git-readonly",
                match: { argv0: "git" },
                cwd: { mode: "workspace-or-session-tmp", allow: [] },
                env: { GITHUB_TOKEN: "secret:github_token" },
                inheritEnv: { mode: "minimal", keys: [] },
                approval: "prompt",
                fallback: "container",
              },
            ],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.hostexec?.rules[0].env.GITHUB_TOKEN).toEqual(
    "secret:github_token",
  );
});

// ---------------------------------------------------------------------------
// hostexec rules: overlapping 警告
// ---------------------------------------------------------------------------

test("validate: hostexec warns on identical match rules", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: {
              prompt: {
                enable: true,
                timeoutSeconds: 300,
                defaultScope: "capability",
                notify: "auto",
              },
              secrets: {},
              rules: [
                {
                  id: "git-a",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
                {
                  id: "git-b",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
              ],
            },
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

test("validate: hostexec warns when catch-all shadows specific rule", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: {
              prompt: {
                enable: true,
                timeoutSeconds: 300,
                defaultScope: "capability",
                notify: "auto",
              },
              secrets: {},
              rules: [
                {
                  id: "git-any",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
                {
                  id: "git-pull",
                  match: { argv0: "git", argRegex: "^pull" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
              ],
            },
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

test("validate: hostexec no warning when specific rule comes before catch-all", () => {
  const warnings: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => warnings.push(msg);
  try {
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            hostexec: {
              prompt: {
                enable: true,
                timeoutSeconds: 300,
                defaultScope: "capability",
                notify: "auto",
              },
              secrets: {},
              rules: [
                {
                  id: "git-pull",
                  match: { argv0: "git", argRegex: "^pull" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
                {
                  id: "git-any",
                  match: { argv0: "git" },
                  cwd: { mode: "workspace-or-session-tmp", allow: [] },
                  env: {},
                  inheritEnv: { mode: "minimal", keys: [] },
                  approval: "prompt",
                  fallback: "container",
                },
              ],
            },
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
// nix.extraPackages の入力検証 (F1)
// ---------------------------------------------------------------------------

test("validate: nix.extraPackages accepts valid package names", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          nix: {
            ...DEFAULT_NIX_CONFIG,
            extraPackages: ["ripgrep", "fd", "jq"],
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.nix.extraPackages).toEqual([
    "ripgrep",
    "fd",
    "jq",
  ]);
});

test("validate: nix.extraPackages rejects entries starting with dash", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            nix: { ...DEFAULT_NIX_CONFIG, extraPackages: ["--malicious"] },
          }),
        },
      }),
    ),
  ).toThrow("flag injection");
});

test("validate: nix.extraPackages rejects entries containing ..", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            nix: {
              ...DEFAULT_NIX_CONFIG,
              extraPackages: ["../../../etc/passwd"],
            },
          }),
        },
      }),
    ),
  ).toThrow("path traversal");
});

test("validate: nix.extraPackages reports both flag injection and path traversal", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            nix: {
              ...DEFAULT_NIX_CONFIG,
              extraPackages: ["-..evil"],
            },
          }),
        },
      }),
    ),
  ).toThrow("flag injection");
});

// ---------------------------------------------------------------------------
// display.size フォーマット検証 (F2)
// ---------------------------------------------------------------------------

test("validate: display.size accepts valid format", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          display: { sandbox: "none", size: "1920x1080" },
        }),
      },
    }),
  );
  expect(config.profiles.test.display.size).toEqual("1920x1080");
});

test("validate: display.size accepts minimum 1x1", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          display: { sandbox: "none", size: "1x1" },
        }),
      },
    }),
  );
  expect(config.profiles.test.display.size).toEqual("1x1");
});

test("validate: display.size accepts maximum 16384x16384", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          display: { sandbox: "none", size: "16384x16384" },
        }),
      },
    }),
  );
  expect(config.profiles.test.display.size).toEqual("16384x16384");
});

test("validate: display.size rejects invalid format", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            display: { sandbox: "none", size: "1920:1080" },
          }),
        },
      }),
    ),
  ).toThrow("display.size");
});

test("validate: display.size rejects non-numeric dimensions", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            display: { sandbox: "none", size: "abcxdef" },
          }),
        },
      }),
    ),
  ).toThrow("display.size");
});

test("validate: display.size rejects width 0", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            display: { sandbox: "none", size: "0x1080" },
          }),
        },
      }),
    ),
  ).toThrow("out of range");
});

test("validate: display.size rejects height exceeding 16384", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            display: { sandbox: "none", size: "1920x16385" },
          }),
        },
      }),
    ),
  ).toThrow("out of range");
});

// ---------------------------------------------------------------------------
// D-Bus ルール名の検証 (F3)
// ---------------------------------------------------------------------------

test("validate: dbus.session.talk accepts valid D-Bus names", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          dbus: {
            session: {
              ...DEFAULT_DBUS_CONFIG.session,
              enable: true,
              talk: ["org.freedesktop.Notifications"],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.dbus.session.talk).toEqual([
    "org.freedesktop.Notifications",
  ]);
});

test("validate: dbus.session.see rejects names containing =", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            dbus: {
              session: {
                ...DEFAULT_DBUS_CONFIG.session,
                enable: true,
                see: ["org.foo=bar"],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("argument injection");
});

test("validate: dbus.session.own rejects invalid D-Bus name format", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            dbus: {
              session: {
                ...DEFAULT_DBUS_CONFIG.session,
                enable: true,
                own: ["123.invalid"],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("not a valid D-Bus well-known name");
});

test("validate: dbus.session.calls rejects rule with = in name", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            dbus: {
              session: {
                ...DEFAULT_DBUS_CONFIG.session,
                enable: true,
                calls: [{ name: "org.foo=evil", rule: "org.bar.Baz" }],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("argument injection");
});

test("validate: dbus.session.broadcasts accepts non-name rule values", () => {
  // rule field is not validated as a D-Bus well-known name since it can
  // contain xdg-dbus-proxy syntax (wildcards, member@path, etc.)
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          dbus: {
            session: {
              ...DEFAULT_DBUS_CONFIG.session,
              enable: true,
              broadcasts: [{ name: "org.valid.Name", rule: "SomeSignal" }],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.dbus.session.broadcasts).toHaveLength(1);
});

test("validate: dbus.session.broadcasts rejects rule with =", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            dbus: {
              session: {
                ...DEFAULT_DBUS_CONFIG.session,
                enable: true,
                broadcasts: [
                  { name: "org.valid.Name", rule: "evil=injection" },
                ],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("argument injection");
});

test("validate: dbus.session.talk accepts trailing wildcard", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          dbus: {
            session: {
              ...DEFAULT_DBUS_CONFIG.session,
              enable: true,
              talk: ["org.gnome.*"],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.dbus.session.talk).toEqual(["org.gnome.*"]);
});

test("validate: dbus.session.calls accepts non-name rule values", () => {
  // xdg-dbus-proxy rules can contain wildcards and member@path syntax
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          dbus: {
            session: {
              ...DEFAULT_DBUS_CONFIG.session,
              enable: true,
              calls: [
                {
                  name: "org.freedesktop.Notifications",
                  rule: "Notify@/org/freedesktop/Notifications",
                },
                {
                  name: "org.freedesktop.portal.Desktop",
                  rule: "*",
                },
              ],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.dbus.session.calls).toHaveLength(2);
});

test("validate: dbus.session.calls rejects rule with =", () => {
  expect(() =>
    validateConfig(
      makeConfig({
        profiles: {
          test: makeProfile({
            dbus: {
              session: {
                ...DEFAULT_DBUS_CONFIG.session,
                enable: true,
                calls: [{ name: "org.valid.Name", rule: "evil=injection" }],
              },
            },
          }),
        },
      }),
    ),
  ).toThrow("argument injection");
});

test("validate: dbus.session accepts valid calls and broadcasts", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        test: makeProfile({
          dbus: {
            session: {
              ...DEFAULT_DBUS_CONFIG.session,
              enable: true,
              see: ["org.freedesktop.DBus"],
              talk: ["org.freedesktop.Notifications"],
              own: ["com.example.MyApp"],
              calls: [
                {
                  name: "org.freedesktop.portal.Desktop",
                  rule: "org.freedesktop.portal.OpenURI",
                },
              ],
              broadcasts: [
                {
                  name: "org.freedesktop.login1",
                  rule: "org.freedesktop.login1.Manager",
                },
              ],
            },
          },
        }),
      },
    }),
  );
  expect(config.profiles.test.dbus.session.calls).toHaveLength(1);
  expect(config.profiles.test.dbus.session.broadcasts).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Passthrough: valid config is returned as-is
// ---------------------------------------------------------------------------

test("validate: valid minimal config is returned unchanged", () => {
  const input = makeConfig({
    default: "test",
    profiles: { test: makeProfile() },
  });
  const config = validateConfig(input);
  expect(config.default).toEqual("test");
  expect(config.profiles.test.agent).toEqual("claude");
});

test("validate: multiple valid profiles all pass", () => {
  const config = validateConfig(
    makeConfig({
      profiles: {
        a: makeProfile({ agent: "claude" }),
        b: makeProfile({ agent: "copilot" }),
        c: makeProfile({ agent: "codex" }),
      },
    }),
  );
  expect(config.profiles.a.agent).toEqual("claude");
  expect(config.profiles.b.agent).toEqual("copilot");
  expect(config.profiles.c.agent).toEqual("codex");
});
