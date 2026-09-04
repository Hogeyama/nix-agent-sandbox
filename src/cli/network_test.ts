import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { PortBindSessionEntry } from "../network/port_bind_protocol.ts";
import {
  readSessionRegistry,
  resolvePortsRuntimePaths,
  writeSessionRegistry,
} from "../network/port_bind_registry.ts";
import { runNetworkCommand } from "./network.ts";

test("network gc also sweeps the default ports runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nas-network-cli-"));
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = root;
  try {
    const paths = await resolvePortsRuntimePaths();
    await writeSessionRegistry(paths, {
      sessionId: "stale",
      pid: Number.MAX_SAFE_INTEGER,
      brokerSocket: path.join(paths.brokersDir, "stale", "sock"),
      bindings: [],
    });

    await runNetworkCommand(["gc"]);

    expect(
      await readSessionRegistry<PortBindSessionEntry>(paths, "stale"),
    ).toBeNull();
  } finally {
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    await rm(root, { recursive: true, force: true });
  }
});
