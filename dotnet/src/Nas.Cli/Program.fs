namespace Nas.Cli

open System

module Program =
    [<EntryPoint>]
    let main argv =
        let args = argv |> Array.toList
        let exitCode =
            match args with
            | [] | [ "-h" ] | [ "--help" ] ->
                printfn "nas - Nix Agent Sandbox"
                printfn "\nUsage: nas [options] [profile-name] [-- agent-args...]"
                printfn "\nSubcommands: rebuild, worktree, container, network, hostexec, ui, audit"
                printfn "\nOptions: -q (quiet), -b BRANCH (worktree), --no-worktree, -V (version), -h (help)"
                0
            | [ "-V" ] | [ "--version" ] -> printfn "nas 0.1.0"; 0
            | "rebuild" :: rest ->
                Commands.RebuildCommand.execute (rest |> List.tryFind (fun a -> not (a.StartsWith("--")))) (rest |> List.contains "--force") |> Async.AwaitTask |> Async.RunSynchronously
            | "worktree" :: "list" :: _ -> Commands.WorktreeCommand.list Environment.CurrentDirectory |> Async.AwaitTask |> Async.RunSynchronously
            | "worktree" :: "clean" :: rest -> Commands.WorktreeCommand.clean Environment.CurrentDirectory (rest |> List.contains "-f" || rest |> List.contains "--force") |> Async.AwaitTask |> Async.RunSynchronously
            | "container" :: "clean" :: _ -> Commands.ContainerCommand.clean () |> Async.AwaitTask |> Async.RunSynchronously
            | "network" :: "pending" :: _ -> Commands.NetworkCommand.pending ()
            | "network" :: "gc" :: _ -> Commands.NetworkCommand.gc ()
            | "hostexec" :: "pending" :: _ -> Commands.HostExecCommand.pending ()
            | "hostexec" :: "gc" :: _ -> Commands.HostExecCommand.gc ()
            | "ui" :: rest ->
                let port =
                    match rest |> List.tryFindIndex (fun a -> a = "--port") with
                    | Some i when i + 1 < rest.Length ->
                        match Int32.TryParse(rest[i+1]) with
                        | true, p -> p
                        | _ -> 3939
                    | _ -> 3939
                Commands.UiCommand.execute port (rest |> List.contains "--no-open") |> Async.AwaitTask |> Async.RunSynchronously
            | "audit" :: rest ->
                let findFlag f = match rest |> List.tryFindIndex (fun a -> a = f) with Some i when i + 1 < rest.Length -> Some rest[i+1] | _ -> None
                Commands.AuditCommand.execute (findFlag "--since") (findFlag "--session") (findFlag "--domain") (rest |> List.contains "--json") (findFlag "--audit-dir")
            | _ -> Commands.RunCommand.execute (Args.parse argv) |> Async.AwaitTask |> Async.RunSynchronously
        exitCode
