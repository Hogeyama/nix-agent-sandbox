namespace Nas.Stages

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Lib
open Nas.Core.Pipeline
open Nas.Docker
open Nas.Network
open Nas.Audit

[<AutoOpen>]
module private ProxyConstants =
    let [<Literal>] EnvoyImage = "envoyproxy/envoy:v1.37.1"
    let [<Literal>] EnvoyContainerName = "nas-envoy-shared"
    let [<Literal>] EnvoyAlias = "nas-envoy"
    let [<Literal>] EnvoyProxyPort = 15001
    let [<Literal>] EnvoyReadyTimeoutMs = 15_000

type ProxyStage() =
    let ct = CancellationToken.None
    let mutable runtimeDir: string option = None
    let mutable sessionNetworkName: string option = None
    let mutable dindContainerName: string option = None
    let mutable brokerState: NetworkBroker.BrokerState option = None
    let mutable brokerCts: CancellationTokenSource option = None

    let isProxyEnabled (ctx: ExecutionContext) =
        not ctx.Profile.Network.Allowlist.IsEmpty || ctx.Profile.Network.Prompt.Enable

    let parseDindContainerName (envVars: Map<string, string>) =
        match envVars |> Map.tryFind "NAS_DIND_CONTAINER_NAME" with
        | Some name when not (String.IsNullOrWhiteSpace(name)) -> Some name
        | _ ->
            match envVars |> Map.tryFind "DOCKER_HOST" with
            | Some host ->
                let m = System.Text.RegularExpressions.Regex.Match(host, @"^tcp://([^:]+):\d+$")
                if m.Success then Some m.Groups.[1].Value else None
            | None -> None

    let replaceNetwork (dockerArgs: string list) (newNetwork: string) =
        let args = dockerArgs |> Array.ofList
        let idx = args |> Array.tryFindIndex (fun a -> a = "--network")
        match idx with
        | Some i when i + 1 < args.Length ->
            args.[i + 1] <- newNetwork
            args |> Array.toList
        | _ -> dockerArgs @ [ "--network"; newNetwork ]

    let ensureSessionNetwork (netName: string) =
        task {
            try
                do! DockerClient.networkCreateWithLabels netName
                        [ NasResources.ManagedLabel, NasResources.ManagedValue
                          NasResources.KindLabel, "session-network" ]
                        true ct
            with _ -> () // already exists
        }

    let waitForEnvoyReady (envoyName: string) =
        task {
            let started = DateTime.UtcNow
            let mutable ready = false
            while not ready && (DateTime.UtcNow - started).TotalMilliseconds < float EnvoyReadyTimeoutMs do
                let! running = DockerClient.isRunning envoyName ct
                if running then ready <- true
                else do! Task.Delay(200)
            if not ready then
                let! logText = DockerClient.logs envoyName 50 ct
                failwith $"Envoy sidecar failed to start:\n{logText}"
        }

    let ensureSharedEnvoy (rtDir: string) =
        task {
            let! running = DockerClient.isRunning EnvoyContainerName ct
            if not running then
                let! exists = DockerClient.containerExists EnvoyContainerName ct
                if exists then
                    try do! DockerClient.rm EnvoyContainerName ct
                    with ex -> Log.info $"[nas] Proxy: failed to remove stale envoy container: {ex.Message}"

                let labels = [ NasResources.ManagedLabel, NasResources.ManagedValue; NasResources.KindLabel, "envoy" ]
                let labelArgs = labels |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
                let mountArgs = [ "-v"; $"{rtDir}:/nas-network:rw" ]
                let! _ = DockerClient.runDetached EnvoyImage EnvoyContainerName (labelArgs @ mountArgs) Map.empty [ "-c"; "/nas-network/envoy.yaml"; "--log-level"; "info" ] ct
                do! waitForEnvoyReady EnvoyContainerName
        }

    let renderEnvoyConfig (rtDir: string) =
        // Write a basic envoy config template for the proxy
        let configPath = Path.Combine(rtDir, "envoy.yaml")
        let envoyTemplatePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "envoy.template.yaml")
        if File.Exists(envoyTemplatePath) then
            let content = File.ReadAllText(envoyTemplatePath)
            File.WriteAllText(configPath, content)
        // If no template available, the config should already be present from a prior build stage

    interface IStage with
        member _.Name = "Proxy"

        member _.Execute(ctx) = task {
            if not (isProxyEnabled ctx) then
                Log.info "[nas] Proxy: skipped (allowlist/prompt disabled)"
                return ctx
            else
                let rtDir = NetworkRegistry.getRuntimeDir ()
                runtimeDir <- Some rtDir
                FsUtils.ensureDir rtDir
                NetworkRegistry.gc rtDir
                renderEnvoyConfig rtDir

                let brokersDir = Path.Combine(rtDir, "brokers")
                FsUtils.ensureDir brokersDir
                let brokerSocket = Path.Combine(brokersDir, $"{ctx.SessionId}.sock")

                let state = NetworkBroker.create ctx.SessionId ctx.Profile.Network rtDir (AuditStore.getAuditDir ())
                brokerState <- Some state
                let cts = new CancellationTokenSource()
                brokerCts <- Some cts
                let _brokerTask = NetworkBroker.start state brokerSocket cts.Token
                do! Task.Delay(100)

                let token = ctx.NetworkPromptToken |> Option.defaultWith Protocol.generateToken

                let entry: Protocol.SessionEntry =
                    { SessionId = ctx.SessionId
                      BrokerSocket = brokerSocket
                      ProxyEndpoint = ""
                      Token = Protocol.hashToken token
                      CreatedAt = DateTimeOffset.UtcNow }
                NetworkRegistry.writeSession rtDir entry |> ignore

                do! ensureSharedEnvoy rtDir

                let netName = $"nas-session-net-{ctx.SessionId}"
                sessionNetworkName <- Some netName
                do! ensureSessionNetwork netName
                try
                    do! DockerClient.networkConnectWithAliases netName EnvoyContainerName [ EnvoyAlias ] ct
                with ex ->
                    Log.info $"[nas] Proxy: failed to connect envoy to network: {ex.Message}"

                dindContainerName <- parseDindContainerName ctx.EnvVars
                match dindContainerName with
                | Some dind ->
                    try do! DockerClient.networkConnect netName dind ct
                    with ex -> Log.info $"[nas] Proxy: failed to connect dind to network: {ex.Message}"
                | None -> ()

                let proxyUrl = $"http://{ctx.SessionId}:{token}@{EnvoyAlias}:{EnvoyProxyPort}"
                let noProxyEntries =
                    [ "localhost"; "127.0.0.1" ]
                    @ (match dindContainerName with Some d -> [ d ] | None -> [])
                let noProxy = noProxyEntries |> String.concat ","

                let newEnv =
                    ctx.EnvVars
                    |> Map.add "http_proxy" proxyUrl
                    |> Map.add "https_proxy" proxyUrl
                    |> Map.add "HTTP_PROXY" proxyUrl
                    |> Map.add "HTTPS_PROXY" proxyUrl
                    |> Map.add "no_proxy" noProxy
                    |> Map.add "NO_PROXY" noProxy

                return { ctx with
                            DockerArgs = replaceNetwork ctx.DockerArgs netName
                            EnvVars = newEnv
                            NetworkRuntimeDir = Some rtDir
                            NetworkPromptToken = Some token
                            NetworkPromptEnabled = ctx.Profile.Network.Prompt.Enable
                            NetworkBrokerSocket = Some brokerSocket
                            NetworkProxyEndpoint = Some proxyUrl }
        }

        member _.Teardown(ctx) = task {
            match runtimeDir with
            | None -> ()
            | Some rtDir ->
                match brokerCts with
                | Some cts ->
                    cts.Cancel()
                    cts.Dispose()
                    brokerCts <- None
                | None -> ()
                match brokerState with
                | Some state ->
                    NetworkBroker.stop state
                    brokerState <- None
                | None -> ()

                try NetworkRegistry.removeSession rtDir ctx.SessionId with _ -> ()
                try
                    let pendingDir = Path.Combine(rtDir, "pending", ctx.SessionId)
                    if Directory.Exists(pendingDir) then Directory.Delete(pendingDir, true)
                with _ -> ()

                match sessionNetworkName with
                | Some netName ->
                    try do! DockerClient.networkDisconnect netName EnvoyContainerName ct
                    with ex -> Log.info $"[nas] Proxy teardown: failed to disconnect envoy from network: {ex.Message}"
                    match dindContainerName with
                    | Some dind ->
                        try do! DockerClient.networkDisconnect netName dind ct
                        with ex -> Log.info $"[nas] Proxy teardown: failed to disconnect dind from network: {ex.Message}"
                    | None -> ()
                    try do! DockerClient.networkRemove netName ct
                    with ex -> Log.info $"[nas] Proxy teardown: failed to remove network: {ex.Message}"
                | None -> ()
        }
