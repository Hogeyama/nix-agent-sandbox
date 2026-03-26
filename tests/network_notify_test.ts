import { assertEquals, assertRejects } from "@std/assert";
import { notifyPendingRequest } from "../src/network/notify.ts";
import type { PendingNotification } from "../src/network/notify.ts";

const TEST_NOTIFICATION: PendingNotification = {
  backend: "desktop",
  brokerSocket: "",
  sessionId: "sess_test",
  requestId: "req_test",
  target: { host: "api.openai.com", port: 443 },
};

Deno.test("notifyPendingRequest: desktop approval notifies broker", async () => {
  await withFakeCommands(async ({ dir }) => {
    const argsLog = `${dir}/notify-args.log`;
    Deno.env.set("NAS_NOTIFY_ARGS_LOG", argsLog);
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "default");

    const { socketPath, messages, close } = await startBrokerStub((
      requestId,
    ) => ({ type: "ack", requestId, decision: "approve" }));
    try {
      await notifyPendingRequest({
        ...TEST_NOTIFICATION,
        brokerSocket: socketPath,
      });
    } finally {
      await close();
    }

    assertEquals(messages, [{ type: "approve", requestId: "req_test" }]);
    const notifyArgs = await Deno.readTextFile(argsLog);
    assertEquals(notifyArgs.includes("[nas] Pending network approval"), true);
    assertEquals(notifyArgs.includes("api.openai.com:443"), true);
  });
});

Deno.test("notifyPendingRequest: desktop deny rejects broker request on invalid ack", async () => {
  await withFakeCommands(async () => {
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "");

    const { socketPath, close } = await startBrokerStub(() => ({
      type: "ack",
      requestId: "wrong",
      decision: "deny",
    }));
    try {
      await assertRejects(
        () =>
          notifyPendingRequest({
            ...TEST_NOTIFICATION,
            brokerSocket: socketPath,
          }),
        Error,
        "invalid broker response",
      );
    } finally {
      await close();
    }
  });
});

Deno.test("notifyPendingRequest: auto backend uses desktop", async () => {
  await withFakeCommands(async ({ dir }) => {
    const argsLog = `${dir}/notify-args.log`;
    Deno.env.set("NAS_NOTIFY_ARGS_LOG", argsLog);
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "default");

    const { socketPath, messages, close } = await startBrokerStub((
      requestId,
    ) => ({ type: "ack", requestId, decision: "approve" }));
    try {
      await notifyPendingRequest({
        ...TEST_NOTIFICATION,
        backend: "auto",
        brokerSocket: socketPath,
      });
    } finally {
      await close();
    }

    assertEquals(messages, [{ type: "approve", requestId: "req_test" }]);
    const notifyArgs = await Deno.readTextFile(argsLog);
    assertEquals(notifyArgs.includes("[nas] Pending network approval"), true);
  });
});

async function withFakeCommands(
  fn: (paths: { dir: string }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "nas-notify-test-" });
  const originalPath = Deno.env.get("PATH") ?? "";
  const originalNotifyArgsLog = Deno.env.get("NAS_NOTIFY_ARGS_LOG");
  const originalNotifyExit = Deno.env.get("NAS_NOTIFY_EXIT");
  const originalNotifyStdout = Deno.env.get("NAS_NOTIFY_STDOUT");

  try {
    await Deno.writeTextFile(
      `${dir}/notify-send`,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${NAS_NOTIFY_ARGS_LOG:-}" ]]; then
  printf '%s\n' "$@" > "\${NAS_NOTIFY_ARGS_LOG}"
fi
printf '42\n'
printf '%s' "\${NAS_NOTIFY_STDOUT:-}"
exit "\${NAS_NOTIFY_EXIT:-0}"
`,
    );
    await Deno.chmod(`${dir}/notify-send`, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    await fn({ dir });
  } finally {
    Deno.env.set("PATH", originalPath);
    restoreEnv("NAS_NOTIFY_ARGS_LOG", originalNotifyArgsLog);
    restoreEnv("NAS_NOTIFY_EXIT", originalNotifyExit);
    restoreEnv("NAS_NOTIFY_STDOUT", originalNotifyStdout);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function startBrokerStub(
  ackFor: (requestId: string) => {
    type: "ack";
    requestId: string;
    decision: "approve" | "deny";
  },
): Promise<{
  socketPath: string;
  messages: Array<{ type: string; requestId: string }>;
  close: () => Promise<void>;
}> {
  const dir = await Deno.makeTempDir({ prefix: "nas-notify-broker-" });
  const socketPath = `${dir}/broker.sock`;
  const listener = Deno.listen({ transport: "unix", path: socketPath });
  const messages: Array<{ type: string; requestId: string }> = [];
  const acceptLoop = (async () => {
    const conn = await listener.accept();
    try {
      const line = await readLine(conn);
      if (!line) return;
      const message = JSON.parse(line) as { type: string; requestId: string };
      messages.push(message);
      const ack = ackFor(message.requestId);
      await conn.write(new TextEncoder().encode(JSON.stringify(ack) + "\n"));
    } finally {
      conn.close();
    }
  })();

  return {
    socketPath,
    messages,
    async close() {
      listener.close();
      await acceptLoop.catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

async function readLine(conn: Deno.Conn): Promise<string | null> {
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(1);
  while (true) {
    const bytesRead = await conn.read(buffer);
    if (bytesRead === null) {
      if (chunks.length === 0) return null;
      break;
    }
    if (buffer[0] === 0x0a) break;
    chunks.push(buffer.slice(0, bytesRead));
  }
  return decoder.decode(concatChunks(chunks));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }
  Deno.env.set(name, value);
}
