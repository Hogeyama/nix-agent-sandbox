import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectUnix, readJsonLine } from "../lib/unix_socket.ts";
import {
  buildInheritedEnv,
  HOSTEXEC_CONTROL_REQUEST_MAX_BYTES,
  HostExecBroker,
  parseHostExecControlMessage,
  resolveAllowEntry,
  sendHostExecControlRequest,
} from "./broker.ts";
import {
  hostExecBrokerSocketPath,
  hostExecInternalSocketPath,
  resolveHostExecRuntimePaths,
} from "./registry.ts";

test("parseHostExecControlMessage: accepts the control request shapes", () => {
  expect(parseHostExecControlMessage({ type: "list_pending" })).toEqual({
    type: "list_pending",
  });
  expect(
    parseHostExecControlMessage({ type: "deny", requestId: "r1", extra: 1 }),
  ).toEqual({ type: "deny", requestId: "r1" });
  expect(
    parseHostExecControlMessage({
      type: "approve",
      requestId: "r1",
      scope: "capability",
    }),
  ).toEqual({ type: "approve", requestId: "r1", scope: "capability" });
  expect(
    parseHostExecControlMessage({ type: "execute", requestId: "r1" }),
  ).toEqual({ type: "execute", requestId: "r1" });
});

test("parseHostExecControlMessage: rejects malformed requests", () => {
  for (const value of [
    null,
    "approve",
    [],
    {},
    { type: "approve" },
    { type: "approve", requestId: 1 },
    { type: "approve", requestId: "r1", scope: ["once"] },
    { type: "approve", requestId: "r1", scope: 1 },
    { type: "deny", requestId: null },
    { type: "shutdown", requestId: "r1" },
  ]) {
    expect(parseHostExecControlMessage(value)).toBeNull();
  }
});

async function withControlSocket(
  fn: (controlSocketPath: string) => Promise<void>,
): Promise<void> {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "nas-hostexec-ctl-"));
  const paths = await resolveHostExecRuntimePaths(runtimeDir);
  const broker = new HostExecBroker({
    paths,
    sessionId: "sess_ctl",
    profileName: "test",
    notify: "off",
    workspaceRoot: runtimeDir,
    sessionTmpDir: path.join(runtimeDir, "tmp"),
  });
  const controlSocketPath = hostExecBrokerSocketPath(paths, "sess_ctl");
  await broker.start(
    hostExecInternalSocketPath(paths, "sess_ctl"),
    controlSocketPath,
  );
  try {
    await fn(controlSocketPath);
  } finally {
    await broker.close();
    await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Writes raw bytes and returns the reply line, or null if closed silently. */
async function sendRawControl(
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

test("HostExecBroker control socket: an oversized line is dropped and the broker keeps serving", async () => {
  await withControlSocket(async (socketPath) => {
    const oversized = Buffer.alloc(
      HOSTEXEC_CONTROL_REQUEST_MAX_BYTES + 1,
      0x61,
    );
    expect(await sendRawControl(socketPath, oversized)).toBeNull();
    expect(await sendRawControl(socketPath, "{not json\n")).toBeNull();

    const response = await sendHostExecControlRequest(socketPath, {
      type: "list_pending",
    });
    expect(response).toEqual({ type: "pending", items: [] });
  });
});

test("HostExecBroker control socket: a request of exactly the limit is still read", async () => {
  await withControlSocket(async (socketPath) => {
    const envelope = JSON.stringify({ type: "deny", requestId: "" });
    const requestId = "x".repeat(
      HOSTEXEC_CONTROL_REQUEST_MAX_BYTES - envelope.length,
    );
    const line = JSON.stringify({ type: "deny", requestId });
    expect(Buffer.byteLength(line)).toBe(HOSTEXEC_CONTROL_REQUEST_MAX_BYTES);
    const reply = await sendRawControl(socketPath, `${line}\n`);
    expect(reply && JSON.parse(reply)).toEqual({
      type: "error",
      requestId,
      message: `Pending request not found: ${requestId}`,
    });
  });
});

test("HostExecBroker control socket: a structurally invalid request gets an error reply", async () => {
  await withControlSocket(async (socketPath) => {
    const reply = await sendRawControl(
      socketPath,
      `${JSON.stringify({ type: "approve", requestId: 7 })}\n`,
    );
    expect(reply && JSON.parse(reply)).toEqual({
      type: "error",
      requestId: "",
      message: "invalid control request",
    });
  });
});

test("resolveAllowEntry: resolves workspace: and session_tmp: within root", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nas-broker-ws-"));
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "nas-broker-tmp-"));
  try {
    expect(
      await resolveAllowEntry("workspace:sub", workspace, sessionTmp),
    ).toEqual(path.join(workspace, "sub"));
    expect(
      await resolveAllowEntry("workspace:", workspace, sessionTmp),
    ).toEqual(workspace);
    expect(
      await resolveAllowEntry("session_tmp:foo/bar", workspace, sessionTmp),
    ).toEqual(path.join(sessionTmp, "foo", "bar"));
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(sessionTmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveAllowEntry: rejects workspace: entries that escape via ..", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nas-broker-ws-"));
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "nas-broker-tmp-"));
  try {
    await expect(
      resolveAllowEntry("workspace:../etc", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
    await expect(
      resolveAllowEntry("workspace:../../../etc/passwd", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(sessionTmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveAllowEntry: rejects session_tmp: entries that escape via absolute path", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "nas-broker-ws-"));
  const sessionTmp = await mkdtemp(path.join(tmpdir(), "nas-broker-tmp-"));
  try {
    await expect(
      resolveAllowEntry("session_tmp:/etc/passwd", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
    await expect(
      resolveAllowEntry("session_tmp:../other", workspace, sessionTmp),
    ).rejects.toThrow(/escapes its root/);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
    await rm(sessionTmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("buildInheritedEnv: unsafe-inherit-all leaves out nas's own and proxy credential variables", () => {
  const hostEnv = {
    HOME: "/home/alice",
    GITHUB_TOKEN: "user-token",
    NAS_UPSTREAM_PROXY: "http://sess:tok@nas-proxy:3128",
    NAS_CONFIG_TRUST_ALL: "1",
    NAS_SESSION_ID: "sess",
    HTTPS_PROXY: "http://bob:hunter2@corp:8080",
    http_proxy: "http://corp:8080",
  };
  expect(
    buildInheritedEnv(
      { mode: "unsafe-inherit-all", keys: ["NAS_SESSION_ID"] },
      hostEnv,
    ),
  ).toEqual({
    HOME: "/home/alice",
    GITHUB_TOKEN: "user-token",
    http_proxy: "http://corp:8080",
    // Named explicitly in keys, so it is still passed.
    NAS_SESSION_ID: "sess",
  });
});

test("buildInheritedEnv: recognises proxy credentials in every proxy variable spelling", () => {
  const hostEnv = {
    ALL_PROXY: "socks5://u:p@corp:1080",
    all_proxy: "u@corp:1080",
    FTP_PROXY: "http://:secret@corp:21",
    https_proxy: "corp:8080",
    NO_PROXY: "localhost,127.0.0.1",
    PROXY_NOTE: "http://u:p@not-a-proxy-var",
    HTTP_PROXY: "::not a url::",
  };
  expect(
    buildInheritedEnv({ mode: "unsafe-inherit-all", keys: [] }, hostEnv),
  ).toEqual({
    https_proxy: "corp:8080",
    NO_PROXY: "localhost,127.0.0.1",
    PROXY_NOTE: "http://u:p@not-a-proxy-var",
    HTTP_PROXY: "::not a url::",
  });
});

test("buildInheritedEnv: explicit keys still pass a proxy credential through", () => {
  expect(
    buildInheritedEnv(
      { mode: "unsafe-inherit-all", keys: ["HTTPS_PROXY"] },
      { HTTPS_PROXY: "http://bob:pw@corp:8080" },
    ),
  ).toEqual({ HTTPS_PROXY: "http://bob:pw@corp:8080" });
});

test("buildInheritedEnv: minimal mode is unchanged", () => {
  expect(
    buildInheritedEnv(
      { mode: "minimal", keys: ["NAS_SESSION_ID", "UNSET_KEY"] },
      {
        HOME: "/home/alice",
        LANG: "C.UTF-8",
        GITHUB_TOKEN: "user-token",
        NAS_SESSION_ID: "sess",
        NAS_UPSTREAM_PROXY: "http://sess:tok@nas-proxy:3128",
      },
    ),
  ).toEqual({
    HOME: "/home/alice",
    LANG: "C.UTF-8",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    NAS_SESSION_ID: "sess",
  });
});
