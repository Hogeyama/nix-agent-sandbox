import { expect, test } from "bun:test";
import { Effect } from "effect";
import { emptyContainerPlan } from "../../pipeline/container_plan.ts";
import type { StageInput } from "../../pipeline/types.ts";
import {
  type AgentHooksPlan,
  makeAgentHooksServiceFake,
} from "./hooks_service.ts";
import { createAgentHooksStage } from "./stage.ts";

function input(enable: boolean): StageInput {
  return {
    profile: {
      agent: "claude",
      extraAgents: ["copilot", "codex"],
      hook: { enable, notify: "off" },
    },
    sessionId: "sess_test",
    host: { uid: 1000, env: new Map([["XDG_RUNTIME_DIR", "/run/user/1000"]]) },
  } as unknown as StageInput;
}

test("hooks are provisioned for primary and extra agents even with notifications off and no masking", async () => {
  const plans: AgentHooksPlan[] = [];
  const container = emptyContainerPlan("image", "/work");
  const result = await Effect.runPromise(
    Effect.scoped(
      createAgentHooksStage(input(true))
        .run({ container })
        .pipe(
          Effect.provide(
            makeAgentHooksServiceFake((plan) =>
              Effect.sync(() => {
                plans.push(plan);
              }),
            ),
          ),
        ),
    ),
  );
  expect(plans).toEqual([
    {
      sessionDir: "/run/user/1000/nas/agent-hooks/sess_test",
      agents: ["claude", "copilot", "codex"],
      lifecycle: true,
      maskSocketPath: undefined,
    },
  ]);
  expect(result.container?.mounts).toContainEqual({
    source: `${plans[0].sessionDir}/assets`,
    target: "/opt/nas/agent-hooks",
    readOnly: true,
  });
  expect(result.container?.env.static.NAS_AGENT_HOOKS).toBe("1");
  expect(result.container?.command).toEqual(container.command);
});

test("hook.enable=false skips registration without needing a service", async () => {
  expect(
    await Effect.runPromise(
      Effect.scoped(
        createAgentHooksStage(input(false))
          .run({ container: emptyContainerPlan("image", "/work") })
          .pipe(
            Effect.provide(
              makeAgentHooksServiceFake(() => Effect.die("must not prepare")),
            ),
          ),
      ),
    ),
  ).toEqual({});
});

test("masking survives lifecycle opt-out and includes extra Codex and Copilot agents", async () => {
  const plans: AgentHooksPlan[] = [];
  const base = emptyContainerPlan("image", "/work");
  const result = await Effect.runPromise(
    Effect.scoped(
      createAgentHooksStage(input(false))
        .run({
          container: {
            ...base,
            env: { ...base.env, static: { NAS_MASK_SOCKET: "/run/mask.sock" } },
          },
        })
        .pipe(
          Effect.provide(
            makeAgentHooksServiceFake((plan) =>
              Effect.sync(() => {
                plans.push(plan);
              }),
            ),
          ),
        ),
    ),
  );
  expect(plans).toHaveLength(1);
  expect(plans[0]).toMatchObject({
    lifecycle: false,
    maskSocketPath: "/run/mask.sock",
    agents: ["copilot", "codex"],
  });
  expect(result.container?.env.static.NAS_AGENT_HOOKS).toBe("1");
  expect(result.container?.env.static.NAS_MASK_SOCKET).toBe("/run/mask.sock");
});
