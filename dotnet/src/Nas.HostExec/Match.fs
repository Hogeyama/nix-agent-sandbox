namespace Nas.HostExec

open System
open System.IO
open System.Text.RegularExpressions
open Nas.Core
open Nas.Core.Config

module Match =
    let matchArgv0 (ruleArgv0: string) (requestArgv0: string) =
        Path.GetFileName(requestArgv0).Equals(Path.GetFileName(ruleArgv0), StringComparison.Ordinal)

    let matchArgs (argRegex: string option) (args: string list) =
        match argRegex with
        | None -> true
        | Some pattern -> Regex.IsMatch(args |> String.concat " ", pattern)

    let validateCwd (cwdConfig: HostExecCwdConfig) (cwd: string) (workDir: string) (sessionTmpDir: string option) =
        match cwdConfig.Mode with
        | HostExecCwdMode.Any -> true
        | HostExecCwdMode.WorkspaceOnly -> cwd.StartsWith(workDir, StringComparison.Ordinal)
        | HostExecCwdMode.WorkspaceOrSessionTmp ->
            cwd.StartsWith(workDir, StringComparison.Ordinal) ||
            (sessionTmpDir |> Option.map (fun t -> cwd.StartsWith(t, StringComparison.Ordinal)) |> Option.defaultValue false)
        | HostExecCwdMode.Allowlist -> cwdConfig.Allow |> List.exists (fun a -> cwd.StartsWith(a, StringComparison.Ordinal))

    let findMatchingRule (rules: HostExecRule list) (argv0: string) (args: string list) (cwd: string) (workDir: string) (sessionTmpDir: string option) =
        rules |> List.tryFind (fun rule ->
            matchArgv0 rule.Match.Argv0 argv0 && matchArgs rule.Match.ArgRegex args && validateCwd rule.Cwd cwd workDir sessionTmpDir)
