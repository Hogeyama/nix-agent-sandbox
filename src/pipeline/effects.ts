/**
 * Effect executor and ResourceHandle teardown management.
 *
 * Phase 0: only `directory-create` and `file-write` are implemented.
 * Other effect kinds throw "not yet implemented" errors.
 */

import type { ResourceEffect, StagePlan } from "./types.ts";

// ---------------------------------------------------------------------------
// ResourceHandle
// ---------------------------------------------------------------------------

/** Handle returned by executeEffect for teardown */
export interface ResourceHandle {
  kind: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// executeEffect
// ---------------------------------------------------------------------------

/** Execute a single ResourceEffect and return a handle for teardown. */
export async function executeEffect(
  effect: ResourceEffect,
): Promise<ResourceHandle> {
  switch (effect.kind) {
    case "directory-create":
      return await executeDirectoryCreate(effect);
    case "file-write":
      return await executeFileWrite(effect);
    case "docker-container":
    case "docker-network":
    case "docker-volume":
    case "symlink":
    case "process-spawn":
    case "unix-listener":
    case "wait-for-ready":
    case "dind-sidecar":
    case "docker-run-interactive":
      throw new Error(`Effect not yet implemented: ${effect.kind}`);
  }
}

// ---------------------------------------------------------------------------
// executePlan
// ---------------------------------------------------------------------------

/** Execute all effects in a StagePlan sequentially and return accumulated handles. */
export async function executePlan(plan: StagePlan): Promise<ResourceHandle[]> {
  const handles: ResourceHandle[] = [];
  for (const effect of plan.effects) {
    try {
      const handle = await executeEffect(effect);
      handles.push(handle);
    } catch (error) {
      try {
        await teardownHandles(handles);
      } catch {
        // teardown failed, but we still want to throw the original error
      }
      throw error;
    }
  }
  return handles;
}

// ---------------------------------------------------------------------------
// teardownHandles
// ---------------------------------------------------------------------------

/** Close handles in reverse order. Errors are collected and reported together. */
export async function teardownHandles(
  handles: ResourceHandle[],
): Promise<void> {
  const errors: { kind: string; error: unknown }[] = [];
  for (let i = handles.length - 1; i >= 0; i--) {
    try {
      await handles[i].close();
    } catch (error) {
      errors.push({ kind: handles[i].kind, error });
    }
  }
  if (errors.length > 0) {
    const messages = errors.map((e) =>
      `[${e.kind}] ${
        e.error instanceof Error ? e.error.message : String(e.error)
      }`
    ).join("; ");
    throw new Error(
      `Teardown failed for ${errors.length} handle(s): ${messages}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Effect implementations (Phase 0)
// ---------------------------------------------------------------------------

async function executeDirectoryCreate(
  effect: Extract<ResourceEffect, { kind: "directory-create" }>,
): Promise<ResourceHandle> {
  await Deno.mkdir(effect.path, { recursive: true, mode: effect.mode });
  return {
    kind: "directory-create",
    close: async () => {
      if (effect.removeOnTeardown) {
        await Deno.remove(effect.path, { recursive: true });
      }
    },
  };
}

async function executeFileWrite(
  effect: Extract<ResourceEffect, { kind: "file-write" }>,
): Promise<ResourceHandle> {
  await Deno.writeTextFile(effect.path, effect.content);
  try {
    await Deno.chmod(effect.path, effect.mode);
  } catch (error) {
    try {
      await Deno.remove(effect.path);
    } catch {
      // cleanup failed, but we still want to throw the original error
    }
    throw error;
  }
  return {
    kind: "file-write",
    close: async () => {
      await Deno.remove(effect.path);
    },
  };
}
