namespace Nas.Stages

open System
open System.Net.Sockets
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Pipeline
open Nas.Docker

[<AutoOpen>]
module private DindConstants =
    let [<Literal>] DindImage = "docker:dind-rootless"
    let [<Literal>] DindInternalPort = 2375
    let [<Literal>] DindCacheVolume = "nas-docker-cache"
    let [<Literal>] DindDataDir = "/home/rootless/.local/share/docker"
    let [<Literal>] SharedContainerName = "nas-dind-shared"
    let [<Literal>] SharedNetworkName = "nas-dind-shared"
    let [<Literal>] SharedTmpVolume = "nas-dind-shared-tmp"
    let [<Literal>] SharedTmpMountPath = "/tmp/nas-shared"
    let [<Literal>] ReadinessTimeoutMs = 30_000
    let [<Literal>] ReadinessPollMs = 500

type DindStage() =
    let ct = CancellationToken.None
    let mutable shared = false
    let mutable networkName: string option = None
    let mutable containerName: string option = None
    let mutable sharedTmpVolume: string option = None

    let canConnectTcp (hostname: string) (port: int) =
        task {
            try
                use client = new TcpClient()
                do! client.ConnectAsync(hostname, port)
                return true
            with _ -> return false
        }

    let waitForDindReady (cName: string) (timeoutMs: int) =
        task {
            let start = DateTime.UtcNow
            let mutable containerIp = None
            let mutable ready = false
            while not ready && (DateTime.UtcNow - start).TotalMilliseconds < float timeoutMs do
                let! running = DockerClient.isRunning cName ct
                if not running then
                    let! logText = DockerClient.logs cName 50 ct
                    failwith $"DinD rootless container exited unexpectedly.\n--- container logs ---\n{logText}"

                if containerIp.IsNone then
                    let! ip = DockerClient.containerIp cName ct
                    containerIp <- ip

                match containerIp with
                | Some ip ->
                    let! canConnect = canConnectTcp ip DindInternalPort
                    if canConnect then
                        let! (exitCode, _, _) = DockerClient.dockerExec cName [ "docker"; "-H"; $"tcp://127.0.0.1:{DindInternalPort}"; "info" ] None ct
                        if exitCode = 0 then ready <- true
                | None -> ()

                if not ready then do! Task.Delay(ReadinessPollMs)

            if not ready then
                let! logText = DockerClient.logs cName 50 ct
                failwith $"DinD rootless failed to become ready within {timeoutMs / 1000}s\n--- container logs ---\n{logText}"
        }

    let buildSidecarArgs (tmpVol: string) (disableCache: bool) =
        let args = [ "--privileged" ]
        let cacheArgs = if not disableCache then [ "-v"; $"{DindCacheVolume}:{DindDataDir}" ] else []
        args @ cacheArgs @ [ "-v"; $"{tmpVol}:{SharedTmpMountPath}" ]

    let runDindSidecar (cName: string) (tmpVol: string) (disableCache: bool) =
        task {
            let dArgs = buildSidecarArgs tmpVol disableCache
            let labels = [ NasResources.ManagedLabel, NasResources.ManagedValue; NasResources.KindLabel, "dind" ]
            let labelArgs = labels |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
            let envArgs = [ "-e"; "DOCKER_TLS_CERTDIR=" ]
            let! _ = DockerClient.runDetached DindImage cName (dArgs @ labelArgs @ envArgs) Map.empty [] ct
            return ()
        }

    let startDindSidecar (cName: string) (tmpVol: string) =
        task {
            Log.info $"[nas] DinD: starting sidecar ({DindImage})"
            try
                do! DockerClient.volumeCreateWithLabels tmpVol [ NasResources.ManagedLabel, NasResources.ManagedValue; NasResources.KindLabel, "dind-tmp" ] ct
            with ex -> Log.info $"[nas] DinD: failed to create shared tmp volume: {ex.Message}"

            do! runDindSidecar cName tmpVol false
            Log.info "[nas] DinD: waiting for daemon to be ready..."
            try
                do! waitForDindReady cName ReadinessTimeoutMs
                Log.info "[nas] DinD: daemon is ready"
            with _ ->
                Log.warn $"[nas] DinD: failed to start with cache volume ({DindCacheVolume}), resetting cache and retrying..."
                try do! DockerClient.stop cName 0 ct with _ -> ()
                try do! DockerClient.rm cName ct with _ -> ()
                try do! DockerClient.volumeRemove DindCacheVolume ct with _ -> ()

                do! runDindSidecar cName tmpVol false
                Log.info "[nas] DinD: waiting for daemon to be ready (fresh cache)..."
                try
                    do! waitForDindReady cName ReadinessTimeoutMs
                    Log.info "[nas] DinD: daemon is ready (fresh cache)"
                with _ ->
                    Log.warn "[nas] DinD: fresh cache retry also failed, retrying without cache..."
                    try do! DockerClient.stop cName 0 ct with _ -> ()
                    try do! DockerClient.rm cName ct with _ -> ()

                    do! runDindSidecar cName tmpVol true
                    Log.info "[nas] DinD: waiting for daemon to be ready (no cache)..."
                    do! waitForDindReady cName ReadinessTimeoutMs
                    Log.info "[nas] DinD: daemon is ready (without cache)"
        }

    let ensureSharedTmpWritable (cName: string) =
        task {
            let! (exitCode, _, _) = DockerClient.dockerExec cName [ "chmod"; "1777"; SharedTmpMountPath ] (Some "0") ct
            if exitCode <> 0 then failwith $"Failed to make shared tmp writable: {SharedTmpMountPath}"
        }

    let ensureNetwork (netName: string) (cName: string) =
        task {
            try
                do! DockerClient.networkCreateWithLabels netName [ NasResources.ManagedLabel, NasResources.ManagedValue; NasResources.KindLabel, "dind-network" ] false ct
                Log.info $"[nas] DinD: created network {netName}"
            with _ -> () // already exists
            try do! DockerClient.networkConnect netName cName ct with _ -> () // already connected
        }

    interface IStage with
        member _.Name = "Dind"

        member _.Execute(ctx) = task {
            if not ctx.Profile.Docker.Enable then
                Log.info "[nas] DinD: skipped (not enabled)"
                return ctx
            else
                shared <- ctx.Profile.Docker.Shared

                let netName, cName, tmpVol =
                    if shared then
                        SharedNetworkName, SharedContainerName, SharedTmpVolume
                    else
                        let sid = Guid.NewGuid().ToString("N").[..7]
                        $"nas-dind-{sid}", $"nas-dind-{sid}", $"nas-dind-tmp-{sid}"
                networkName <- Some netName
                containerName <- Some cName
                sharedTmpVolume <- Some tmpVol

                let! isReusing = task {
                    if shared then return! DockerClient.isRunning cName ct
                    else return false
                }

                if isReusing then
                    Log.info $"[nas] DinD: reusing shared sidecar ({cName})"
                else
                    if shared then
                        try do! DockerClient.rm cName ct with _ -> ()
                    do! startDindSidecar cName tmpVol

                do! ensureSharedTmpWritable cName
                do! ensureNetwork netName cName

                let args =
                    ctx.DockerArgs
                    @ [ "--network"; netName; "-v"; $"{tmpVol}:{SharedTmpMountPath}" ]
                let envVars =
                    ctx.EnvVars
                    |> Map.add "DOCKER_HOST" $"tcp://{cName}:{DindInternalPort}"
                    |> Map.add "NAS_DIND_CONTAINER_NAME" cName
                    |> Map.add "NAS_DIND_SHARED_TMP" SharedTmpMountPath

                return { ctx with DockerArgs = args; EnvVars = envVars }
        }

        member _.Teardown(_ctx) = task {
            match containerName with
            | None -> ()
            | Some cName ->
                if shared then
                    Log.info $"[nas] DinD: keeping shared sidecar ({cName})"
                else
                    try
                        Log.info $"[nas] DinD: stopping sidecar {cName}"
                        do! DockerClient.stop cName 0 ct
                    with _ -> ()
                    try do! DockerClient.rm cName ct with _ -> ()
                    match networkName with
                    | Some net ->
                        try
                            Log.info $"[nas] DinD: removing network {net}"
                            do! DockerClient.networkRemove net ct
                        with _ -> ()
                    | None -> ()
                    match sharedTmpVolume with
                    | Some vol ->
                        try
                            Log.info $"[nas] DinD: removing volume {vol}"
                            do! DockerClient.volumeRemove vol ct
                        with _ -> ()
                    | None -> ()
        }
