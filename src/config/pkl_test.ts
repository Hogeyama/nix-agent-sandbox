import { describe, expect, test } from "bun:test";
import { rawConfigToPklSource } from "./pkl.ts";
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
    expect(result).toContain('["idle-timeout"] = 300');
  });

  test("nested object with kebab-case keys", () => {
    const raw: RawConfig = {
      ui: { enable: true, port: 3939, "idle-timeout": 300 },
    };
    const result = rawConfigToPklSource(raw);
    expect(result).toContain("ui {");
    expect(result).toContain('["idle-timeout"] = 300');
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
    expect(result).toContain('["agent-args"] = new Listing {');
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
    expect(result).toContain('["on-create"] = "echo \\"hello\\\\world\\""');
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
    expect(result).toContain('["agent-args"] = new Listing {}');
  });

  test("deeply nested structure", () => {
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
    expect(result).toContain('["timeout-seconds"] = 300');
    expect(result).toContain('["default-scope"] = "host-port"');
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
    expect(result).toContain('["on-create"] = "line1\\nline2\\r\\nend\\ttab"');
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
});
