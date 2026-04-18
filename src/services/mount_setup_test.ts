import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { FsService, makeFsServiceFake } from "./fs.ts";
import { MountSetupService, MountSetupServiceLive } from "./mount_setup.ts";

test("ensureDirectories: mkdir is called for every dir with recursive and mode", async () => {
  const fsFake = makeFsServiceFake();
  const calls: Array<{
    path: string;
    opts: { recursive?: boolean; mode?: number };
  }> = [];
  const recordingFs = Layer.succeed(FsService, {
    mkdir: (path, opts) => {
      calls.push({ path, opts });
      return Effect.provide(
        Effect.flatMap(FsService, (s) => s.mkdir(path, opts)),
        fsFake.layer,
      );
    },
    writeFile: () => Effect.void,
    chmod: () => Effect.void,
    symlink: () => Effect.void,
    rm: () => Effect.void,
    stat: () => Effect.die("not used"),
    exists: () => Effect.succeed(false),
    readFile: () => Effect.succeed(""),
    rename: () => Effect.void,
    mkdtemp: () => Effect.succeed("/tmp/test"),
  });

  const live = MountSetupServiceLive.pipe(Layer.provide(recordingFs));
  await Effect.runPromise(
    Effect.flatMap(MountSetupService, (svc) =>
      svc.ensureDirectories([
        { path: "/a", mode: 0o755 },
        { path: "/b/c", mode: 0o700 },
        { path: "/no-mode" }, // omitted mode
      ]),
    ).pipe(Effect.provide(live)),
  );

  expect(calls).toEqual([
    { path: "/a", opts: { recursive: true, mode: 0o755 } },
    { path: "/b/c", opts: { recursive: true, mode: 0o700 } },
    { path: "/no-mode", opts: { recursive: true, mode: undefined } },
  ]);
});

test("ensureDirectories: empty list is a no-op", async () => {
  const fsFake = makeFsServiceFake();
  const live = MountSetupServiceLive.pipe(Layer.provide(fsFake.layer));
  await Effect.runPromise(
    Effect.flatMap(MountSetupService, (svc) => svc.ensureDirectories([])).pipe(
      Effect.provide(live),
    ),
  );
  expect(fsFake.store.size).toEqual(0);
});
