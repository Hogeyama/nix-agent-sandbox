import { assertEquals, assertRejects } from "@std/assert";
import { notifyHostExecPendingRequest } from "../src/hostexec/notify.ts";
import type { HostExecPendingNotification } from "../src/hostexec/notify.ts";

const TEST_NOTIFICATION: HostExecPendingNotification = {
  backend: "desktop",
  brokerSocket: "",
  pending: {
    version: 1,
    sessionId: "sess_test",
    requestId: "req_test",
    approvalKey: "approval-key",
    ruleId: "git-readonly",
    argv0: "git",
    args: ["pull", "--ff-only"],
    cwd: "/tmp/workspace",
    state: "pending",
    createdAt: "2026-03-17T00:00:00.000Z",
    updatedAt: "2026-03-17T00:00:00.000Z",
  },
};

Deno.test("notifyHostExecPendingRequest: desktop approval notifies broker", async () => {
  await withFakeCommands(async ({ dir }) => {
    const argsLog = `${dir}/notify-args.log`;
    Deno.env.set("NAS_NOTIFY_ARGS_LOG", argsLog);
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "default");

    const { socketPath, messages, close } = await startBrokerStub((
      requestId,
    ) => ({ type: "ack", requestId, decision: "approve" }));
    try {
      await notifyHostExecPendingRequest({
        ...TEST_NOTIFICATION,
        brokerSocket: socketPath,
      });
    } finally {
      await close();
    }

    assertEquals(messages, [{ type: "approve", requestId: "req_test" }]);
    const notifyArgs = await Deno.readTextFile(argsLog);
    assertEquals(notifyArgs.includes("[nas] Pending hostexec approval"), true);
    assertEquals(notifyArgs.includes("git pull --ff-only"), true);
    assertEquals(notifyArgs.includes("/tmp/workspace"), true);
  });
});

Deno.test("notifyHostExecPendingRequest: desktop deny rejects broker request on invalid ack", async () => {
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
          notifyHostExecPendingRequest({
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

Deno.test("notifyHostExecPendingRequest: auto falls back to tmux when desktop is unavailable", async () => {
  await withFakeCommands(async ({ dir }) => {
    const tmuxLog = `${dir}/tmux.log`;
    Deno.env.set("NAS_NOTIFY_EXIT", "1");
    Deno.env.set("NAS_TMUX_LOG", tmuxLog);
    Deno.env.set("NAS_TMUX_EXIT", "0");
    Deno.env.set("TMUX", "/tmp/tmux-session");

    await notifyHostExecPendingRequest({
      ...TEST_NOTIFICATION,
      backend: "auto",
      brokerSocket: `${dir}/unused.sock`,
    });

    const tmuxArgs = await Deno.readTextFile(tmuxLog);
    assertEquals(tmuxArgs.includes("display-popup"), true);
    assertEquals(tmuxArgs.includes("req_test"), true);
    assertEquals(tmuxArgs.includes("sess_test"), true);
  });
});

async function withFakeCommands(
  fn: (paths: { dir: string }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "nas-hostexec-notify-test-" });
  const originalPath = Deno.env.get("PATH") ?? "";
  const originalTmux = Deno.env.get("TMUX");
  const originalNotifyArgsLog = Deno.env.get("NAS_NOTIFY_ARGS_LOG");
  const originalNotifyExit = Deno.env.get("NAS_NOTIFY_EXIT");
  const originalNotifyStdout = Deno.env.get("NAS_NOTIFY_STDOUT");
  const originalTmuxLog = Deno.env.get("NAS_TMUX_LOG");
  const originalTmuxExit = Deno.env.get("NAS_TMUX_EXIT");

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
    await Deno.writeTextFile(
      `${dir}/tmux`,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "\${NAS_TMUX_LOG}"
exit "\${NAS_TMUX_EXIT:-0}"
`,
    );
    await Deno.chmod(`${dir}/notify-send`, 0o755);
    await Deno.chmod(`${dir}/tmux`, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    await fn({ dir });
  } finally {
    Deno.env.set("PATH", originalPath);
    restoreEnv("TMUX", originalTmux);
    restoreEnv("NAS_NOTIFY_ARGS_LOG", originalNotifyArgsLog);
    restoreEnv("NAS_NOTIFY_EXIT", originalNotifyExit);
    restoreEnv("NAS_NOTIFY_STDOUT", originalNotifyStdout);
    restoreEnv("NAS_TMUX_LOG", originalTmuxLog);
    restoreEnv("NAS_TMUX_EXIT", originalTmuxExit);
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
  const dir = await Deno.makeTempDir({ prefix: "nas-hostexec-notify-broker-" });
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
