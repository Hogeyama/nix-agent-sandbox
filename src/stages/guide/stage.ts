import * as path from "node:path";
import { Effect } from "effect";
import { resolveRuntimeSubdir } from "../../lib/runtime_dir.ts";
import { mergeContainerPlan } from "../../pipeline/container_plan.ts";
import type { Stage } from "../../pipeline/stage_builder.ts";
import type { MountSpec, PipelineState } from "../../pipeline/state.ts";
import type { StageInput, StageResult } from "../../pipeline/types.ts";
import { GUIDE_SKILL_NAME, renderGuide } from "./content.ts";
import { profileToGuideFacts } from "./facts.ts";
import { GuideService } from "./guide_service.ts";

/**
 * Claude Code は ~/.agents/skills を読まず、~/.claude はホストから RW で
 * bind mount されている。中立なディレクトリに置いて --add-dir で拾わせる。
 */
export const GUIDE_CLAUDE_ADD_DIR = "/opt/nas/guide";

export type GuideStageInput = StageInput & Pick<PipelineState, "container">;

export interface GuidePlan {
  readonly hostDir: string;
  readonly content: string;
  readonly mounts: readonly MountSpec[];
  readonly extraArgs: readonly string[];
}

function containerTarget(
  agent: StageInput["profile"]["agent"],
  containerHome: string,
): {
  readonly target: string;
  readonly extraArgs: readonly string[];
} {
  if (agent === "claude") {
    return {
      target: `${GUIDE_CLAUDE_ADD_DIR}/.claude/skills/${GUIDE_SKILL_NAME}`,
      // `claude --help` declares `--add-dir <directories...>` as variadic:
      // emitted as two argv tokens, it swallows every following non-option
      // argument (including the user's prompt). A single `--add-dir=...`
      // token cannot absorb anything after it.
      extraArgs: [`--add-dir=${GUIDE_CLAUDE_ADD_DIR}`],
    };
  }
  // codex と copilot はどちらも ~/.agents/skills を読む。nas はホストの
  // ~/.agents をマウントしないので、この位置は衝突しない。
  return {
    target: `${containerHome}/.agents/skills/${GUIDE_SKILL_NAME}`,
    extraArgs: [],
  };
}

export function planGuide(input: GuideStageInput): GuidePlan | null {
  if (!input.profile.guide.enable) return null;

  // env.static is typed as Record<string, string>, so indexing it always
  // yields `string` under this repo's tsconfig (noUncheckedIndexedAccess is
  // off). That is a static fiction: the producing stage may not have
  // written NAS_HOME, and the value must be widened and checked here.
  const containerHome: string | undefined = input.container.env.static.NAS_HOME;
  if (containerHome === undefined) return null;

  const hostDir = path.join(
    resolveRuntimeSubdir(input.host, "guide"),
    input.sessionId,
    GUIDE_SKILL_NAME,
  );
  const { target, extraArgs } = containerTarget(
    input.profile.agent,
    containerHome,
  );
  const facts = profileToGuideFacts(input.profile, input.container.workDir);

  return {
    hostDir,
    content: renderGuide(facts),
    mounts: [{ source: hostDir, target, readOnly: true }],
    extraArgs,
  };
}

export function createGuideStage(
  shared: StageInput,
): Stage<"container", Pick<StageResult, "container">, GuideService, unknown> {
  return {
    name: "GuideStage",
    needs: ["container"],
    run(input) {
      return Effect.gen(function* () {
        const plan = planGuide({ ...shared, ...input });
        if (plan === null) return { container: input.container };

        const service = yield* GuideService;
        yield* Effect.acquireRelease(
          service.write({ dir: plan.hostDir, content: plan.content }),
          (handle) =>
            handle
              .close()
              .pipe(
                Effect.catchAll(() =>
                  Effect.logWarning("guide cleanup failed"),
                ),
              ),
        );

        return {
          container: mergeContainerPlan(input.container, {
            mounts: plan.mounts,
            command: {
              agentCommand: input.container.command.agentCommand,
              extraArgs: [
                ...input.container.command.extraArgs,
                ...plan.extraArgs,
              ],
            },
          }),
        };
      });
    },
  };
}
