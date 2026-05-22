import { describe, expect, test } from "bun:test";
import { normalizePklKeys, rawConfigToPklSource } from "./pkl.ts";
import type { RawConfig } from "./types.ts";

describe("rawConfigToPklSource", () => {
  test("empty object produces empty string", () => {
    const result = rawConfigToPklSource({});
    expect(result).toBe("");
  });

  test("minimal RawConfig with a profile", () => {
    const raw: RawConfig = {
      profiles: { dev: { agent: "claude" } },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("profiles {");
    expect(result).toContain("dev {");
    expect(result).toContain('agent = "claude"');
  });

  test("top-level string field", () => {
    const raw: RawConfig = { default: "dev" };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain('default = "dev"');
  });

  test("primitive types: string, number, boolean", () => {
    const raw: RawConfig = {
      ui: { enable: true, port: 3939, "idle-timeout": 300 },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("enable = true");
    expect(result).toContain("port = 3939");
    expect(result).toContain("idleTimeout = 300");
  });

  test("nested object with kebab-case keys emits camelCase", () => {
    const raw: RawConfig = {
      ui: { enable: true, port: 3939, "idle-timeout": 300 },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("ui {");
    expect(result).toContain("idleTimeout = 300");
  });

  test("array of strings produces Listing", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          "agent-args": ["--flag1", "--flag2"],
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("agentArgs = new Listing {");
    expect(result).toContain('"--flag1"');
    expect(result).toContain('"--flag2"');
  });

  test("array of numbers produces Listing", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          network: {
            proxy: { "forward-ports": [8080, 5432] },
          },
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("new Listing {");
    expect(result).toContain("8080");
    expect(result).toContain("5432");
  });

  test("array of objects produces Listing with new blocks", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          env: [
            { key: "FOO", val: "bar", mode: "set" },
            { key: "PATH", val: "/usr/bin", mode: "prefix", separator: ":" },
          ],
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("env = new Listing {");
    expect(result).toContain("new {");
    expect(result).toContain('key = "FOO"');
    expect(result).toContain('val = "bar"');
    expect(result).toContain('separator = ":"');
  });

  test("kebab-case profile name uses bracket syntax", () => {
    const raw: RawConfig = {
      profiles: {
        "my-profile": { agent: "claude" },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain('["my-profile"] {');
  });

  test("special characters in strings are escaped", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          worktree: { "on-create": 'echo "hello\\world"' },
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain('onCreate = "echo \\"hello\\\\world\\""');
  });

  test("null and undefined fields are omitted", () => {
    const raw: RawConfig = {
      default: undefined,
      observability: { enable: true, retention: null },
    };
    const result = rawConfigToPklSource(raw);
    // "default" should not appear (undefined)
    expect(result).not.toContain("default");
    // "retention" should not appear (null)
    expect(result).not.toContain("retention");
    // "enable" should appear
    expect(result).toContain("enable = true");
  });

  test("empty nested object produces empty block", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          worktree: {},
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("worktree {}");
  });

  test("empty array produces empty Listing", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          "agent-args": [],
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("agentArgs = new Listing {}");
  });

  test("deeply nested structure with camelCase conversion", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          network: {
            allowlist: ["github.com", "npmjs.org"],
            prompt: {
              enable: true,
              "timeout-seconds": 300,
              "default-scope": "host-port",
              notify: "auto",
            },
          },
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("network {");
    expect(result).toContain("allowlist = new Listing {");
    expect(result).toContain('"github.com"');
    expect(result).toContain("prompt {");
    expect(result).toContain("enable = true");
    expect(result).toContain("timeoutSeconds = 300");
    expect(result).toContain('defaultScope = "host-port"');
  });

  test("full RawConfig with multiple sections", () => {
    const raw: RawConfig = {
      default: "dev",
      ui: { enable: true, port: 3939 },
      observability: { enable: false },
      profiles: {
        dev: { agent: "claude" },
        prod: { agent: "copilot" },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain('default = "dev"');
    expect(result).toContain("ui {");
    expect(result).toContain("observability {");
    expect(result).toContain("profiles {");
    expect(result).toContain("dev {");
    expect(result).toContain("prod {");
  });

  test("string values with newline, carriage return, and tab are escaped", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          worktree: { "on-create": "line1\nline2\r\nend\ttab" },
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain('onCreate = "line1\\nline2\\r\\nend\\ttab"');
  });

  test("keys with non-hyphen special characters use bracket syntax", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [
            { "2key": "val" },
            { "key.name": "val" },
            { "key with space": "val" },
          ],
        },
      },
    } as unknown as RawConfig;
    const result = rawConfigToPklSource(raw);
    expect(result).toContain('["2key"] = "val"');
    expect(result).toContain('["key.name"] = "val"');
    expect(result).toContain('["key with space"] = "val"');
  });

  test("hostexec with rules array of objects", () => {
    const raw: RawConfig = {
      profiles: {
        dev: {
          agent: "claude",
          hostexec: {
            rules: [
              {
                id: "git",
                match: { argv0: "git" },
                approval: "allow",
              },
            ],
          },
        },
      },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("rules = new Listing {");
    expect(result).toContain("new {");
    expect(result).toContain('id = "git"');
    expect(result).toContain("match {");
    expect(result).toContain('argv0 = "git"');
    expect(result).toContain('approval = "allow"');
  });

  test("user-defined keys (profile names) stay as-is, not camelCased", () => {
    const raw: RawConfig = {
      profiles: {
        "my-profile": { agent: "claude" },
        dev: { agent: "copilot" },
      },
    };
    const result = rawConfigToPklSource(raw);
    // profile name with hyphen still uses bracket syntax (not a whitelisted key)
    expect(result).toContain('["my-profile"] {');
    // profile name without hyphen uses identifier syntax
    expect(result).toContain("dev {");
  });
});

describe("normalizePklKeys", () => {
  test("converts whitelisted camelCase keys to kebab-case", () => {
    const input = {
      profiles: {
        dev: {
          agent: "claude",
          agentArgs: ["--flag"],
          mountSocket: true,
        },
      },
    };
    const result = normalizePklKeys(input) as Record<string, unknown>;
    const dev = (result.profiles as Record<string, unknown>).dev as Record<
      string,
      unknown
    >;
    expect(dev["agent-args"]).toEqual(["--flag"]);
    expect(dev["mount-socket"]).toBe(true);
    expect(dev.agent).toBe("claude");
  });

  test("leaves non-whitelisted keys unchanged", () => {
    const input = {
      profiles: {
        claudeRemote: { agent: "claude" },
      },
    };
    const result = normalizePklKeys(input) as Record<string, unknown>;
    const profiles = result.profiles as Record<string, unknown>;
    // "claudeRemote" is not a whitelisted key → stays as-is
    expect(profiles.claudeRemote).toBeDefined();
    expect(profiles["claude-remote"]).toBeUndefined();
  });

  test("leaves already-kebab keys unchanged", () => {
    const input = {
      profiles: {
        dev: { "agent-args": ["--flag"], "mount-socket": true },
      },
    };
    const result = normalizePklKeys(input) as Record<string, unknown>;
    const dev = (result.profiles as Record<string, unknown>).dev as Record<
      string,
      unknown
    >;
    expect(dev["agent-args"]).toEqual(["--flag"]);
    expect(dev["mount-socket"]).toBe(true);
  });

  test("kebab-case wins when both camelCase and kebab-case exist", () => {
    const input = {
      "mount-socket": true,
      mountSocket: false,
    };
    const result = normalizePklKeys(input) as Record<string, unknown>;
    // kebab-case form was seen first → its value is kept
    expect(result["mount-socket"]).toBe(true);
    expect(result.mountSocket).toBeUndefined();
  });

  test("handles deeply nested whitelisted keys", () => {
    const input = {
      profiles: {
        dev: {
          network: {
            prompt: { timeoutSeconds: 300, defaultScope: "host-port" },
            proxy: { forwardPorts: [8080] },
          },
          hostexec: {
            rules: [
              {
                match: { argRegex: "^git" },
                inheritEnv: { mode: "minimal" },
              },
            ],
          },
        },
      },
    };
    const result = normalizePklKeys(input) as Record<string, unknown>;
    const dev = (result.profiles as Record<string, unknown>).dev as Record<
      string,
      unknown
    >;
    const prompt = (dev.network as Record<string, unknown>).prompt as Record<
      string,
      unknown
    >;
    expect(prompt["timeout-seconds"]).toBe(300);
    expect(prompt["default-scope"]).toBe("host-port");

    const proxy = (dev.network as Record<string, unknown>).proxy as Record<
      string,
      unknown
    >;
    expect(proxy["forward-ports"]).toEqual([8080]);

    const rule = (
      (dev.hostexec as Record<string, unknown>).rules as Array<
        Record<string, unknown>
      >
    )[0];
    expect((rule.match as Record<string, unknown>)["arg-regex"]).toBe("^git");
    expect(rule["inherit-env"]).toEqual({ mode: "minimal" });
  });

  test("does not convert env var names or secret names", () => {
    const input = {
      profiles: {
        dev: {
          hostexec: {
            secrets: {
              myApiToken: { from: "env:TOKEN", required: true },
            },
            rules: [
              {
                env: { MY_API_URL: "https://example.com" },
              },
            ],
          },
        },
      },
    };
    const result = normalizePklKeys(input) as Record<string, unknown>;
    const hostexec = (
      (result.profiles as Record<string, unknown>).dev as Record<
        string,
        unknown
      >
    ).hostexec as Record<string, unknown>;
    // secret names are not whitelisted → unchanged
    expect(
      (hostexec.secrets as Record<string, unknown>).myApiToken,
    ).toBeDefined();
    // env var names are not whitelisted → unchanged
    const rule = (hostexec.rules as Array<Record<string, unknown>>)[0];
    expect((rule.env as Record<string, unknown>).MY_API_URL).toBe(
      "https://example.com",
    );
  });

  test("handles primitives and null gracefully", () => {
    expect(normalizePklKeys("hello")).toBe("hello");
    expect(normalizePklKeys(42)).toBe(42);
    expect(normalizePklKeys(null)).toBe(null);
    expect(normalizePklKeys(undefined)).toBe(undefined);
  });
});
