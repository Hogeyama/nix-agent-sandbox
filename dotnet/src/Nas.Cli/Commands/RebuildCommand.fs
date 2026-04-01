namespace Nas.Cli.Commands

open System.Threading
open Nas.Core
open Nas.Docker

module RebuildCommand =
    let execute (_profileName: string option) (force: bool) = task {
        let ct = CancellationToken.None
        Log.info "Removing image: nas-sandbox"
        let! success = DockerClient.imageRemove "nas-sandbox" force ct
        if success then Log.info "Image removed. It will be rebuilt on next run."
        else Log.warn "Image not found or could not be removed."
        return 0
    }
