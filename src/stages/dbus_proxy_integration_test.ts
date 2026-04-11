import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../config/types.ts";
import { executePlan, teardownHandles } from "../pipeline/effects.ts";
import type {
  DbusProxyEffect,
  HostEnv,
  ProbeResults,
  StageInput,
} from "../pipeline/types.ts";
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
    display: structuredClone(DEFAULT_DISPLAY_CONFIG),
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
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
    prior: {
      dockerArgs: [],
      envVars: {},
      workDir: process.cwd(),
      nixEnabled: false,
      imageName: "nas:default",
      agentCommand: ["claude"],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    },
  };
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

test("DbusProxyStage: returns null when disabled", () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createDbusProxyStage();
  const plan = stage.plan(input);
  expect(plan).toEqual(null);
});

test("DbusProxyStage: returns dbusProxyEnabled=false when uid is null", () => {
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
  const stage = createDbusProxyStage();
  const plan = stage.plan(input);
  expect(plan).not.toEqual(null);
  expect(plan!.outputOverrides.dbusProxyEnabled).toEqual(false);
  expect(plan!.effects.length).toEqual(0);
});

test("DbusProxyStage: returns dbusProxyEnabled=false when xdg-dbus-proxy not found", () => {
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
  const stage = createDbusProxyStage();
  const plan = stage.plan(input);
  expect(plan).not.toEqual(null);
  expect(plan!.outputOverrides.dbusProxyEnabled).toEqual(false);
  expect(plan!.effects.length).toEqual(0);
});

test("DbusProxyStage: returns dbusProxyEnabled=false for unsupported address", () => {
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
  const stage = createDbusProxyStage();
  const plan = stage.plan(input);
  expect(plan).not.toEqual(null);
  expect(plan!.outputOverrides.dbusProxyEnabled).toEqual(false);
  expect(plan!.effects.length).toEqual(0);
});

test("DbusProxyStage: produces correct effects and outputs when enabled", () => {
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
  const input = makeInput(
    profile,
    { uid },
    {
      xdgDbusProxyPath: "/usr/bin/xdg-dbus-proxy",
      dbusSessionAddress: `unix:path=/run/user/${uid}/bus`,
    },
  );
  const stage = createDbusProxyStage();
  const plan = stage.plan(input);
  expect(plan).not.toEqual(null);

  // Check outputOverrides
  expect(plan!.outputOverrides.dbusProxyEnabled).toEqual(true);
  expect(
    plan!.outputOverrides.dbusSessionRuntimeDir?.includes(input.sessionId),
  ).toEqual(true);
  expect(plan!.outputOverrides.dbusSessionSocket?.endsWith("/bus")).toEqual(
    true,
  );
  expect(plan!.outputOverrides.dbusSessionSourceAddress).toEqual(
    `unix:path=/run/user/${uid}/bus`,
  );

  // Check effects structure: single dbus-proxy high-level effect
  const effectKinds = plan!.effects.map((e) => e.kind);
  expect(effectKinds).toEqual(["dbus-proxy"]);

  // Check dbus-proxy effect has correct fields
  const dbusEffect = plan!.effects[0] as DbusProxyEffect;
  expect(dbusEffect.proxyBinaryPath).toEqual("/usr/bin/xdg-dbus-proxy");
  expect(dbusEffect.args.includes("--filter")).toEqual(true);
  expect(dbusEffect.args.includes("--talk=org.freedesktop.secrets")).toEqual(
    true,
  );
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

test("DbusProxyStage: starts fake proxy via executePlan and exposes runtime paths", async () => {
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
    // Pass XDG_RUNTIME_DIR through HostEnv instead of Deno.env
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
    const stage = createDbusProxyStage();
    const plan = stage.plan(input);
    expect(plan).not.toEqual(null);

    const handles = await executePlan(plan!);
    try {
      expect(plan!.outputOverrides.dbusProxyEnabled).toEqual(true);
      expect(
        plan!.outputOverrides.dbusSessionRuntimeDir?.includes(input.sessionId),
      ).toEqual(true);
      expect(plan!.outputOverrides.dbusSessionSocket?.endsWith("/bus")).toEqual(
        true,
      );
      const st = await stat(plan!.outputOverrides.dbusSessionSocket!);
      expect(st.isSocket()).toEqual(true);
    } finally {
      await teardownHandles(handles);
    }
  } finally {
    listener.close();
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
  }
});
