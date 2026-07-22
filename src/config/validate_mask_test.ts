import { describe, expect, test } from "bun:test";
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
import { ConfigValidationError, validateConfig } from "./validate.ts";

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

function makeConfig(profile: Profile): Config {
  return {
    ui: DEFAULT_UI_CONFIG,
    observability: DEFAULT_OBSERVABILITY_CONFIG,
    profiles: { main: profile },
  };
}

describe("validateConfig: mask", () => {
  test("accepts valid mask config", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "env:MY_SECRET" }, { source: "dotenv:.env#KEY" }],
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: false,
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts lines: source", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "lines:/home/u/.secrets/tokens.txt" }],
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: false,
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects unsupported source scheme", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "literal:passw0rd" }],
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: false,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(/mask\.values\[0\]\.source/);
  });

  test("rejects empty source", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "" }],
          writePolicy: "passthrough",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: false,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
  });

  test("mask omitted is fine", () => {
    const config = makeConfig(makeProfile());
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects non-boolean maskfs / proxy flags", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          values: [{ source: "env:MY_SECRET" }],
          writePolicy: "readonly",
          maskfs: "yes" as any,
          proxy: 1 as any,
          filter: true,
          anthropicEgress: false,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    try {
      validateConfig(config);
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain("mask.maskfs must be a boolean");
      expect(msg).toContain("mask.proxy must be a boolean");
    }
  });

  test("rejects non-boolean anthropicEgress", () => {
    const config = makeConfig(
      makeProfile({
        agent: "claude",
        mask: {
          values: [],
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: "yes" as unknown as boolean,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    try {
      validateConfig(config);
    } catch (e) {
      expect(String(e)).toContain("mask.anthropicEgress must be a boolean");
    }
  });

  test("anthropicEgress requires claude agent", () => {
    const config = makeConfig(
      makeProfile({
        agent: "copilot",
        mask: {
          values: [],
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: true,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    try {
      validateConfig(config);
    } catch (e) {
      expect(String(e)).toContain('requires agent "claude"');
    }
  });

  test("anthropicEgress requires mask.proxy", () => {
    const config = makeConfig(
      makeProfile({
        agent: "claude",
        mask: {
          values: [],
          writePolicy: "readonly",
          maskfs: true,
          proxy: false,
          filter: true,
          anthropicEgress: true,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    try {
      validateConfig(config);
    } catch (e) {
      expect(String(e)).toContain("requires mask.proxy");
    }
  });

  test("anthropicEgress valid for claude + proxy", () => {
    const config = makeConfig(
      makeProfile({
        agent: "claude",
        mask: {
          values: [],
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
          anthropicEgress: true,
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });
});
