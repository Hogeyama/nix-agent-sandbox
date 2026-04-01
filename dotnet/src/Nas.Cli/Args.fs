namespace Nas.Cli

open Nas.Core

module Args =
    type ParsedArgs = { ProfileName: string option; WorktreeBase: string option; NoWorktree: bool; LogLevel: LogLevel; AgentArgs: string list }

    let parse (argv: string array) =
        let sepIndex = argv |> Array.tryFindIndex (fun a -> a = "--")
        let nasArgs, agentArgs = match sepIndex with Some i -> argv[..i-1], argv[i+1..] |> Array.toList | None -> argv, []
        let mutable profileName = None
        let mutable worktreeBase = None
        let mutable noWorktree = false
        let mutable logLevel = LogLevel.Normal
        let mutable i = 0
        while i < nasArgs.Length do
            match nasArgs[i] with
            | "-q" | "--quiet" -> logLevel <- LogLevel.Quiet; i <- i + 1
            | "-b" | "--worktree" when i + 1 < nasArgs.Length -> worktreeBase <- Some nasArgs[i + 1]; i <- i + 2
            | "--no-worktree" -> noWorktree <- true; i <- i + 1
            | arg when not (arg.StartsWith("-")) && profileName.IsNone -> profileName <- Some arg; i <- i + 1
            | _ -> i <- i + 1
        { ProfileName = profileName; WorktreeBase = worktreeBase; NoWorktree = noWorktree; LogLevel = logLevel; AgentArgs = agentArgs }
