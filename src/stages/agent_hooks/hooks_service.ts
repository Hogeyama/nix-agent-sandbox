import * as path from "node:path";
import { Cause, Context, Effect, Layer, type Scope } from "effect";
import { FsService } from "../../services/fs.ts";
import {
  type AgentHookOptions,
  buildAgentHookSettings,
  buildCodexMaskHookScript,
  CODEX_MASK_HOOK_COMMANDS,
  type HookAgent,
  SESSION_HOOK_REPORT_SCRIPT,
} from "./settings.ts";

type Fs = Context.Tag.Service<typeof FsService>;

export interface AgentHooksPlan extends AgentHookOptions {
  readonly sessionDir: string;
  readonly agents: readonly HookAgent[];
}

export class AgentHooksService extends Context.Tag("nas/AgentHooksService")<
  AgentHooksService,
  {
    readonly prepare: (
      plan: AgentHooksPlan,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>() {}

function createDirectory(fs: Fs, dir: string, mode: number) {
  return fs.mkdir(dir, { recursive: true, mode });
}

function writeAsset(fs: Fs, file: string, content: string, mode = 0o644) {
  return fs.writeFile(file, content, { mode });
}

function removeDirectory(fs: Fs, dir: string) {
  return fs
    .rm(dir, { recursive: true, force: true })
    .pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(`agent hooks cleanup failed: ${Cause.pretty(cause)}`),
      ),
    );
}

function prepareHooks(fs: Fs, plan: AgentHooksPlan) {
  return Effect.gen(function* () {
    // Register cleanup before writing any assets, including partial failures.
    yield* Effect.acquireRelease(
      createDirectory(fs, plan.sessionDir, 0o700),
      () => removeDirectory(fs, plan.sessionDir),
    );
    const assets = path.join(plan.sessionDir, "assets");
    yield* createDirectory(fs, assets, 0o755);
    yield* writeAsset(
      fs,
      path.join(assets, "report"),
      SESSION_HOOK_REPORT_SCRIPT,
      0o755,
    );
    for (const agent of plan.agents) {
      yield* writeAsset(
        fs,
        path.join(assets, `${agent}.${agent === "codex" ? "toml" : "json"}`),
        buildAgentHookSettings(agent, plan),
      );
    }
    if (plan.maskSocketPath && plan.agents.includes("codex")) {
      for (const event of ["post-tool", "prompt"] as const) {
        yield* writeAsset(
          fs,
          path.join(assets, path.basename(CODEX_MASK_HOOK_COMMANDS[event])),
          buildCodexMaskHookScript(event, plan.maskSocketPath),
          0o755,
        );
      }
    }
  });
}

export const AgentHooksServiceLive = Layer.effect(
  AgentHooksService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    return AgentHooksService.of({
      prepare: (plan) => prepareHooks(fs, plan),
    });
  }),
);

export function makeAgentHooksServiceFake(
  prepare: (
    plan: AgentHooksPlan,
  ) => Effect.Effect<void, never, Scope.Scope> = () => Effect.void,
) {
  return Layer.succeed(AgentHooksService, AgentHooksService.of({ prepare }));
}
