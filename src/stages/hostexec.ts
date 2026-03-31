import * as path from "@std/path";
import type { Stage } from "../pipeline/pipeline.ts";
import type { ExecutionContext } from "../pipeline/context.ts";
import { DEFAULT_HOSTEXEC_CONFIG } from "../config/types.ts";
import { logInfo } from "../log.ts";
import { HostExecBroker } from "../hostexec/broker.ts";
import { resolveAuditDir } from "../audit/store.ts";
import {
  hostExecBrokerSocketPath,
  type HostExecRuntimePaths,
  removeHostExecPendingDir,
  removeHostExecSessionRegistry,
  resolveHostExecRuntimePaths,
  writeHostExecSessionRegistry,
} from "../hostexec/registry.ts";
import {
  isBareCommandHostExecArgv0,
  isRelativeHostExecArgv0,
} from "../hostexec/match.ts";

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
    await Deno.chmod(wrapperScript, 0o755).catch((e) =>
      logInfo(`[nas] HostExec: failed to chmod wrapper script: ${e}`)
    );

    const argv0Names = new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter(isBareCommandHostExecArgv0),
    );
    for (const argv0 of argv0Names) {
      const linkPath = path.join(wrapperBinDir, argv0);
      await Deno.remove(linkPath).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) {
          logInfo(
            `[nas] HostExec: failed to remove old symlink ${linkPath}: ${e}`,
          );
        }
      });
      await Deno.symlink("hostexec-wrapper.py", linkPath);
    }

    const relativeArgv0Candidates = [
      ...new Set(
        config.rules.map((rule) => rule.match.argv0).filter(
          isRelativeHostExecArgv0,
        ),
      ),
    ];
    const relativeArgv0s: string[] = [];
    for (const argv0 of relativeArgv0Candidates) {
      const containerTarget = path.resolve(ctx.workDir, argv0);
      try {
        const stat = await Deno.stat(containerTarget);
        if (!stat.isFile) {
          logInfo(
            `[nas] HostExec: relative argv0 is not a file, skipping mount: ${argv0}`,
          );
          continue;
        }
      } catch (e) {
        logInfo(
          `[nas] HostExec: relative argv0 is missing, skipping mount: ${argv0}: ${e}`,
        );
        continue;
      }
      relativeArgv0s.push(argv0);
    }

    const broker = new HostExecBroker({
      paths: runtimePaths,
      sessionId: ctx.sessionId,
      profileName: ctx.profileName,
      workspaceRoot: ctx.mountDir ?? ctx.workDir,
      sessionTmpDir,
      hostexec: config,
      uiEnabled: ctx.config.ui.enable,
      uiPort: ctx.config.ui.port,
      uiIdleTimeout: ctx.config.ui.idleTimeout,
      auditDir: resolveAuditDir(),
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
      agent: ctx.profile.agent,
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
        ...relativeArgv0s.flatMap((argv0) => [
          "-v",
          `${wrapperScript}:${path.resolve(ctx.workDir, argv0)}:ro`,
        ]),
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
        .catch((e) =>
          logInfo(
            `[nas] HostExec teardown: failed to remove session registry: ${e}`,
          )
        );
      await removeHostExecPendingDir(this.runtimePaths, ctx.sessionId).catch(
        (e) =>
          logInfo(
            `[nas] HostExec teardown: failed to remove pending dir: ${e}`,
          ),
      );
    }
    if (this.wrapperRoot) {
      await Deno.remove(this.wrapperRoot, { recursive: true }).catch((e) =>
        logInfo(`[nas] HostExec teardown: failed to remove wrapper root: ${e}`)
      );
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
    if os.path.sep in argv0:
        argv0 = os.path.basename(argv0)
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
    argv0 = sys.argv[0]
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
        if (not os.path.isabs(argv0)) and (os.path.sep in argv0):
            print(f"relative argv0 fallback is not supported: {argv0}", file=sys.stderr)
            return 1
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
