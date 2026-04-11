/**
 * Filesystem effects: directory-create, file-write, symlink.
 */

import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { logWarn } from "../../log.ts";
import type { ResourceEffect } from "../types.ts";
import type { ResourceHandle } from "./types.ts";

export async function executeDirectoryCreate(
  effect: Extract<ResourceEffect, { kind: "directory-create" }>,
): Promise<ResourceHandle> {
  await mkdir(effect.path, { recursive: true, mode: effect.mode });
  return {
    kind: "directory-create",
    close: async () => {
      if (effect.removeOnTeardown) {
        await rm(effect.path, { recursive: true, force: true });
      }
    },
  };
}

export async function executeFileWrite(
  effect: Extract<ResourceEffect, { kind: "file-write" }>,
): Promise<ResourceHandle> {
  await writeFile(effect.path, effect.content);
  try {
    await chmod(effect.path, effect.mode);
  } catch (error) {
    try {
      await rm(effect.path, { force: true });
    } catch (cleanupErr) {
      if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
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
      await rm(effect.path);
    },
  };
}

export async function executeSymlink(
  effect: Extract<ResourceEffect, { kind: "symlink" }>,
): Promise<ResourceHandle> {
  // Remove old symlink if it exists
  try {
    await rm(effect.path, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw e;
    }
  }
  await symlink(effect.target, effect.path);
  return {
    kind: "symlink",
    close: async () => {
      try {
        await rm(effect.path, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e;
        }
      }
    },
  };
}
