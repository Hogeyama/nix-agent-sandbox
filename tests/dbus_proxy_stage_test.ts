import { assertEquals, assertNotEquals } from "@std/assert";
import * as path from "@std/path";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_DISPLAY_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  DEFAULT_UI_CONFIG,
  type Profile,
} from "../src/config/types.ts";
import {
  buildProxyArgs,
  createDbusProxyStage,
  resolveRuntimeDir,
  resolveSourceAddress,
} from "../src/stages/dbus_proxy.ts";
import type {
  DbusProxyEffect,
  HostEnv,
  ProbeResults,
  StageInput,
} from "../src/pipeline/types.ts";
import { executePlan, teardownHandles } from "../src/pipeline/effects.ts";

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
    home: Deno.env.get("HOME") ?? "/root",
    user: Deno.env.get("USER") ?? "",
    uid: Deno.uid(),
    gid: Deno.gid(),
    isWSL: false,
    env: new Map(Object.entries(Deno.env.toObject())),
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
      workDir: Deno.cwd(),
      nixEnabled: false,
      imageName: "nas:default",
      agentCommand: ["claude"],
      networkPromptEnabled: false,
      dbusProxyEnabled: false,
    },
  };
}

Deno.test("resolveSourceAddress: prefers configured address, then probe, then default path", () => {
  assertEquals(
    resolveSourceAddress(
      "unix:path=/tmp/from-config",
      "unix:path=/tmp/from-env",
      1000,
    ),
    "unix:path=/tmp/from-config",
  );
  assertEquals(
    resolveSourceAddress(undefined, "unix:path=/tmp/from-env", 1000),
    "unix:path=/tmp/from-env",
  );
  assertEquals(
    resolveSourceAddress(undefined, null, 1000),
    "unix:path=/run/user/1000/bus",
  );
});

Deno.test("buildProxyArgs: serializes filter flags", () => {
  assertEquals(
    buildProxyArgs(
      "unix:path=/run/user/1000/bus",
      "/tmp/proxy/bus",
      ["org.freedesktop.secrets"],
      ["org.freedesktop.secrets"],
      ["org.example.Owned"],
      [{ name: "org.freedesktop.secrets", rule: "*" }],
      [{ name: "org.freedesktop.secrets", rule: "*" }],
    ),
    [
      "unix:path=/run/user/1000/bus",
      "/tmp/proxy/bus",
      "--filter",
      "--see=org.freedesktop.secrets",
      "--talk=org.freedesktop.secrets",
      "--own=org.example.Owned",
      "--call=org.freedesktop.secrets=*",
      "--broadcast=org.freedesktop.secrets=*",
    ],
  );
});

Deno.test("DbusProxyStage: returns null when disabled", () => {
  const profile = makeProfile();
  const input = makeInput(profile);
  const stage = createDbusProxyStage();
  const plan = stage.plan(input);
  assertEquals(plan, null);
});

Deno.test("DbusProxyStage: returns dbusProxyEnabled=false when uid is null", () => {
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
  assertNotEquals(plan, null);
  assertEquals(plan!.outputOverrides.dbusProxyEnabled, false);
  assertEquals(plan!.effects.length, 0);
});

Deno.test("DbusProxyStage: returns dbusProxyEnabled=false when xdg-dbus-proxy not found", () => {
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
  assertNotEquals(plan, null);
  assertEquals(plan!.outputOverrides.dbusProxyEnabled, false);
  assertEquals(plan!.effects.length, 0);
});

Deno.test("DbusProxyStage: returns dbusProxyEnabled=false for unsupported address", () => {
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
  assertNotEquals(plan, null);
  assertEquals(plan!.outputOverrides.dbusProxyEnabled, false);
  assertEquals(plan!.effects.length, 0);
});

Deno.test("DbusProxyStage: produces correct effects and outputs when enabled", () => {
  const uid = Deno.uid();
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
  assertNotEquals(plan, null);

  // Check outputOverrides
  assertEquals(plan!.outputOverrides.dbusProxyEnabled, true);
  assertEquals(
    plan!.outputOverrides.dbusSessionRuntimeDir?.includes(input.sessionId),
    true,
  );
  assertEquals(plan!.outputOverrides.dbusSessionSocket?.endsWith("/bus"), true);
  assertEquals(
    plan!.outputOverrides.dbusSessionSourceAddress,
    `unix:path=/run/user/${uid}/bus`,
  );

  // Check effects structure: single dbus-proxy high-level effect
  const effectKinds = plan!.effects.map((e) => e.kind);
  assertEquals(effectKinds, ["dbus-proxy"]);

  // Check dbus-proxy effect has correct fields
  const dbusEffect = plan!.effects[0] as DbusProxyEffect;
  assertEquals(dbusEffect.proxyBinaryPath, "/usr/bin/xdg-dbus-proxy");
  assertEquals(dbusEffect.args.includes("--filter"), true);
  assertEquals(
    dbusEffect.args.includes("--talk=org.freedesktop.secrets"),
    true,
  );
});

Deno.test("resolveRuntimeDir: uses HostEnv instead of Deno.env directly", () => {
  const hostWithXdg = makeHostEnv({
    env: new Map([["XDG_RUNTIME_DIR", "/custom/runtime"]]),
  });
  assertEquals(resolveRuntimeDir(hostWithXdg), "/custom/runtime/nas/dbus");

  const hostWithoutXdg = makeHostEnv({
    uid: 1234,
    env: new Map(),
  });
  assertEquals(resolveRuntimeDir(hostWithoutXdg), "/tmp/nas-1234/dbus");

  const hostWithNullUid = makeHostEnv({
    uid: null,
    env: new Map(),
  });
  assertEquals(resolveRuntimeDir(hostWithNullUid), "/tmp/nas-unknown/dbus");
});

Deno.test("DbusProxyStage: starts fake proxy via executePlan and exposes runtime paths", async () => {
  const uid = Deno.uid();
  if (uid === null) return;

  const runtimeRoot = await Deno.makeTempDir({ prefix: "nas-dbus-runtime-" });
  const sourceSocketPath = path.join(runtimeRoot, "source.sock");
  const fakeBinDir = path.join(runtimeRoot, "bin");
  const fakeProxyPath = path.join(fakeBinDir, "xdg-dbus-proxy");
  const listener = Deno.listen({
    transport: "unix",
    path: sourceSocketPath,
  });

  await Deno.mkdir(fakeBinDir, { recursive: true });
  await Deno.writeTextFile(
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
  await Deno.chmod(fakeProxyPath, 0o755);

  try {
    // Pass XDG_RUNTIME_DIR through HostEnv instead of Deno.env
    const hostEnvMap = new Map(Object.entries(Deno.env.toObject()));
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
    assertNotEquals(plan, null);

    const handles = await executePlan(plan!);
    try {
      assertEquals(plan!.outputOverrides.dbusProxyEnabled, true);
      assertEquals(
        plan!.outputOverrides.dbusSessionRuntimeDir?.includes(input.sessionId),
        true,
      );
      assertEquals(
        plan!.outputOverrides.dbusSessionSocket?.endsWith("/bus"),
        true,
      );
      const stat = await Deno.stat(plan!.outputOverrides.dbusSessionSocket!);
      assertEquals(stat.isSocket, true);
    } finally {
      await teardownHandles(handles);
    }
  } finally {
    listener.close();
    await Deno.remove(runtimeRoot, { recursive: true }).catch(() => {});
  }
});
