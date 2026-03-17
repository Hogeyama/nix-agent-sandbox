import { assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  type Config,
  DEFAULT_DBUS_CONFIG,
  DEFAULT_NETWORK_CONFIG,
  type Profile,
} from "../src/config/types.ts";
import { createContext } from "../src/pipeline/context.ts";
import {
  buildProxyArgs,
  DbusProxyStage,
  resolveSourceAddress,
} from "../src/stages/dbus_proxy.ts";

function makeProfile(): Profile {
  return {
    agent: "claude",
    agentArgs: [],
    nix: { enable: false, mountSocket: false, extraPackages: [] },
    docker: { enable: false, shared: false },
    gcloud: { mountConfig: false },
    aws: { mountConfig: false },
    gpg: { forwardAgent: false },
    network: structuredClone(DEFAULT_NETWORK_CONFIG),
    dbus: structuredClone(DEFAULT_DBUS_CONFIG),
    extraMounts: [],
    env: [],
  };
}

function makeCtx(profile: Profile) {
  const config: Config = { profiles: { default: profile } };
  return createContext(config, profile, "default", Deno.cwd());
}

Deno.test("resolveSourceAddress: prefers configured address, then env, then default path", () => {
  const original = Deno.env.get("DBUS_SESSION_BUS_ADDRESS");
  try {
    Deno.env.set("DBUS_SESSION_BUS_ADDRESS", "unix:path=/tmp/from-env");
    assertEquals(
      resolveSourceAddress("unix:path=/tmp/from-config", 1000),
      "unix:path=/tmp/from-config",
    );
    assertEquals(
      resolveSourceAddress(undefined, 1000),
      "unix:path=/tmp/from-env",
    );
    Deno.env.delete("DBUS_SESSION_BUS_ADDRESS");
    assertEquals(
      resolveSourceAddress(undefined, 1000),
      "unix:path=/run/user/1000/bus",
    );
  } finally {
    if (original) {
      Deno.env.set("DBUS_SESSION_BUS_ADDRESS", original);
    } else {
      Deno.env.delete("DBUS_SESSION_BUS_ADDRESS");
    }
  }
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

Deno.test("DbusProxyStage: skips when disabled", async () => {
  const profile = makeProfile();
  const ctx = makeCtx(profile);
  const result = await new DbusProxyStage().execute(ctx);
  assertEquals(result, ctx);
});

Deno.test("DbusProxyStage: fails when xdg-dbus-proxy is unavailable", async () => {
  const uid = Deno.uid();
  if (uid === null) return;

  const profile: Profile = {
    ...makeProfile(),
    dbus: {
      session: {
        ...structuredClone(DEFAULT_DBUS_CONFIG.session),
        enable: true,
        sourceAddress: `unix:path=/run/user/${uid}/bus`,
      },
    },
  };
  const ctx = makeCtx(profile);
  const originalPath = Deno.env.get("PATH");
  const emptyBin = await Deno.makeTempDir({ prefix: "nas-empty-path-" });
  try {
    Deno.env.set("PATH", emptyBin);
    await assertRejects(
      () => new DbusProxyStage().execute(ctx),
      Error,
      "xdg-dbus-proxy",
    );
  } finally {
    if (originalPath) {
      Deno.env.set("PATH", originalPath);
    } else {
      Deno.env.delete("PATH");
    }
    await Deno.remove(emptyBin, { recursive: true }).catch(() => {});
  }
});

Deno.test("DbusProxyStage: starts fake proxy and exposes runtime paths", async () => {
  const uid = Deno.uid();
  if (uid === null) return;

  const runtimeRoot = await Deno.makeTempDir({ prefix: "nas-dbus-runtime-" });
  const sourceSocketPath = path.join(runtimeRoot, "source.sock");
  const fakeBinDir = path.join(runtimeRoot, "bin");
  const fakeProxyPath = path.join(fakeBinDir, "xdg-dbus-proxy");
  const originalPath = Deno.env.get("PATH");
  const originalRuntimeDir = Deno.env.get("XDG_RUNTIME_DIR");
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
    Deno.env.set("PATH", `${fakeBinDir}:${originalPath ?? ""}`);
    Deno.env.set("XDG_RUNTIME_DIR", runtimeRoot);
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
    const ctx = makeCtx(profile);
    const stage = new DbusProxyStage();
    const result = await stage.execute(ctx);
    try {
      assertEquals(result.dbusProxyEnabled, true);
      assertEquals(result.dbusSessionRuntimeDir?.includes(ctx.sessionId), true);
      assertEquals(result.dbusSessionSocket?.endsWith("/bus"), true);
      const stat = await Deno.stat(result.dbusSessionSocket!);
      assertEquals(stat.isSocket, true);
    } finally {
      await stage.teardown(result);
    }
  } finally {
    listener.close();
    if (originalPath) {
      Deno.env.set("PATH", originalPath);
    } else {
      Deno.env.delete("PATH");
    }
    if (originalRuntimeDir) {
      Deno.env.set("XDG_RUNTIME_DIR", originalRuntimeDir);
    } else {
      Deno.env.delete("XDG_RUNTIME_DIR");
    }
    await Deno.remove(runtimeRoot, { recursive: true }).catch(() => {});
  }
});
