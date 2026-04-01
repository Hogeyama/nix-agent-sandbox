namespace Nas.Cli.Commands

open System
open System.Threading
open Nas.Core
open Nas.Stages

module WorktreeCommand =
    let list (workDir: string) = task {
        let ct = CancellationToken.None
        let! repoRoot = WorktreeHelpers.getRepoRoot workDir ct
        let! worktrees = WorktreeHelpers.listWorktrees repoRoot ct
        let nasWt = worktrees |> List.filter (fun w -> w.Contains(".nas-worktrees"))
        if nasWt.IsEmpty then printfn "No NAS worktrees found."
        else printfn "NAS Worktrees:"; for wt in nasWt do printfn $"  {wt}"
        return 0
    }
    let clean (workDir: string) (force: bool) = task {
        let ct = CancellationToken.None
        let! repoRoot = WorktreeHelpers.getRepoRoot workDir ct
        let! worktrees = WorktreeHelpers.listWorktrees repoRoot ct
        let nasWt = worktrees |> List.filter (fun w -> w.Contains(".nas-worktrees"))
        if nasWt.IsEmpty then
            printfn "No NAS worktrees to clean."
            return 0
        else
            if not force then
                printf $"Remove {nasWt.Length} worktree(s)? [y/N] "
                let input = Console.ReadLine()
                if input <> "y" && input <> "Y" then
                    printfn "Cancelled."
                    return 0
                else
                    for wt in nasWt do
                        Log.info $"Removing: {wt}"
                        do! WorktreeHelpers.removeWorktree repoRoot wt ct
                    return 0
            else
                for wt in nasWt do
                    Log.info $"Removing: {wt}"
                    do! WorktreeHelpers.removeWorktree repoRoot wt ct
                return 0
    }
