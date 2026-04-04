import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { buildHostEnv, resolveProbes } from "../src/pipeline/host_env.ts";
import type { HostEnv } from "../src/pipeline/types.ts";

// ---------------------------------------------------------------------------
// buildHostEnv
// ---------------------------------------------------------------------------

Deno.test("buildHostEnv: returns HostEnv with expected fields", () => {
  const env = buildHostEnv();

  assertExists(env.home);
  assertEquals(typeof env.home, "string");
  assertEquals(typeof env.user, "string");
  // uid/gid may be null on non-Unix platforms
  if (env.uid !== null) {
    assertEquals(typeof env.uid, "number");
  }
  if (env.gid !== null) {
    assertEquals(typeof env.gid, "number");
  }
  assertEquals(typeof env.isWSL, "boolean");
  assertEquals(env.env instanceof Map, true);
});

Deno.test("buildHostEnv: env map contains HOME", () => {
  const env = buildHostEnv();
  // HOME should be present on any Unix-like system where tests run
  const homeFromMap = env.env.get("HOME");
  assertExists(homeFromMap);
  assertEquals(env.home, homeFromMap);
});

Deno.test("buildHostEnv: isWSL reflects WSL_DISTRO_NAME", () => {
  const env = buildHostEnv();
  const hasWslEnv = Boolean(Deno.env.get("WSL_DISTRO_NAME"));
  assertEquals(env.isWSL, hasWslEnv);
});

// ---------------------------------------------------------------------------
// resolveProbes
// ---------------------------------------------------------------------------

Deno.test("resolveProbes: returns ProbeResults with expected fields", async () => {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);

  assertEquals(typeof probes.hasHostNix, "boolean");
  assertEquals(typeof probes.auditDir, "string");
  // xdgDbusProxyPath may or may not exist depending on system
  assertEquals(
    probes.xdgDbusProxyPath === null ||
      typeof probes.xdgDbusProxyPath === "string",
    true,
  );
  // dbusSessionAddress may or may not exist
  assertEquals(
    probes.dbusSessionAddress === null ||
      typeof probes.dbusSessionAddress === "string",
    true,
  );
  // gpgAgentSocket may or may not exist
  assertEquals(
    probes.gpgAgentSocket === null ||
      typeof probes.gpgAgentSocket === "string",
    true,
  );
});

Deno.test("resolveProbes: auditDir uses XDG_DATA_HOME when set", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/testuser"],
      ["XDG_DATA_HOME", "/custom/data"],
    ]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.auditDir, "/custom/data/nas/audit");
});

Deno.test("resolveProbes: auditDir falls back to HOME/.local/share when XDG_DATA_HOME is unset", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/testuser"]]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.auditDir, "/home/testuser/.local/share/nas/audit");
});

Deno.test("resolveProbes: dbusSessionAddress reads DBUS_SESSION_BUS_ADDRESS", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/testuser"],
      ["DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"],
    ]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.dbusSessionAddress, "unix:path=/run/user/1000/bus");
});

Deno.test("resolveProbes: dbusSessionAddress is null when env not set", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/testuser"]]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.dbusSessionAddress, null);
});

Deno.test("resolveProbes: hasHostNix reflects /nix existence", async () => {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);

  // Verify consistency: check /nix directly
  let nixExists = false;
  try {
    await Deno.stat("/nix");
    nixExists = true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      nixExists = false;
    } else {
      throw e;
    }
  }
  assertEquals(probes.hasHostNix, nixExists);
});

// ---------------------------------------------------------------------------
// resolveAuditDirFromEnv error handling (C1)
// ---------------------------------------------------------------------------

Deno.test("resolveProbes: auditDir throws when neither XDG_DATA_HOME nor HOME is set", async () => {
  const hostEnv: HostEnv = {
    home: "/root",
    user: "",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(), // neither XDG_DATA_HOME nor HOME
  };
  await assertRejects(
    () => resolveProbes(hostEnv),
    Error,
    "Cannot resolve audit directory: neither XDG_DATA_HOME nor HOME is set",
  );
});

Deno.test("resolveProbes: auditDir uses HOME from env map, not hostEnv.home", async () => {
  const hostEnv: HostEnv = {
    home: "/root", // buildHostEnv fallback
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/realuser"]]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.auditDir, "/home/realuser/.local/share/nas/audit");
});

// ---------------------------------------------------------------------------
// dbusSessionAddress edge cases (W2)
// ---------------------------------------------------------------------------

Deno.test("resolveProbes: dbusSessionAddress is null when env value is whitespace-only", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/testuser"],
      ["DBUS_SESSION_BUS_ADDRESS", "   "],
    ]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.dbusSessionAddress, null);
});

Deno.test("resolveProbes: dbusSessionAddress is null when env value is empty string", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([
      ["HOME", "/home/testuser"],
      ["DBUS_SESSION_BUS_ADDRESS", ""],
    ]),
  };
  const probes = await resolveProbes(hostEnv);
  assertEquals(probes.dbusSessionAddress, null);
});
