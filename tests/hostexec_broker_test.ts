import { assertEquals, assertMatch } from "@std/assert";
import type { HostExecConfig } from "../src/config/types.ts";
import {
  HostExecBroker,
  sendHostExecBrokerRequest,
} from "../src/hostexec/broker.ts";
import {
  hostExecBrokerSocketPath,
  listHostExecPendingEntries,
  resolveHostExecRuntimePaths,
} from "../src/hostexec/registry.ts";
import type {
  ExecuteRequest,
  HostExecBrokerResponse,
  PendingListResponse,
} from "../src/hostexec/types.ts";

type HostExecConfigOverrides = Omit<Partial<HostExecConfig>, "prompt"> & {
  prompt?: Partial<HostExecConfig["prompt"]>;
};

function makeConfig(overrides: HostExecConfigOverrides = {}): HostExecConfig {
  return {
    prompt: {
      enable: true,
      timeoutSeconds: 30,
      defaultScope: "capability",
      notify: "off",
      ...(overrides.prompt ?? {}),
    },
    secrets: overrides.secrets ?? {},
    rules: overrides.rules ?? [],
  };
}

function request(
  args: string[],
  cwd: string,
  requestId = `req_${crypto.randomUUID()}`,
  argv0 = "deno",
): ExecuteRequest {
  return {
    version: 1,
    type: "execute",
    sessionId: "sess_test",
    requestId,
    argv0,
    args,
    cwd,
    tty: false,
  };
}

Deno.test("HostExecBroker: falls back when no rule matches", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: Deno.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('x')"], Deno.cwd()),
    );
    assertEquals(response.type, "fallback");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: prompts and resumes after approve", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const oldToken = Deno.env.get("HOSTEXEC_TEST_TOKEN");
  Deno.env.set("HOSTEXEC_TEST_TOKEN", "super-secret-value");
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      secrets: {
        test_token: { from: "env:HOSTEXEC_TEST_TOKEN", required: true },
      },
      rules: [{
        id: "deno-eval",
        match: { argv0: "deno", argRegex: "^eval\\b" },
        cwd: { mode: "workspace-only", allow: [] },
        env: { TOKEN: "secret:test_token" },
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "container",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const execPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(
        ["eval", "console.log(Deno.env.get('TOKEN'))"],
        workspace,
        "req_approve",
      ),
    );
    const earlyResponse = await Promise.race([
      execPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (earlyResponse !== null) {
      throw new Error(
        `request resolved too early: ${JSON.stringify(earlyResponse)}`,
      );
    }
    const pending = await waitForPendingEntries(paths, 1);
    assertEquals(pending.length, 1);
    assertEquals(pending[0].ruleId, "deno-eval");
    await sendHostExecBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_approve",
    });
    const response = await execPromise;
    assertEquals(response.type, "result");
    if (response.type !== "result") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    assertEquals(response.stdout.trim(), "[REDACTED]");
  } finally {
    if (oldToken !== undefined) Deno.env.set("HOSTEXEC_TEST_TOKEN", oldToken);
    else Deno.env.delete("HOSTEXEC_TEST_TOKEN");
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: desktop notify can deny pending request", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const notifyDir = await Deno.makeTempDir({
    prefix: "nas-hostexec-notify-",
  });
  const notifyLog = `${notifyDir}/notify.log`;
  const originalPath = Deno.env.get("PATH") ?? "";
  const originalNotifyExit = Deno.env.get("NAS_NOTIFY_EXIT");
  const originalNotifyStdout = Deno.env.get("NAS_NOTIFY_STDOUT");
  const originalNotifyArgsLog = Deno.env.get("NAS_NOTIFY_ARGS_LOG");
  await Deno.writeTextFile(
    `${notifyDir}/notify-send`,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "\${NAS_NOTIFY_ARGS_LOG}"
printf '%s' "\${NAS_NOTIFY_STDOUT:-}"
exit "\${NAS_NOTIFY_EXIT:-0}"
`,
  );
  await Deno.chmod(`${notifyDir}/notify-send`, 0o755);
  Deno.env.set("PATH", `${notifyDir}:${originalPath}`);
  Deno.env.set("NAS_NOTIFY_EXIT", "0");
  Deno.env.set("NAS_NOTIFY_STDOUT", "deny");
  Deno.env.set("NAS_NOTIFY_ARGS_LOG", notifyLog);

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      prompt: {
        enable: true,
        timeoutSeconds: 30,
        defaultScope: "capability",
        notify: "desktop",
      },
      rules: [{
        id: "deno-eval",
        match: { argv0: "deno", argRegex: "^eval\\b" },
        cwd: { mode: "workspace-only", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "prompt",
        fallback: "container",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('x')"], workspace, "req_notify_deny"),
    );
    assertEquals(response.type, "error");
    if (response.type === "error") {
      assertEquals(response.message, "permission denied by user");
    }
    const notifyArgs = await Deno.readTextFile(notifyLog);
    assertEquals(notifyArgs.includes("[nas] Pending hostexec approval"), true);
    assertEquals(notifyArgs.includes("deno eval console.log('x')"), true);
  } finally {
    restoreEnv("NAS_NOTIFY_EXIT", originalNotifyExit);
    restoreEnv("NAS_NOTIFY_STDOUT", originalNotifyStdout);
    restoreEnv("NAS_NOTIFY_ARGS_LOG", originalNotifyArgsLog);
    Deno.env.set("PATH", originalPath);
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
    await Deno.remove(notifyDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: capability key differs by secret reference and cwd", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const oldTokenA = Deno.env.get("TOKEN_A");
  const oldTokenB = Deno.env.get("TOKEN_B");
  Deno.env.set("TOKEN_A", "token-a");
  Deno.env.set("TOKEN_B", "token-b");
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      secrets: {
        token_a: { from: "env:TOKEN_A", required: true },
        token_b: { from: "env:TOKEN_B", required: true },
      },
      rules: [
        {
          id: "deno-secret-a",
          match: { argv0: "deno", argRegex: "^eval\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:token_a" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
        {
          id: "deno-secret-b",
          match: { argv0: "deno", argRegex: "^fmt\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:token_b" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const firstPromise = sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('a')"], workspace, "req_a"),
    );
    const nested = `${workspace}/nested`;
    await Deno.mkdir(nested, { recursive: true });
    const secondPromise = sendHostExecBrokerRequest(
      socketPath,
      request(["fmt", "--help"], nested, "req_b"),
    );
    const earlyFirst = await Promise.race([
      firstPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    const earlySecond = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    if (earlyFirst !== null || earlySecond !== null) {
      throw new Error(
        `request resolved too early: ${
          JSON.stringify([earlyFirst, earlySecond])
        }`,
      );
    }
    const entries = await waitForPendingCount(paths, 2);
    assertMatch(entries[0].approvalKey, /^[0-9a-f]{64}$/);
    assertMatch(entries[1].approvalKey, /^[0-9a-f]{64}$/);
    assertEquals(entries[0].approvalKey === entries[1].approvalKey, false);
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_a",
    });
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_b",
    });
    assertEquals((await firstPromise).type, "error");
    assertEquals((await secondPromise).type, "error");
  } finally {
    if (oldTokenA !== undefined) Deno.env.set("TOKEN_A", oldTokenA);
    else Deno.env.delete("TOKEN_A");
    if (oldTokenB !== undefined) Deno.env.set("TOKEN_B", oldTokenB);
    else Deno.env.delete("TOKEN_B");
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: argv0-only rule matches any args", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [{
        id: "deno-any",
        match: { argv0: "deno" },
        cwd: { mode: "workspace-only", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "container",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('ok')"], workspace, "req_any"),
    );
    assertEquals(response.type, "result");
    if (response.type !== "result") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    assertEquals(response.stdout.trim(), "ok");
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: argv0-only rule also matches no-args command", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [{
        id: "true-any",
        match: { argv0: "true" },
        cwd: { mode: "workspace-only", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "container",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request([], workspace, "req_true_noargs", "true"),
    );
    assertEquals(response.type, "result");
    if (response.type === "result") {
      assertEquals(response.exitCode, 0);
    }
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: rejects cwd outside workspace with workspace-only mode", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const outsideDir = await Deno.makeTempDir({
    prefix: "nas-hostexec-outside-",
  });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [{
        id: "deno-ws-only",
        match: { argv0: "deno" },
        cwd: { mode: "workspace-only", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "container",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('x')"], outsideDir, "req_cwd"),
    );
    assertEquals(response.type, "error");
    if (response.type === "error") {
      assertMatch(response.message, /outside workspace/);
    }
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
    await Deno.remove(outsideDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: allows cwd in session tmp with workspace-or-session-tmp mode", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const sessionTmpDir = `${runtimeDir}/tmp`;
  await Deno.mkdir(sessionTmpDir, { recursive: true });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir,
    hostexec: makeConfig({
      rules: [{
        id: "deno-ws-tmp",
        match: { argv0: "deno" },
        cwd: { mode: "workspace-or-session-tmp", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "allow",
        fallback: "container",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('ok')"], sessionTmpDir, "req_tmp"),
    );
    assertEquals(response.type, "result");
    if (response.type === "result") {
      assertEquals(response.stdout.trim(), "ok");
    }
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: fallback deny returns error for unmatched command", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: Deno.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [{
        id: "deno-deny",
        match: { argv0: "deno", argRegex: "^eval\\b" },
        cwd: { mode: "any", allow: [] },
        env: {},
        inheritEnv: { mode: "minimal", keys: [] },
        approval: "deny",
        fallback: "deny",
      }],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    // Unmatched command: no rule for "fmt"
    const fallbackResponse = await sendHostExecBrokerRequest(
      socketPath,
      request(["fmt", "--help"], Deno.cwd(), "req_unmatched"),
    );
    assertEquals(fallbackResponse.type, "fallback");

    // Matched command with approval: deny
    const denyResponse = await sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('x')"], Deno.cwd(), "req_deny"),
    );
    assertEquals(denyResponse.type, "error");
    if (denyResponse.type === "error") {
      assertMatch(denyResponse.message, /permission denied/);
    }
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("HostExecBroker: capability key differs by inheritEnv", async () => {
  const runtimeDir = await Deno.makeTempDir({ prefix: "nas-hostexec-" });
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await Deno.makeTempDir({
    prefix: "nas-hostexec-workspace-",
  });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-minimal",
          match: { argv0: "deno", argRegex: "^eval\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
        {
          id: "deno-with-keys",
          match: { argv0: "deno", argRegex: "^fmt\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: ["SSH_AUTH_SOCK"] },
          approval: "prompt",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const firstPromise = sendHostExecBrokerRequest(
      socketPath,
      request(["eval", "console.log('a')"], workspace, "req_ie_a"),
    );
    const secondPromise = sendHostExecBrokerRequest(
      socketPath,
      request(["fmt", "--help"], workspace, "req_ie_b"),
    );
    await Promise.race([
      firstPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
    ]);
    const entries = await waitForPendingCount(paths, 2);
    assertEquals(entries[0].approvalKey === entries[1].approvalKey, false);
    // Clean up
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_ie_a",
    });
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_ie_b",
    });
    await firstPromise;
    await secondPromise;
  } finally {
    await broker.close();
    await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    await Deno.remove(workspace, { recursive: true }).catch(() => {});
  }
});

async function waitForPendingEntries(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  count: number,
): Promise<PendingListResponse["items"]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = await listHostExecPendingEntries(paths, "sess_test");
    if (entries.length >= count) return entries;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for hostexec pending entry");
}

async function waitForPendingCount(
  paths: Awaited<ReturnType<typeof resolveHostExecRuntimePaths>>,
  count: number,
) {
  return await waitForPendingEntries(paths, count);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }
  Deno.env.set(name, value);
}
