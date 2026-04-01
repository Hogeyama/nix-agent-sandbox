namespace Nas.Stages

open System.IO
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Pipeline

type NixDetectStage() =
    interface IStage with
        member _.Name = "NixDetect"
        member _.Execute(ctx) = task {
            let nixEnabled = match ctx.Profile.Nix.Enable with NixEnableMode.Enabled -> true | NixEnableMode.Disabled -> false | NixEnableMode.Auto -> Directory.Exists("/nix")
            if nixEnabled then Log.info "Nix detected on host" else Log.verbose "Nix not detected or disabled"
            return { ctx with NixEnabled = nixEnabled }
        }
        member _.Teardown(_ctx) = task { return () }
