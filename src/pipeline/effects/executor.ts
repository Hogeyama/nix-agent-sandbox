/**
 * Effect executor: executeEffect, executePlan, teardownHandles.
 */

import { logWarn } from "../../log.ts";
import type { ResourceEffect } from "./types.ts";

interface StagePlan {
  effects: ResourceEffect[];
  dockerArgs: string[];
  envVars: Record<string, string>;
  outputOverrides: Record<string, unknown>;
}

import { executeDbusProxy } from "./dbus.ts";
import { executeDindSidecar } from "./dind.ts";
import {
  executeDockerImageBuild,
  executeDockerRunInteractive,
} from "./docker.ts";
import {
  executeDirectoryCreate,
  executeFileWrite,
  executeSymlink,
} from "./fs.ts";
import { executeProcessSpawn, executeWaitForReady } from "./process.ts";
import { executeProxySession } from "./proxy.ts";
import type { ResourceHandle } from "./types.ts";
import { executeUnixListener } from "./unix_listener.ts";

/** Execute a single ResourceEffect and return a handle for teardown. */
export async function executeEffect(
  effect: ResourceEffect,
): Promise<ResourceHandle> {
  switch (effect.kind) {
    case "directory-create":
      return await executeDirectoryCreate(effect);
    case "file-write":
      return await executeFileWrite(effect);
    case "dind-sidecar":
      return await executeDindSidecar(effect);
    case "dbus-proxy":
      return await executeDbusProxy(effect);
    case "process-spawn":
      return await executeProcessSpawn(effect);
    case "wait-for-ready":
      return await executeWaitForReady(effect);
    case "symlink":
      return await executeSymlink(effect);
    case "unix-listener":
      return await executeUnixListener(effect);
    case "proxy-session":
      return await executeProxySession(effect);
    case "docker-image-build":
      return await executeDockerImageBuild(effect);
    case "docker-run-interactive":
      return await executeDockerRunInteractive(effect);
    case "docker-container":
    case "docker-network":
    case "docker-volume":
      throw new Error(`Effect not yet implemented: ${effect.kind}`);
  }
}

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
      } catch (teardownErr) {
        logWarn(
          `[nas] executePlan: teardown failed during error recovery: ${
            teardownErr instanceof Error
              ? teardownErr.message
              : String(teardownErr)
          }`,
        );
      }
      throw error;
    }
  }
  return handles;
}

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
    const messages = errors
      .map(
        (e) =>
          `[${e.kind}] ${
            e.error instanceof Error ? e.error.message : String(e.error)
          }`,
      )
      .join("; ");
    throw new Error(
      `Teardown failed for ${errors.length} handle(s): ${messages}`,
    );
  }
}
