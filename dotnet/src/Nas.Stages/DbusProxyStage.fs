namespace Nas.Stages

open System
open System.Diagnostics
open System.IO
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Pipeline
open Nas.Dbus

type DbusProxyStage() =
    let mutable sessionDir: string option = None
    let mutable proxyProcess: Process option = None

    let resolveProxyBinary () =
        task {
            try
                let psi = ProcessStartInfo("which", "xdg-dbus-proxy", RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true)
                use p = Process.Start(psi)
                let! output = p.StandardOutput.ReadToEndAsync()
                do! p.WaitForExitAsync()
                let binary = output.Trim()
                return if p.ExitCode = 0 && not (String.IsNullOrEmpty(binary)) then Some binary else None
            with _ -> return None
        }

    let resolveSourceAddress (configured: string option) =
        match configured with
        | Some addr when not (String.IsNullOrWhiteSpace(addr)) -> Some addr
        | _ -> DbusRegistry.getDefaultBusAddress ()

    let validateSourceAddress (address: string) =
        if not (address.StartsWith("unix:path=")) then
            failwith $"[nas] Unsupported dbus source address: {address}. Only unix:path=... is supported"

    let ensureSourceReachable (address: string) =
        let socketPath = address.Substring("unix:path=".Length)
        if not (File.Exists(socketPath)) then
            failwith $"[nas] DBus session bus socket not found: {socketPath}"

    let buildProxyArgs (sourceAddress: string) (socketPath: string) (session: Config.DbusSessionConfig) =
        let args = [ sourceAddress; socketPath; "--filter" ]
        let seeArgs = session.See |> List.map (fun n -> $"--see={n}")
        let talkArgs = session.Talk |> List.map (fun n -> $"--talk={n}")
        let ownArgs = session.Own |> List.map (fun n -> $"--own={n}")
        let callArgs = session.Calls |> List.map (fun r -> $"--call={r.Rule}")
        let broadcastArgs = session.Broadcasts |> List.map (fun r -> $"--broadcast={r.Rule}")
        args @ seeArgs @ talkArgs @ ownArgs @ callArgs @ broadcastArgs

    let waitForSocket (socketPath: string) (proc: Process) (timeoutMs: int) =
        task {
            let started = DateTime.UtcNow
            while (DateTime.UtcNow - started).TotalMilliseconds < float timeoutMs do
                if File.Exists(socketPath) then return ()
                if proc.HasExited then
                    failwith $"[nas] xdg-dbus-proxy exited before creating socket (exit code {proc.ExitCode})"
                do! Task.Delay(50)
            failwith $"[nas] Timed out waiting for xdg-dbus-proxy socket: {socketPath}"
        }

    interface IStage with
        member _.Name = "DbusProxy"

        member this.Execute(ctx) = task {
            if not ctx.Profile.Dbus.Session.Enable then return ctx
            else
                let skip reason =
                    Log.warn reason
                    { ctx with DbusProxyEnabled = false }

                let! proxyBin = resolveProxyBinary ()
                match proxyBin with
                | None ->
                    return skip "[nas] xdg-dbus-proxy not found on PATH — skipping D-Bus proxy"
                | Some binary ->
                    let sourceAddr = resolveSourceAddress ctx.Profile.Dbus.Session.SourceAddress
                    match sourceAddr with
                    | None ->
                        return skip "[nas] DBUS_SESSION_BUS_ADDRESS not set and default bus not found — skipping D-Bus proxy"
                    | Some addr ->
                        let preconditionOk =
                            try
                                validateSourceAddress addr
                                ensureSourceReachable addr
                                true
                            with ex ->
                                Log.warn $"[nas] D-Bus proxy precondition failed — skipping: {ex.Message}"
                                false

                        if not preconditionOk then
                            return { ctx with DbusProxyEnabled = false }
                        else
                            try
                                let rtDir = Nas.Core.Lib.RuntimeRegistry.getRuntimeDir ()
                                let sessDir = DbusRegistry.ensureSessionDir rtDir ctx.SessionId
                                sessionDir <- Some sessDir
                                let socketPath = DbusRegistry.getSocketPath sessDir

                                let commandArgs = buildProxyArgs addr socketPath ctx.Profile.Dbus.Session
                                let psi = ProcessStartInfo(binary, commandArgs |> String.concat " ",
                                                           RedirectStandardOutput = true, RedirectStandardError = true,
                                                           UseShellExecute = false, CreateNoWindow = true)
                                let proc = Process.Start(psi)
                                proxyProcess <- Some proc

                                let pidFile = Path.Combine(sessDir, "pid")
                                File.WriteAllText(pidFile, $"{proc.Id}\n")

                                do! waitForSocket socketPath proc 5000

                                return { ctx with
                                            DbusProxyEnabled = true
                                            DbusSessionRuntimeDir = Some sessDir
                                            DbusSessionSocket = Some socketPath }
                            with ex ->
                                do! (this :> IStage).Teardown(ctx)
                                return raise ex
        }

        member _.Teardown(_ctx) = task {
            match proxyProcess with
            | Some proc ->
                try proc.Kill(true) with _ -> ()
                try proc.WaitForExit(3000) |> ignore with _ -> ()
                proxyProcess <- None
            | None -> ()
            match sessionDir with
            | Some dir ->
                try if Directory.Exists(dir) then Directory.Delete(dir, true) with _ -> ()
                sessionDir <- None
            | None -> ()
        }
