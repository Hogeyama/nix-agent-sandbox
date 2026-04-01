namespace Nas.Stages

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Config
open Nas.Core.Lib
open Nas.Core.Pipeline
open Nas.HostExec
open Nas.Audit

[<AutoOpen>]
module private HostExecConstants =
    let [<Literal>] WrapperDir = "/opt/nas/hostexec/bin"
    let [<Literal>] SessionTmpRoot = "/tmp/nas-hostexec"

type HostExecStage() =
    let mutable runtimeDir: string option = None
    let mutable brokerState: HostExecBroker.BrokerState option = None
    let mutable brokerCts: CancellationTokenSource option = None
    let mutable wrapperRoot: string option = None

    let buildWrapperScript () =
        """#!/usr/bin/env python3
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
        sock.sendall((json.dumps(payload) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
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
"""

    let isBareCommand (argv0: string) =
        not (argv0.Contains('/')) && not (argv0.Contains('\\'))

    let isRelativeArgv0 (argv0: string) =
        not (Path.IsPathRooted(argv0)) && (argv0.Contains('/') || argv0.Contains('\\'))

    interface IStage with
        member _.Name = "HostExec"

        member _.Execute(ctx) = task {
            let config = ctx.Profile.HostExec |> Option.defaultValue HostExecConfig.Default
            if config.Rules.IsEmpty then return ctx
            else
                let rtDir = HostExecRegistry.getRuntimeDir ()
                runtimeDir <- Some rtDir
                FsUtils.ensureDir rtDir

                let brokersDir = Path.Combine(rtDir, "brokers")
                FsUtils.ensureDir brokersDir
                let socketPath = Path.Combine(brokersDir, $"{ctx.SessionId}.sock")

                let wrappersDir = Path.Combine(rtDir, "wrappers")
                let wrapRoot = Path.Combine(wrappersDir, ctx.SessionId)
                let wrapBinDir = Path.Combine(wrapRoot, "bin")
                let wrapperScript = Path.Combine(wrapBinDir, "hostexec-wrapper.py")
                let sessionTmpDir = Path.Combine(wrapRoot, "tmp")
                wrapperRoot <- Some wrapRoot

                FsUtils.ensureDir wrapBinDir
                FsUtils.ensureDir sessionTmpDir
                File.WriteAllText(wrapperScript, buildWrapperScript ())
                // Make executable
                try
                    let psi = System.Diagnostics.ProcessStartInfo("chmod", $"755 {wrapperScript}", UseShellExecute = false, CreateNoWindow = true)
                    use p = System.Diagnostics.Process.Start(psi)
                    p.WaitForExit()
                with _ -> ()

                // Create symlinks for bare command argv0s
                let bareNames =
                    config.Rules
                    |> List.map (fun r -> r.Match.Argv0)
                    |> List.filter isBareCommand
                    |> List.distinct
                for argv0 in bareNames do
                    let linkPath = Path.Combine(wrapBinDir, argv0)
                    try File.Delete(linkPath) with _ -> ()
                    File.CreateSymbolicLink(linkPath, "hostexec-wrapper.py") |> ignore

                // Handle relative argv0s
                let relativeArgv0s =
                    config.Rules
                    |> List.map (fun r -> r.Match.Argv0)
                    |> List.filter isRelativeArgv0
                    |> List.distinct
                    |> List.filter (fun argv0 ->
                        let target = Path.Combine(ctx.WorkDir, argv0)
                        try File.Exists(target) with _ -> false)

                // Start broker
                let auditDir = AuditStore.getAuditDir ()
                let state = HostExecBroker.create ctx.SessionId config (ctx.MountDir |> Option.defaultValue ctx.WorkDir) (Some sessionTmpDir) rtDir auditDir
                brokerState <- Some state
                let cts = new CancellationTokenSource()
                brokerCts <- Some cts
                let _brokerTask = HostExecBroker.start state socketPath cts.Token
                do! Task.Delay(100) // brief wait for broker to start listening

                // Write session registry
                let entry: SessionEntry =
                    { SessionId = ctx.SessionId
                      BrokerSocket = socketPath
                      Rules = config.Rules |> List.map (fun r -> r.Id)
                      CreatedAt = DateTimeOffset.UtcNow }
                HostExecRegistry.writeSession rtDir entry |> ignore

                // Build docker args for mounts
                let mountArgs =
                    [ "-v"; $"{wrapBinDir}:{WrapperDir}:ro"
                      "-v"; $"{brokersDir}:{brokersDir}"
                      "-v"; $"{sessionTmpDir}:{Path.Combine(SessionTmpRoot, ctx.SessionId)}" ]
                let relMountArgs =
                    relativeArgv0s |> List.collect (fun argv0 ->
                        [ "-v"; $"{wrapperScript}:{Path.GetFullPath(Path.Combine(ctx.WorkDir, argv0))}:ro" ])

                // Build env vars
                let defaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
                let currentPath = ctx.EnvVars |> Map.tryFind "PATH" |> Option.defaultValue defaultPath
                let newEnv =
                    ctx.EnvVars
                    |> Map.add "PATH" $"{WrapperDir}:{currentPath}"
                    |> Map.add "NAS_HOSTEXEC_SOCKET" socketPath
                    |> Map.add "NAS_HOSTEXEC_WRAPPER_DIR" WrapperDir
                    |> Map.add "NAS_HOSTEXEC_SESSION_ID" ctx.SessionId
                    |> Map.add "NAS_HOSTEXEC_SESSION_TMP" (Path.Combine(SessionTmpRoot, ctx.SessionId))

                return { ctx with
                            DockerArgs = ctx.DockerArgs @ mountArgs @ relMountArgs
                            EnvVars = newEnv
                            HostExecRuntimeDir = Some rtDir
                            HostExecBrokerSocket = Some socketPath
                            HostExecSessionTmpDir = Some (Path.Combine(SessionTmpRoot, ctx.SessionId)) }
        }

        member _.Teardown(ctx) = task {
            match brokerCts with
            | Some cts ->
                cts.Cancel()
                cts.Dispose()
                brokerCts <- None
            | None -> ()
            match brokerState with
            | Some state ->
                HostExecBroker.stop state
                brokerState <- None
            | None -> ()
            match runtimeDir with
            | Some dir ->
                try HostExecRegistry.removeSession dir ctx.SessionId with ex ->
                    Log.info $"[nas] HostExec teardown: failed to remove session registry: {ex.Message}"
            | None -> ()
            match wrapperRoot with
            | Some dir ->
                try if Directory.Exists(dir) then Directory.Delete(dir, true) with ex ->
                    Log.info $"[nas] HostExec teardown: failed to remove wrapper root: {ex.Message}"
                wrapperRoot <- None
            | None -> ()
        }
