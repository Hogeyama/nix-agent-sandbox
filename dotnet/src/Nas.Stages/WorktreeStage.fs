namespace Nas.Stages

open System.IO
open System.Threading
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Pipeline

type WorktreeStage() =
    let mutable worktreePath: string option = None
    interface IStage with
        member _.Name = "Worktree"
        member _.Execute(ctx) = task {
            match ctx.Profile.Worktree with
            | Some wt when wt.Enable ->
                let ct = CancellationToken.None
                let! repoRoot = WorktreeHelpers.getRepoRoot ctx.WorkDir ct
                let! baseBranch = match wt.Base with
                                  | Some b when b = "@" || b = "HEAD" -> WorktreeHelpers.getCurrentBranch ctx.WorkDir ct
                                  | Some b -> task { return b }
                                  | None -> task { return "main" }
                let branchName = WorktreeHelpers.generateBranchName ctx.ProfileName
                let wtPath = Path.Combine(Path.GetDirectoryName(repoRoot), $".nas-worktrees/{branchName}")
                Log.info $"Creating worktree at {wtPath} (base: {baseBranch})"
                do! WorktreeHelpers.createWorktree repoRoot wtPath branchName baseBranch ct
                worktreePath <- Some wtPath
                match wt.OnCreate with
                | Some cmd ->
                    let psi = System.Diagnostics.ProcessStartInfo("bash", $"-c \"{cmd}\"", WorkingDirectory = wtPath, UseShellExecute = false)
                    use p = System.Diagnostics.Process.Start(psi)
                    do! p.WaitForExitAsync()
                | None -> ()
                return { ctx with WorkDir = wtPath; MountDir = Some wtPath }
            | _ -> return ctx
        }
        member _.Teardown(ctx) = task {
            match worktreePath with
            | Some path when Directory.Exists(path) ->
                try
                    let! repoRoot = WorktreeHelpers.getRepoRoot ctx.WorkDir CancellationToken.None
                    do! WorktreeHelpers.removeWorktree repoRoot path CancellationToken.None
                with ex -> Log.warn $"Failed to remove worktree: {ex.Message}"
            | _ -> ()
        }
