/**
 * HostExec Stage (PlanStage)
 *
 * ホスト上のコマンド実行を仲介する HostExecBroker を起動し、
 * エージェントコンテナ内からラッパースクリプト経由でアクセスできるようにする。
 */

import * as path from "node:path";
import { DEFAULT_HOSTEXEC_CONFIG } from "../config/types.ts";
import {
  isBareCommandHostExecArgv0,
  isRelativeHostExecArgv0,
} from "../hostexec/match.ts";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import { resolveNotifyBackend } from "../lib/notify_utils.ts";
import type {
  HostEnv,
  PlanStage,
  ResourceEffect,
  StageInput,
  StagePlan,
} from "../pipeline/types.ts";

const WRAPPER_DIR = "/opt/nas/hostexec/bin";
const SESSION_TMP_ROOT = "/tmp/nas-hostexec";

// ---------------------------------------------------------------------------
// PlanStage
// ---------------------------------------------------------------------------

export function createHostExecStage(): PlanStage {
  return {
    kind: "plan",
    name: "HostExecStage",

    plan(input: StageInput): StagePlan | null {
      const config =
        input.profile.hostexec ?? structuredClone(DEFAULT_HOSTEXEC_CONFIG);
      if (config.rules.length === 0) {
        return null;
      }

      const runtimePaths = resolveHostExecRuntimePathsPure(input.host);
      const socketPath = path.join(
        runtimePaths.brokersDir,
        `${input.sessionId}.sock`,
      );
      const wrapperRoot = path.join(runtimePaths.wrappersDir, input.sessionId);
      const wrapperBinDir = path.join(wrapperRoot, "bin");
      const wrapperScript = path.join(wrapperBinDir, "hostexec-wrapper.py");
      const sessionTmpDir = path.join(wrapperRoot, "tmp");
      const containerSessionTmp = path.join(SESSION_TMP_ROOT, input.sessionId);

      const effects: ResourceEffect[] = [];

      // Create runtime directories
      effects.push({
        kind: "directory-create",
        path: runtimePaths.runtimeDir,
        mode: 0o755,
        removeOnTeardown: false,
      });
      effects.push({
        kind: "directory-create",
        path: runtimePaths.sessionsDir,
        mode: 0o700,
        removeOnTeardown: false,
      });
      effects.push({
        kind: "directory-create",
        path: runtimePaths.pendingDir,
        mode: 0o700,
        removeOnTeardown: false,
      });
      effects.push({
        kind: "directory-create",
        path: runtimePaths.brokersDir,
        mode: 0o700,
        removeOnTeardown: false,
      });
      effects.push({
        kind: "directory-create",
        path: runtimePaths.wrappersDir,
        mode: 0o700,
        removeOnTeardown: false,
      });

      // Create wrapper bin dir and session tmp dir
      effects.push({
        kind: "directory-create",
        path: wrapperBinDir,
        mode: 0o755,
        removeOnTeardown: false,
      });
      effects.push({
        kind: "directory-create",
        path: sessionTmpDir,
        mode: 0o700,
        removeOnTeardown: false,
      });

      // Write wrapper script
      effects.push({
        kind: "file-write",
        path: wrapperScript,
        content: buildWrapperScript(),
        mode: 0o755,
      });

      // Create symlinks for bare command argv0s
      const argv0Names = new Set(
        config.rules
          .map((rule) => rule.match.argv0)
          .filter(isBareCommandHostExecArgv0),
      );
      for (const argv0 of argv0Names) {
        effects.push({
          kind: "symlink",
          target: "hostexec-wrapper.py",
          path: path.join(wrapperBinDir, argv0),
        });
      }

      // Symlinks for relative argv0 wrappers — computed purely.
      // NOTE: The legacy stage did Deno.stat() to check if the target file
      // exists. In the PlanStage version, we skip the existence check and
      // always emit the mount. If the file doesn't exist at container start,
      // Docker will create a directory mount instead (harmless for missing
      // targets, and the wrapper script handles missing binaries gracefully).
      const relativeArgv0s = [
        ...new Set(
          config.rules
            .map((rule) => rule.match.argv0)
            .filter(isRelativeHostExecArgv0),
        ),
      ];

      // Bind-mounts for absolute argv0 wrappers — replaces the container
      // binary at that exact path so the wrapper intercepts the call.
      const absoluteArgv0s = [
        ...new Set(
          config.rules
            .map((rule) => rule.match.argv0)
            .filter((argv0) => path.isAbsolute(argv0)),
        ),
      ];

      // Start HostExecBroker via unix-listener effect
      const workspaceRoot = input.prior.mountDir ?? input.prior.workDir;
      effects.push({
        kind: "unix-listener",
        id: "hostexec-broker",
        socketPath,
        spec: {
          kind: "hostexec-broker",
          paths: runtimePaths,
          sessionId: input.sessionId,
          profileName: input.profileName,
          workspaceRoot,
          sessionTmpDir,
          hostexec: config,
          notify: resolveNotifyBackend(config.prompt.notify),
          uiEnabled: input.config.ui.enable,
          uiPort: input.config.ui.port,
          uiIdleTimeout: input.config.ui.idleTimeout,
          auditDir: input.probes.auditDir,
          agent: input.profile.agent,
        },
      });

      const workDir = input.prior.workDir;

      return {
        effects,
        dockerArgs: [
          "-v",
          `${wrapperBinDir}:${WRAPPER_DIR}:ro`,
          "-v",
          `${runtimePaths.brokersDir}:${runtimePaths.brokersDir}`,
          "-v",
          `${sessionTmpDir}:${containerSessionTmp}`,
          ...relativeArgv0s.flatMap((argv0) => [
            "-v",
            `${wrapperScript}:${path.resolve(workDir, argv0)}:ro`,
          ]),
          ...absoluteArgv0s.flatMap((argv0) => [
            "-v",
            `${wrapperScript}:${argv0}:ro`,
          ]),
        ],
        envVars: {
          NAS_HOSTEXEC_SOCKET: socketPath,
          NAS_HOSTEXEC_WRAPPER_DIR: WRAPPER_DIR,
          NAS_HOSTEXEC_SESSION_ID: input.sessionId,
          NAS_HOSTEXEC_SESSION_TMP: containerSessionTmp,
        },
        outputOverrides: {
          hostexecRuntimeDir: runtimePaths.runtimeDir,
          hostexecBrokerSocket: socketPath,
          hostexecSessionTmpDir: containerSessionTmp,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Compute HostExecRuntimePaths purely from HostEnv (no I/O).
 * Mirrors the logic of resolveHostExecRuntimePaths() but without
 * creating directories.
 */
export function resolveHostExecRuntimePathsPure(
  host: HostEnv,
): HostExecRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "hostexec");
  } else {
    // uid is always non-null on Linux; "unknown" is a defensive fallback
    const uid = host.uid ?? "unknown";
    runtimeDir = path.join("/tmp", `nas-${uid}`, "hostexec");
  }
  return {
    runtimeDir,
    sessionsDir: path.join(runtimeDir, "sessions"),
    pendingDir: path.join(runtimeDir, "pending"),
    brokersDir: path.join(runtimeDir, "brokers"),
    wrappersDir: path.join(runtimeDir, "wrappers"),
  };
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
