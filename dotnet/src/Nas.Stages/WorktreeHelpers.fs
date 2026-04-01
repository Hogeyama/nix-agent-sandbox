namespace Nas.Stages

open System
open System.Diagnostics
open System.Threading

module WorktreeHelpers =
    let runGit (workDir: string) (args: string list) (ct: CancellationToken) = task {
        let psi = ProcessStartInfo("git", args |> String.concat " ", WorkingDirectory = workDir, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false)
        use p = Process.Start(psi)
        let! stdout = p.StandardOutput.ReadToEndAsync(ct)
        let! stderr = p.StandardError.ReadToEndAsync(ct)
        do! p.WaitForExitAsync(ct)
        if p.ExitCode <> 0 then
            let argStr = args |> String.concat " "
            failwith $"git {argStr} failed: {stderr}"
        return stdout.Trim()
    }
    let getRepoRoot wd ct = runGit wd [ "rev-parse"; "--show-toplevel" ] ct
    let getCurrentBranch wd ct = runGit wd [ "rev-parse"; "--abbrev-ref"; "HEAD" ] ct
    let createWorktree root path branch baseBranch ct = task { let! _ = runGit root [ "worktree"; "add"; "-b"; branch; path; baseBranch ] ct in () }
    let removeWorktree root path ct = task { let! _ = runGit root [ "worktree"; "remove"; "--force"; path ] ct in () }
    let listWorktrees root ct = task {
        let! output = runGit root [ "worktree"; "list"; "--porcelain" ] ct
        return output.Split('\n', StringSplitOptions.RemoveEmptyEntries) |> Array.filter (fun l -> l.StartsWith("worktree ")) |> Array.map (fun l -> l.Substring(9)) |> Array.toList
    }
    let generateBranchName (profileName: string) =
        let ts = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss")
        $"nas/{profileName}/{ts}"
