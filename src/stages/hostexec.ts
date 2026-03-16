import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { DEFAULT_HOSTEXEC_CONFIG } from "../config/types.ts";
import { HostExecBroker } from "../hostexec/broker.ts";
import {
  hostExecBrokerSocketPath,
  type HostExecRuntimePaths,
  removeHostExecPendingDir,
  removeHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
  writeHostExecSessionRegistry,
} from "../hostexec/registry.ts";

const WRAPPER_DIR = "/opt/nas/hostexec/bin";
const SESSION_TMP_ROOT = "/tmp/nas-hostexec";

export class HostExecStage implements Stage {
  name = "HostExecStage";

  private runtimePaths: HostExecRuntimePaths | null = null;
  private broker: HostExecBroker | null = null;
  private wrapperRoot: string | null = null;
  private sessionTmpDir: string | null = null;

  async execute(ctx: ExecutionContext): Promise<ExecutionContext> {
    const config = ctx.profile.hostexec ??
      structuredClone(DEFAULT_HOSTEXEC_CONFIG);
    if (config.rules.length === 0) {
      return ctx;
    }

    const runtimePaths = await resolveHostExecRuntimePaths();
    this.runtimePaths = runtimePaths;
    const socketPath = hostExecBrokerSocketPath(runtimePaths, ctx.sessionId);
    const wrapperRoot = path.join(runtimePaths.wrappersDir, ctx.sessionId);
    const wrapperBinDir = path.join(wrapperRoot, "bin");
    const wrapperScript = path.join(wrapperBinDir, "hostexec-wrapper.py");
    const sessionTmpDir = path.join(wrapperRoot, "tmp");
    this.wrapperRoot = wrapperRoot;
    this.sessionTmpDir = sessionTmpDir;

    await Deno.mkdir(wrapperBinDir, { recursive: true, mode: 0o755 });
    await Deno.mkdir(sessionTmpDir, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(wrapperScript, buildWrapperScript(), {
      create: true,
      mode: 0o755,
    });
    await Deno.chmod(wrapperScript, 0o755).catch(() => {});

    const argv0Names = new Set(config.rules.map((rule) => rule.match.argv0));
    for (const argv0 of argv0Names) {
      const linkPath = path.join(wrapperBinDir, argv0);
      await Deno.remove(linkPath).catch(() => {});
      await Deno.symlink("hostexec-wrapper.py", linkPath);
    }

    const broker = new HostExecBroker({
      paths: runtimePaths,
      sessionId: ctx.sessionId,
      profileName: ctx.profileName,
      workspaceRoot: ctx.mountDir ?? ctx.workDir,
      sessionTmpDir,
      hostexec: config,
      secrets: ctx.profile.secrets,
    });
    await broker.start(socketPath);
    this.broker = broker;

    await writeHostExecSessionRegistry(runtimePaths, {
      version: 1,
      sessionId: ctx.sessionId,
      brokerSocket: socketPath,
      profileName: ctx.profileName,
      createdAt: new Date().toISOString(),
      pid: Deno.pid,
    });

    return {
      ...ctx,
      dockerArgs: [
        ...ctx.dockerArgs,
        "-v",
        `${wrapperBinDir}:${WRAPPER_DIR}:ro`,
        "-v",
        `${runtimePaths.brokersDir}:${runtimePaths.brokersDir}`,
        "-v",
        `${sessionTmpDir}:${path.join(SESSION_TMP_ROOT, ctx.sessionId)}`,
      ],
      envVars: {
        ...ctx.envVars,
        PATH: `${WRAPPER_DIR}:${
          ctx.envVars["PATH"] ??
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        }`,
        NAS_HOSTEXEC_SOCKET: socketPath,
        NAS_HOSTEXEC_WRAPPER_DIR: WRAPPER_DIR,
        NAS_HOSTEXEC_SESSION_ID: ctx.sessionId,
        NAS_HOSTEXEC_SESSION_TMP: path.join(SESSION_TMP_ROOT, ctx.sessionId),
      },
      hostexecRuntimeDir: runtimePaths.runtimeDir,
      hostexecBrokerSocket: socketPath,
      hostexecSessionTmpDir: path.join(SESSION_TMP_ROOT, ctx.sessionId),
    };
  }

  async teardown(ctx: ExecutionContext): Promise<void> {
    if (this.broker) {
      await this.broker.close();
      this.broker = null;
    }
    if (this.runtimePaths) {
      await removeHostExecSessionRegistry(this.runtimePaths, ctx.sessionId)
        .catch(() => {});
      await removeHostExecPendingDir(this.runtimePaths, ctx.sessionId).catch(
        () => {},
      );
    }
    if (this.wrapperRoot) {
      await Deno.remove(this.wrapperRoot, { recursive: true }).catch(() => {});
      this.wrapperRoot = null;
    }
  }
}

function buildWrapperScript(): string {
  return `#!/usr/bin/env python3
import base64
import json
import os
import select
import shutil
import socket
import subprocess
import sys


def find_fallback_binary(argv0: str, wrapper_dir: str) -> str:
    path_value = os.environ.get("PATH", "")
    for directory in path_value.split(":"):
        if not directory:
            continue
        candidate = os.path.join(directory, argv0)
        if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            continue
        if os.path.realpath(candidate).startswith(os.path.realpath(wrapper_dir)):
            continue
        return candidate
    resolved = shutil.which(argv0)
    if resolved and not os.path.realpath(resolved).startswith(os.path.realpath(wrapper_dir)):
        return resolved
    raise FileNotFoundError(f"fallback binary not found: {argv0}")


def call_broker(payload: dict) -> dict:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(os.environ["NAS_HOSTEXEC_SOCKET"])
    try:
        sock.sendall((json.dumps(payload) + "\\n").encode())
        data = b""
        while not data.endswith(b"\\n"):
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        if not data:
            raise RuntimeError("empty hostexec broker response")
        return json.loads(data.decode())
    finally:
        sock.close()

def read_available_stdin() -> bytes:
    fd = sys.stdin.fileno()
    chunks = []
    while True:
        ready, _, _ = select.select([fd], [], [], 0)
        if not ready:
            break
        chunk = os.read(fd, 65536)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def main() -> int:
    argv0 = os.path.basename(sys.argv[0])
    payload = {
        "version": 1,
        "type": "execute",
        "sessionId": os.environ.get("NAS_HOSTEXEC_SESSION_ID", ""),
        "requestId": f"req_{os.getpid()}_{os.urandom(4).hex()}",
        "argv0": argv0,
        "args": sys.argv[1:],
        "cwd": os.getcwd(),
        "tty": sys.stdin.isatty(),
    }
    if not sys.stdin.isatty():
        stdin_data = read_available_stdin()
        if stdin_data:
            payload["stdin"] = base64.b64encode(stdin_data).decode()

    response = call_broker(payload)
    if response["type"] == "fallback":
        binary = find_fallback_binary(argv0, os.environ["NAS_HOSTEXEC_WRAPPER_DIR"])
        os.execv(binary, [binary, *sys.argv[1:]])
    if response["type"] == "error":
        print(response["message"], file=sys.stderr)
        return 1
    sys.stdout.write(response.get("stdout", ""))
    sys.stderr.write(response.get("stderr", ""))
    return int(response.get("exitCode", 0))


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
