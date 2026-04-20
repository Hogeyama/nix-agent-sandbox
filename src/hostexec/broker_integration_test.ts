import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { queryAuditLogs } from "../audit/store.ts";
import type { HostExecConfig } from "../config/types.ts";
import { HostExecBroker, sendHostExecBrokerRequest } from "./broker.ts";
import {
  hostExecBrokerSocketPath,
  listHostExecPendingEntries,
  resolveHostExecRuntimePaths,
} from "./registry.ts";
import type {
  ExecuteRequest,
  HostExecBrokerResponse,
  PendingListResponse,
} from "./types.ts";

type HostExecConfigOverrides = Omit<Partial<HostExecConfig>, "prompt"> & {
  prompt?: Partial<HostExecConfig["prompt"]>;
};

function decodeStdout(response: HostExecBrokerResponse): string {
  if (response.type !== "result") {
    throw new Error(`expected result response, got ${response.type}`);
  }
  return Buffer.from(response.stdout, "base64").toString("utf-8");
}

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
  argv0 = "node",
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

test("HostExecBroker: falls back when no rule matches", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["-e", "console.log('x')"], process.cwd()),
    );
    expect(response.type).toEqual("fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: prompts and resumes after approve", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const oldToken = process.env.HOSTEXEC_TEST_TOKEN;
  process.env.HOSTEXEC_TEST_TOKEN = "super-secret-value";
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: makeConfig({
      secrets: {
        test_token: { from: "env:HOSTEXEC_TEST_TOKEN", required: true },
      },
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:test_token" },
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
    const execPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(
        ["-e", "console.log(process.env['TOKEN'])"],
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
    expect(pending.length).toEqual(1);
    expect(pending[0].ruleId).toEqual("node-eval");
    await sendHostExecBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_approve",
    });
    const response = await execPromise;
    expect(response.type).toEqual("result");
    if (response.type !== "result") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    expect(decodeStdout(response).trim()).toEqual("[REDACTED]");

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("allow");
    expect(logs[0].reason).toEqual("approved-by-user");
    expect(logs[0].requestId).toEqual("req_approve");
    expect(logs[0].command!).toMatch(/^node -e /);
  } finally {
    if (oldToken !== undefined) process.env.HOSTEXEC_TEST_TOKEN = oldToken;
    else delete process.env.HOSTEXEC_TEST_TOKEN;
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: pending request can be denied via broker", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: makeConfig({
      prompt: {
        enable: true,
        timeoutSeconds: 30,
        defaultScope: "capability",
        notify: "off",
      },
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
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
    const executePromise = sendHostExecBrokerRequest(
      socketPath,
      request(["-e", "console.log('x')"], workspace, "req_deny"),
    );
    const pending = await waitForPendingEntries(paths, 1);
    expect(pending.length).toEqual(1);
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_deny",
    });
    const response = await executePromise;
    expect(response.type).toEqual("error");
    if (response.type === "error") {
      expect(response.message).toEqual("permission denied by user");
    }

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("denied-by-user");
    expect(logs[0].requestId).toEqual("req_deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: capability key differs by secret reference and cwd", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const oldTokenA = process.env.TOKEN_A;
  const oldTokenB = process.env.TOKEN_B;
  process.env.TOKEN_A = "token-a";
  process.env.TOKEN_B = "token-b";
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
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
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: { TOKEN: "secret:token_a" },
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
        {
          id: "deno-secret-b",
          match: { argv0: "node", argRegex: "^fmt\\b" },
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
      request(["-e", "console.log('a')"], workspace, "req_a"),
    );
    const nested = `${workspace}/nested`;
    await mkdir(nested, { recursive: true });
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
        `request resolved too early: ${JSON.stringify([
          earlyFirst,
          earlySecond,
        ])}`,
      );
    }
    const entries = await waitForPendingCount(paths, 2);
    expect(entries[0].approvalKey).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[1].approvalKey).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0].approvalKey === entries[1].approvalKey).toEqual(false);
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_a",
    });
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_b",
    });
    expect((await firstPromise).type).toEqual("error");
    expect((await secondPromise).type).toEqual("error");
  } finally {
    if (oldTokenA !== undefined) process.env.TOKEN_A = oldTokenA;
    else delete process.env.TOKEN_A;
    if (oldTokenB !== undefined) process.env.TOKEN_B = oldTokenB;
    else delete process.env.TOKEN_B;
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: argv0-only rule matches any args", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-any",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["-e", "console.log('ok')"], workspace, "req_any"),
    );
    expect(response.type).toEqual("result");
    if (response.type !== "result") {
      throw new Error(`unexpected response type: ${response.type}`);
    }
    expect(decodeStdout(response).trim()).toEqual("ok");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: PATH rule executes basename when request argv0 is wrapper path", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "sh-any",
          match: { argv0: "sh" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(
        ["-c", "printf ok"],
        workspace,
        "req_sh_wrapper",
        "/opt/nas/hostexec/bin/sh",
      ),
    );
    expect(response.type).toEqual("result");
    if (response.type === "result") {
      expect(decodeStdout(response)).toEqual("ok");
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: relative rule executes original relative argv0", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const scriptPath = `${workspace}/gradlew`;
  await writeFile(scriptPath, "#!/bin/sh\nprintf gradle-ok\n");
  await chmod(scriptPath, 0o755);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "gradlew-any",
          match: { argv0: "./gradlew" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request([], workspace, "req_gradlew", "./gradlew"),
    );
    expect(response.type).toEqual("result");
    if (response.type === "result") {
      expect(decodeStdout(response)).toEqual("gradle-ok");
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: absolute rule executes exact absolute binary path", async () => {
  // Verify that a rule with an absolute argv0 executes that exact binary on
  // the host and does not degrade to a basename/PATH lookup.
  // We use a temp script at a known absolute path to avoid platform-specific
  // assumptions about /usr/bin/true availability inside the test sandbox.
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  // Create a helper script inside workspace whose absolute path we control.
  const helperScript = `${workspace}/helper.sh`;
  await writeFile(helperScript, "#!/bin/sh\nprintf absolute-ok\n");
  await chmod(helperScript, 0o755);

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "helper-absolute",
          match: { argv0: helperScript },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    // Request must use the exact absolute path — broker must execute it directly.
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request([], workspace, "req_helper_abs", helperScript),
    );
    expect(response.type).toEqual("result");
    if (response.type === "result") {
      expect(decodeStdout(response)).toEqual("absolute-ok");
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: absolute rule does not match bare-name invocation", async () => {
  // A rule matching an absolute path should NOT intercept a bare-name invocation.
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const helperScript = `${workspace}/helper.sh`;
  await writeFile(helperScript, "#!/bin/sh\nexit 0\n");
  await chmod(helperScript, 0o755);

  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "helper-absolute",
          match: { argv0: helperScript },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "deny",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request([], workspace, "req_helper_bare", "helper.sh"),
    );
    // Bare 'helper.sh' should not match the absolute rule → fallback
    expect(response.type).toEqual("fallback");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: argv0-only rule also matches no-args command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "true-any",
          match: { argv0: "true" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request([], workspace, "req_true_noargs", "true"),
    );
    expect(response.type).toEqual("result");
    if (response.type === "result") {
      expect(response.exitCode).toEqual(0);
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: rejects cwd outside workspace with workspace-only mode", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const outsideDir = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-outside-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-ws-only",
          match: { argv0: "node" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["-e", "console.log('x')"], outsideDir, "req_cwd"),
    );
    expect(response.type).toEqual("error");
    if (response.type === "error") {
      expect(response.message).toMatch(/outside workspace/);
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: allows cwd in session tmp with workspace-or-session-tmp mode", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const sessionTmpDir = `${runtimeDir}/tmp`;
  await mkdir(sessionTmpDir, { recursive: true });
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-ws-tmp",
          match: { argv0: "node" },
          cwd: { mode: "workspace-or-session-tmp", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "allow",
          fallback: "container",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    const response = await sendHostExecBrokerRequest(
      socketPath,
      request(["-e", "console.log('ok')"], sessionTmpDir, "req_tmp"),
    );
    expect(response.type).toEqual("result");
    if (response.type === "result") {
      expect(decodeStdout(response).trim()).toEqual("ok");
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: fallback deny returns error for unmatched command", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const auditDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-audit-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    auditDir,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-deny",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "any", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "deny",
          fallback: "deny",
        },
      ],
    }),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_test");
  await broker.start(socketPath);
  try {
    // Unmatched command: no rule for "fmt"
    const fallbackResponse = await sendHostExecBrokerRequest(
      socketPath,
      request(["fmt", "--help"], process.cwd(), "req_unmatched"),
    );
    expect(fallbackResponse.type).toEqual("fallback");

    // Matched command with approval: deny
    const denyResponse = await sendHostExecBrokerRequest(
      socketPath,
      request(["-e", "console.log('x')"], process.cwd(), "req_deny"),
    );
    expect(denyResponse.type).toEqual("error");
    if (denyResponse.type === "error") {
      expect(denyResponse.message).toMatch(/permission denied/);
    }

    const logs = await queryAuditLogs({ domain: "hostexec" }, auditDir);
    expect(logs.length).toEqual(1);
    expect(logs[0].decision).toEqual("deny");
    expect(logs[0].reason).toEqual("policy-deny");
    expect(logs[0].requestId).toEqual("req_deny");
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(auditDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: capability key differs by inheritEnv", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "deno-minimal",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
          inheritEnv: { mode: "minimal", keys: [] },
          approval: "prompt",
          fallback: "container",
        },
        {
          id: "deno-with-keys",
          match: { argv0: "node", argRegex: "^fmt\\b" },
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
      request(["-e", "console.log('a')"], workspace, "req_ie_a"),
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
    expect(entries[0].approvalKey === entries[1].approvalKey).toEqual(false);
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
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: scope once does not cache approval key", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
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
    // First request: approve with scope "once"
    const firstPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(["-e", "console.log('first')"], workspace, "req_once_1"),
    );
    await waitForPendingEntries(paths, 1);
    await sendHostExecBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_once_1",
      scope: "once",
    });
    const firstResponse = await firstPromise;
    expect(firstResponse.type).toEqual("result");
    if (firstResponse.type === "result") {
      expect(decodeStdout(firstResponse).trim()).toEqual("first");
    }

    // Second identical request (same args) should go to pending again (not auto-approved)
    const secondPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(["-e", "console.log('first')"], workspace, "req_once_2"),
    );
    const earlyResponse = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(earlyResponse).toEqual(null);

    // Clean up
    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_once_2",
    });
    await secondPromise;
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: scope capability caches approval key", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
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
    // First request: approve with scope "capability"
    const firstPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(["-e", "console.log('first')"], workspace, "req_cap_1"),
    );
    await waitForPendingEntries(paths, 1);
    await sendHostExecBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_cap_1",
      scope: "capability",
    });
    const firstResponse = await firstPromise;
    expect(firstResponse.type).toEqual("result");

    // Second identical request (same args) should be auto-approved (not pending)
    const secondResponse =
      await sendHostExecBrokerRequest<HostExecBrokerResponse>(
        socketPath,
        request(["-e", "console.log('first')"], workspace, "req_cap_2"),
      );
    expect(secondResponse.type).toEqual("result");
    if (secondResponse.type === "result") {
      expect(decodeStdout(secondResponse).trim()).toEqual("first");
    }
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: defaultScope once used when no explicit scope", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "nas-hostexec-workspace-"),
  );
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_test",
    profileName: "test",
    notify: "off",
    workspaceRoot: workspace,
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig({
      prompt: { defaultScope: "once" },
      rules: [
        {
          id: "node-eval",
          match: { argv0: "node", argRegex: "^-e\\b" },
          cwd: { mode: "workspace-only", allow: [] },
          env: {},
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
    // First request: approve without explicit scope (defaultScope = "once")
    const firstPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(["-e", "console.log('first')"], workspace, "req_def_1"),
    );
    await waitForPendingEntries(paths, 1);
    await sendHostExecBrokerRequest(socketPath, {
      type: "approve",
      requestId: "req_def_1",
    });
    const firstResponse = await firstPromise;
    expect(firstResponse.type).toEqual("result");

    // Second request (same args) should go to pending (defaultScope was "once", so not cached)
    const secondPromise = sendHostExecBrokerRequest<HostExecBrokerResponse>(
      socketPath,
      request(["-e", "console.log('first')"], workspace, "req_def_2"),
    );
    const earlyResponse = await Promise.race([
      secondPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
    ]);
    expect(earlyResponse).toEqual(null);

    await sendHostExecBrokerRequest(socketPath, {
      type: "deny",
      requestId: "req_def_2",
    });
    await secondPromise;
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
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

test("HostExecBroker: isolates sockets per session under 0o700 subdirs", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);

  const brokerA = new HostExecBroker({
    paths,
    sessionId: "sess_alpha",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const brokerB = new HostExecBroker({
    paths,
    sessionId: "sess_beta",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });

  const socketA = hostExecBrokerSocketPath(paths, "sess_alpha");
  const socketB = hostExecBrokerSocketPath(paths, "sess_beta");

  try {
    await brokerA.start(socketA);
    await brokerB.start(socketB);

    expect(path.dirname(socketA)).toBe(
      path.join(paths.brokersDir, "sess_alpha"),
    );
    expect(path.dirname(socketB)).toBe(
      path.join(paths.brokersDir, "sess_beta"),
    );
    expect(path.basename(socketA)).toBe("sock");

    const dirA = await stat(path.dirname(socketA));
    const dirB = await stat(path.dirname(socketB));
    expect(dirA.mode & 0o777).toBe(0o700);
    expect(dirB.mode & 0o777).toBe(0o700);

    const entries = (await readdir(paths.brokersDir)).sort();
    expect(entries).toEqual(["sess_alpha", "sess_beta"]);

    // Each session's subdir contains only its own socket — sibling
    // sockets are not reachable by name from the other subdir.
    const inA = await readdir(path.dirname(socketA));
    const inB = await readdir(path.dirname(socketB));
    expect(inA).toEqual(["sock"]);
    expect(inB).toEqual(["sock"]);
  } finally {
    await brokerA.close();
    await brokerB.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("HostExecBroker: close() removes both socket and session subdir", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_cleanup",
    profileName: "test",
    notify: "off",
    workspaceRoot: process.cwd(),
    sessionTmpDir: `${runtimeDir}/tmp`,
    hostexec: makeConfig(),
  });
  const socketPath = hostExecBrokerSocketPath(paths, "sess_cleanup");
  try {
    await broker.start(socketPath);
    expect(await readdir(paths.brokersDir)).toEqual(["sess_cleanup"]);
    await broker.close();
    expect(await readdir(paths.brokersDir)).toEqual([]);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
});
