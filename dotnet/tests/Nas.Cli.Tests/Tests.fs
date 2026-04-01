module Nas.Cli.Tests.AllTests

open System
open System.IO
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Core.Config
open Nas.Cli

// ============================================================
// Helpers
// ============================================================

let private withTempDir (f: string -> unit) =
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    try f dir
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

let private captureStdout (f: unit -> 'a) =
    let oldOut = Console.Out
    use sw = new StringWriter()
    Console.SetOut(sw)
    try
        let result = f ()
        Console.Out.Flush()
        result, sw.ToString()
    finally
        Console.SetOut(oldOut)

/// Mirrors the worktree override logic from RunCommand.execute
let private applyWorktreeOverride (profile: Profile) (args: Args.ParsedArgs) =
    match args.WorktreeBase with
    | Some b ->
        { profile with
            Worktree = Some { WorktreeConfig.Default with Enable = true; Base = Some b } }
    | None when args.NoWorktree ->
        { profile with Worktree = None }
    | None -> profile

// ============================================================
// Args.parse — original tests (preserved)
// ============================================================

[<Fact>]
let ``parse profile`` () =
    (Args.parse [| "myprofile" |]).ProfileName |> should equal (Some "myprofile")

[<Fact>]
let ``parse quiet`` () =
    (Args.parse [| "-q" |]).LogLevel |> should equal LogLevel.Quiet

[<Fact>]
let ``parse agent args`` () =
    (Args.parse [| "p"; "--"; "--help" |]).AgentArgs |> should equal [ "--help" ]

[<Fact>]
let ``parse worktree`` () =
    (Args.parse [| "-b"; "main" |]).WorktreeBase |> should equal (Some "main")

[<Fact>]
let ``parse no-worktree`` () =
    (Args.parse [| "--no-worktree" |]).NoWorktree |> should be True

[<Fact>]
let ``parse empty`` () =
    let r = Args.parse [||]
    r.ProfileName |> should equal None
    r.AgentArgs |> should be Empty

// ============================================================
// Args.parse — from cli_parse_test.ts: parseProfileAndWorktreeArgs
// ============================================================

[<Fact>]
let ``parse empty returns all defaults`` () =
    let r = Args.parse [||]
    r.ProfileName |> should equal None
    r.WorktreeBase |> should equal None
    r.NoWorktree |> should equal false
    r.LogLevel |> should equal LogLevel.Normal
    r.AgentArgs |> should be Empty

[<Fact>]
let ``parse profile name sets ProfileName`` () =
    let r = Args.parse [| "dev" |]
    r.ProfileName |> should equal (Some "dev")
    r.WorktreeBase |> should equal None
    r.AgentArgs |> should be Empty

[<Fact>]
let ``parse profile with agent args after separator`` () =
    let r = Args.parse [| "dev"; "--"; "-p"; "hello" |]
    r.ProfileName |> should equal (Some "dev")
    r.AgentArgs |> should equal [ "-p"; "hello" ]

[<Fact>]
let ``parse --worktree with branch name`` () =
    let r = Args.parse [| "--worktree"; "main" |]
    r.ProfileName |> should equal None
    r.WorktreeBase |> should equal (Some "main")

[<Fact>]
let ``parse -b with feature branch`` () =
    let r = Args.parse [| "-b"; "feature/login" |]
    r.WorktreeBase |> should equal (Some "feature/login")

[<Fact>]
let ``parse -b with at-sign passes through`` () =
    let r = Args.parse [| "-b"; "@" |]
    r.WorktreeBase |> should equal (Some "@")

[<Fact>]
let ``parse -b with HEAD stays HEAD`` () =
    let r = Args.parse [| "-b"; "HEAD" |]
    r.WorktreeBase |> should equal (Some "HEAD")

[<Fact>]
let ``parse --no-worktree sets flag and no base`` () =
    let r = Args.parse [| "--no-worktree" |]
    r.NoWorktree |> should equal true
    r.WorktreeBase |> should equal None

[<Fact>]
let ``parse --worktree before profile captures both`` () =
    let r = Args.parse [| "--worktree"; "main"; "dev" |]
    r.ProfileName |> should equal (Some "dev")
    r.WorktreeBase |> should equal (Some "main")

[<Fact>]
let ``parse --no-worktree before profile captures both`` () =
    let r = Args.parse [| "--no-worktree"; "dev" |]
    r.ProfileName |> should equal (Some "dev")
    r.NoWorktree |> should equal true

[<Fact>]
let ``parse profile then agent args with flags after separator`` () =
    let r = Args.parse [| "dev"; "--"; "--resume=session-123"; "-v" |]
    r.ProfileName |> should equal (Some "dev")
    r.AgentArgs |> should equal [ "--resume=session-123"; "-v" ]

[<Fact>]
let ``parse -b as last arg is silently ignored`` () =
    let r = Args.parse [| "-b" |]
    r.WorktreeBase |> should equal None

[<Fact>]
let ``parse --worktree as last arg is silently ignored`` () =
    let r = Args.parse [| "--worktree" |]
    r.WorktreeBase |> should equal None

[<Fact>]
let ``parse -b with flag-like value accepts it as branch`` () =
    let r = Args.parse [| "-b"; "--something" |]
    r.WorktreeBase |> should equal (Some "--something")

[<Fact>]
let ``parse --quiet long form sets quiet`` () =
    (Args.parse [| "--quiet" |]).LogLevel |> should equal LogLevel.Quiet

[<Fact>]
let ``parse -q with profile`` () =
    let r = Args.parse [| "-q"; "dev" |]
    r.LogLevel |> should equal LogLevel.Quiet
    r.ProfileName |> should equal (Some "dev")

// ============================================================
// Args.parse — from cli_worktree_override_test.ts
// ============================================================

[<Fact>]
let ``parse captures profile after -b option`` () =
    let r = Args.parse [| "-b"; "@"; "my-profile" |]
    r.ProfileName |> should equal (Some "my-profile")
    r.WorktreeBase |> should equal (Some "@")
    r.AgentArgs |> should be Empty

[<Fact>]
let ``parse -b with branch and profile`` () =
    let r = Args.parse [| "-b"; "feature/login"; "my-profile" |]
    r.ProfileName |> should equal (Some "my-profile")
    r.WorktreeBase |> should equal (Some "feature/login")

[<Fact>]
let ``parse collects agent args with worktree and profile`` () =
    let r = Args.parse [| "-b"; "feature/base"; "copilot"; "--"; "--resume=uuid"; "-p"; "continue" |]
    r.ProfileName |> should equal (Some "copilot")
    r.WorktreeBase |> should equal (Some "feature/base")
    r.AgentArgs |> should equal [ "--resume=uuid"; "-p"; "continue" ]

[<Fact>]
let ``parse separator with no following args gives empty agent args`` () =
    let r = Args.parse [| "dev"; "--" |]
    r.ProfileName |> should equal (Some "dev")
    r.AgentArgs |> should be Empty

// ============================================================
// Worktree override logic
// (from cli_parse_test.ts: applyWorktreeOverride &
//  cli_worktree_override_test.ts)
// ============================================================

[<Fact>]
let ``worktree override none returns profile unchanged`` () =
    let profile = Profile.Default
    let args = Args.parse [||]
    let result = applyWorktreeOverride profile args
    result |> should equal profile

[<Fact>]
let ``worktree override disable removes worktree`` () =
    let profile =
        { Profile.Default with
            Worktree = Some { Enable = true; Base = Some "main"; OnCreate = Some "" } }
    let args = Args.parse [| "--no-worktree" |]
    let result = applyWorktreeOverride profile args
    result.Worktree |> should equal None

[<Fact>]
let ``worktree override enable sets worktree base`` () =
    let args = Args.parse [| "-b"; "feature/x" |]
    let result = applyWorktreeOverride Profile.Default args
    result.Worktree.IsSome |> should equal true
    result.Worktree.Value.Base |> should equal (Some "feature/x")
    result.Worktree.Value.Enable |> should equal true

[<Fact>]
let ``worktree override enable uses default OnCreate`` () =
    let args = Args.parse [| "-b"; "main" |]
    let result = applyWorktreeOverride Profile.Default args
    result.Worktree.Value.OnCreate |> should equal WorktreeConfig.Default.OnCreate

[<Fact>]
let ``worktree override enable replaces existing worktree config`` () =
    let profile =
        { Profile.Default with
            Worktree = Some { Enable = true; Base = Some "origin/main"; OnCreate = Some "echo hook" } }
    let args = Args.parse [| "-b"; "feature/login" |]
    let result = applyWorktreeOverride profile args
    result.Worktree.Value.Base |> should equal (Some "feature/login")

// ============================================================
// Program.main — help (from cli_test.ts)
// ============================================================

[<Fact>]
let ``CLI --help exits 0`` () =
    let code, _ = captureStdout (fun () -> Program.main [| "--help" |])
    code |> should equal 0

[<Fact>]
let ``CLI --help shows header`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("nas - Nix Agent Sandbox") |> should be True

[<Fact>]
let ``CLI -h exits 0 and shows header`` () =
    let code, stdout = captureStdout (fun () -> Program.main [| "-h" |])
    code |> should equal 0
    stdout.Contains("nas - Nix Agent Sandbox") |> should be True

[<Fact>]
let ``CLI help shows Usage`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("Usage:") |> should be True

[<Fact>]
let ``CLI help shows Subcommands`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("Subcommands:") |> should be True

[<Fact>]
let ``CLI help shows Options`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("Options:") |> should be True

[<Fact>]
let ``CLI help mentions quiet option`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("-q") |> should be True

[<Fact>]
let ``CLI help mentions container subcommand`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("container") |> should be True

[<Fact>]
let ``CLI help mentions worktree subcommand`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("worktree") |> should be True

[<Fact>]
let ``CLI help mentions rebuild subcommand`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("rebuild") |> should be True

[<Fact>]
let ``CLI help mentions audit subcommand`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--help" |])
    stdout.Contains("audit") |> should be True

// ============================================================
// Program.main — version (from cli_test.ts)
// ============================================================

[<Fact>]
let ``CLI --version exits 0`` () =
    let code, _ = captureStdout (fun () -> Program.main [| "--version" |])
    code |> should equal 0

[<Fact>]
let ``CLI --version shows version string`` () =
    let _, stdout = captureStdout (fun () -> Program.main [| "--version" |])
    stdout.Trim().StartsWith("nas ") |> should be True

[<Fact>]
let ``CLI -V exits 0 and shows version`` () =
    let code, stdout = captureStdout (fun () -> Program.main [| "-V" |])
    code |> should equal 0
    stdout.Trim().StartsWith("nas ") |> should be True

[<Fact>]
let ``CLI empty args shows help and exits 0`` () =
    let code, stdout = captureStdout (fun () -> Program.main [||])
    code |> should equal 0
    stdout.Contains("nas - Nix Agent Sandbox") |> should be True

// ============================================================
// Config Load — resolveProfile (from cli_test.ts)
// ============================================================

[<Fact>]
let ``resolveProfile returns error for nonexistent profile`` () =
    let config =
        { Config.Empty with
            Profiles = Map.ofList [ "dev", Profile.Default ] }
    Load.resolveProfile config (Some "nonexistent")
    |> Result.isError
    |> should be True

[<Fact>]
let ``resolveProfile error mentions not found`` () =
    let config =
        { Config.Empty with
            Profiles = Map.ofList [ "dev", Profile.Default ] }
    match Load.resolveProfile config (Some "nonexistent") with
    | Error msg -> msg.Contains("not found") |> should be True
    | Ok _ -> failwith "expected Error"

[<Fact>]
let ``resolveProfile returns error for empty profiles`` () =
    Load.resolveProfile Config.Empty None
    |> Result.isError
    |> should be True

[<Fact>]
let ``resolveProfile returns error when multiple profiles and no default`` () =
    let config =
        { Config.Empty with
            Profiles =
                Map.ofList
                    [ "a", Profile.Default
                      "b", { Profile.Default with Agent = AgentType.Copilot } ] }
    Load.resolveProfile config None
    |> Result.isError
    |> should be True

[<Fact>]
let ``resolveProfile returns single profile when only one exists`` () =
    let config =
        { Config.Empty with
            Profiles = Map.ofList [ "dev", Profile.Default ] }
    match Load.resolveProfile config None with
    | Ok (name, _) -> name |> should equal "dev"
    | Error msg -> failwith $"expected Ok, got Error: {msg}"

[<Fact>]
let ``resolveProfile uses default profile`` () =
    let config =
        { Config.Empty with
            Default = Some "b"
            Profiles =
                Map.ofList
                    [ "a", Profile.Default
                      "b", { Profile.Default with Agent = AgentType.Copilot } ] }
    match Load.resolveProfile config None with
    | Ok (name, profile) ->
        name |> should equal "b"
        profile.Agent |> should equal AgentType.Copilot
    | Error msg -> failwith $"expected Ok, got Error: {msg}"

// ============================================================
// Config Load — parseConfig (from cli_test.ts)
// ============================================================

[<Fact>]
let ``parseConfig with valid YAML returns profile`` () =
    let yaml = "profiles:\n  dev:\n    agent: claude\n"
    let config = Load.parseConfig yaml
    config.Profiles.ContainsKey("dev") |> should be True
    config.Profiles["dev"].Agent |> should equal AgentType.Claude

[<Fact>]
let ``parseConfig with invalid agent throws`` () =
    let yaml = "profiles:\n  test:\n    agent: invalid_agent\n"
    (fun () -> Load.parseConfig yaml |> ignore)
    |> should throw typeof<Exception>

[<Fact>]
let ``parseConfig with copilot agent`` () =
    let yaml = "profiles:\n  ci:\n    agent: copilot\n"
    let config = Load.parseConfig yaml
    config.Profiles["ci"].Agent |> should equal AgentType.Copilot

[<Fact>]
let ``parseConfig with empty profiles returns empty map`` () =
    let yaml = "profiles: {}\n"
    let config = Load.parseConfig yaml
    config.Profiles |> should be Empty

[<Fact>]
let ``parseConfig with multiple profiles`` () =
    let yaml = "profiles:\n  a:\n    agent: claude\n  b:\n    agent: copilot\n"
    let config = Load.parseConfig yaml
    config.Profiles.Count |> should equal 2

[<Fact>]
let ``parseConfig with default profile`` () =
    let yaml = "default: dev\nprofiles:\n  dev:\n    agent: claude\n  ci:\n    agent: copilot\n"
    let config = Load.parseConfig yaml
    config.Default |> should equal (Some "dev")
