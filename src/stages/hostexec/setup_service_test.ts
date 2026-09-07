import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { FsService, FsServiceLive } from "../../services/fs.ts";
import {
  type HostExecSetupHandle,
  HostExecSetupService,
  HostExecSetupServiceLive,
  type HostExecWorkspacePlan,
} from "./setup_service.ts";

function prepareWorkspace(
  plan: HostExecWorkspacePlan,
  fsLayer: Layer.Layer<FsService> = FsServiceLive,
): Promise<HostExecSetupHandle> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* HostExecSetupService;
      return yield* service.prepareWorkspace(plan);
    }).pipe(
      Effect.provide(HostExecSetupServiceLive.pipe(Layer.provide(fsLayer))),
    ),
  );
}

describe("HostExecSetupServiceLive", () => {
  test("writes the installed PATH command executable and removes it on close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nas-hostexec-setup-"));
    try {
      const runtimePath = path.join(root, "wrapper", "bin", "hostexec");
      const plan: HostExecWorkspacePlan = {
        directories: [{ path: path.dirname(runtimePath), mode: 0o755 }],
        symlinks: [],
        script: {
          runtimePath,
          content: '#!/bin/sh\nexec "$@"\n',
        },
      };

      const handle = await prepareWorkspace(plan);

      expect(await readFile(runtimePath, "utf8")).toBe(plan.script!.content);
      expect((await stat(runtimePath)).mode & 0o777).toBe(0o755);

      await Effect.runPromise(handle.close());
      await expect(stat(runtimePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("removes a partially created runtime script when later setup fails", async () => {
    const runtimePath = "/runtime/session/bin/hostexec";
    const entries = new Set<string>();
    let scriptPresentWhenSymlinkRan = false;
    const removed: string[] = [];
    const fakeFs = FsService.of({
      mkdir: (target) =>
        Effect.sync(() => {
          entries.add(target);
        }),
      writeFile: (target) =>
        Effect.sync(() => {
          entries.add(target);
        }),
      chmod: () => Effect.void,
      symlink: () =>
        Effect.sync(() => {
          scriptPresentWhenSymlinkRan = entries.has(runtimePath);
          throw new Error("simulated symlink failure");
        }),
      rm: (target) =>
        Effect.sync(() => {
          removed.push(target);
          entries.delete(target);
        }),
      rmdir: () => Effect.die(new Error("unexpected rmdir call")),
      stat: () => Effect.die(new Error("unexpected stat call")),
      exists: () => Effect.die(new Error("unexpected exists call")),
      readFile: () => Effect.die(new Error("unexpected readFile call")),
      rename: () => Effect.die(new Error("unexpected rename call")),
      mkdtemp: () => Effect.die(new Error("unexpected mkdtemp call")),
    });

    await expect(
      prepareWorkspace(
        {
          directories: [{ path: "/runtime/session/bin", mode: 0o755 }],
          symlinks: [{ target: "/client", path: "/runtime/session/bin/git" }],
          script: { runtimePath, content: "generated\n" },
        },
        Layer.succeed(FsService, fakeFs),
      ),
    ).rejects.toThrow("simulated symlink failure");

    expect(scriptPresentWhenSymlinkRan).toBe(true);
    expect(removed).toContain(runtimePath);
    expect(entries.has(runtimePath)).toBe(false);
  });
});
