import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Layer } from "effect";
import type { HostEnv } from "../../pipeline/types.ts";
import { devcontainerProfile } from "./fixtures.ts";
import { DevcontainerService, makeDevcontainerServiceLive } from "./service.ts";
import {
  type DevcontainerInputs,
  DevcontainerStoreOps,
  makeDevcontainerStoreOpsLive,
  resolveDevcontainerPaths,
  resolveDevcontainerRuntimePaths,
  writeDevcontainerSession,
} from "./store.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function fixture(
  overrides: Partial<DevcontainerInputs> = {},
  opsOverrides:
    | Partial<ContextService>
    | ((real: ContextService) => Partial<ContextService>) = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "nas-devcontainer-service-"));
  dirs.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const home = path.join(root, "home");
  await mkdir(home);
  const host: HostEnv = {
    home,
    user: "nas",
    uid: process.getuid!(),
    gid: process.getgid!(),
    isWSL: false,
    env: new Map([
      ["XDG_STATE_HOME", path.join(root, "state")],
      ["XDG_RUNTIME_DIR", path.join(root, "run")],
    ]),
  };
  const inputs: DevcontainerInputs = {
    profile: devcontainerProfile(),
    profileName: "claude",
    trustHash: "trust-v1",
    configDir: path.join(workspace, ".nas"),
    implementation: "test-v1",
    embedHash: "embed-v1",
    command: ["/bin/nas"],
    ...overrides,
  };
  let loads = 0;
  const ops = Layer.effect(
    DevcontainerStoreOps,
    Effect.gen(function* () {
      const real = yield* DevcontainerStoreOps;
      return DevcontainerStoreOps.of({
        ...real,
        inputs: () =>
          Effect.sync(() => {
            loads++;
            return inputs;
          }),
        ...(typeof opsOverrides === "function"
          ? opsOverrides(real)
          : opsOverrides),
      });
    }),
  ).pipe(Layer.provide(makeDevcontainerStoreOpsLive(host)));
  const live = makeDevcontainerServiceLive(host).pipe(Layer.provide(ops));
  function run<A>(
    f: (
      svc: import("effect").Context.Tag.Service<DevcontainerService>,
    ) => Effect.Effect<A, Error>,
  ) {
    return Effect.runPromise(
      Effect.flatMap(DevcontainerService, f).pipe(Effect.provide(live)),
    );
  }
  return { root, workspace, host, inputs, run, loads: () => loads };
}
type ContextService =
  import("effect").Context.Tag.Service<DevcontainerStoreOps>;

test("init creates managed entry and dedicated state, then repeat init preserves authentication", async () => {
  const { workspace, host, run } = await fixture();
  const registration = await run((s) => s.init(workspace, "claude"));
  const paths = resolveDevcontainerPaths(host, workspace);
  expect(registration.workspace).toBe(workspace);
  expect(registration.composePath).toBe(paths.composeFile);
  expect(
    JSON.parse(await readFile(registration.configPath, "utf8"))
      .initializeCommand,
  ).toEqual(["/bin/nas", "devcontainer", "up", "--workspace", workspace]);
  expect((await stat(paths.registrationFile)).mode & 0o777).toBe(0o600);
  await writeFile(paths.claudeJson, '{"session":"retained"}');
  expect(await run((s) => s.init(workspace, "claude"))).toEqual(registration);
  expect(await readFile(paths.claudeJson, "utf8")).toBe(
    '{"session":"retained"}',
  );
  expect(await run((s) => s.verify(workspace))).toEqual(registration);
});

test("third-party config and symlink refusal precede config evaluation and preserve bytes", async () => {
  const f = await fixture();
  const dir = path.join(f.workspace, ".devcontainer");
  await mkdir(dir);
  await writeFile(path.join(dir, "devcontainer.json"), "third-party");
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "existing",
  );
  expect(f.loads()).toBe(0);
  expect(await readFile(path.join(dir, "devcontainer.json"), "utf8")).toBe(
    "third-party",
  );
  const second = await fixture();
  await symlink(dir, path.join(second.workspace, ".devcontainer"));
  await expect(
    second.run((s) => s.init(second.workspace, "claude")),
  ).rejects.toThrow("symlink");
  expect(second.loads()).toBe(0);
});

test("reinit refuses active or failed generations and independent edits", async () => {
  const f = await fixture();
  const registration = await f.run((s) => s.init(f.workspace, "claude"));
  const runtime = resolveDevcontainerRuntimePaths(f.host, f.workspace);
  await writeDevcontainerSession(f.host, f.workspace, {
    version: 1,
    workspaceId: registration.workspaceId,
    fingerprint: registration.fingerprint,
    sessionId: "session-a",
    containerId: "container-a",
    phase: "ready",
    controlSocket: runtime.controlSocket,
    diagnostic: null,
  });
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "stopped",
  );
  await writeDevcontainerSession(
    f.host,
    f.workspace,
    {
      version: 1,
      workspaceId: registration.workspaceId,
      fingerprint: registration.fingerprint,
      sessionId: "session-a",
      containerId: null,
      phase: "stopped",
      controlSocket: runtime.controlSocket,
      diagnostic: null,
    },
    "session-a",
  );
  await writeFile(registration.configPath, "edited");
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "modified",
  );
  expect(await readFile(registration.configPath, "utf8")).toBe("edited");
});

test("mid-generation failure rolls back only new managed artifacts", async () => {
  const f = await fixture({}, (real) => ({
    write: (file, bytes, exclusive) =>
      file.endsWith("registration.json")
        ? Effect.fail(new Error("publish failed"))
        : real.write(file, bytes, exclusive),
  }));
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "failed",
  );
  expect(await readdir(f.workspace)).toEqual([]);
  const paths = resolveDevcontainerPaths(f.host, f.workspace);
  expect(await readdir(paths.registrationDir)).toEqual(["operation.lock"]);
});

test("fingerprint rejects config input changes without executing env commands; status exposes only public fields", async () => {
  const f = await fixture();
  f.inputs.profile.env.push({ key: "NO_EXEC", valCmd: "exit 99", mode: "set" });
  const registration = await f.run((s) => s.init(f.workspace, "claude"));
  expect(await f.run((s) => s.status(f.workspace))).toEqual({
    workspaceId: registration.workspaceId,
    profileName: "claude",
    phase: "stopped",
    sessionId: null,
    containerId: null,
    diagnostic: null,
  });
  f.inputs.profile.agentArgs.push("--changed");
  await expect(f.run((s) => s.verify(f.workspace))).rejects.toThrow(
    "fingerprint",
  );
  expect(await f.run((s) => s.status(f.workspace))).not.toHaveProperty(
    "controlSocket",
  );
});

test("simultaneous init serializes and rejects unsafe explicit git credential shares", async () => {
  const f = await fixture();
  const results = await Promise.all([
    f.run((s) => s.init(f.workspace, "claude")),
    f.run((s) => s.init(f.workspace, "claude")),
  ]);
  expect(results[0]).toEqual(results[1]);
  const unsafe = await fixture();
  unsafe.inputs.profile.extraMounts.push({
    src: path.join(unsafe.host.home, ".config", "git"),
    dst: "/alias",
    mode: "ro",
  });
  await expect(
    unsafe.run((s) => s.init(unsafe.workspace, "claude")),
  ).rejects.toThrow("protected host path");
  expect(await readdir(unsafe.workspace)).toEqual([]);
});

test("bare tilde mount resolves to the actual host HOME and is rejected", async () => {
  const f = await fixture();
  f.inputs.profile.extraMounts.push({
    src: "~",
    dst: "/alias",
    mode: "rw",
  });

  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "mount source exposes host HOME",
  );
  expect(await readdir(f.workspace)).toEqual([]);
});

test("init refuses unregistered dedicated state without adopting authentication", async () => {
  const f = await fixture();
  const paths = resolveDevcontainerPaths(f.host, f.workspace);
  await mkdir(paths.claudeDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(paths.claudeDir, "existing"), "outside-state");
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "unregistered dedicated state",
  );
  expect(await readFile(path.join(paths.claudeDir, "existing"), "utf8")).toBe(
    "outside-state",
  );
  expect(await readdir(f.workspace)).toEqual([]);
});

test("Fake defaults and client overrides preserve typed errors", async () => {
  const { host } = await fixture();
  const { makeDevcontainerClient, makeDevcontainerServiceFake } = await import(
    "./service.ts"
  );
  const { DevcontainerError } = await import("./types.ts");
  const empty = makeDevcontainerClient(host, makeDevcontainerServiceFake());
  expect(await empty.status("/none")).toBe(null);
  expect((await empty.init("/workspace", "claude")).workspace).toBe(
    "/workspace",
  );
  const error = new DevcontainerError("typed refusal");
  const client = makeDevcontainerClient(
    host,
    makeDevcontainerServiceFake({ init: () => Effect.fail(error) }),
  );
  expect(await client.init("/workspace", "claude").catch((e) => e)).toBe(error);
});

// Dependency closure is checked without evaluating the layer or touching host files.
const _defaultLayerClosesToNever = (host: HostEnv) =>
  makeDevcontainerServiceLive(host).pipe(
    Layer.provide(makeDevcontainerStoreOpsLive(host)),
  ) satisfies Layer.Layer<DevcontainerService, never, never>;

test("failed stopped reinit restores both ownership bytes and prior registration", async () => {
  let rejectPublish = false;
  const f = await fixture({}, (real) => ({
    write: (file, bytes, exclusive) =>
      rejectPublish && file.endsWith("registration.json")
        ? Effect.fail(new Error("publish failed"))
        : real.write(file, bytes, exclusive),
  }));
  const registration = await f.run((s) => s.init(f.workspace, "claude"));
  const paths = resolveDevcontainerPaths(f.host, f.workspace);
  const snapshot = async () =>
    Promise.all(
      [
        registration.configPath,
        paths.registrationFile,
        path.join(paths.registrationDir, "ownership.json"),
        paths.claudeJson,
      ].map((file) => readFile(file, "utf8")),
    );
  const before = await snapshot();
  f.inputs.profile.agentArgs.push("--new");
  rejectPublish = true;
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "publish failed",
  );
  expect(await snapshot()).toEqual(before);
});

test("explicit mounts cannot read another workspace's dedicated authentication", async () => {
  const f = await fixture();
  const other = resolveDevcontainerPaths(f.host, "/another/workspace");
  f.inputs.profile.extraMounts.push({
    src: other.claudeDir,
    dst: "/alias",
    mode: "ro",
  });
  await expect(f.run((s) => s.init(f.workspace, "claude"))).rejects.toThrow(
    "dedicated state",
  );
});
