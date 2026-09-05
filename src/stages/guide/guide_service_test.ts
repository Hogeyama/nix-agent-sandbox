import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { FsService, FsServiceLive } from "../../services/fs.ts";
import { GUIDE_SKILL_NAME } from "./content.ts";
import { GuideService, GuideServiceLive } from "./guide_service.ts";

describe("GuideServiceLive", () => {
  test("writes SKILL.md into the session directory (0o700) and removes the whole session directory on close", async () => {
    const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-guide-"));
    const sessionDir = path.join(runtimeDir, "sess-1");
    try {
      const skillPath = path.join(sessionDir, GUIDE_SKILL_NAME, "SKILL.md");

      const handle = await Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* GuideService;
          return yield* service.write({
            sessionDir,
            content: "---\nname: x\n---\n",
          });
        }).pipe(
          Effect.provide(GuideServiceLive.pipe(Layer.provide(FsServiceLive))),
        ),
      );

      expect(await readFile(skillPath, "utf8")).toBe("---\nname: x\n---\n");
      // Matches every other per-session runtime directory in this
      // repository (display, dbus-proxy, maskfs all use 0o700). Under the
      // /tmp fallback (XDG_RUNTIME_DIR absent), a world-readable session
      // directory would let any local user reach the skill content below.
      expect((await stat(sessionDir)).mode & 0o777).toBe(0o700);

      await Effect.runPromise(handle.close());

      // close() must remove the session directory itself, not just the
      // skill directory beneath it — otherwise an empty <sessionId>
      // directory accumulates under the runtime dir for the life of the
      // login session.
      await expect(stat(sessionDir)).rejects.toThrow();
    } finally {
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
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
          sessionDir: "/fake/sess-1",
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

  test("write() removes what it created when writeFile fails partway through", async () => {
    // Reproduces the second-order case: mkdir succeeds (twice — session dir,
    // then skill dir) but writeFile then dies. No handle is ever returned in
    // that case, so Effect.acquireRelease in the caller never gets to
    // register a release for what was already created on disk. The service
    // itself must clean up on this failure path.
    const created = new Set<string>();
    const failingFsService = FsService.of({
      mkdir: (p) =>
        Effect.sync(() => {
          created.add(p);
        }),
      writeFile: () => Effect.die(new Error("ENOSPC: no space left on device")),
      chmod: () => Effect.die(new Error("unexpected chmod call")),
      symlink: () => Effect.die(new Error("unexpected symlink call")),
      rm: (p, opts) =>
        Effect.sync(() => {
          if (opts?.recursive) {
            const prefix = p.endsWith("/") ? p : `${p}/`;
            for (const entry of [...created]) {
              if (entry === p || entry.startsWith(prefix))
                created.delete(entry);
            }
          } else {
            created.delete(p);
          }
        }),
      rmdir: () => Effect.die(new Error("unexpected rmdir call")),
      stat: () => Effect.die(new Error("unexpected stat call")),
      exists: () => Effect.die(new Error("unexpected exists call")),
      readFile: () => Effect.die(new Error("unexpected readFile call")),
      rename: () => Effect.die(new Error("unexpected rename call")),
      mkdtemp: () => Effect.die(new Error("unexpected mkdtemp call")),
    });

    const sessionDir = "/fake/guide/sess-1";

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* GuideService;
          return yield* service.write({ sessionDir, content: "x" });
        }).pipe(
          Effect.provide(
            GuideServiceLive.pipe(
              Layer.provide(Layer.succeed(FsService, failingFsService)),
            ),
          ),
        ),
      ),
    ).rejects.toThrow();

    // Nothing the failed write created — session dir or skill dir — is left
    // behind.
    expect(created.size).toBe(0);
  });
});
