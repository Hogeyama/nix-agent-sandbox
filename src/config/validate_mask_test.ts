import { describe, expect, test } from "bun:test";
import type { Config, Profile } from "./types.ts";
import {
  DEFAULT_AWS_CONFIG,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GCLOUD_CONFIG,
  DEFAULT_GPG_CONFIG,
  DEFAULT_GUIDE_CONFIG,
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
    secrets: {},
    hook: DEFAULT_HOOK_CONFIG,
    guide: DEFAULT_GUIDE_CONFIG,
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
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("accepts a lines: secret", () => {
    const config = makeConfig(
      makeProfile({
        secrets: { workspace: { from: "lines:/home/dev/secrets.txt" } },
        mask: {
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects a secret source with an unsupported scheme", () => {
    const config = makeConfig(
      makeProfile({
        secrets: { workspace: { from: "http://example.com/token" } },
        mask: {
          writePolicy: "readonly",
          maskfs: true,
          proxy: true,
          filter: true,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(
      /secrets\["workspace"\]\.from/,
    );
  });

  test("rejects an empty secret source", () => {
    const config = makeConfig(
      makeProfile({
        secrets: { workspace: { from: "" } },
        mask: {
          writePolicy: "passthrough",
          maskfs: true,
          proxy: true,
          filter: true,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(/must be a non-empty string/);
  });

  test("mask omitted is fine", () => {
    const config = makeConfig(makeProfile());
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("a scope that masks is refused when proxy masking is off", () => {
    const config = makeConfig(
      makeProfile({
        network: {
          ...DEFAULT_NETWORK_CONFIG,
          scopes: {
            api: { targets: ["api.example.com"], fallback: "allow" },
          },
        },
        mask: {
          writePolicy: "readonly",
          maskfs: false,
          proxy: false,
          filter: false,
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(
      /mask\.proxy = false を選べません/,
    );
  });

  test("omitting mask leaves proxy masking on, so a masking scope is fine", () => {
    const config = makeConfig(
      makeProfile({
        network: {
          ...DEFAULT_NETWORK_CONFIG,
          scopes: {
            api: { targets: ["api.example.com"], fallback: "allow" },
          },
        },
      }),
    );
    expect(() => validateConfig(config)).not.toThrow();
  });

  test("rejects non-boolean maskfs / proxy flags", () => {
    const config = makeConfig(
      makeProfile({
        mask: {
          writePolicy: "readonly",
          maskfs: "yes" as any,
          proxy: 1 as any,
          filter: true,
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
});
