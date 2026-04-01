module Nas.Stages.Tests.AllTests

open System
open System.IO
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Core.Config
open Nas.Core.Pipeline
open Nas.Stages

let private makeCtx (profile: Profile) (workDir: string) =
    ExecutionContext.create Config.Empty profile "test" workDir LogLevel.Quiet

// ============================================================
// NixDetectStage (from deno NixDetectStage tests)
// ============================================================

[<Fact>]
let ``NixDetect disabled`` () = task {
    let p = { Profile.Default with Nix = { NixConfig.Default with Enable = NixEnableMode.Disabled } }
    let ctx = makeCtx p "/ws"
    let! r = (NixDetectStage() :> IStage).Execute(ctx)
    r.NixEnabled |> should be False
}

[<Fact>]
let ``NixDetect enabled`` () = task {
    let p = { Profile.Default with Nix = { NixConfig.Default with Enable = NixEnableMode.Enabled } }
    let ctx = makeCtx p "/ws"
    let! r = (NixDetectStage() :> IStage).Execute(ctx)
    r.NixEnabled |> should be True
}

[<Fact>]
let ``NixDetect auto depends on nix directory`` () = task {
    let p = { Profile.Default with Nix = { NixConfig.Default with Enable = NixEnableMode.Auto } }
    let ctx = makeCtx p "/ws"
    let! r = (NixDetectStage() :> IStage).Execute(ctx)
    // Auto mode checks Directory.Exists("/nix") — result depends on host
    let expected = Directory.Exists("/nix")
    r.NixEnabled |> should equal expected
}

// ============================================================
// MountStage (from agents_test.ts MountStage dispatch + mount tests)
// ============================================================

[<Fact>]
let ``Mount adds workspace`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (MountStage() :> IStage).Execute(ctx)
    r.DockerArgs |> List.exists (fun a -> a.Contains("/ws")) |> should be True
}

[<Fact>]
let ``Mount sets working directory flag`` () = task {
    let ctx = makeCtx Profile.Default "/workspace"
    let! r = (MountStage() :> IStage).Execute(ctx)
    let wIdx = r.DockerArgs |> List.findIndex (fun a -> a = "-w")
    r.DockerArgs.[wIdx + 1] |> should equal "/workspace"
}

[<Fact>]
let ``Mount sets HOST_UID and HOST_GID`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (MountStage() :> IStage).Execute(ctx)
    r.EnvVars |> Map.containsKey "HOST_UID" |> should be True
    r.EnvVars |> Map.containsKey "HOST_GID" |> should be True
}

[<Fact>]
let ``Mount processes extra mounts readonly`` () = task {
    let profile =
        { Profile.Default with
            ExtraMounts = [ { Src = "/src"; Dst = "/dst"; Mode = "ro" } ] }
    let ctx = makeCtx profile "/ws"
    let! r = (MountStage() :> IStage).Execute(ctx)
    r.DockerArgs |> List.exists (fun a -> a = "/src:/dst:ro") |> should be True
}

[<Fact>]
let ``Mount processes extra mounts writable`` () = task {
    let profile =
        { Profile.Default with
            ExtraMounts = [ { Src = "/src"; Dst = "/dst"; Mode = "rw" } ] }
    let ctx = makeCtx profile "/ws"
    let! r = (MountStage() :> IStage).Execute(ctx)
    r.DockerArgs |> List.exists (fun a -> a = "/src:/dst") |> should be True
}

[<Fact>]
let ``Mount processes env config with value`` () = task {
    let profile =
        { Profile.Default with
            Env = [ { Key = Some "FOO"; KeyCmd = None; Val = Some "bar"; ValCmd = None } ] }
    let ctx = makeCtx profile "/ws"
    let! r = (MountStage() :> IStage).Execute(ctx)
    r.EnvVars |> Map.tryFind "FOO" |> should equal (Some "bar")
}

[<Fact>]
let ``Mount processes env config from host`` () = task {
    let origVal = Environment.GetEnvironmentVariable("NAS_STAGE_TEST_ENV")
    try
        Environment.SetEnvironmentVariable("NAS_STAGE_TEST_ENV", "from_host")
        let profile =
            { Profile.Default with
                Env = [ { Key = Some "NAS_STAGE_TEST_ENV"; KeyCmd = None; Val = None; ValCmd = None } ] }
        let ctx = makeCtx profile "/ws"
        let! r = (MountStage() :> IStage).Execute(ctx)
        r.EnvVars |> Map.tryFind "NAS_STAGE_TEST_ENV" |> should equal (Some "from_host")
    finally
        Environment.SetEnvironmentVariable("NAS_STAGE_TEST_ENV", origVal)
}

[<Fact>]
let ``Mount uses MountDir when set`` () = task {
    let ctx = { makeCtx Profile.Default "/ws" with MountDir = Some "/mount-root" }
    let! r = (MountStage() :> IStage).Execute(ctx)
    r.DockerArgs |> List.exists (fun a -> a.Contains("/mount-root")) |> should be True
}

// ============================================================
// DindStage (from dind_stage_test.ts)
// ============================================================

[<Fact>]
let ``DindStage skip when disabled`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (DindStage() :> IStage).Execute(ctx)
    r.DockerArgs |> should equal ctx.DockerArgs
    r.EnvVars |> should equal ctx.EnvVars
}

[<Fact>]
let ``DindStage skip preserves existing DockerArgs`` () = task {
    let ctx = { makeCtx Profile.Default "/ws" with DockerArgs = [ "--existing"; "arg" ] }
    let! r = (DindStage() :> IStage).Execute(ctx)
    r.DockerArgs |> should equal [ "--existing"; "arg" ]
}

[<Fact>]
let ``DindStage skip preserves existing EnvVars`` () = task {
    let ctx = { makeCtx Profile.Default "/ws" with EnvVars = Map.ofList [ "KEEP", "me" ] }
    let! r = (DindStage() :> IStage).Execute(ctx)
    r.EnvVars |> Map.tryFind "KEEP" |> should equal (Some "me")
}

[<Fact>]
let ``DindStage does not set DOCKER_HOST when disabled`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (DindStage() :> IStage).Execute(ctx)
    r.EnvVars |> Map.containsKey "DOCKER_HOST" |> should be False
}

// ============================================================
// ProxyStage (from proxy_stage_test.ts)
// ============================================================

[<Fact>]
let ``ProxyStage skip when allowlist and prompt disabled`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (ProxyStage() :> IStage).Execute(ctx)
    r.NetworkRuntimeDir |> should equal None
    r.NetworkPromptEnabled |> should be False
}

[<Fact>]
let ``ProxyStage skip preserves DockerArgs`` () = task {
    let ctx = { makeCtx Profile.Default "/ws" with DockerArgs = [ "--network"; "old-net" ] }
    let! r = (ProxyStage() :> IStage).Execute(ctx)
    r.DockerArgs |> should equal [ "--network"; "old-net" ]
}

[<Fact>]
let ``ProxyStage skip preserves EnvVars`` () = task {
    let ctx = { makeCtx Profile.Default "/ws" with EnvVars = Map.ofList [ "TOKEN", "secret" ] }
    let! r = (ProxyStage() :> IStage).Execute(ctx)
    r.EnvVars |> Map.tryFind "TOKEN" |> should equal (Some "secret")
}

[<Fact>]
let ``ProxyStage skip does not set proxy env vars`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (ProxyStage() :> IStage).Execute(ctx)
    r.EnvVars |> Map.containsKey "http_proxy" |> should be False
    r.EnvVars |> Map.containsKey "https_proxy" |> should be False
    r.EnvVars |> Map.containsKey "no_proxy" |> should be False
}

[<Fact>]
let ``ProxyStage skip does not set NetworkProxyEndpoint`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (ProxyStage() :> IStage).Execute(ctx)
    r.NetworkProxyEndpoint |> should equal None
}

[<Fact>]
let ``ProxyStage skip does not set NetworkBrokerSocket`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (ProxyStage() :> IStage).Execute(ctx)
    r.NetworkBrokerSocket |> should equal None
}

// ============================================================
// DbusProxyStage (from dbus_proxy_stage_test.ts)
// ============================================================

[<Fact>]
let ``DbusProxyStage skip when disabled`` () = task {
    let ctx = makeCtx Profile.Default "/ws"
    let! r = (DbusProxyStage() :> IStage).Execute(ctx)
    r.DbusProxyEnabled |> should be False
    r.DbusSessionRuntimeDir |> should equal None
    r.DbusSessionSocket |> should equal None
}

[<Fact>]
let ``DbusProxyStage skip preserves context`` () = task {
    let ctx = { makeCtx Profile.Default "/ws" with DockerArgs = [ "--test" ] }
    let! r = (DbusProxyStage() :> IStage).Execute(ctx)
    r.DockerArgs |> should equal [ "--test" ]
}

[<Fact>]
let ``DbusProxyStage skip when xdg-dbus-proxy unavailable`` () = task {
    let profile =
        { Profile.Default with
            Dbus =
                { DbusConfig.Default with
                    Session = { DbusSessionConfig.Default with Enable = true } } }
    let ctx = makeCtx profile "/ws"
    let origPath = Environment.GetEnvironmentVariable("PATH")
    let emptyDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(emptyDir) |> ignore
    try
        Environment.SetEnvironmentVariable("PATH", emptyDir)
        let! r = (DbusProxyStage() :> IStage).Execute(ctx)
        r.DbusProxyEnabled |> should be False
    finally
        Environment.SetEnvironmentVariable("PATH", origPath)
        try if Directory.Exists(emptyDir) then Directory.Delete(emptyDir, true) with _ -> ()
}

[<Fact>]
let ``DbusProxyStage enabled but no proxy returns disabled`` () = task {
    let profile =
        { Profile.Default with
            Dbus =
                { DbusConfig.Default with
                    Session =
                        { DbusSessionConfig.Default with
                            Enable = true
                            SourceAddress = Some "unix:path=/nonexistent/dbus/socket" } } }
    let ctx = makeCtx profile "/ws"
    let origPath = Environment.GetEnvironmentVariable("PATH")
    let emptyDir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(emptyDir) |> ignore
    try
        Environment.SetEnvironmentVariable("PATH", emptyDir)
        let! r = (DbusProxyStage() :> IStage).Execute(ctx)
        r.DbusProxyEnabled |> should be False
    finally
        Environment.SetEnvironmentVariable("PATH", origPath)
        try if Directory.Exists(emptyDir) then Directory.Delete(emptyDir, true) with _ -> ()
}

// ============================================================
// WorktreeStage (from worktree_stage_test.ts + worktree_teardown_test.ts)
// ============================================================

[<Fact>]
let ``WorktreeStage skip when not configured`` () = task {
    // Profile.Default has Worktree = None
    let ctx = makeCtx Profile.Default "/workspace"
    let! r = (WorktreeStage() :> IStage).Execute(ctx)
    r.WorkDir |> should equal "/workspace"
}

[<Fact>]
let ``WorktreeStage skip when worktree disabled`` () = task {
    let profile =
        { Profile.Default with
            Worktree = Some { WorktreeConfig.Default with Enable = false } }
    let ctx = makeCtx profile "/workspace"
    let! r = (WorktreeStage() :> IStage).Execute(ctx)
    r.WorkDir |> should equal "/workspace"
}

[<Fact>]
let ``WorktreeStage skip preserves MountDir`` () = task {
    let ctx = { makeCtx Profile.Default "/workspace" with MountDir = Some "/mount" }
    let! r = (WorktreeStage() :> IStage).Execute(ctx)
    r.MountDir |> should equal (Some "/mount")
}

[<Fact>]
let ``WorktreeStage teardown without execute is no-op`` () = task {
    let stage = WorktreeStage() :> IStage
    let ctx = makeCtx Profile.Default "/workspace"
    do! stage.Teardown(ctx)
    // Should not throw
}

[<Fact>]
let ``WorktreeStage teardown with no worktree path is safe`` () = task {
    let stage = WorktreeStage() :> IStage
    let profile =
        { Profile.Default with
            Worktree = Some { WorktreeConfig.Default with Enable = false } }
    let ctx = makeCtx profile "/nonexistent"
    do! stage.Teardown(ctx)
}

// ============================================================
// WorktreeHelpers (from worktree_lifecycle_test.ts concepts)
// ============================================================

[<Fact>]
let ``generateBranchName starts with nas prefix`` () =
    let name = WorktreeHelpers.generateBranchName "myprofile"
    name.StartsWith("nas/myprofile/") |> should be True

[<Fact>]
let ``generateBranchName includes timestamp`` () =
    let name = WorktreeHelpers.generateBranchName "test"
    // Format: nas/test/yyyyMMdd-HHmmss
    let suffix = name.Substring("nas/test/".Length)
    suffix.Length |> should equal 15
    suffix.[8] |> should equal '-'

[<Fact>]
let ``generateBranchName different profiles produce different prefixes`` () =
    let name1 = WorktreeHelpers.generateBranchName "alpha"
    let name2 = WorktreeHelpers.generateBranchName "beta"
    name1.StartsWith("nas/alpha/") |> should be True
    name2.StartsWith("nas/beta/") |> should be True
