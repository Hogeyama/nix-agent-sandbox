namespace Nas.Cli.Commands

open System.IO
open Nas.Core
open Nas.Core.Config
open Nas.Core.Pipeline
open Nas.Stages

module RunCommand =
    let execute (args: Nas.Cli.Args.ParsedArgs) = task {
        Log.setLevel args.LogLevel
        let workDir = Directory.GetCurrentDirectory()
        try
            let config = Load.loadConfig workDir
            match Load.resolveProfile config args.ProfileName with
            | Error msg -> Log.error msg; return 1
            | Ok (profileName, profile) ->
                let profile = match args.WorktreeBase with
                              | Some b -> { profile with Worktree = Some { WorktreeConfig.Default with Enable = true; Base = Some b } }
                              | None when args.NoWorktree -> { profile with Worktree = None }
                              | None -> profile
                let ctx = ExecutionContext.create config profile profileName workDir args.LogLevel
                let stages: IStage list = [ WorktreeStage(); DockerBuildStage(); NixDetectStage(); DbusProxyStage(); MountStage(); HostExecStage(); DindStage(); ProxyStage(); LaunchStage() ]
                match! Pipeline.run stages ctx with
                | Ok finalCtx ->
                    do! Pipeline.teardownAll stages finalCtx
                    return 0
                | Error _ -> return 1
        with ex ->
            Log.error ex.Message
            return 1
    }
