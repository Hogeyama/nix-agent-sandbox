namespace Nas.Cli.Commands

open System.Threading
open Nas.Core
open Nas.Docker

module ContainerCommand =
    let clean () = task {
        let ct = CancellationToken.None
        let! containers = DockerClient.listNasContainers ct
        if containers.IsEmpty then printfn "No NAS containers to clean."
        else
            printfn $"Found {containers.Length} NAS container(s)"
            for c in containers do let name = c.Split('\t').[0] in Log.info $"Removing: {name}"; do! DockerClient.stopAndRemove name ct
        return 0
    }
