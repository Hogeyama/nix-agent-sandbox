/**
 * MountSetupService — Effect-based abstraction over mount directory preparation.
 *
 * Prepares mount sources and owns the protected Claude state lifetime.
 *
 * Live implementation delegates to filesystem helpers and FsService.
 * Fake implementation provides configurable stubs for testing.
 */

import { Context, Effect, Layer, type Scope } from "effect";
import type { ProtectedClaudeState } from "../../agents/types.ts";
import { FsService } from "../../services/fs.ts";
import {
  prepareDummyClaudeCredentials,
  removeDummyClaudeCredentials,
} from "./claude_credentials_fs.ts";
import {
  prepareProtectedClaudeState,
  removeProtectedClaudeState,
} from "./claude_state_fs.ts";
import {
  prepareDummyCodexCredentials,
  removeDummyCodexCredentials,
} from "./codex_credentials_fs.ts";
import { type GitMetadataProbe, resolveGitMetadata } from "./mount_probes.ts";

// ---------------------------------------------------------------------------
// Service-local plan interface (avoids service -> stage dependency)
// ---------------------------------------------------------------------------

export interface MountDirectoryEntry {
  readonly path: string;
  readonly mode?: number;
}

export interface MountFileEntry {
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

// ---------------------------------------------------------------------------
// MountSetupService tag
// ---------------------------------------------------------------------------

export class MountSetupService extends Context.Tag("nas/MountSetupService")<
  MountSetupService,
  {
    readonly prepareClaudeState: (
      hostHome: string,
      options?: { shareCredentials?: boolean; protectSettings?: boolean },
    ) => Effect.Effect<ProtectedClaudeState, unknown, Scope.Scope>;
    readonly prepareClaudeCredentials: (
      hostHome: string,
    ) => Effect.Effect<string, unknown, Scope.Scope>;
    readonly prepareCodexCredentials: (
      hostHome: string,
    ) => Effect.Effect<string, unknown, Scope.Scope>;
    readonly ensureDirectories: (
      dirs: ReadonlyArray<MountDirectoryEntry>,
    ) => Effect.Effect<void>;
    /**
     * WorktreeStage が作った worktree の git メタデータを解決する。
     * mount probe は worktree を作る前に元の cwd で走るので、その worktree の
     * 管理ディレクトリ (`<common-dir>/worktrees/<id>`) はここで補う。
     */
    readonly probeWorktreeGitMetadata: (
      worktreeDir: string,
    ) => Effect.Effect<GitMetadataProbe | null>;
    /** 無いファイルだけを作る。既にあるファイルの中身には触れない。 */
    readonly ensureFiles: (
      files: ReadonlyArray<MountFileEntry>,
    ) => Effect.Effect<void>;
  }
>() {}

// ---------------------------------------------------------------------------
// Live implementation
// ---------------------------------------------------------------------------

export const MountSetupServiceLive: Layer.Layer<
  MountSetupService,
  never,
  FsService
> = Layer.effect(
  MountSetupService,
  Effect.gen(function* () {
    const fs = yield* FsService;

    return MountSetupService.of({
      prepareClaudeState: (hostHome, options) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => prepareProtectedClaudeState(hostHome, options),
            // Preserve the original error (e.g. ClaudeOAuthUnavailableError's
            // login guidance) instead of letting tryPromise's default catch
            // wrap it in an UnknownException and discard its message.
            catch: (error) => error,
          }),
          (state) => Effect.promise(() => removeProtectedClaudeState(state)),
        ),
      prepareClaudeCredentials: (hostHome) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => prepareDummyClaudeCredentials(hostHome),
            catch: (error) => error,
          }),
          (state) => Effect.promise(() => removeDummyClaudeCredentials(state)),
        ).pipe(Effect.map((state) => state.file)),
      prepareCodexCredentials: (hostHome) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () => prepareDummyCodexCredentials(hostHome),
            // CodexOAuthUnavailableError のログイン案内を残すため、元のエラーを
            // そのまま返す。
            catch: (error) => error,
          }),
          (state) => Effect.promise(() => removeDummyCodexCredentials(state)),
        ).pipe(Effect.map((state) => state.file)),
      ensureDirectories: (dirs) =>
        Effect.gen(function* () {
          for (const dir of dirs) {
            yield* fs.mkdir(dir.path, { recursive: true, mode: dir.mode });
          }
        }),
      probeWorktreeGitMetadata: (worktreeDir) =>
        Effect.tryPromise({
          try: () => resolveGitMetadata(worktreeDir),
          catch: (error) => error,
        }).pipe(Effect.orDie),
      ensureFiles: (files) =>
        Effect.gen(function* () {
          for (const file of files) {
            if (yield* fs.exists(file.path)) continue;
            yield* fs.writeFile(file.path, file.content, { mode: file.mode });
          }
        }),
    });
  }),
);

// ---------------------------------------------------------------------------
// Fake / test implementation
// ---------------------------------------------------------------------------

export interface MountSetupServiceFakeConfig {
  readonly prepareClaudeState?: (
    hostHome: string,
    options?: { shareCredentials?: boolean; protectSettings?: boolean },
  ) => Effect.Effect<ProtectedClaudeState, unknown, Scope.Scope>;
  readonly prepareClaudeCredentials?: (
    hostHome: string,
  ) => Effect.Effect<string, unknown, Scope.Scope>;
  readonly prepareCodexCredentials?: (
    hostHome: string,
  ) => Effect.Effect<string, unknown, Scope.Scope>;
  readonly ensureDirectories?: (
    dirs: ReadonlyArray<MountDirectoryEntry>,
  ) => Effect.Effect<void>;
  readonly probeWorktreeGitMetadata?: (
    worktreeDir: string,
  ) => Effect.Effect<GitMetadataProbe | null>;
  readonly ensureFiles?: (
    files: ReadonlyArray<MountFileEntry>,
  ) => Effect.Effect<void>;
}

export function makeMountSetupServiceFake(
  overrides: MountSetupServiceFakeConfig = {},
): Layer.Layer<MountSetupService> {
  return Layer.succeed(
    MountSetupService,
    MountSetupService.of({
      prepareClaudeState:
        overrides.prepareClaudeState ??
        (() => Effect.die("prepareClaudeState fake is required")),
      prepareClaudeCredentials:
        overrides.prepareClaudeCredentials ??
        (() => Effect.die("prepareClaudeCredentials fake is required")),
      prepareCodexCredentials:
        overrides.prepareCodexCredentials ??
        (() => Effect.die("prepareCodexCredentials fake is required")),
      ensureDirectories: overrides.ensureDirectories ?? (() => Effect.void),
      probeWorktreeGitMetadata:
        overrides.probeWorktreeGitMetadata ?? (() => Effect.succeed(null)),
      ensureFiles: overrides.ensureFiles ?? (() => Effect.void),
    }),
  );
}
