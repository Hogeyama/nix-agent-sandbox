import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_HOOK_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_SESSION_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import type {
  HostEnv,
  ProbeResults,
  StageResult,
  StageInput,
} from "../pipeline/types.ts";
import { FsServiceLive } from "../services/fs.ts";
import { ProcessServiceLive } from "../services/process.ts";
import {
  buildProxyArgs,
  createDbusProxyStage,
  resolveRuntimeDir,
  resolveSourceAddress,
} from "./dbus_proxy.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    session: DEFAULT_SESSION_CONFIG,
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    hook: DEFAULT_HOOK_CONFIG,
    extraMounts: [],
    env: [],
  };
}

function makeHostEnv(overrides?: Partial<HostEnv>): HostEnv {
  return {
    home: process.env.HOME ?? "/root",
    user: process.env.USER ?? "",
    uid: process.getuid!(),
    gid: process.getgid!(),
    isWSL: false,
    env: new Map(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    ),
    ...overrides,
  };
}

function makeProbes(overrides?: Partial<ProbeResults>): ProbeResults {
  return {
    hasHostNix: false,
    xdgDbusProxyPath: null,
    dbusSessionAddress: null,
    gpgAgentSocket: null,
    auditDir: "/tmp/nas-test-audit",
    ...overrides,
  };
}

function makeInput(
  profile: Profile,
  hostEnv?: Partial<HostEnv>,
  probes?: Partial<ProbeResults>,
): StageInput {
  const config: Config = {
    profiles: { default: profile },
    ui: DEFAULT_UI_CONFIG,
  };
  return {
    config,
    profile,
    profileName: "default",
    sessionId: "test-session-id",
    host: makeHostEnv(hostEnv),
    probes: makeProbes(probes),
  };
}

import {
  DbusProxyServiceLive,
  makeDbusProxyServiceFake,
} from "../services/dbus_proxy.ts";

const dummyLayer = makeDbusProxyServiceFake();

function runStage(input: StageInput): Promise<StageResult> {
  const stage = createDbusProxyStage(input);
  const scope = Effect.runSync(Scope.make());
  const effect = stage
    .run({})
    .pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(dummyLayer),
    );
  return Effect.runPromise(effect);
}

async function runStageScoped(
  input: StageInput,
  layer: Layer.Layer<
    import("../services/dbus_proxy.ts").DbusProxyService,
    never,
    never
  >,
  fn: (result: StageResult) => Promise<void>,
): Promise<void> {
  const stage = createDbusProxyStage(input);
  const scope = Effect.runSync(Scope.make());
  const effect = stage
    .run({})
    .pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(layer));
  const result = await Effect.runPromise(effect);
  try {
    await fn(result);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

test("resolveSourceAddress: prefers configured address, then probe, then default path", () => {
  expect(
    resolveSourceAddress(
      "unix:path=/tmp/from-config",
      "unix:path=/tmp/from-env",
      1000,
    ),
  ).toEqual("unix:path=/tmp/from-config");
  expect(
    resolveSourceAddress(undefined, "unix:path=/tmp/from-env", 1000),
  ).toEqual("unix:path=/tmp/from-env");
  expect(resolveSourceAddress(undefined, null, 1000)).toEqual(
    "unix:path=/run/user/1000/bus",
  );
});

test("buildProxyArgs: serializes filter flags", () => {
  expect(
    buildProxyArgs(
      "unix:path=/run/user/1000/bus",
      "/tmp/proxy/bus",
      ["org.freedesktop.secrets"],
      ["org.freedesktop.secrets"],
      ["org.example.Owned"],
      [{ name: "org.freedesktop.secrets", rule: "*" }],
      [{ name: "org.freedesktop.secrets", rule: "*" }],
    ),
  ).toEqual([
    "unix:path=/run/user/1000/bus",
    "/tmp/proxy/bus",
    "--filter",
    "--see=org.freedesktop.secrets",
    "--talk=org.freedesktop.secrets",
    "--own=org.example.Owned",
    "--call=org.freedesktop.secrets=*",
    "--broadcast=org.freedesktop.secrets=*",
  ]);
});

test("DbusProxyStage: returns disabled dbus slice when disabled", async () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const result = await runStage(input);
  expect(result).toEqual({ dbus: { enabled: false } });
});

test("DbusProxyStage: returns disabled dbus slice when uid is null", async () => {
  const profile: Profile = {
    ...makeProfile(),
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
      },
    },
  };
  const input = makeInput(profile, { uid: null });
  const result = await runStage(input);
  expect(result.dbus).toEqual({ enabled: false });
});

test("DbusProxyStage: returns disabled dbus slice when xdg-dbus-proxy not found", async () => {
  const profile: Profile = {
    ...makeProfile(),
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
        sourceAddress: "unix:path=/run/user/1000/bus",
      },
    },
  };
  const input = makeInput(profile, { uid: 1000 }, { xdgDbusProxyPath: null });
  const result = await runStage(input);
  expect(result.dbus).toEqual({ enabled: false });
});

test("DbusProxyStage: returns disabled dbus slice for unsupported address", async () => {
  const profile: Profile = {
    ...makeProfile(),
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
        sourceAddress: "tcp:host=127.0.0.1,port=1234",
      },
    },
  };
  const input = makeInput(
    profile,
    { uid: 1000 },
    { xdgDbusProxyPath: "/usr/bin/xdg-dbus-proxy" },
  );
  const result = await runStage(input);
  expect(result.dbus).toEqual({ enabled: false });
});

test("DbusProxyStage: produces correct outputs when enabled", async () => {
  const uid = process.getuid!();
  if (uid === null) return;

  const profile: Profile = {
    ...makeProfile(),
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
        sourceAddress: `unix:path=/run/user/${uid}/bus`,
        talk: ["org.freedesktop.secrets"],
      },
    },
  };

  const fakeLayer = makeDbusProxyServiceFake();

  const input = makeInput(
    profile,
    { uid },
    {
      xdgDbusProxyPath: "/usr/bin/xdg-dbus-proxy",
      dbusSessionAddress: `unix:path=/run/user/${uid}/bus`,
    },
  );

  const stage = createDbusProxyStage(input);
  const scope = Effect.runSync(Scope.make());
  const result = await Effect.runPromise(
    stage
      .run({})
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(fakeLayer),
      ),
  );
  await Effect.runPromise(Scope.close(scope, Exit.void));

  expect(result.dbus).toEqual({
    enabled: true,
    runtimeDir: expect.stringContaining(input.sessionId),
    socket: expect.stringMatching(/\/bus$/),
    sourceAddress: `unix:path=/run/user/${uid}/bus`,
  });
});

test("resolveRuntimeDir: uses HostEnv instead of Deno.env directly", () => {
  const hostWithXdg = makeHostEnv({
    env: new Map([["XDG_RUNTIME_DIR", "/custom/runtime"]]),
  });
  expect(resolveRuntimeDir(hostWithXdg)).toEqual("/custom/runtime/nas/dbus");

  const hostWithoutXdg = makeHostEnv({
    uid: 1234,
    env: new Map(),
  });
  expect(resolveRuntimeDir(hostWithoutXdg)).toEqual("/tmp/nas-1234/dbus");

  const hostWithNullUid = makeHostEnv({
    uid: null,
    env: new Map(),
  });
  expect(resolveRuntimeDir(hostWithNullUid)).toEqual("/tmp/nas-unknown/dbus");
});

test("DbusProxyStage: starts fake proxy and exposes runtime paths", async () => {
  const uid = process.getuid!();
  if (uid === null) return;

  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "nas-dbus-runtime-"));
  const sourceSocketPath = path.join(runtimeRoot, "source.sock");
  const fakeBinDir = path.join(runtimeRoot, "bin");
  const fakeProxyPath = path.join(fakeBinDir, "xdg-dbus-proxy");
  const listener = net.createServer();
  listener.listen(sourceSocketPath);

  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(
    fakeProxyPath,
    `#!/usr/bin/env bash
set -euo pipefail
target="$2"
exec python3 - "$target" <<'PY'
import os
import signal
import socket
import sys
import time

target = sys.argv[1]
os.makedirs(os.path.dirname(target), exist_ok=True)
try:
    os.unlink(target)
except FileNotFoundError:
    pass
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(target)
sock.listen(1)
running = True
def stop(signum, frame):
    global running
    running = False
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while running:
    time.sleep(0.1)
sock.close()
try:
    os.unlink(target)
except FileNotFoundError:
    pass
PY
`,
    {
      mode: 0o755,
    },
  );
  await chmod(fakeProxyPath, 0o755);

  try {
    const hostEnvMap = new Map(
      Object.entries(process.env).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    hostEnvMap.set("XDG_RUNTIME_DIR", runtimeRoot);
    const profile: Profile = {
      ...makeProfile(),
      dbus: {
        session: {
          ...structuredClone(DEFAULT_DBUS_CONFIG.session),
          enable: true,
          sourceAddress: `unix:path=${sourceSocketPath}`,
          talk: ["org.freedesktop.secrets"],
        },
      },
    };
    const input = makeInput(
      profile,
      { uid, env: hostEnvMap },
      {
        xdgDbusProxyPath: fakeProxyPath,
        dbusSessionAddress: `unix:path=${sourceSocketPath}`,
      },
    );

    const liveLayer = DbusProxyServiceLive.pipe(
      Layer.provide(Layer.mergeAll(FsServiceLive, ProcessServiceLive)),
    );
    await runStageScoped(input, liveLayer, async (result) => {
      expect(result.dbus?.enabled).toEqual(true);
      if (!result.dbus?.enabled) {
        throw new Error("expected enabled dbus slice");
      }
      expect(result.dbus.runtimeDir.includes(input.sessionId)).toEqual(true);
      expect(result.dbus.socket.endsWith("/bus")).toEqual(true);
      const st = await stat(result.dbus.socket);
      expect(st.isSocket()).toEqual(true);
    });
  } finally {
    listener.close();
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
  }
});
