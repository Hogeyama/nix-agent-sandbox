import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeSessionRegistry } from "../lib/runtime_registry.ts";
import type { PortBindSessionEntry } from "./port_bind_protocol.ts";
import {
  findSessionsByHostPort,
  listPortBindSessions,
  portsRuntimeDir,
  relayScriptPath,
  relaySocketPath,
  resolvePortsRuntimePaths,
} from "./port_bind_registry.ts";

async function withPaths<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "nas-ports-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function entry(
  sessionId: string,
  bindings: PortBindSessionEntry["bindings"],
): PortBindSessionEntry {
  return {
    sessionId,
    pid: process.pid,
    brokerSocket: `/nonexistent/${sessionId}/sock`,
    bindings,
  };
}

test("portsRuntimeDir prefers XDG_RUNTIME_DIR and falls back to the uid", () => {
  expect(portsRuntimeDir("/run/user/1000", 1000)).toEqual(
    "/run/user/1000/nas/ports",
  );
  expect(portsRuntimeDir(undefined, 1000)).toEqual("/tmp/nas-1000/ports");
  expect(portsRuntimeDir("   ", 1000)).toEqual("/tmp/nas-1000/ports");
});

test("resolvePortsRuntimePaths derives every subdirectory from the root", async () => {
  await withPaths(async (root) => {
    const paths = await resolvePortsRuntimePaths(root);
    expect(paths.runtimeDir).toEqual(root);
    expect(paths.sessionsDir).toEqual(path.join(root, "sessions"));
    expect(paths.brokersDir).toEqual(path.join(root, "brokers"));
    expect(relaySocketPath(paths, "s1")).toEqual(
      path.join(root, "brokers", "s1", "relay.sock"),
    );
    expect(relayScriptPath(paths, "s1")).toEqual(
      path.join(root, "relay", "s1", "port-relay.mjs"),
    );
  });
});

test("listPortBindSessions returns written entries with their bindings", async () => {
  await withPaths(async (root) => {
    const paths = await resolvePortsRuntimePaths(root);
    await writeSessionRegistry(
      paths,
      entry("s1", [{ containerPort: 3000, hostPort: 3000, createdAt: "t" }]),
    );
    const listed = await listPortBindSessions(paths);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.bindings[0]?.hostPort).toEqual(3000);
  });
});

test("findSessionsByHostPort matches on host port and returns every claimant", async () => {
  await withPaths(async (root) => {
    const paths = await resolvePortsRuntimePaths(root);
    await writeSessionRegistry(
      paths,
      entry("s1", [{ containerPort: 3000, hostPort: 8080, createdAt: "t" }]),
    );
    await writeSessionRegistry(
      paths,
      entry("s2", [{ containerPort: 5173, hostPort: 8080, createdAt: "t" }]),
    );
    await writeSessionRegistry(
      paths,
      entry("s3", [{ containerPort: 5173, hostPort: 9090, createdAt: "t" }]),
    );
    const matches = await findSessionsByHostPort(paths, 8080);
    expect(matches.map((m) => m.sessionId).sort()).toEqual(["s1", "s2"]);
  });
});
