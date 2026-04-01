module Nas.Agents.Tests.AllTests

open System
open System.IO
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Core.Config
open Nas.Core.Pipeline
open Nas.Agents
open Nas.Stages

// ============================================================
// Helpers
// ============================================================

let private withTempHome (f: string -> unit) =
    let origHome = Environment.GetEnvironmentVariable("HOME")
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    try
        Environment.SetEnvironmentVariable("HOME", dir)
        f dir
    finally
        Environment.SetEnvironmentVariable("HOME", origHome)
        try if Directory.Exists(dir) then Directory.Delete(dir, true) with _ -> ()

let private withFakeBinary (name: string) (f: unit -> unit) =
    let origPath = Environment.GetEnvironmentVariable("PATH")
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    let script = Path.Combine(dir, name)
    File.WriteAllText(script, "#!/bin/sh\nexit 0\n")
    let psi = Diagnostics.ProcessStartInfo("chmod", $"+x \"{script}\"")
    psi.UseShellExecute <- false
    use p = Diagnostics.Process.Start(psi)
    p.WaitForExit()
    try
        Environment.SetEnvironmentVariable("PATH", $"{dir}:{origPath}")
        f ()
    finally
        Environment.SetEnvironmentVariable("PATH", origPath)
        try if Directory.Exists(dir) then Directory.Delete(dir, true) with _ -> ()

let private withoutBinary (name: string) (f: unit -> unit) =
    let origPath =
        Environment.GetEnvironmentVariable("PATH")
        |> Option.ofObj
        |> Option.defaultValue ""
    let filtered =
        origPath.Split(':')
        |> Array.filter (fun d ->
            try not (File.Exists(Path.Combine(d, name)))
            with _ -> true)
        |> String.concat ":"
    try
        Environment.SetEnvironmentVariable("PATH", filtered)
        f ()
    finally
        Environment.SetEnvironmentVariable("PATH", origPath)

let private containerHome = "/home/user"
let private hostHome () = Environment.GetEnvironmentVariable("HOME")

let private makeCtx (agent: AgentType) =
    ExecutionContext.create
        Config.Empty
        { Profile.Default with Agent = agent }
        "test" "/workspace" LogLevel.Quiet

// ============================================================
// AgentUtils
// ============================================================

[<Fact>]
let ``bindMount readonly`` () =
    AgentUtils.bindMount "/s" "/d" true |> should equal [ "-v"; "/s:/d:ro" ]

[<Fact>]
let ``bindMount writable`` () =
    AgentUtils.bindMount "/s" "/d" false |> should equal [ "-v"; "/s:/d" ]

[<Fact>]
let ``findBinary returns None for non-existing binary`` () =
    AgentUtils.findBinary "no-such-binary-xyz-nas-test" |> should equal None

[<Fact>]
let ``resolveSymlinks returns path unchanged for regular file`` () =
    let tmpFile = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    File.WriteAllText(tmpFile, "test")
    try
        AgentUtils.resolveSymlinks tmpFile |> should equal tmpFile
    finally
        File.Delete(tmpFile)

// ============================================================
// configureClaude
// ============================================================

[<Fact>]
let ``Claude setup non-empty command`` () =
    (Claude.setup containerHome (hostHome())).Command |> should not' (be Empty)

[<Fact>]
let ``Claude mounts claude dir when directory exists`` () =
    withTempHome (fun tmpHome ->
        Directory.CreateDirectory(Path.Combine(tmpHome, ".claude")) |> ignore
        let result = Claude.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains("/.claude:"))
        |> should be True
    )

[<Fact>]
let ``Claude does not mount claude dir when absent`` () =
    withTempHome (fun _tmpHome ->
        let result = Claude.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains("/.claude:/"))
        |> should be False
    )

[<Fact>]
let ``Claude mounts claude json when file exists`` () =
    withTempHome (fun tmpHome ->
        File.WriteAllText(Path.Combine(tmpHome, ".claude.json"), "{}")
        let result = Claude.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains(".claude.json"))
        |> should be True
    )

[<Fact>]
let ``Claude does not mount claude json when absent`` () =
    withTempHome (fun _tmpHome ->
        let result = Claude.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains(".claude.json"))
        |> should be False
    )

[<Fact>]
let ``Claude uses claude command when binary found on PATH`` () =
    withFakeBinary "claude" (fun () ->
        let result = Claude.setup containerHome (hostHome())
        result.Command |> should equal [ "claude" ]
    )

[<Fact>]
let ``Claude mounts binary directory read-only when found on PATH`` () =
    withFakeBinary "claude" (fun () ->
        let result = Claude.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains("/opt/claude:ro"))
        |> should be True
    )

[<Fact>]
let ``Claude adds PATH env when binary found`` () =
    withFakeBinary "claude" (fun () ->
        let result = Claude.setup containerHome (hostHome())
        result.EnvVars |> Map.containsKey "PATH" |> should be True
        result.EnvVars.["PATH"].StartsWith("/opt/claude:") |> should be True
    )

[<Fact>]
let ``Claude uses install script when binary not found`` () =
    withoutBinary "claude" (fun () ->
        let result = Claude.setup containerHome (hostHome())
        result.Command.[0] |> should equal "bash"
        result.Command.[1] |> should equal "-c"
        result.Command.[2].Contains("install.sh") |> should be True
    )

[<Fact>]
let ``Claude install script invokes bash -c with three args`` () =
    withoutBinary "claude" (fun () ->
        let result = Claude.setup containerHome (hostHome())
        result.Command |> List.length |> should equal 3
    )

[<Fact>]
let ``Claude does not add PATH env when binary not found`` () =
    withoutBinary "claude" (fun () ->
        let result = Claude.setup containerHome (hostHome())
        result.EnvVars |> Map.containsKey "PATH" |> should be False
    )

// ============================================================
// configureCopilot
// ============================================================

[<Fact>]
let ``Copilot setup non-empty command`` () =
    (Copilot.setup containerHome (hostHome())).Command |> should not' (be Empty)

[<Fact>]
let ``Copilot uses copilot command when binary found on PATH`` () =
    withFakeBinary "copilot" (fun () ->
        let result = Copilot.setup containerHome (hostHome())
        result.Command |> should equal [ "copilot" ]
    )

[<Fact>]
let ``Copilot mounts binary when found on PATH`` () =
    withFakeBinary "copilot" (fun () ->
        let result = Copilot.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains("copilot") && a.Contains(":ro"))
        |> should be True
    )

[<Fact>]
let ``Copilot uses copilot command when binary not found`` () =
    withoutBinary "copilot" (fun () ->
        let result = Copilot.setup containerHome (hostHome())
        result.Command |> should equal [ "copilot" ]
    )

[<Fact>]
let ``Copilot mounts config dir when github-copilot exists`` () =
    withTempHome (fun tmpHome ->
        let origXdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")
        try
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", null)
            let configDir = Path.Combine(tmpHome, ".config", "github-copilot")
            Directory.CreateDirectory(configDir) |> ignore
            let result = Copilot.setup containerHome (hostHome())
            result.DockerArgs
            |> List.exists (fun a -> a.Contains("github-copilot"))
            |> should be True
        finally
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", origXdg)
    )

[<Fact>]
let ``Copilot does not mount config dir when absent`` () =
    withTempHome (fun _tmpHome ->
        let origXdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")
        try
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", null)
            let result = Copilot.setup containerHome (hostHome())
            result.DockerArgs
            |> List.exists (fun a -> a.Contains("github-copilot"))
            |> should be False
        finally
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", origXdg)
    )

[<Fact>]
let ``Copilot uses XDG_CONFIG_HOME when set`` () =
    withTempHome (fun tmpHome ->
        let xdgDir = Path.Combine(tmpHome, "custom-config")
        Directory.CreateDirectory(xdgDir) |> ignore
        let copilotDir = Path.Combine(xdgDir, "github-copilot")
        Directory.CreateDirectory(copilotDir) |> ignore
        let origXdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")
        try
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", xdgDir)
            let result = Copilot.setup containerHome (hostHome())
            result.DockerArgs
            |> List.exists (fun a -> a.Contains(xdgDir))
            |> should be True
        finally
            Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", origXdg)
    )

[<Fact>]
let ``Copilot does not set env vars`` () =
    let result = Copilot.setup containerHome (hostHome())
    result.EnvVars |> Map.isEmpty |> should be True

[<Fact>]
let ``Copilot does not set XDG vars when XDG_CONFIG_HOME not set`` () =
    let origXdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")
    try
        Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", null)
        let result = Copilot.setup containerHome (hostHome())
        result.EnvVars |> Map.containsKey "XDG_CONFIG_HOME" |> should be False
    finally
        Environment.SetEnvironmentVariable("XDG_CONFIG_HOME", origXdg)

// ============================================================
// configureCodex
// ============================================================

[<Fact>]
let ``Codex setup non-empty command`` () =
    (Codex.setup containerHome (hostHome())).Command |> should not' (be Empty)

[<Fact>]
let ``Codex uses codex command when binary found on PATH`` () =
    withFakeBinary "codex" (fun () ->
        let result = Codex.setup containerHome (hostHome())
        result.Command |> should equal [ "codex" ]
    )

[<Fact>]
let ``Codex mounts binary directory when found on PATH`` () =
    withFakeBinary "codex" (fun () ->
        let result = Codex.setup containerHome (hostHome())
        result.DockerArgs
        |> List.exists (fun a -> a.Contains("/opt/codex:ro"))
        |> should be True
    )

[<Fact>]
let ``Codex adds PATH env when binary found`` () =
    withFakeBinary "codex" (fun () ->
        let result = Codex.setup containerHome (hostHome())
        result.EnvVars |> Map.containsKey "PATH" |> should be True
        result.EnvVars.["PATH"].StartsWith("/opt/codex:") |> should be True
    )

[<Fact>]
let ``Codex uses codex command when binary not found`` () =
    withoutBinary "codex" (fun () ->
        let result = Codex.setup containerHome (hostHome())
        result.Command |> should equal [ "codex" ]
    )

[<Fact>]
let ``Codex does not add PATH env when binary not found`` () =
    withoutBinary "codex" (fun () ->
        let result = Codex.setup containerHome (hostHome())
        result.EnvVars |> Map.containsKey "PATH" |> should be False
    )

// ============================================================
// MountStage dispatch (via Execute)
// ============================================================

[<Fact>]
let ``MountStage dispatches to Claude for agent=claude`` () = task {
    let ctx = makeCtx AgentType.Claude
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.AgentCommand |> should not' (be Empty)
}

[<Fact>]
let ``MountStage dispatches to Copilot for agent=copilot`` () = task {
    let ctx = makeCtx AgentType.Copilot
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.AgentCommand
    |> List.exists (fun a -> a.Contains("copilot"))
    |> should be True
}

[<Fact>]
let ``MountStage dispatches to Codex for agent=codex`` () = task {
    let ctx = makeCtx AgentType.Codex
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.AgentCommand
    |> List.exists (fun a -> a.Contains("codex"))
    |> should be True
}

[<Fact>]
let ``MountStage adds workspace to DockerArgs`` () = task {
    let ctx = makeCtx AgentType.Claude
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.DockerArgs
    |> List.exists (fun a -> a.Contains("/workspace"))
    |> should be True
}

[<Fact>]
let ``MountStage sets working directory`` () = task {
    let ctx = makeCtx AgentType.Claude
    let! result = (MountStage() :> IStage).Execute(ctx)
    let wIdx = result.DockerArgs |> List.findIndex (fun a -> a = "-w")
    result.DockerArgs.[wIdx + 1] |> should equal "/workspace"
}

[<Fact>]
let ``MountStage sets HOST_UID and HOST_GID`` () = task {
    let ctx = makeCtx AgentType.Claude
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.EnvVars |> Map.containsKey "HOST_UID" |> should be True
    result.EnvVars |> Map.containsKey "HOST_GID" |> should be True
}

[<Fact>]
let ``MountStage processes extra mounts readonly`` () = task {
    let profile =
        { Profile.Default with
            Agent = AgentType.Claude
            ExtraMounts =
                [ { Src = "/host/data"
                    Dst = "/container/data"
                    Mode = "ro" } ] }
    let ctx = ExecutionContext.create Config.Empty profile "test" "/workspace" LogLevel.Quiet
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.DockerArgs
    |> List.exists (fun a -> a = "/host/data:/container/data:ro")
    |> should be True
}

[<Fact>]
let ``MountStage processes extra mounts writable`` () = task {
    let profile =
        { Profile.Default with
            Agent = AgentType.Claude
            ExtraMounts =
                [ { Src = "/host/rw"
                    Dst = "/container/rw"
                    Mode = "rw" } ] }
    let ctx = ExecutionContext.create Config.Empty profile "test" "/workspace" LogLevel.Quiet
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.DockerArgs
    |> List.exists (fun a -> a = "/host/rw:/container/rw")
    |> should be True
}

[<Fact>]
let ``MountStage processes env config with explicit value`` () = task {
    let profile =
        { Profile.Default with
            Agent = AgentType.Claude
            Env = [ { Key = Some "MY_VAR"; KeyCmd = None; Val = Some "my_value"; ValCmd = None } ] }
    let ctx = ExecutionContext.create Config.Empty profile "test" "/workspace" LogLevel.Quiet
    let! result = (MountStage() :> IStage).Execute(ctx)
    result.EnvVars |> Map.tryFind "MY_VAR" |> should equal (Some "my_value")
}

[<Fact>]
let ``MountStage processes env config from host`` () = task {
    let origVal = Environment.GetEnvironmentVariable("NAS_TEST_HOST_ENV")
    try
        Environment.SetEnvironmentVariable("NAS_TEST_HOST_ENV", "host_value")
        let profile =
            { Profile.Default with
                Agent = AgentType.Claude
                Env = [ { Key = Some "NAS_TEST_HOST_ENV"; KeyCmd = None; Val = None; ValCmd = None } ] }
        let ctx = ExecutionContext.create Config.Empty profile "test" "/workspace" LogLevel.Quiet
        let! result = (MountStage() :> IStage).Execute(ctx)
        result.EnvVars |> Map.tryFind "NAS_TEST_HOST_ENV" |> should equal (Some "host_value")
    finally
        Environment.SetEnvironmentVariable("NAS_TEST_HOST_ENV", origVal)
}
