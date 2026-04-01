namespace Nas.Stages

open System
open System.IO
open System.Threading
open Nas.Core
open Nas.Core.Pipeline
open Nas.Docker

type DockerBuildStage() =
    static let embedHashLabel = "nas.embed-hash"

    interface IStage with
        member _.Name = "DockerBuild"

        member _.Execute(ctx) = task {
            let imageName = ctx.ImageName
            let! exists = DockerClient.imageExists imageName CancellationToken.None
            if exists then
                Log.info $"[nas] Docker image \"{imageName}\" already exists, skipping build"
                // Check staleness via label
                let! currentLabel = DockerClient.getImageLabel imageName embedHashLabel CancellationToken.None
                match currentLabel with
                | Some _ -> ()
                | None -> Log.warn "[nas] ⚠ Docker image may be outdated. Run `nas rebuild` to update."
            else
                Log.info $"[nas] Building Docker image \"{imageName}\"..."
                // Look for Dockerfile in the embedded resources directory
                let execDir = AppContext.BaseDirectory
                let dockerDir = Path.Combine(execDir, "docker")
                if Directory.Exists(dockerDir) then
                    let! _result = DockerClient.build dockerDir imageName [] CancellationToken.None
                    ()
                else
                    Log.warn $"[nas] No docker build context found at {dockerDir}. Image \"{imageName}\" must be built manually."
            return ctx
        }

        member _.Teardown(_ctx) = task { return () }
