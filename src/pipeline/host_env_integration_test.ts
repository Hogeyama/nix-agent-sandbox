import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { buildHostEnv, resolveProbes } from "./host_env.ts";
import type { HostEnv } from "./types.ts";
import { stat } from "node:fs/promises";

// ---------------------------------------------------------------------------
// buildHostEnv
// ---------------------------------------------------------------------------

test("buildHostEnv: returns HostEnv with expected fields", () => {
  const env = buildHostEnv();

  expect(env.home).toBeDefined();
  expect(typeof env.home).toEqual("string");
  expect(typeof env.user).toEqual("string");
  // uid/gid may be null on non-Unix platforms
  if (env.uid !== null) {
    expect(typeof env.uid).toEqual("number");
  }
  if (env.gid !== null) {
    expect(typeof env.gid).toEqual("number");
  }
  expect(typeof env.isWSL).toEqual("boolean");
  expect(env.env instanceof Map).toEqual(true);
});

test("buildHostEnv: env map contains HOME", () => {
  const env = buildHostEnv();
  // HOME should be present on any Unix-like system where tests run
  const homeFromMap = env.env.get("HOME");
  expect(homeFromMap).toBeDefined();
  expect(env.home).toEqual(homeFromMap!);
});

test("buildHostEnv: isWSL reflects WSL_DISTRO_NAME", () => {
  const env = buildHostEnv();
  const hasWslEnv = Boolean(process.env["WSL_DISTRO_NAME"]);
  expect(env.isWSL).toEqual(hasWslEnv);
});

// ---------------------------------------------------------------------------
// resolveProbes
// ---------------------------------------------------------------------------

test("resolveProbes: returns ProbeResults with expected fields", async () => {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);

  expect(typeof probes.hasHostNix).toEqual("boolean");
  expect(typeof probes.auditDir).toEqual("string");
  // xdgDbusProxyPath may or may not exist depending on system
  expect(
    probes.xdgDbusProxyPath === null ||
      typeof probes.xdgDbusProxyPath === "string",
  ).toEqual(true);
  // dbusSessionAddress may or may not exist
  expect(
    probes.dbusSessionAddress === null ||
      typeof probes.dbusSessionAddress === "string",
  ).toEqual(true);
  // gpgAgentSocket may or may not exist
  expect(
    probes.gpgAgentSocket === null ||
      typeof probes.gpgAgentSocket === "string",
  ).toEqual(true);
});

test("resolveProbes: auditDir uses XDG_DATA_HOME when set", async () => {
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
  expect(probes.auditDir).toEqual("/custom/data/nas/audit");
});

test("resolveProbes: auditDir falls back to HOME/.local/share when XDG_DATA_HOME is unset", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/testuser"]]),
  };
  const probes = await resolveProbes(hostEnv);
  expect(probes.auditDir).toEqual("/home/testuser/.local/share/nas/audit");
});

test("resolveProbes: dbusSessionAddress reads DBUS_SESSION_BUS_ADDRESS", async () => {
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
  expect(probes.dbusSessionAddress).toEqual("unix:path=/run/user/1000/bus");
});

test("resolveProbes: dbusSessionAddress is null when env not set", async () => {
  const hostEnv: HostEnv = {
    home: "/home/testuser",
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/testuser"]]),
  };
  const probes = await resolveProbes(hostEnv);
  expect(probes.dbusSessionAddress).toEqual(null);
});

test("resolveProbes: hasHostNix reflects /nix existence", async () => {
  const hostEnv = buildHostEnv();
  const probes = await resolveProbes(hostEnv);

  // Verify consistency: check /nix directly
  let nixExists = false;
  try {
    await stat("/nix");
    nixExists = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      nixExists = false;
    } else {
      throw e;
    }
  }
  expect(probes.hasHostNix).toEqual(nixExists);
});

// ---------------------------------------------------------------------------
// resolveAuditDirFromEnv error handling (C1)
// ---------------------------------------------------------------------------

test("resolveProbes: auditDir throws when neither XDG_DATA_HOME nor HOME is set", async () => {
  const hostEnv: HostEnv = {
    home: "/root",
    user: "",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map(), // neither XDG_DATA_HOME nor HOME
  };
  await expect(resolveProbes(hostEnv)).rejects.toThrow(
    "Cannot resolve audit directory: neither XDG_DATA_HOME nor HOME is set",
  );
});

test("resolveProbes: auditDir uses HOME from env map, not hostEnv.home", async () => {
  const hostEnv: HostEnv = {
    home: "/root", // buildHostEnv fallback
    user: "testuser",
    uid: 1000,
    gid: 1000,
    isWSL: false,
    env: new Map([["HOME", "/home/realuser"]]),
  };
  const probes = await resolveProbes(hostEnv);
  expect(probes.auditDir).toEqual("/home/realuser/.local/share/nas/audit");
});

// ---------------------------------------------------------------------------
// dbusSessionAddress edge cases (W2)
// ---------------------------------------------------------------------------

test("resolveProbes: dbusSessionAddress is null when env value is whitespace-only", async () => {
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
  expect(probes.dbusSessionAddress).toEqual(null);
});

test("resolveProbes: dbusSessionAddress is null when env value is empty string", async () => {
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
  expect(probes.dbusSessionAddress).toEqual(null);
});
