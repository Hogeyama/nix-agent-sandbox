namespace Nas.Stages

open System
open System.IO
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Pipeline
open Nas.Docker

type LaunchStage(?extraArgs: string list) =
    let extraArgs = defaultArg extraArgs []

    let isGradleWorkspace (workDir: string) =
        [ "build.gradle"; "build.gradle.kts"; "settings.gradle"; "settings.gradle.kts" ]
        |> List.exists (fun marker ->
            try File.Exists(Path.Combine(workDir, marker)) with _ -> false)

    let parseProxyUrl (envVars: Map<string, string>) =
        [ "http_proxy"; "https_proxy"; "HTTP_PROXY"; "HTTPS_PROXY" ]
        |> List.tryPick (fun key ->
            envVars |> Map.tryFind key
            |> Option.bind (fun v -> if String.IsNullOrWhiteSpace(v) then None else Some (v.Trim())))

    let buildGradleProxyProperties (proxyUrl: string) =
        try
            let uri = Uri(proxyUrl)
            let host = uri.Host
            let port = string uri.Port
            let lines = [
                $"systemProp.http.proxyHost={host}"
                $"systemProp.http.proxyPort={port}"
                $"systemProp.https.proxyHost={host}"
                $"systemProp.https.proxyPort={port}"
            ]
            let userLines =
                if not (String.IsNullOrEmpty(uri.UserInfo)) then
                    let parts = uri.UserInfo.Split(':')
                    let user = parts.[0]
                    let pass = if parts.Length > 1 then parts.[1] else ""
                    [ $"systemProp.http.proxyUser={user}"
                      $"systemProp.https.proxyUser={user}" ]
                    @ (if not (String.IsNullOrEmpty(pass)) then
                        [ $"systemProp.http.proxyPassword={pass}"
                          $"systemProp.https.proxyPassword={pass}" ]
                       else [])
                else []
            Some ((lines @ userLines |> String.concat "\n") + "\n")
        with _ -> None

    let maybeWriteGradleProxyProperties (ctx: ExecutionContext) =
        let proxyEnabled =
            ctx.Profile.Network.Gradle.Proxy.IsEnabled (fun () -> isGradleWorkspace ctx.WorkDir)
        if not proxyEnabled then ()
        elif not (isGradleWorkspace ctx.WorkDir) then ()
        else
            match parseProxyUrl ctx.EnvVars with
            | None -> ()
            | Some proxy ->
                match buildGradleProxyProperties proxy with
                | None -> ()
                | Some content ->
                    let home = Environment.GetEnvironmentVariable("HOME")
                    if not (String.IsNullOrEmpty(home)) then
                        let gradleDir = Path.Combine(home, ".gradle")
                        try
                            if not (Directory.Exists(gradleDir)) then
                                Directory.CreateDirectory(gradleDir) |> ignore
                            File.WriteAllText(Path.Combine(gradleDir, "gradle.properties"), content)
                        with _ -> ()

    interface IStage with
        member _.Name = "Launch"

        member _.Execute(ctx) = task {
            maybeWriteGradleProxyProperties ctx

            let command = ctx.AgentCommand @ ctx.Profile.AgentArgs @ extraArgs
            Log.info "Launching container..."
            Log.info $"  Image: {ctx.ImageName}"
            Log.info $"  Agent: {ctx.Profile.Agent.ToConfigString()}"
            let commandStr = command |> String.concat " "
            Log.info $"  Command: {commandStr}"

            let containerName = $"nas-agent-{ctx.SessionId}"
            let labels =
                [ NasResources.ManagedLabel, NasResources.ManagedValue
                  NasResources.KindLabel, NasResourceKind.Agent.ToLabel()
                  NasResources.PwdLabel, ctx.WorkDir ]
            let labelArgs = labels |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
            let allArgs = ctx.DockerArgs @ labelArgs

            let! _exitCode = DockerClient.run ctx.ImageName containerName allArgs ctx.EnvVars command CancellationToken.None
            return ctx
        }

        member _.Teardown(_ctx) = task { return () }
