namespace Nas.HostExec

open System
open System.Diagnostics
open System.IO
open System.Net
open System.Net.Sockets
open System.Text
open System.Text.Json
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Config
open Nas.Core.Lib
open Nas.Audit

module HostExecBroker =
    let private jsonOpts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)

    type BrokerState =
        { SessionId: string; Config: HostExecConfig; WorkDir: string; SessionTmpDir: string option
          RuntimeDir: string; AuditDir: string; Secrets: Map<string, string>; mutable IsRunning: bool }

    let create (sid: string) (config: HostExecConfig) (workDir: string) (tmpDir: string option) (runtimeDir: string) (auditDir: string) =
        { SessionId = sid; Config = config; WorkDir = workDir; SessionTmpDir = tmpDir
          RuntimeDir = runtimeDir; AuditDir = auditDir; Secrets = SecretStore.resolveAll config.Secrets; IsRunning = false }

    let private resolveEnv (state: BrokerState) (rule: HostExecRule) =
        let mutable env = Map.empty
        for kv in rule.Env do
            let v = if kv.Value.StartsWith("$") then state.Secrets |> Map.tryFind (kv.Value.Substring(1)) |> Option.defaultValue kv.Value else kv.Value
            env <- env |> Map.add kv.Key v
        match rule.InheritEnv.Mode with
        | "minimal" -> for key in rule.InheritEnv.Keys do let v = Environment.GetEnvironmentVariable(key) in if not (isNull v) then env <- env |> Map.add key v
        | _ -> ()
        env

    let private executeOnHost (argv0: string) (args: string list) (cwd: string) (env: Map<string, string>) (ct: CancellationToken) =
        task {
            let psi = ProcessStartInfo(argv0, args |> String.concat " ", WorkingDirectory = cwd, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true)
            for kv in env do psi.Environment.[kv.Key] <- kv.Value
            use p = Process.Start(psi)
            let! stdout = p.StandardOutput.ReadToEndAsync(ct)
            let! stderr = p.StandardError.ReadToEndAsync(ct)
            do! p.WaitForExitAsync(ct)
            return (p.ExitCode, stdout, stderr)
        }

    let private mkAuditEntry (state: BrokerState) (req: ExecuteRequest) (dec: string) (reason: string) =
        { AuditLogEntry.Id = Guid.NewGuid().ToString(); Timestamp = DateTimeOffset.UtcNow; Domain = AuditDomain.HostExec
          SessionId = state.SessionId; RequestId = req.RequestId; Decision = dec; Reason = reason
          Scope = None; Target = None; Command = Some(sprintf "%s %s" req.Argv0 (req.Args |> String.concat " ")) }

    let handleRequest (state: BrokerState) (req: ExecuteRequest) (ct: CancellationToken) =
        task {
            match Match.findMatchingRule state.Config.Rules req.Argv0 req.Args req.Cwd state.WorkDir state.SessionTmpDir with
            | Some rule ->
                match rule.Approval with
                | HostExecApproval.Allow ->
                    let env = resolveEnv state rule
                    let! (exitCode, stdout, stderr) = executeOnHost req.Argv0 req.Args req.Cwd env ct
                    AuditStore.append state.AuditDir (mkAuditEntry state req "allow" (sprintf "rule:%s" rule.Id))
                    return { Version = 1; Type = "response"; Kind = BrokerResponseKind.Result; RequestId = req.RequestId
                             ExitCode = Some exitCode; Stdout = Some stdout; Stderr = Some stderr; Message = None }
                | HostExecApproval.Deny ->
                    AuditStore.append state.AuditDir (mkAuditEntry state req "deny" (sprintf "rule:%s" rule.Id))
                    return { Version = 1; Type = "response"; Kind = BrokerResponseKind.Error; RequestId = req.RequestId
                             ExitCode = None; Stdout = None; Stderr = None; Message = Some "Denied by rule" }
                | HostExecApproval.Prompt ->
                    let pending: PendingEntry = { RequestId = req.RequestId; SessionId = state.SessionId; Argv0 = req.Argv0; Args = req.Args; Cwd = req.Cwd; RuleId = rule.Id; ObservedAt = DateTimeOffset.UtcNow }
                    HostExecRegistry.writePending state.RuntimeDir pending |> ignore
                    HostExecNotify.notifyPending req.Argv0 state.SessionId |> ignore
                    return { Version = 1; Type = "response"; Kind = BrokerResponseKind.Pending; RequestId = req.RequestId; ExitCode = None; Stdout = None; Stderr = None; Message = Some "Awaiting user approval" }
            | None ->
                return { Version = 1; Type = "response"; Kind = BrokerResponseKind.Error; RequestId = req.RequestId; ExitCode = None; Stdout = None; Stderr = None; Message = Some "No matching rule" }
        }

    let start (state: BrokerState) (socketPath: string) (ct: CancellationToken) =
        task {
            FsUtils.ensureDir (Path.GetDirectoryName(socketPath))
            if File.Exists(socketPath) then File.Delete(socketPath)
            let endpoint = UnixDomainSocketEndPoint(socketPath)
            use listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            listener.Bind(endpoint); listener.Listen(10); state.IsRunning <- true
            Log.info $"HostExec broker listening on {socketPath}"
            while state.IsRunning && not ct.IsCancellationRequested do
                try
                    let! client = listener.AcceptAsync(ct)
                    let _ = Task.Run<unit>((fun () -> task {
                        use client = client
                        use stream = new NetworkStream(client)
                        use reader = new StreamReader(stream, Encoding.UTF8)
                        use writer = new StreamWriter(stream, Encoding.UTF8, AutoFlush = true)
                        let! line = reader.ReadLineAsync()
                        if not (isNull line) then
                            try
                                let req = JsonSerializer.Deserialize<ExecuteRequest>(line, jsonOpts)
                                let! resp = handleRequest state req ct
                                do! writer.WriteLineAsync(JsonSerializer.Serialize(resp, jsonOpts))
                            with ex -> Log.warn $"HostExec broker error: {ex.Message}"
                    }), ct)
                    ()
                with :? OperationCanceledException -> () | ex -> Log.warn $"HostExec accept error: {ex.Message}"
        }

    let stop (state: BrokerState) = state.IsRunning <- false
