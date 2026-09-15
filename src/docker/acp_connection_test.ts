import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  ACP_PREPARATION_BUFFER_LIMIT,
  AcpConnection,
} from "./acp_connection.ts";

test("ACP preparation buffering fails closed at one MiB", async () => {
  const input = new PassThrough();
  const connection = new AcpConnection(input, new PassThrough());
  try {
    input.write(Buffer.alloc(ACP_PREPARATION_BUFFER_LIMIT + 1));
    expect(connection.controller.signal.aborted).toBe(true);
    expect(() => connection.takeInput()).toThrow("exceeds 1048576 bytes");
  } finally {
    connection.dispose();
  }
});

test("closing a client during a stalled probe prevents the next preparation phase", async () => {
  const input = new PassThrough();
  const connection = new AcpConnection(input, new PassThrough());
  let nextPhase = false;
  let finishProbe: () => void = () => {};
  try {
    const preparing = (async () => {
      await connection.prepare(
        () =>
          new Promise<void>((resolve) => {
            finishProbe = resolve;
          }),
      );
      nextPhase = true;
    })();
    input.end();
    await expect(preparing).rejects.toThrow("closed stdin during preparation");
    finishProbe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextPhase).toBe(false);
    expect(() => connection.takeInput()).toThrow("closed stdin");
  } finally {
    finishProbe();
    connection.dispose();
  }
});
