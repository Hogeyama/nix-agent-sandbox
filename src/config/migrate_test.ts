import { describe, expect, test } from "bun:test";
import { normalizeEnvSnakeCaseKeys, objectToPklSource } from "./migrate.ts";

// ---------------------------------------------------------------------------
// objectToPklSource
// ---------------------------------------------------------------------------

describe("objectToPklSource", () => {
  test("empty object produces header only", () => {
    expect(objectToPklSource({})).toEqual('amends "Schema.pkl"\n');
  });

  test("simple string field", () => {
    const result = objectToPklSource({ default: "main" });
    expect(result).toEqual('amends "Schema.pkl"\n\ndefault = "main"\n');
  });

  test("boolean and number fields", () => {
    const result = objectToPklSource({ ui: { enable: true, port: 3939 } });
    expect(result).toContain("ui {");
    expect(result).toContain("  enable = true");
    expect(result).toContain("  port = 3939");
  });

  test("kebab-case keys are converted to camelCase", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "agent-args": ["--verbose"],
          "mount-socket": true,
        },
      },
    });
    expect(result).toContain("agentArgs");
    expect(result).not.toContain("agent-args");
    expect(result).toContain("mountSocket");
    expect(result).not.toContain("mount-socket");
  });

  test("profiles keys use bracket notation (Mapping)", () => {
    const result = objectToPklSource({
      profiles: {
        dev: { agent: "claude" },
      },
    });
    expect(result).toContain('["dev"]');
  });

  test("hostexec.secrets keys use bracket notation (Mapping)", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          hostexec: {
            secrets: {
              "my-secret": { from: "env", required: true },
            },
          },
        },
      },
    });
    expect(result).toContain('["my-secret"]');
  });

  test("hostexec.rules.*.env keys use bracket notation (Mapping)", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          hostexec: {
            rules: [
              {
                id: "r1",
                env: { FOO: "bar", BAZ: "qux" },
              },
            ],
          },
        },
      },
    });
    expect(result).toContain('["FOO"] = "bar"');
    expect(result).toContain('["BAZ"] = "qux"');
  });

  test("arrays produce Listing syntax", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-packages": ["git", "curl"],
        },
      },
    });
    expect(result).toContain("new Listing {");
    expect(result).toContain('"git"');
    expect(result).toContain('"curl"');
  });

  test("empty array produces empty Listing", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-packages": [],
        },
      },
    });
    expect(result).toContain("new Listing {}");
  });

  test("null and undefined values are omitted", () => {
    const result = objectToPklSource({
      default: null,
      ui: { enable: true, port: undefined },
    });
    expect(result).not.toContain("default");
    expect(result).not.toContain("port");
    expect(result).toContain("enable = true");
  });

  test("string escaping", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          session: { "detach-key": '^"\\n' },
        },
      },
    });
    expect(result).toContain('detachKey = "^\\"\\\\n"');
  });

  test("array of objects produces nested Listing", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-mounts": [
            { src: "/host/path", dst: "/container/path", mode: "ro" },
          ],
        },
      },
    });
    expect(result).toContain("new Listing {");
    expect(result).toContain('src = "/host/path"');
    expect(result).toContain('dst = "/container/path"');
    expect(result).toContain('mode = "ro"');
  });

  test("empty nested object produces empty block", () => {
    const result = objectToPklSource({
      ui: {},
    });
    expect(result).toContain("ui {}");
  });

  test("keys needing bracket notation get it", () => {
    const result = objectToPklSource({
      ui: { "with-hyphen": true },
    });
    // "with-hyphen" is not in KEBAB_KEYS, so it should use bracket notation
    expect(result).toContain('["with-hyphen"] = true');
  });

  test("null items in arrays are filtered out", () => {
    const result = objectToPklSource({
      profiles: {
        dev: {
          "extra-packages": ["git", null, "curl"],
        },
      },
    });
    expect(result).toContain('"git"');
    expect(result).toContain('"curl"');
    // Should not contain "null" as a value
    const lines = result.split("\n");
    const listingLines = lines.filter(
      (l) => l.trim() !== "" && !l.includes("Listing") && !l.includes("}"),
    );
    for (const l of listingLines) {
      expect(l).not.toContain("null");
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeEnvSnakeCaseKeys
// ---------------------------------------------------------------------------

describe("normalizeEnvSnakeCaseKeys", () => {
  test("returns input unchanged when no profiles", () => {
    const raw = { default: "main" };
    expect(normalizeEnvSnakeCaseKeys(raw)).toEqual({ default: "main" });
  });

  test("returns input unchanged when profile has no env", () => {
    const raw = {
      profiles: {
        dev: { agent: "claude" },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    expect(result).toEqual(raw);
  });

  test("converts key_cmd to keyCmd", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "echo FOO", val: "bar", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({ keyCmd: "echo FOO", val: "bar", mode: "set" });
    expect(env[0]).not.toHaveProperty("key_cmd");
  });

  test("converts val_cmd to valCmd", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key: "FOO", val_cmd: "echo bar", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({ key: "FOO", valCmd: "echo bar", mode: "set" });
    expect(env[0]).not.toHaveProperty("val_cmd");
  });

  test("converts both key_cmd and val_cmd together", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "echo KEY", val_cmd: "echo VAL", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({
      keyCmd: "echo KEY",
      valCmd: "echo VAL",
      mode: "set",
    });
  });

  test("leaves camelCase keys unchanged", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ keyCmd: "echo KEY", valCmd: "echo VAL", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const env = (result.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toEqual({
      keyCmd: "echo KEY",
      valCmd: "echo VAL",
      mode: "set",
    });
  });

  test("handles multiple profiles", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "cmd1", val: "v1", mode: "set" }],
        },
        prod: {
          agent: "copilot",
          env: [{ key: "K", val_cmd: "cmd2", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const profiles = result.profiles as Record<string, Record<string, unknown>>;
    const devEnv = profiles.dev.env as Record<string, unknown>[];
    const prodEnv = profiles.prod.env as Record<string, unknown>[];
    expect(devEnv[0]).toHaveProperty("keyCmd", "cmd1");
    expect(prodEnv[0]).toHaveProperty("valCmd", "cmd2");
  });

  test("does not mutate original object", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          env: [{ key_cmd: "echo FOO", val: "bar", mode: "set" }],
        },
      },
    };
    normalizeEnvSnakeCaseKeys(raw);
    // Original should still have key_cmd
    const env = (raw.profiles as Record<string, Record<string, unknown>>).dev
      .env as Record<string, unknown>[];
    expect(env[0]).toHaveProperty("key_cmd");
  });

  test("preserves non-env profile fields", () => {
    const raw = {
      profiles: {
        dev: {
          agent: "claude",
          session: { multiplex: true },
          env: [{ key: "A", val: "B", mode: "set" }],
        },
      },
    };
    const result = normalizeEnvSnakeCaseKeys(raw);
    const profile = (result.profiles as Record<string, Record<string, unknown>>)
      .dev;
    expect(profile.agent).toEqual("claude");
    expect(profile.session).toEqual({ multiplex: true });
  });
});
