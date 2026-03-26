import { assertEquals } from "@std/assert";
import { notifyPendingRequest } from "../src/network/notify.ts";
import type { PendingNotification } from "../src/network/notify.ts";

Deno.test("notifyPendingRequest: desktop notification opens UI via xdg-open", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const argsLog = `${dir}/notify-args.log`;
    const xdgLog = `${dir}/xdg-open.log`;
    Deno.env.set("NAS_NOTIFY_ARGS_LOG", argsLog);
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "default");
    Deno.env.set("NAS_XDG_LOG", xdgLog);

    const notification: PendingNotification = {
      backend: "desktop",
      sessionId: "sess_test",
      requestId: "req_test",
      target: { host: "api.openai.com", port: 443 },
      uiPort: healthServer.port,
    };

    await notifyPendingRequest(notification);

    const notifyArgs = await Deno.readTextFile(argsLog);
    assertEquals(notifyArgs.includes("[nas] Pending network approval"), true);
    assertEquals(notifyArgs.includes("api.openai.com:443"), true);
    assertEquals(notifyArgs.includes("--action=default=Open"), true);

    const xdgArgs = await Deno.readTextFile(xdgLog);
    assertEquals(xdgArgs.includes("type=network"), true);
    assertEquals(xdgArgs.includes("sessionId=sess_test"), true);
    assertEquals(xdgArgs.includes("requestId=req_test"), true);
  });
});

Deno.test("notifyPendingRequest: dismiss does not open browser", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const xdgLog = `${dir}/xdg-open.log`;
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "");
    Deno.env.set("NAS_XDG_LOG", xdgLog);

    await notifyPendingRequest({
      backend: "desktop",
      sessionId: "sess_test",
      requestId: "req_test",
      target: { host: "api.openai.com", port: 443 },
      uiPort: healthServer.port,
    });

    const xdgExists = await Deno.stat(xdgLog).then(() => true).catch(() =>
      false
    );
    assertEquals(xdgExists, false, "xdg-open should not have been called");
  });
});

Deno.test("notifyPendingRequest: auto backend uses desktop", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const argsLog = `${dir}/notify-args.log`;
    Deno.env.set("NAS_NOTIFY_ARGS_LOG", argsLog);
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "default");
    Deno.env.set("NAS_XDG_LOG", `${dir}/xdg-open.log`);

    await notifyPendingRequest({
      backend: "auto",
      sessionId: "sess_test",
      requestId: "req_test",
      target: { host: "api.openai.com", port: 443 },
      uiPort: healthServer.port,
    });

    const notifyArgs = await Deno.readTextFile(argsLog);
    assertEquals(notifyArgs.includes("[nas] Pending network approval"), true);
  });
});

Deno.test("notifyPendingRequest: uiEnabled=false shows approve/deny actions", async () => {
  await withFakeCommands(async ({ dir }) => {
    const argsLog = `${dir}/notify-args.log`;
    Deno.env.set("NAS_NOTIFY_ARGS_LOG", argsLog);
    Deno.env.set("NAS_NOTIFY_EXIT", "0");
    Deno.env.set("NAS_NOTIFY_STDOUT", "approve");

    await notifyPendingRequest({
      backend: "desktop",
      sessionId: "sess_test",
      requestId: "req_test",
      target: { host: "api.openai.com", port: 443 },
      uiEnabled: false,
    });

    const notifyArgs = await Deno.readTextFile(argsLog);
    assertEquals(notifyArgs.includes("--action=approve=Approve"), true);
    assertEquals(notifyArgs.includes("--action=deny=Deny"), true);
    assertEquals(notifyArgs.includes("--action=default=Open"), false);
  });
});

interface HealthServer {
  port: number;
  shutdown: () => Promise<void>;
}

function startHealthServer(): HealthServer {
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    if (new URL(req.url).pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  });
  const port = server.addr.port;
  return { port, shutdown: () => server.shutdown() };
}

async function withFakeCommands(
  fn: (ctx: { dir: string; healthServer: HealthServer }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "nas-notify-test-" });
  const originalPath = Deno.env.get("PATH") ?? "";
  const originalNotifyArgsLog = Deno.env.get("NAS_NOTIFY_ARGS_LOG");
  const originalNotifyExit = Deno.env.get("NAS_NOTIFY_EXIT");
  const originalNotifyStdout = Deno.env.get("NAS_NOTIFY_STDOUT");
  const originalXdgLog = Deno.env.get("NAS_XDG_LOG");
  const healthServer = startHealthServer();

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
      `${dir}/xdg-open`,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${NAS_XDG_LOG:-}" ]]; then
  printf '%s\n' "$@" > "\${NAS_XDG_LOG}"
fi
`,
    );
    await Deno.chmod(`${dir}/notify-send`, 0o755);
    await Deno.chmod(`${dir}/xdg-open`, 0o755);
    Deno.env.set("PATH", `${dir}:${originalPath}`);
    await fn({ dir, healthServer });
  } finally {
    Deno.env.set("PATH", originalPath);
    restoreEnv("NAS_NOTIFY_ARGS_LOG", originalNotifyArgsLog);
    restoreEnv("NAS_NOTIFY_EXIT", originalNotifyExit);
    restoreEnv("NAS_NOTIFY_STDOUT", originalNotifyStdout);
    restoreEnv("NAS_XDG_LOG", originalXdgLog);
    await healthServer.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }
  Deno.env.set(name, value);
}
