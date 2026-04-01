namespace Nas.Network

open System
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

/// Session-level network broker that handles authorization decisions
module NetworkBroker =
    let private jsonOptions =
        let opts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)
        opts

    /// Broker state
    type BrokerState =
        { SessionId: string
          Config: NetworkConfig
          RuntimeDir: string
          AuditDir: string
          AllowCache: TtlLruCache<string, Decision>
          DenyCache: TtlLruCache<string, Decision>
          mutable IsRunning: bool }

    /// Create a new broker state
    let create (sessionId: string) (config: NetworkConfig) (runtimeDir: string) (auditDir: string) =
        { SessionId = sessionId
          Config = config
          RuntimeDir = runtimeDir
          AuditDir = auditDir
          AllowCache = TtlLruCache(1000, TimeSpan.FromHours(1.0))
          DenyCache = TtlLruCache(1000, TimeSpan.FromSeconds(30.0))
          IsRunning = false }

    /// Evaluate an authorization request
    let evaluate (state: BrokerState) (req: Protocol.AuthorizeRequest) : Protocol.DecisionResponse =
        // Check allow cache
        let cacheKeyOnce = Protocol.cacheKey req.Target ApprovalScope.Once
        let cacheKeyHp = Protocol.cacheKey req.Target ApprovalScope.HostPort
        let cacheKeyHost = Protocol.cacheKey req.Target ApprovalScope.Host

        match state.AllowCache.TryGet(cacheKeyHost) with
        | Some _ ->
            { Protocol.DecisionResponse.Version = 1
              Type = "decision"
              RequestId = req.RequestId
              Decision = Decision.Allow
              Scope = Some ApprovalScope.Host
              Reason = "cached"
              Message = None }
        | None ->

        match state.AllowCache.TryGet(cacheKeyHp) with
        | Some _ ->
            { Protocol.DecisionResponse.Version = 1; Type = "decision"; RequestId = req.RequestId
              Decision = Decision.Allow; Scope = Some ApprovalScope.HostPort
              Reason = "cached"; Message = None }
        | None ->

        // Check deny cache
        match state.DenyCache.TryGet(cacheKeyOnce) with
        | Some _ ->
            { Protocol.DecisionResponse.Version = 1; Type = "decision"; RequestId = req.RequestId
              Decision = Decision.Deny; Scope = None
              Reason = "cached-deny"; Message = None }
        | None ->

        // Check allowlist
        if Protocol.isAllowedByList req.Target state.Config.Allowlist then
            // Cache the allow
            state.AllowCache.Set(cacheKeyHost, Decision.Allow)
            { Protocol.DecisionResponse.Version = 1; Type = "decision"; RequestId = req.RequestId
              Decision = Decision.Allow; Scope = Some ApprovalScope.Host
              Reason = "allowlist"; Message = None }

        // Check denylist
        elif Protocol.isDeniedByList req.Target state.Config.Prompt.Denylist then
            state.DenyCache.Set(cacheKeyOnce, Decision.Deny)
            { Protocol.DecisionResponse.Version = 1; Type = "decision"; RequestId = req.RequestId
              Decision = Decision.Deny; Scope = None
              Reason = "denylist"; Message = None }

        // If prompt not enabled, deny
        elif not state.Config.Prompt.Enable then
            { Protocol.DecisionResponse.Version = 1; Type = "decision"; RequestId = req.RequestId
              Decision = Decision.Deny; Scope = None
              Reason = "no-prompt"; Message = Some "Network access not allowed and prompt disabled" }

        else
            // Create pending entry and wait for user decision
            let pending: Protocol.PendingEntry =
                { RequestId = req.RequestId
                  SessionId = req.SessionId
                  Target = req.Target
                  Method = req.Method
                  RequestKind = req.RequestKind
                  ObservedAt = req.ObservedAt }
            NetworkRegistry.writePending state.RuntimeDir pending |> ignore

            // Send notification
            NetworkNotify.notifyPending req.Target state.SessionId |> ignore

            // Return pending (caller needs to wait for approval via registry)
            { Protocol.DecisionResponse.Version = 1; Type = "decision"; RequestId = req.RequestId
              Decision = Decision.Deny; Scope = None
              Reason = "pending"; Message = Some "Awaiting user approval" }

    /// Apply a user approval decision
    let applyApproval (state: BrokerState) (requestId: string) (decision: Decision) (scope: ApprovalScope) =
        // Remove pending entry
        NetworkRegistry.removePending state.RuntimeDir state.SessionId requestId

        // Cache the decision
        match decision with
        | Decision.Allow ->
            Protocol.cacheKey { Host = ""; Port = 0 } scope |> ignore
        | Decision.Deny ->
            ()

        // Audit log
        let entry: AuditLogEntry =
            { Id = Guid.NewGuid().ToString()
              Timestamp = DateTimeOffset.UtcNow
              Domain = AuditDomain.Network
              SessionId = state.SessionId
              RequestId = requestId
              Decision = (match decision with Decision.Allow -> "allow" | Decision.Deny -> "deny")
              Reason = "user-approval"
              Scope = Some (scope.ToConfigString())
              Target = None
              Command = None }
        AuditStore.append state.AuditDir entry

    /// Start the broker, listening on a Unix socket
    let start (state: BrokerState) (socketPath: string) (ct: CancellationToken) =
        task {
            FsUtils.ensureDir (Path.GetDirectoryName(socketPath))
            if File.Exists(socketPath) then
                File.Delete(socketPath)

            let endpoint = UnixDomainSocketEndPoint(socketPath)
            use listener = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            listener.Bind(endpoint)
            listener.Listen(10)
            state.IsRunning <- true

            Log.info $"Network broker listening on {socketPath}"

            while state.IsRunning && not ct.IsCancellationRequested do
                try
                    let! client = listener.AcceptAsync(ct)
                    // Handle connection in background
                    Task.Run(fun () ->
                        task {
                            use client = client
                            use stream = new NetworkStream(client)
                            use reader = new StreamReader(stream, Encoding.UTF8)
                            use writer = new StreamWriter(stream, Encoding.UTF8, AutoFlush = true)

                            let! line = reader.ReadLineAsync()
                            if not (isNull line) then
                                try
                                    let req = JsonSerializer.Deserialize<Protocol.AuthorizeRequest>(line, jsonOptions)
                                    let resp = evaluate state req
                                    let respJson = JsonSerializer.Serialize(resp, jsonOptions)
                                    do! writer.WriteLineAsync(respJson)
                                with
                                | ex -> Log.warn $"Broker request error: {ex.Message}"
                        }, ct)
                    |> ignore
                with
                | :? OperationCanceledException -> ()
                | ex -> Log.warn $"Broker accept error: {ex.Message}"
        }

    /// Stop the broker
    let stop (state: BrokerState) =
        state.IsRunning <- false
