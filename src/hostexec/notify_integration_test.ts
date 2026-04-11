import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { notifyHostExecPendingRequest } from "./notify.ts";
import { _resetNotifySendCache } from "../lib/notify_utils.ts";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const TEST_PENDING = {
  version: 1 as const,
  sessionId: "sess_test",
  requestId: "req_test",
  approvalKey: "approval-key",
  ruleId: "git-readonly",
  argv0: "git",
  args: ["pull", "--ff-only"],
  cwd: "/tmp/workspace",
  state: "pending" as const,
  createdAt: "2026-03-17T00:00:00.000Z",
  updatedAt: "2026-03-17T00:00:00.000Z",
};

test("notifyHostExecPendingRequest: desktop notification opens UI via xdg-open", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const argsLog = `${dir}/notify-args.log`;
    const xdgLog = `${dir}/xdg-open.log`;
    process.env["NAS_NOTIFY_ARGS_LOG"] = argsLog;
    process.env["NAS_NOTIFY_EXIT"] = "0";
    process.env["NAS_NOTIFY_STDOUT"] = "default";
    process.env["NAS_XDG_LOG"] = xdgLog;

    await notifyHostExecPendingRequest({
      backend: "desktop",
      pending: TEST_PENDING,
      uiPort: healthServer.port,
    });

    const notifyArgs = await readFile(argsLog, "utf8");
    expect(notifyArgs.includes("[nas] Pending hostexec approval")).toEqual(
      true,
    );
    expect(notifyArgs.includes("git pull --ff-only")).toEqual(true);
    expect(notifyArgs.includes("/tmp/workspace")).toEqual(true);

    const xdgArgs = await readFile(xdgLog, "utf8");
    expect(xdgArgs.includes("type=hostexec")).toEqual(true);
    expect(xdgArgs.includes("sessionId=sess_test")).toEqual(true);
    expect(xdgArgs.includes("requestId=req_test")).toEqual(true);
  });
});

test("notifyHostExecPendingRequest: dismiss does not open browser", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const xdgLog = `${dir}/xdg-open.log`;
    process.env["NAS_NOTIFY_EXIT"] = "0";
    process.env["NAS_NOTIFY_STDOUT"] = "";
    process.env["NAS_XDG_LOG"] = xdgLog;

    await notifyHostExecPendingRequest({
      backend: "desktop",
      pending: TEST_PENDING,
      uiPort: healthServer.port,
    });

    const xdgExists = await stat(xdgLog).then(() => true).catch(() => false);
    expect(xdgExists).toEqual(false);
  });
});

test("notifyHostExecPendingRequest: desktop backend sends notification", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const argsLog = `${dir}/notify-args.log`;
    process.env["NAS_NOTIFY_ARGS_LOG"] = argsLog;
    process.env["NAS_NOTIFY_EXIT"] = "0";
    process.env["NAS_NOTIFY_STDOUT"] = "default";
    process.env["NAS_XDG_LOG"] = `${dir}/xdg-open.log`;

    await notifyHostExecPendingRequest({
      backend: "desktop",
      pending: TEST_PENDING,
      uiPort: healthServer.port,
    });

    const notifyArgs = await readFile(argsLog, "utf8");
    expect(notifyArgs.includes("[nas] Pending hostexec approval")).toEqual(
      true,
    );
  });
});

test("notifyHostExecPendingRequest: propagates uiUrl via NAS_NOTIFY_UI_URL env", async () => {
  await withFakeCommands(async ({ dir, healthServer }) => {
    const envLog = `${dir}/notify-env.log`;
    process.env["NAS_NOTIFY_ENV_LOG"] = envLog;
    process.env["NAS_NOTIFY_EXIT"] = "0";
    process.env["NAS_NOTIFY_STDOUT"] = "";
    process.env["NAS_XDG_LOG"] = `${dir}/xdg-open.log`;

    await notifyHostExecPendingRequest({
      backend: "desktop",
      pending: TEST_PENDING,
      uiPort: healthServer.port,
    });

    const captured = (await readFile(envLog, "utf8")).trim();
    expect(captured.startsWith("http://")).toEqual(true);
    expect(captured.includes(`:${healthServer.port}`)).toEqual(true);
    expect(captured.includes("type=hostexec")).toEqual(true);
    expect(captured.includes("sessionId=sess_test")).toEqual(true);
    expect(captured.includes("requestId=req_test")).toEqual(true);
  });
});

test("notifyHostExecPendingRequest: uiEnabled=false shows approve/deny actions", async () => {
  await withFakeCommands(async ({ dir }) => {
    const argsLog = `${dir}/notify-args.log`;
    process.env["NAS_NOTIFY_ARGS_LOG"] = argsLog;
    process.env["NAS_NOTIFY_EXIT"] = "0";
    process.env["NAS_NOTIFY_STDOUT"] = "approve";

    await notifyHostExecPendingRequest({
      backend: "desktop",
      pending: TEST_PENDING,
      uiEnabled: false,
    });

    const notifyArgs = await readFile(argsLog, "utf8");
    expect(notifyArgs.includes("--action=approve=Approve")).toEqual(true);
    expect(notifyArgs.includes("--action=deny=Deny")).toEqual(true);
    expect(notifyArgs.includes("--action=default=Open")).toEqual(false);
  });
});

interface HealthServer {
  port: number;
  shutdown: () => Promise<void>;
}

function startHealthServer(): HealthServer {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (new URL(req.url).pathname === "/api/health") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  const port = server.port!;
  return {
    port,
    shutdown: async () => {
      server.stop();
    },
  };
}

async function withFakeCommands(
  fn: (ctx: { dir: string; healthServer: HealthServer }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-notify-test-"));
  const originalPath = process.env["PATH"] ?? "";
  const originalNotifyArgsLog = process.env["NAS_NOTIFY_ARGS_LOG"];
  const originalNotifyEnvLog = process.env["NAS_NOTIFY_ENV_LOG"];
  const originalNotifyExit = process.env["NAS_NOTIFY_EXIT"];
  const originalNotifyStdout = process.env["NAS_NOTIFY_STDOUT"];
  const originalXdgLog = process.env["NAS_XDG_LOG"];
  const healthServer = startHealthServer();

  try {
    await writeFile(
      `${dir}/notify-send`,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${NAS_NOTIFY_ARGS_LOG:-}" ]]; then
  printf '%s\n' "$@" > "\${NAS_NOTIFY_ARGS_LOG}"
fi
if [[ -n "\${NAS_NOTIFY_ENV_LOG:-}" ]]; then
  printf '%s\n' "\${NAS_NOTIFY_UI_URL:-}" > "\${NAS_NOTIFY_ENV_LOG}"
fi
printf '42\n'
printf '%s' "\${NAS_NOTIFY_STDOUT:-}"
exit "\${NAS_NOTIFY_EXIT:-0}"
`,
    );
    await writeFile(
      `${dir}/xdg-open`,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${NAS_XDG_LOG:-}" ]]; then
  printf '%s\n' "$@" > "\${NAS_XDG_LOG}"
fi
`,
    );
    await chmod(`${dir}/notify-send`, 0o755);
    await chmod(`${dir}/xdg-open`, 0o755);
    process.env["PATH"] = `${dir}:${originalPath}`;
    _resetNotifySendCache();
    await fn({ dir, healthServer });
  } finally {
    process.env["PATH"] = originalPath;
    _resetNotifySendCache();
    restoreEnv("NAS_NOTIFY_ARGS_LOG", originalNotifyArgsLog);
    restoreEnv("NAS_NOTIFY_ENV_LOG", originalNotifyEnvLog);
    restoreEnv("NAS_NOTIFY_EXIT", originalNotifyExit);
    restoreEnv("NAS_NOTIFY_STDOUT", originalNotifyStdout);
    restoreEnv("NAS_XDG_LOG", originalXdgLog);
    await healthServer.shutdown();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
