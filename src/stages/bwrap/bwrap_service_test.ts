import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import { FsServiceLive } from "../../services/fs.ts";
import { BwrapService, BwrapServiceLive } from "./bwrap_service.ts";

test("writes the profile privately into the session directory and removes the directory on close", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-bwrap-"));
  const sessionDir = path.join(runtimeDir, "sess-1");
  try {
    const handle = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* BwrapService;
        return yield* service.write({ sessionDir, seccompProfile: "{}" });
      }).pipe(
        Effect.provide(BwrapServiceLive.pipe(Layer.provide(FsServiceLive))),
      ),
    );

    expect(handle.seccompProfilePath).toBe(
      path.join(sessionDir, "seccomp.json"),
    );
    expect(await readFile(handle.seccompProfilePath, "utf8")).toBe("{}");
    expect((await stat(sessionDir)).mode & 0o777).toBe(0o700);
    expect((await stat(handle.seccompProfilePath)).mode & 0o777).toBe(0o600);

    await Effect.runPromise(handle.close());
    await expect(stat(sessionDir)).rejects.toThrow();
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
