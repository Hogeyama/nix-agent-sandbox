import * as path from "node:path";
import { Cause, Context, Effect, Layer, type Scope } from "effect";
import { FsService } from "../../services/fs.ts";
import {
  buildSessionHookSettings,
  type HookAgent,
  SESSION_HOOK_REPORT_SCRIPT,
} from "./settings.ts";

type Fs = Context.Tag.Service<typeof FsService>;

export interface SessionHooksPlan {
  readonly sessionDir: string;
  readonly agents: readonly HookAgent[];
}

export class SessionHooksService extends Context.Tag("nas/SessionHooksService")<
  SessionHooksService,
  {
    readonly prepare: (
      plan: SessionHooksPlan,
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
        Effect.logWarning(
          `session hooks cleanup failed: ${Cause.pretty(cause)}`,
        ),
      ),
    );
}

function prepareHooks(fs: Fs, plan: SessionHooksPlan) {
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
        buildSessionHookSettings(agent),
      );
    }
  });
}

export const SessionHooksServiceLive = Layer.effect(
  SessionHooksService,
  Effect.gen(function* () {
    const fs = yield* FsService;
    return SessionHooksService.of({
      prepare: (plan) => prepareHooks(fs, plan),
    });
  }),
);

export function makeSessionHooksServiceFake(
  prepare: (
    plan: SessionHooksPlan,
  ) => Effect.Effect<void, never, Scope.Scope> = () => Effect.void,
) {
  return Layer.succeed(
    SessionHooksService,
    SessionHooksService.of({ prepare }),
  );
}
