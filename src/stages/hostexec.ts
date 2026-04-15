/**
 * HostExec Stage (EffectStage)
 *
 * ホスト上のコマンド実行を仲介する HostExecBroker を起動し、
 * エージェントコンテナ内からラッパースクリプト経由でアクセスできるようにする。
 */

import * as path from "node:path";
import { Effect, type Scope } from "effect";
import { DEFAULT_HOSTEXEC_CONFIG, type HostExecRule } from "../config/types.ts";
import {
  isBareCommandHostExecArgv0,
  isRelativeHostExecArgv0,
} from "../hostexec/match.ts";
import type { HostExecRuntimePaths } from "../hostexec/registry.ts";
import { resolveNotifyBackend } from "../lib/notify_utils.ts";
import {
  emptyContainerPlan,
  mergeContainerPlan,
} from "../pipeline/container_plan.ts";
import { encodeDynamicEnvOps } from "../pipeline/env_ops.ts";
import type {
  ContainerPlan,
  HostExecState,
  MountSpec,
  WorkspaceState,
} from "../pipeline/state.ts";
import type {
  EffectStage,
  EffectStageResult,
  HostEnv,
  StageInput,
} from "../pipeline/types.ts";
import { HostExecBrokerService } from "../services/hostexec_broker.ts";
import { HostExecSetupService } from "../services/hostexec_setup.ts";

const WRAPPER_DIR = "/opt/nas/hostexec/bin";
const SESSION_TMP_ROOT = "/tmp/nas-hostexec";

// ---------------------------------------------------------------------------
// HostExecPlan
// ---------------------------------------------------------------------------

export interface HostExecPlan {
  readonly directories: ReadonlyArray<{ path: string; mode: number }>;
  readonly files: ReadonlyArray<{
    path: string;
    content: string;
    mode: number;
  }>;
  readonly symlinks: ReadonlyArray<{ target: string; path: string }>;
  readonly mounts: readonly MountSpec[];
  readonly dockerArgs: string[];
  readonly envVars: Record<string, string>;
  readonly outputOverrides: EffectStageResult;
  readonly broker: {
    readonly socketPath: string;
    readonly paths: HostExecRuntimePaths;
    readonly sessionId: string;
    readonly profileName: string;
    readonly workspaceRoot: string;
    readonly sessionTmpDir: string;
    readonly hostexec: StageInput["profile"]["hostexec"];
    readonly notify: ReturnType<typeof resolveNotifyBackend>;
    readonly uiEnabled: boolean;
    readonly uiPort: number;
    readonly uiIdleTimeout: number;
    readonly auditDir: string | undefined;
    readonly agent: StageInput["profile"]["agent"];
  };
}

// ---------------------------------------------------------------------------
// EffectStage
// ---------------------------------------------------------------------------

export function createHostExecStage(): EffectStage<
  HostExecSetupService | HostExecBrokerService
> {
  return {
    kind: "effect",
    name: "HostExecStage",

    run(
      input: StageInput,
    ): Effect.Effect<
      EffectStageResult,
      unknown,
      Scope.Scope | HostExecSetupService | HostExecBrokerService
    > {
      const plan = planHostExec(input);
      if (plan === null) {
        return Effect.succeed({});
      }
      return runHostExec(plan, input);
    },
  };
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

/** Internal rule: route `nas hook` to the host via HostExec. */
const NAS_HOOK_RULE: HostExecRule = {
  id: "__nas_hook",
  match: { argv0: "nas", argRegex: "^hook\\b" },
  cwd: { mode: "any", allow: [] },
  env: {},
  inheritEnv: {
    mode: "minimal",
    keys: ["NAS_SESSION_ID", "NAS_SESSION_STORE_DIR", "XDG_RUNTIME_DIR"],
  },
  approval: "allow",
  fallback: "container",
};

export function planHostExec(input: StageInput): HostExecPlan | null {
  const config =
    input.profile.hostexec ?? structuredClone(DEFAULT_HOSTEXEC_CONFIG);
  config.rules = [...config.rules, NAS_HOOK_RULE];
  const workspace = resolveWorkspace(input);

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

  const directories: HostExecPlan["directories"] = [
    { path: runtimePaths.runtimeDir, mode: 0o755 },
    { path: runtimePaths.sessionsDir, mode: 0o700 },
    { path: runtimePaths.pendingDir, mode: 0o700 },
    { path: runtimePaths.brokersDir, mode: 0o700 },
    { path: runtimePaths.wrappersDir, mode: 0o700 },
    { path: wrapperBinDir, mode: 0o755 },
    { path: sessionTmpDir, mode: 0o700 },
  ];

  const files: HostExecPlan["files"] = [
    { path: wrapperScript, content: buildWrapperScript(), mode: 0o755 },
  ];

  const symlinks: Array<{ target: string; path: string }> = [];
  const argv0Names = new Set(
    config.rules
      .map((rule) => rule.match.argv0)
      .filter(isBareCommandHostExecArgv0),
  );
  for (const argv0 of argv0Names) {
    symlinks.push({
      target: "hostexec-wrapper.py",
      path: path.join(wrapperBinDir, argv0),
    });
  }

  const relativeArgv0s = [
    ...new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter(isRelativeHostExecArgv0),
    ),
  ];

  const absoluteArgv0s = [
    ...new Set(
      config.rules
        .map((rule) => rule.match.argv0)
        .filter((argv0) => path.isAbsolute(argv0)),
    ),
  ];

  const workDir = workspace.workDir;
  const workspaceRoot = workspace.mountDir ?? workspace.workDir;
  const mounts: MountSpec[] = [];
  const dockerArgs = [
    "-v",
    addMount(mounts, wrapperBinDir, WRAPPER_DIR, true),
    "-v",
    addMount(mounts, runtimePaths.brokersDir, runtimePaths.brokersDir),
    "-v",
    addMount(mounts, sessionTmpDir, containerSessionTmp),
    ...relativeArgv0s.flatMap((argv0) => {
      const target = path.resolve(workDir, argv0);
      return ["-v", addMount(mounts, wrapperScript, target, true)];
    }),
    ...absoluteArgv0s.flatMap((argv0) => [
      "-v",
      addMount(mounts, wrapperScript, argv0, true),
    ]),
  ];

  return {
    directories,
    files,
    symlinks,
    mounts,
    dockerArgs,
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
      hostexec: {
        runtimeDir: runtimePaths.runtimeDir,
        brokerSocket: socketPath,
        sessionTmpDir: containerSessionTmp,
      } satisfies HostExecState,
    },
    broker: {
      socketPath,
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
  };
}

// ---------------------------------------------------------------------------
// Effect runner
// ---------------------------------------------------------------------------

function runHostExec(
  plan: HostExecPlan,
  input: StageInput,
): Effect.Effect<
  EffectStageResult,
  unknown,
  Scope.Scope | HostExecSetupService | HostExecBrokerService
> {
  return Effect.gen(function* () {
    const setupService = yield* HostExecSetupService;
    const brokerService = yield* HostExecBrokerService;
    const container = buildContainerState(input, plan);
    const legacy = renderLegacyContainerState(container);

    yield* setupService.prepareWorkspace({
      directories: plan.directories,
      files: plan.files,
      symlinks: plan.symlinks,
    });

    const spec = plan.broker;

    yield* Effect.acquireRelease(
      brokerService.start({
        paths: spec.paths,
        sessionId: spec.sessionId,
        socketPath: spec.socketPath,
        profileName: spec.profileName,
        workspaceRoot: spec.workspaceRoot,
        sessionTmpDir: spec.sessionTmpDir,
        hostexec: spec.hostexec,
        notify: spec.notify,
        uiEnabled: spec.uiEnabled,
        uiPort: spec.uiPort,
        uiIdleTimeout: spec.uiIdleTimeout,
        auditDir: spec.auditDir,
        agent: spec.agent,
      }),
      (handle) => handle.close(),
    );

    return {
      ...plan.outputOverrides,
      container,
      dockerArgs: legacy.dockerArgs,
      envVars: legacy.envVars,
    };
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function resolveHostExecRuntimePathsPure(
  host: HostEnv,
): HostExecRuntimePaths {
  const xdg = host.env.get("XDG_RUNTIME_DIR");
  let runtimeDir: string;
  if (xdg && xdg.trim().length > 0) {
    runtimeDir = path.join(xdg, "nas", "hostexec");
  } else {
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

function resolveWorkspace(input: StageInput): WorkspaceState {
  return (
    input.prior.workspace ?? {
      workDir: input.prior.workDir,
      imageName: input.prior.imageName,
      ...(input.prior.mountDir ? { mountDir: input.prior.mountDir } : {}),
    }
  );
}

function buildContainerState(
  input: StageInput,
  plan: HostExecPlan,
): ContainerPlan {
  const workspace = resolveWorkspace(input);
  return mergeContainerPlan(resolveContainerBase(input, workspace), {
    mounts: plan.mounts,
    env: { static: plan.envVars },
  });
}

function resolveContainerBase(
  input: StageInput,
  workspace: WorkspaceState,
): ContainerPlan {
  if (input.prior.container) {
    return input.prior.container;
  }

  let workDir = workspace.workDir;
  const mounts: MountSpec[] = [];
  const extraRunArgs: string[] = [];
  for (let i = 0; i < input.prior.dockerArgs.length; i += 1) {
    const arg = input.prior.dockerArgs[i];
    if (arg === "-v" && i + 1 < input.prior.dockerArgs.length) {
      const mountArg = input.prior.dockerArgs[i + 1];
      if (mountArg !== undefined) {
        mounts.push(parseMountSpec(mountArg));
      }
      i += 1;
      continue;
    }
    if (arg === "-w" && i + 1 < input.prior.dockerArgs.length) {
      const workDirArg = input.prior.dockerArgs[i + 1];
      if (workDirArg !== undefined) {
        workDir = workDirArg;
      }
      i += 1;
      continue;
    }
    extraRunArgs.push(arg);
  }

  return mergeContainerPlan(emptyContainerPlan(workspace.imageName, workDir), {
    mounts,
    env: { static: { ...input.prior.envVars } },
    extraRunArgs,
    command: {
      agentCommand: [...input.prior.agentCommand],
      extraArgs: [],
    },
  });
}

function renderLegacyContainerState(container: ContainerPlan): {
  readonly dockerArgs: readonly string[];
  readonly envVars: Readonly<Record<string, string>>;
} {
  const dockerArgs = [
    ...container.mounts.flatMap((mount) => [
      "-v",
      `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`,
    ]),
    "-w",
    container.workDir,
    ...container.extraRunArgs,
  ];

  const envVars: Record<string, string> = { ...container.env.static };
  if (container.env.dynamicOps.length > 0) {
    envVars.NAS_ENV_OPS = encodeDynamicEnvOps(container.env.dynamicOps);
  }

  return { dockerArgs, envVars };
}

function addMount(
  mounts: MountSpec[],
  source: string,
  target: string,
  readOnly = false,
): string {
  mounts.push(
    readOnly ? { source, target, readOnly: true } : { source, target },
  );
  return `${source}:${target}${readOnly ? ":ro" : ""}`;
}

function parseMountSpec(rawMount: string): MountSpec {
  const readOnly = rawMount.endsWith(":ro");
  const mountValue = readOnly ? rawMount.slice(0, -3) : rawMount;
  const separatorIndex = mountValue.indexOf(":");
  if (separatorIndex === -1) {
    throw new Error(`[nas] Invalid mount arg: ${rawMount}`);
  }
  const source = mountValue.slice(0, separatorIndex);
  const target = mountValue.slice(separatorIndex + 1);
  return readOnly ? { source, target, readOnly: true } : { source, target };
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
    stdout_b64 = response.get("stdout", "")
    stderr_b64 = response.get("stderr", "")
    if stdout_b64:
        sys.stdout.buffer.write(base64.b64decode(stdout_b64))
        sys.stdout.flush()
    if stderr_b64:
        sys.stderr.buffer.write(base64.b64decode(stderr_b64))
        sys.stderr.flush()
    return int(response.get("exitCode", 0))


if __name__ == "__main__":
    raise SystemExit(main())
`;
}
