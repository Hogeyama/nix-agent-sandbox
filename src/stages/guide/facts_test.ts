import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GUIDE_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type Profile,
} from "../../config/types.ts";
import { profileToGuideFacts } from "./facts.ts";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    session: { multiplex: false, detachKey: "^\\", notify: "auto" },
    nix: { enable: "auto", mountSocket: true, extraPackages: [] },
    docker: DEFAULT_DOCKER_CONFIG,
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: DEFAULT_NETWORK_CONFIG,
    dbus: {
      session: {
        enable: false,
        see: [],
        talk: [],
        own: [],
        calls: [],
        broadcasts: [],
      },
    },
    display: { sandbox: "none", size: "1280x800" },
    extraMounts: [],
    env: [],
    hook: {},
    secrets: {},
    guide: DEFAULT_GUIDE_CONFIG,
    ...overrides,
  } as Profile;
}

describe("profileToGuideFacts", () => {
  test("carries the network fallback and forwarded ports", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        network: {
          ...DEFAULT_NETWORK_CONFIG,
          fallback: "review",
          pendingTimeoutSeconds: 120,
          proxy: { forwardPorts: [8080, 5432] },
        },
      }),
      "/work/repo",
    );

    expect(facts.network.fallback).toBe("review");
    expect(facts.network.pendingTimeoutSeconds).toBe(120);
    expect(facts.network.forwardPorts).toEqual([8080, 5432]);
    expect(facts.workDir).toBe("/work/repo");
  });

  test("defaults the network fallback to deny when unset", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        network: { ...DEFAULT_NETWORK_CONFIG, fallback: undefined },
      }),
      "/work/repo",
    );

    expect(facts.network.fallback).toBe("deny");
  });

  test("reports hostexec only when the profile configures it", () => {
    expect(profileToGuideFacts(makeProfile(), "/w").hostexec).toBeNull();

    // No rules at all means no rule can ever prompt, so promptEnabled is
    // false even though prompt.enable is true — see the dedicated
    // promptEnabled tests below for the rule-approval gating itself.
    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: {
          prompt: {
            enable: true,
            timeoutSeconds: 300,
            defaultScope: "capability",
            notify: "off",
          },
          secrets: {},
          rules: [],
        },
      }),
      "/w",
    );

    expect(facts.hostexec).toEqual({
      promptEnabled: false,
      timeoutSeconds: 300,
    });
  });

  test("reports promptEnabled false when every rule is allow/deny, even with prompt.enable true", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: {
          prompt: {
            enable: true,
            timeoutSeconds: 300,
            defaultScope: "capability",
            notify: "off",
          },
          secrets: {},
          rules: [
            {
              id: "a",
              match: { argv0: "git" },
              cwd: { mode: "any", allow: [] },
              env: {},
              inheritEnv: { mode: "minimal", keys: [] },
              approval: "allow",
              fallback: "deny",
            },
            {
              id: "b",
              match: { argv0: "rm" },
              cwd: { mode: "any", allow: [] },
              env: {},
              inheritEnv: { mode: "minimal", keys: [] },
              approval: "deny",
              fallback: "deny",
            },
          ],
        },
      }),
      "/w",
    );

    expect(facts.hostexec).toEqual({
      promptEnabled: false,
      timeoutSeconds: 300,
    });
  });

  test("reports promptEnabled true when at least one rule approval is prompt", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: {
          prompt: {
            enable: true,
            timeoutSeconds: 300,
            defaultScope: "capability",
            notify: "off",
          },
          secrets: {},
          rules: [
            {
              id: "a",
              match: { argv0: "git" },
              cwd: { mode: "any", allow: [] },
              env: {},
              inheritEnv: { mode: "minimal", keys: [] },
              approval: "allow",
              fallback: "deny",
            },
            {
              id: "b",
              match: { argv0: "curl" },
              cwd: { mode: "any", allow: [] },
              env: {},
              inheritEnv: { mode: "minimal", keys: [] },
              approval: "prompt",
              fallback: "deny",
            },
          ],
        },
      }),
      "/w",
    );

    expect(facts.hostexec).toEqual({
      promptEnabled: true,
      timeoutSeconds: 300,
    });
  });

  test("reports promptEnabled false when prompt.enable is false, even with a prompt rule", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: {
          prompt: {
            enable: false,
            timeoutSeconds: 300,
            defaultScope: "capability",
            notify: "off",
          },
          secrets: {},
          rules: [
            {
              id: "a",
              match: { argv0: "curl" },
              cwd: { mode: "any", allow: [] },
              env: {},
              inheritEnv: { mode: "minimal", keys: [] },
              approval: "prompt",
              fallback: "deny",
            },
          ],
        },
      }),
      "/w",
    );

    expect(facts.hostexec).toEqual({
      promptEnabled: false,
      timeoutSeconds: 300,
    });
  });

  test("treats a rule that omits approval as prompting, matching the pkl default", () => {
    // Schema.pkl declares `approval: "allow"|"prompt"|"deny" = "prompt"`, so
    // a rule that omits `approval` in the user's config arrives here — after
    // pkl evaluation — with `approval: "prompt"` already filled in. There is
    // no "field absent" state to observe in the TS type; this rule literal
    // is what an omitted-approval rule looks like by the time it reaches
    // profileToGuideFacts.
    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: {
          prompt: {
            enable: true,
            timeoutSeconds: 300,
            defaultScope: "capability",
            notify: "off",
          },
          secrets: {},
          rules: [
            {
              id: "a",
              match: { argv0: "curl" },
              cwd: { mode: "any", allow: [] },
              env: {},
              inheritEnv: { mode: "minimal", keys: [] },
              approval: "prompt",
              fallback: "deny",
            },
          ],
        },
      }),
      "/w",
    );

    expect(facts.hostexec).toEqual({
      promptEnabled: true,
      timeoutSeconds: 300,
    });
  });

  test("treats hostexec null the same as undefined", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        hostexec: null as unknown as Profile["hostexec"],
      }),
      "/w",
    );

    expect(facts.hostexec).toBeNull();
  });

  test("reports dind only when docker is enabled", () => {
    expect(profileToGuideFacts(makeProfile(), "/w").dind).toBeNull();

    const facts = profileToGuideFacts(
      makeProfile({ docker: { enable: true, shared: true } }),
      "/w",
    );

    expect(facts.dind).toEqual({ shared: true });
  });

  test("reduces mask config to a boolean without reading its contents", () => {
    expect(profileToGuideFacts(makeProfile(), "/w").maskEnabled).toBe(false);

    const facts = profileToGuideFacts(
      makeProfile({ mask: { proxy: true } as Profile["mask"] }),
      "/w",
    );

    expect(facts.maskEnabled).toBe(true);
  });

  test("does not surface env entries or secret names", () => {
    const facts = profileToGuideFacts(
      makeProfile({
        env: [
          { key: "GITHUB_TOKEN", valCmd: "pass github/token", mode: "set" },
        ],
        secrets: { "my-secret": { kind: "literal", value: "s3cret" } as never },
      }),
      "/w",
    );

    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("my-secret");
    expect(serialized).not.toContain("s3cret");
  });
});
