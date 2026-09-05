import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DEFAULT_DOCKER_CONFIG,
  DEFAULT_GUIDE_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type Profile,
} from "../../config/types.ts";
import {
  emptyContainerPlan,
  mergeContainerPlan,
} from "../../pipeline/container_plan.ts";
import type { ContainerPlan } from "../../pipeline/state.ts";
import type { StageInput } from "../../pipeline/types.ts";
import { makeGuideServiceFake } from "./guide_service.ts";
import { createGuideStage, GUIDE_CLAUDE_ADD_DIR, planGuide } from "./stage.ts";

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

function makeInput(
  profileOverrides: Partial<Profile> = {},
  agent: "claude" | "codex" | "copilot" = "claude",
): StageInput & { container: ContainerPlan } {
  const container = mergeContainerPlan(
    emptyContainerPlan("img", "/work/repo"),
    {
      env: { static: { NAS_HOME: "/home/nas" } },
      command: { agentCommand: [agent], extraArgs: [] },
    },
  );
  return {
    config: {} as StageInput["config"],
    profile: makeProfile({ agent, ...profileOverrides }),
    profileName: "test",
    sessionId: "sess-1",
    host: {
      home: "/home/user",
      user: "user",
      uid: 1000,
      gid: 1000,
      isWSL: false,
      env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]),
    },
    probes: {} as StageInput["probes"],
    container,
  };
}

describe("planGuide", () => {
  test("returns null when the guide is disabled", () => {
    expect(planGuide(makeInput({ guide: { enable: false } }))).toBeNull();
  });

  test("returns null when NAS_HOME is absent from env.static", () => {
    // NAS_HOME is written by an earlier stage into env.static, which is
    // typed as Record<string, string>; that type does not guarantee the
    // key was actually written, so the value can be absent at runtime.
    const input = makeInput({ guide: { enable: true } });
    const container = mergeContainerPlan(
      emptyContainerPlan("img", "/work/repo"),
      {
        env: { static: {} },
        command: { agentCommand: ["claude"], extraArgs: [] },
      },
    );

    expect(planGuide({ ...input, container })).toBeNull();
  });

  test("mounts into ~/.agents/skills for codex", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }, "codex"));

    expect(plan?.mounts).toEqual([
      {
        source: "/run/user/1000/nas/guide/sess-1/nas-sandbox",
        target: "/home/nas/.agents/skills/nas-sandbox",
        readOnly: true,
      },
    ]);
    expect(plan?.extraArgs).toEqual([]);
  });

  test("mounts into ~/.agents/skills for copilot", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }, "copilot"));

    expect(plan?.mounts[0]?.target).toBe(
      "/home/nas/.agents/skills/nas-sandbox",
    );
  });

  test("mounts into a neutral dir and adds --add-dir for claude", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }, "claude"));

    expect(plan?.mounts[0]?.target).toBe(
      `${GUIDE_CLAUDE_ADD_DIR}/.claude/skills/nas-sandbox`,
    );
    expect(plan?.extraArgs).toEqual(["--add-dir", GUIDE_CLAUDE_ADD_DIR]);
  });

  test("never mounts the guide writable", () => {
    for (const agent of ["claude", "codex", "copilot"] as const) {
      const plan = planGuide(makeInput({ guide: { enable: true } }, agent));
      expect(plan?.mounts.every((m) => m.readOnly === true)).toBe(true);
    }
  });

  test("carries the rendered content", () => {
    const plan = planGuide(makeInput({ guide: { enable: true } }));

    expect(plan?.content).toContain("name: nas-sandbox");
    expect(plan?.content).toContain("/work/repo");
  });
});

describe("createGuideStage", () => {
  test("leaves the container plan untouched when disabled", async () => {
    const fake = makeGuideServiceFake();
    const input = makeInput({ guide: { enable: false } });

    const result = await Effect.runPromise(
      Effect.scoped(
        createGuideStage(input)
          .run({ container: input.container })
          .pipe(Effect.provide(fake.layer)),
      ),
    );

    expect(fake.writes).toEqual([]);
    expect(result.container).toBe(input.container);
  });

  test("writes the guide and patches mounts and args when enabled", async () => {
    const fake = makeGuideServiceFake();
    const input = makeInput({ guide: { enable: true } });

    const result = await Effect.runPromise(
      Effect.scoped(
        createGuideStage(input)
          .run({ container: input.container })
          .pipe(Effect.provide(fake.layer)),
      ),
    );

    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]?.content).toContain("name: nas-sandbox");
    expect(result.container?.mounts).toHaveLength(1);
    expect(result.container?.command.extraArgs).toEqual([
      "--add-dir",
      GUIDE_CLAUDE_ADD_DIR,
    ]);
  });
});
