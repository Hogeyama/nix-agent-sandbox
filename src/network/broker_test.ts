import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectUnix, readJsonLine } from "../lib/unix_socket.ts";
import { documentWithScopes } from "./authz/testing.ts";
import {
  BROKER_REQUEST_MAX_BYTES,
  parseBrokerMessage,
  SessionBroker,
  sendBrokerRequest,
} from "./broker.ts";
import { resolveNetworkRuntimePaths } from "./registry.ts";

test("parseBrokerMessage: accepts known message envelopes", () => {
  expect(parseBrokerMessage({ type: "list_pending" })).toEqual({
    type: "list_pending",
  });
  expect(
    parseBrokerMessage({ type: "approve", requestId: "r1", scope: "host" }),
  ).toEqual({ type: "approve", requestId: "r1", scope: "host" });
  expect(parseBrokerMessage({ type: "deny", requestId: "r1" })).toEqual({
    type: "deny",
    requestId: "r1",
  });
  // The payload of authorize-like messages is checked by their own
  // validators after dispatch; the envelope only needs a known type.
  expect(parseBrokerMessage({ type: "authorize" })).not.toBeNull();
});

test("parseBrokerMessage: rejects malformed or unknown messages", () => {
  for (const value of [
    null,
    42,
    "list_pending",
    [],
    {},
    { type: 1 },
    { type: "shutdown" },
    { type: "approve" },
    { type: "approve", requestId: 1 },
    { type: "approve", requestId: "r1", scope: 1 },
    { type: "deny", requestId: "r1", scope: null },
  ]) {
    expect(parseBrokerMessage(value)).toBeNull();
  }
});

async function withBroker(
  fn: (socketPath: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-broker-limit-"));
  const paths = await resolveNetworkRuntimePaths(runtimeDir);
  const broker = new SessionBroker({
    paths,
    sessionId: "sess_limit",
    document: documentWithScopes({}),
    pendingTimeoutSeconds: 30,
    pendingNotify: "off",
  });
  const socketPath = `${paths.brokersDir}/sess_limit/sock`;
  await broker.start(socketPath);
  try {
    await fn(socketPath);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Writes raw bytes and returns the reply line, or null if closed silently. */
async function sendRaw(
  socketPath: string,
  payload: string | Buffer,
): Promise<string | null> {
  const socket = await connectUnix(socketPath);
  socket.on("error", () => {});
  try {
    const reply = readJsonLine(socket, 1024 * 1024).catch(() => null);
    socket.write(payload);
    return await reply;
  } finally {
    socket.destroy();
  }
}

test("SessionBroker: a line over the byte limit is dropped and the broker keeps serving", async () => {
  await withBroker(async (socketPath) => {
    const oversized = Buffer.alloc(BROKER_REQUEST_MAX_BYTES + 1, 0x61);
    expect(await sendRaw(socketPath, oversized)).toBeNull();

    const response = await sendBrokerRequest(socketPath, {
      type: "list_pending",
    });
    expect(response).toEqual({ type: "pending", items: [] });
  });
});

test("SessionBroker: an unknown message type is dropped instead of listing pending", async () => {
  await withBroker(async (socketPath) => {
    expect(
      await sendRaw(socketPath, `${JSON.stringify({ type: "shutdown" })}\n`),
    ).toBeNull();
    expect(await sendRaw(socketPath, "[]\n")).toBeNull();
  });
});
