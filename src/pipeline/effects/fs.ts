/**
 * Filesystem effects: directory-create, file-write, symlink.
 */

import type { ResourceEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";
import { logWarn } from "../../log.ts";

export async function executeDirectoryCreate(
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

export async function executeFileWrite(
  effect: Extract<ResourceEffect, { kind: "file-write" }>,
): Promise<ResourceHandle> {
  await Deno.writeTextFile(effect.path, effect.content);
  try {
    await Deno.chmod(effect.path, effect.mode);
  } catch (error) {
    try {
      await Deno.remove(effect.path);
    } catch (cleanupErr) {
      if (!(cleanupErr instanceof Deno.errors.NotFound)) {
        logWarn(
          `[nas] file-write: cleanup failed after chmod error: ${
            cleanupErr instanceof Error
              ? cleanupErr.message
              : String(cleanupErr)
          }`,
        );
      }
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

export async function executeSymlink(
  effect: Extract<ResourceEffect, { kind: "symlink" }>,
): Promise<ResourceHandle> {
  // Remove old symlink if it exists
  try {
    await Deno.remove(effect.path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }
  await Deno.symlink(effect.target, effect.path);
  return {
    kind: "symlink",
    close: async () => {
      try {
        await Deno.remove(effect.path);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) {
          throw e;
        }
      }
    },
  };
}
