import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeFsServiceFake } from "./fs.ts";
import {
  HostExecSetupService,
  HostExecSetupServiceLive,
} from "./hostexec_setup.ts";

test("prepareWorkspace: creates dirs, writes files, and makes symlinks in order", async () => {
  const fsFake = makeFsServiceFake();
  const live = HostExecSetupServiceLive.pipe(Layer.provide(fsFake.layer));

  await Effect.runPromise(
    Effect.flatMap(HostExecSetupService, (svc) =>
      svc.prepareWorkspace({
        directories: [
          { path: "/nas/wrap", mode: 0o755 },
          { path: "/nas/secrets", mode: 0o700 },
        ],
        files: [
          { path: "/nas/wrap/docker", content: "#!/bin/sh\n", mode: 0o755 },
          { path: "/nas/secrets/token", content: "abc", mode: 0o600 },
        ],
        symlinks: [{ target: "/nas/wrap/docker", path: "/nas/wrap/podman" }],
      }),
    ).pipe(Effect.provide(live)),
  );

  // Directories
  const wrapDir = fsFake.store.get("/nas/wrap");
  expect(wrapDir?.isDirectory).toEqual(true);
  expect(wrapDir?.mode).toEqual(0o755);
  expect(fsFake.store.get("/nas/secrets")?.mode).toEqual(0o700);

  // Files
  expect(fsFake.store.get("/nas/wrap/docker")?.content).toEqual("#!/bin/sh\n");
  expect(fsFake.store.get("/nas/wrap/docker")?.mode).toEqual(0o755);
  expect(fsFake.store.get("/nas/secrets/token")?.content).toEqual("abc");
  expect(fsFake.store.get("/nas/secrets/token")?.mode).toEqual(0o600);

  // Symlink
  const link = fsFake.store.get("/nas/wrap/podman");
  expect(link?.symlinkTarget).toEqual("/nas/wrap/docker");
});

test("prepareWorkspace: empty plan is a no-op", async () => {
  const fsFake = makeFsServiceFake();
  const live = HostExecSetupServiceLive.pipe(Layer.provide(fsFake.layer));

  await Effect.runPromise(
    Effect.flatMap(HostExecSetupService, (svc) =>
      svc.prepareWorkspace({ directories: [], files: [], symlinks: [] }),
    ).pipe(Effect.provide(live)),
  );

  expect(fsFake.store.size).toEqual(0);
});
