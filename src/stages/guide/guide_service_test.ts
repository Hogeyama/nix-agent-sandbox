import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { FsService, FsServiceLive } from "../../services/fs.ts";
import { GuideService, GuideServiceLive } from "./guide_service.ts";

describe("GuideServiceLive", () => {
  test("writes SKILL.md into the given directory and removes it on close", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "nas-guide-"));
    const dir = path.join(base, "nas-sandbox");
    try {
      const skillPath = path.join(dir, "SKILL.md");

      const handle = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* GuideService;
          return yield* service.write({ dir, content: "---\nname: x\n---\n" });
        }).pipe(
          Effect.provide(GuideServiceLive.pipe(Layer.provide(FsServiceLive))),
        ),
      );

      expect(await readFile(skillPath, "utf8")).toBe("---\nname: x\n---\n");

      await Effect.runPromise(handle.close());

      await expect(stat(dir)).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("close() succeeds even when the underlying rm dies (defect, not a typed error)", async () => {
    // FsServiceLive.rm ends in Effect.orDie, so a real removal failure (EBUSY,
    // EPERM, ...) surfaces as a defect. This fake reproduces that shape
    // directly instead of trying to provoke a real EBUSY, so the test proves
    // close() tolerates a defect from `rm` specifically.
    const dyingFsService = FsService.of({
      mkdir: () => Effect.void,
      writeFile: () => Effect.void,
      chmod: () => Effect.die(new Error("unexpected chmod call")),
      symlink: () => Effect.die(new Error("unexpected symlink call")),
      rm: () => Effect.die(new Error("EBUSY: resource busy or locked")),
      rmdir: () => Effect.die(new Error("unexpected rmdir call")),
      stat: () => Effect.die(new Error("unexpected stat call")),
      exists: () => Effect.die(new Error("unexpected exists call")),
      readFile: () => Effect.die(new Error("unexpected readFile call")),
      rename: () => Effect.die(new Error("unexpected rename call")),
      mkdtemp: () => Effect.die(new Error("unexpected mkdtemp call")),
    });

    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* GuideService;
        return yield* service.write({
          dir: "/fake/nas-sandbox",
          content: "---\nname: x\n---\n",
        });
      }).pipe(
        Effect.provide(
          GuideServiceLive.pipe(
            Layer.provide(Layer.succeed(FsService, dyingFsService)),
          ),
        ),
      ),
    );

    // Must not reject: a finalizer that fails on a defect is the bug this
    // test guards against.
    await expect(Effect.runPromise(handle.close())).resolves.toBeUndefined();
  });
});
