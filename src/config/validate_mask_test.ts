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
        },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
    expect(() => validateConfig(config)).toThrow(/mask\.values\[0\]\.source/);
  });

  test("rejects empty source", () => {
    const config = makeConfig(
      makeProfile({
        mask: { values: [{ source: "" }], writePolicy: "passthrough" },
      }),
    );
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
  });

  test("mask omitted is fine", () => {
    const config = makeConfig(makeProfile());
    expect(() => validateConfig(config)).not.toThrow();
  });
});
