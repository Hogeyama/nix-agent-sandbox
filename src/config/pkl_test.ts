import { describe, expect, test } from "bun:test";
import { normalizePklKeys } from "./pkl.ts";

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
