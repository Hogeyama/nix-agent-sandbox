module Nas.Core.Tests.AllTests

open System
open System.IO
open System.Threading
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Core.Config
open Nas.Core.Lib
open Nas.Core.Pipeline

// ============================================================
// Helpers
// ============================================================

let private withTempDir (f: string -> unit) =
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    try f dir
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

let private withNestedDirs (f: string -> string -> string -> unit) =
    withTempDir (fun root ->
        let child = Path.Combine(root, "child")
        let grandchild = Path.Combine(child, "grandchild")
        Directory.CreateDirectory(grandchild) |> ignore
        f root child grandchild)

let private withTempConfig (yaml: string) (f: string -> unit) =
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        f dir)

// ============================================================
// Types Tests
// ============================================================

[<Fact>]
let ``AgentType.FromString parses claude`` () =
    AgentType.FromString "claude" |> should equal (Some AgentType.Claude)

[<Fact>]
let ``AgentType.FromString parses copilot`` () =
    AgentType.FromString "copilot" |> should equal (Some AgentType.Copilot)

[<Fact>]
let ``AgentType.FromString parses codex`` () =
    AgentType.FromString "codex" |> should equal (Some AgentType.Codex)

[<Fact>]
let ``AgentType.FromString returns None for unknown`` () =
    AgentType.FromString "x" |> should equal None

[<Fact>]
let ``AgentType.FromString returns None for empty`` () =
    AgentType.FromString "" |> should equal None

[<Fact>]
let ``AgentType.FromString is case insensitive`` () =
    AgentType.FromString "CLAUDE" |> should equal (Some AgentType.Claude)
    AgentType.FromString "Copilot" |> should equal (Some AgentType.Copilot)
    AgentType.FromString "CODEX" |> should equal (Some AgentType.Codex)

[<Fact>]
let ``AgentType.ToConfigString roundtrips`` () =
    for a in [ AgentType.Claude; AgentType.Copilot; AgentType.Codex ] do
        a.ToConfigString() |> AgentType.FromString |> should equal (Some a)

[<Fact>]
let ``ApprovalScope roundtrips`` () =
    for s in [ ApprovalScope.Once; ApprovalScope.HostPort; ApprovalScope.Host ] do
        s.ToConfigString() |> ApprovalScope.FromString |> should equal (Some s)

[<Fact>]
let ``ApprovalScope.FromString returns None for unknown`` () =
    ApprovalScope.FromString "invalid" |> should equal None

[<Fact>]
let ``SessionId creates unique IDs`` () =
    let a = SessionId.create () |> SessionId.value
    let b = SessionId.create () |> SessionId.value
    a |> should not' (equal b)
    a.Length |> should equal 8

[<Fact>]
let ``SessionId value extracts string`` () =
    let id = SessionId.create ()
    let v = SessionId.value id
    v.Length |> should equal 8

[<Fact>]
let ``NixEnableMode values are distinct`` () =
    NixEnableMode.Auto |> should not' (equal NixEnableMode.Enabled)
    NixEnableMode.Enabled |> should not' (equal NixEnableMode.Disabled)
    NixEnableMode.Disabled |> should not' (equal NixEnableMode.Auto)

[<Fact>]
let ``NotifyMode values are distinct`` () =
    NotifyMode.Auto |> should not' (equal NotifyMode.Desktop)
    NotifyMode.Desktop |> should not' (equal NotifyMode.Off)

// ============================================================
// TtlLruCache Tests
// ============================================================

[<Fact>]
let ``Cache stores and retrieves`` () =
    let c = TtlLruCache<string,int>(10, TimeSpan.FromSeconds(60.0))
    c.Set("k", 42)
    c.TryGet("k") |> should equal (Some 42)

[<Fact>]
let ``Cache returns None for missing`` () =
    TtlLruCache<string,int>(10, TimeSpan.FromSeconds(60.0)).TryGet("x") |> should equal None

[<Fact>]
let ``Cache evicts oldest at capacity`` () =
    let c = TtlLruCache<string,int>(2, TimeSpan.FromSeconds(60.0))
    c.Set("a", 1)
    c.Set("b", 2)
    c.Set("c", 3)
    c.TryGet("a") |> should equal None
    c.TryGet("b") |> should equal (Some 2)
    c.TryGet("c") |> should equal (Some 3)
    c.Count |> should equal 2

[<Fact>]
let ``Cache expires after TTL`` () =
    let c = TtlLruCache<string,int>(10, TimeSpan.FromMilliseconds(50.0))
    c.Set("k", 1)
    Thread.Sleep(100)
    c.TryGet("k") |> should equal None

[<Fact>]
let ``Cache overwriting a key updates value`` () =
    let c = TtlLruCache<string,int>(2, TimeSpan.FromSeconds(60.0))
    c.Set("a", 1)
    c.Set("b", 2)
    c.Set("a", 10)
    c.Set("c", 3)
    // "a" was re-set (promoted), so "b" should be evicted
    c.TryGet("b") |> should equal None
    c.TryGet("a") |> should equal (Some 10)
    c.TryGet("c") |> should equal (Some 3)

[<Fact>]
let ``Cache get promotes entry in LRU order`` () =
    let c = TtlLruCache<string,int>(2, TimeSpan.FromSeconds(60.0))
    c.Set("a", 1)
    c.Set("b", 2)
    c.TryGet("a") |> ignore // promotes "a"
    c.Set("c", 3) // should evict "b" (oldest)
    c.TryGet("b") |> should equal None
    c.TryGet("a") |> should equal (Some 1)
    c.TryGet("c") |> should equal (Some 3)

[<Fact>]
let ``Cache Remove removes entry`` () =
    let c = TtlLruCache<string,int>(10, TimeSpan.FromSeconds(60.0))
    c.Set("a", 1)
    c.Remove("a")
    c.TryGet("a") |> should equal None

[<Fact>]
let ``Cache Clear removes all entries`` () =
    let c = TtlLruCache<string,int>(10, TimeSpan.FromSeconds(60.0))
    c.Set("a", 1)
    c.Set("b", 2)
    c.Clear()
    c.Count |> should equal 0
    c.TryGet("a") |> should equal None

[<Fact>]
let ``Cache Count reflects current entry count`` () =
    let c = TtlLruCache<string,int>(10, TimeSpan.FromSeconds(60.0))
    c.Count |> should equal 0
    c.Set("a", 1)
    c.Count |> should equal 1
    c.Set("b", 2)
    c.Count |> should equal 2
    c.Remove("a")
    c.Count |> should equal 1

[<Fact>]
let ``Cache expired entries are removed on get`` () =
    let c = TtlLruCache<string,int>(10, TimeSpan.FromMilliseconds(1.0))
    c.Set("a", 1)
    Thread.Sleep(20)
    c.TryGet("a") |> should equal None
    c.Count |> should equal 0

// ============================================================
// FsUtils Tests
// ============================================================

[<Fact>]
let ``ensureDir creates directory`` () =
    let d = Path.Combine(Path.GetTempPath(), $"nas-{Guid.NewGuid():N}")
    try
        FsUtils.ensureDir d
        Directory.Exists(d) |> should be True
    finally
        if Directory.Exists(d) then Directory.Delete(d, true)

[<Fact>]
let ``ensureDir is idempotent`` () =
    let d = Path.Combine(Path.GetTempPath(), $"nas-{Guid.NewGuid():N}")
    try
        FsUtils.ensureDir d
        FsUtils.ensureDir d
        Directory.Exists(d) |> should be True
    finally
        if Directory.Exists(d) then Directory.Delete(d, true)

[<Fact>]
let ``tryReadAllText returns Some for existing`` () =
    let p = Path.GetTempFileName()
    try
        File.WriteAllText(p, "hi")
        FsUtils.tryReadAllText p |> should equal (Some "hi")
    finally
        File.Delete(p)

[<Fact>]
let ``tryReadAllText returns None for missing`` () =
    FsUtils.tryReadAllText "/tmp/nas-nonexistent" |> should equal None

[<Fact>]
let ``searchUpward finds file in current dir`` () =
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), "test")
        let result = FsUtils.searchUpward dir (fun p -> Path.GetFileName(p) = ".agent-sandbox.yml")
        result.IsSome |> should be True
        result.Value |> should equal (Path.Combine(dir, ".agent-sandbox.yml")))

[<Fact>]
let ``searchUpward finds file in parent dir`` () =
    withNestedDirs (fun root _child grandchild ->
        File.WriteAllText(Path.Combine(root, ".agent-sandbox.yml"), "test")
        let result = FsUtils.searchUpward grandchild (fun p -> Path.GetFileName(p) = ".agent-sandbox.yml")
        result.IsSome |> should be True
        result.Value |> should equal (Path.Combine(root, ".agent-sandbox.yml")))

[<Fact>]
let ``searchUpward returns None when file not found`` () =
    withTempDir (fun dir ->
        let result = FsUtils.searchUpward dir (fun p -> Path.GetFileName(p) = ".nonexistent-file-xyz")
        result |> should equal None)

// ============================================================
// Config Validate Tests
// ============================================================

[<Fact>]
let ``allowlist accepts wildcard`` () =
    Validate.isValidAllowlistEntry "*.example.com" |> should be True

[<Fact>]
let ``allowlist accepts exact`` () =
    Validate.isValidAllowlistEntry "api.example.com" |> should be True

[<Fact>]
let ``allowlist rejects double wildcard`` () =
    Validate.isValidAllowlistEntry "**.example.com" |> should be False

[<Fact>]
let ``allowlist rejects wildcard in middle`` () =
    Validate.isValidAllowlistEntry "git*hub.com" |> should be False

[<Fact>]
let ``allowlist rejects trailing wildcard`` () =
    Validate.isValidAllowlistEntry "github.*" |> should be False

[<Fact>]
let ``allowlist rejects empty string`` () =
    Validate.isValidAllowlistEntry "" |> should be False

[<Fact>]
let ``allowlist rejects whitespace only`` () =
    Validate.isValidAllowlistEntry "   " |> should be False

[<Fact>]
let ``allowlist accepts wildcard subdomain`` () =
    Validate.isValidAllowlistEntry "*.npmjs.org" |> should be True

[<Fact>]
let ``validateAllowlist returns empty for valid entries`` () =
    Validate.validateAllowlist [ "*.github.com"; "api.openai.com" ] |> should be Empty

[<Fact>]
let ``validateAllowlist returns errors for invalid entries`` () =
    let errors = Validate.validateAllowlist [ "*.github.com"; "git*hub.com"; "api.openai.com" ]
    errors.Length |> should equal 1

[<Fact>]
let ``validateConfig detects missing default`` () =
    let c = { Config.Empty with Default = Some "nope"; Profiles = Map.ofList [ "dev", Profile.Default ] }
    Validate.validateConfig c |> should not' (be Empty)

[<Fact>]
let ``validateConfig passes valid`` () =
    let c = { Config.Empty with Default = Some "dev"; Profiles = Map.ofList [ "dev", Profile.Default ] }
    Validate.validateConfig c |> should be Empty

[<Fact>]
let ``validateConfig passes with no default`` () =
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", Profile.Default ] }
    Validate.validateConfig c |> should be Empty

[<Fact>]
let ``validateConfig detects invalid allowlist in profile`` () =
    let p = { Profile.Default with Network = { NetworkConfig.Default with Allowlist = [ "git*hub.com" ] } }
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", p ] }
    Validate.validateConfig c |> should not' (be Empty)

[<Fact>]
let ``validateConfig detects duplicate hostexec rule IDs`` () =
    let rule = { Id = "git"; Match = { Argv0 = "git"; ArgRegex = None }; Cwd = { Mode = HostExecCwdMode.WorkspaceOnly; Allow = [] }; Env = Map.empty; InheritEnv = HostExecInheritEnvConfig.Default; Approval = HostExecApproval.Allow; Fallback = HostExecFallback.Container }
    let he = { HostExecConfig.Default with Rules = [ rule; rule ] }
    let p = { Profile.Default with HostExec = Some he }
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", p ] }
    let errors = Validate.validateConfig c
    errors |> should not' (be Empty)
    errors |> List.exists (fun e -> e.Contains("Duplicate hostexec rule ID")) |> should be True

[<Fact>]
let ``validateConfig detects duplicate mount destinations`` () =
    let mounts = [ { Src = "/a"; Dst = "/dup"; Mode = "ro" }; { Src = "/b"; Dst = "/dup"; Mode = "rw" } ]
    let p = { Profile.Default with ExtraMounts = mounts }
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", p ] }
    let errors = Validate.validateConfig c
    errors |> should not' (be Empty)
    errors |> List.exists (fun e -> e.Contains("Duplicate mount destination")) |> should be True

[<Fact>]
let ``validateConfig passes with valid allowlist entries`` () =
    let p = { Profile.Default with Network = { NetworkConfig.Default with Allowlist = [ "*.github.com"; "api.openai.com" ] } }
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", p ] }
    Validate.validateConfig c |> should be Empty

[<Fact>]
let ``validateConfig validates multiple profiles independently`` () =
    let p1 = Profile.Default
    let p2 = { Profile.Default with Network = { NetworkConfig.Default with Allowlist = [ "git*hub.com" ] } }
    let c = { Config.Empty with Profiles = Map.ofList [ "good", p1; "bad", p2 ] }
    let errors = Validate.validateConfig c
    errors |> should not' (be Empty)

// ============================================================
// Config Load Tests
// ============================================================

[<Fact>]
let ``resolveProfile returns named`` () =
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", Profile.Default ] }
    match Load.resolveProfile c (Some "dev") with
    | Ok _ -> ()
    | Error e -> failwith $"Expected Ok, got Error: {e}"

[<Fact>]
let ``resolveProfile auto-selects single`` () =
    let c = { Config.Empty with Profiles = Map.ofList [ "only", Profile.Default ] }
    match Load.resolveProfile c None with
    | Ok (n,_) -> n |> should equal "only"
    | _ -> failwith "Expected Ok"

[<Fact>]
let ``resolveProfile errors on missing`` () =
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", Profile.Default ] }
    match Load.resolveProfile c (Some "prod") with
    | Error _ -> ()
    | Ok _ -> failwith "Expected Error"

[<Fact>]
let ``resolveProfile falls back to default`` () =
    let c = { Config.Empty with Default = Some "dev"; Profiles = Map.ofList [ "dev", Profile.Default; "prod", Profile.Default ] }
    match Load.resolveProfile c None with
    | Ok (n, _) -> n |> should equal "dev"
    | Error e -> failwith $"Expected Ok, got Error: {e}"

[<Fact>]
let ``resolveProfile errors when multiple profiles and no default`` () =
    let c = { Config.Empty with Profiles = Map.ofList [ "a", Profile.Default; "b", Profile.Default ] }
    match Load.resolveProfile c None with
    | Error e -> e |> should haveSubstring "Multiple profiles"
    | Ok _ -> failwith "Expected Error"

[<Fact>]
let ``resolveProfile errors when no profiles defined`` () =
    let c = Config.Empty
    match Load.resolveProfile c None with
    | Error e -> e |> should haveSubstring "No profiles"
    | Ok _ -> failwith "Expected Error"

[<Fact>]
let ``resolveProfile errors when default profile not found`` () =
    let c = { Config.Empty with Default = Some "missing"; Profiles = Map.ofList [ "dev", Profile.Default ] }
    match Load.resolveProfile c None with
    | Error e -> e |> should haveSubstring "not found"
    | Ok _ -> failwith "Expected Error"

// ============================================================
// Config Load: findConfigFile Tests
// ============================================================

[<Fact>]
let ``findConfigFile finds yml in current dir`` () =
    withTempConfig "profiles:\n  test:\n    agent: claude" (fun dir ->
        let result = Load.findConfigFile dir
        result.IsSome |> should be True
        Path.GetFileName(result.Value) |> should equal ".agent-sandbox.yml")

[<Fact>]
let ``findConfigFile finds yaml variant`` () =
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yaml"), "profiles:\n  test:\n    agent: claude")
        let result = Load.findConfigFile dir
        result.IsSome |> should be True
        Path.GetFileName(result.Value) |> should equal ".agent-sandbox.yaml")

[<Fact>]
let ``findConfigFile searches upward`` () =
    withNestedDirs (fun root _child grandchild ->
        File.WriteAllText(Path.Combine(root, ".agent-sandbox.yml"), "profiles:\n  test:\n    agent: claude")
        let result = Load.findConfigFile grandchild
        result.IsSome |> should be True
        result.Value |> should equal (Path.Combine(root, ".agent-sandbox.yml")))

[<Fact>]
let ``findConfigFile nearest wins over parent`` () =
    withNestedDirs (fun root child grandchild ->
        File.WriteAllText(Path.Combine(root, ".agent-sandbox.yml"), "profiles:\n  parent:\n    agent: copilot")
        File.WriteAllText(Path.Combine(child, ".agent-sandbox.yml"), "profiles:\n  child:\n    agent: claude")
        let result = Load.findConfigFile grandchild
        result.IsSome |> should be True
        result.Value |> should equal (Path.Combine(child, ".agent-sandbox.yml")))

[<Fact>]
let ``findConfigFile returns None when no config found`` () =
    withTempDir (fun dir ->
        let result = Load.findConfigFile dir
        result |> should equal None)

// ============================================================
// Config Load: loadConfigFile Tests
// ============================================================

[<Fact>]
let ``loadConfigFile loads minimal YAML`` () =
    withTempConfig "profiles:\n  dev:\n    agent: claude" (fun dir ->
        let path = Path.Combine(dir, ".agent-sandbox.yml")
        let config = Load.loadConfigFile path
        config.Profiles.ContainsKey("dev") |> should be True
        config.Profiles["dev"].Agent |> should equal AgentType.Claude)

[<Fact>]
let ``loadConfigFile loads codex agent`` () =
    withTempConfig "profiles:\n  test:\n    agent: codex" (fun dir ->
        let path = Path.Combine(dir, ".agent-sandbox.yml")
        let config = Load.loadConfigFile path
        config.Profiles["test"].Agent |> should equal AgentType.Codex)

[<Fact>]
let ``loadConfigFile loads full YAML with all profile fields`` () =
    let yaml = """
default: full
profiles:
  full:
    agent: copilot
    agent-args:
      - "--yolo"
      - "--verbose"
    worktree:
      base: /worktrees
      on-create: "npm ci"
    nix:
      enable: true
      mount-socket: true
    docker:
      enable: true
    gcloud:
      enable: true
    aws:
      enable: true
    gpg:
      enable: true
    extra-mounts:
      - source: /host/tmp
        destination: /mnt/host-tmp
        read-only: false
    env:
      - name: MY_VAR
        value: my_value
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        let p = config.Profiles["full"]
        config.Default |> should equal (Some "full")
        p.Agent |> should equal AgentType.Copilot
        p.AgentArgs |> should equal [ "--yolo"; "--verbose" ]
        p.Worktree.IsSome |> should be True
        p.Worktree.Value.Base |> should equal (Some "/worktrees")
        p.Worktree.Value.OnCreate |> should equal (Some "npm ci")
        p.Nix.Enable |> should equal NixEnableMode.Enabled
        p.Nix.MountSocket |> should be True
        p.Docker.Enable |> should be True
        p.Gcloud.MountConfig |> should be True
        p.Aws.MountConfig |> should be True
        p.Gpg.ForwardAgent |> should be True
        p.ExtraMounts.Length |> should equal 1
        p.Env.Length |> should equal 1
        p.Env[0].Key |> should equal (Some "MY_VAR")
        p.Env[0].Val |> should equal (Some "my_value"))

[<Fact>]
let ``loadConfigFile loads multiple profiles`` () =
    let yaml = """
default: claude-dev
profiles:
  claude-dev:
    agent: claude
  copilot-dev:
    agent: copilot
    agent-args:
      - "--yolo"
  codex-dev:
    agent: codex
  claude-nix:
    agent: claude
    nix:
      enable: true
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        config.Profiles |> Map.count |> should equal 4
        config.Profiles["claude-dev"].Agent |> should equal AgentType.Claude
        config.Profiles["copilot-dev"].Agent |> should equal AgentType.Copilot
        config.Profiles["codex-dev"].Agent |> should equal AgentType.Codex
        config.Profiles["copilot-dev"].AgentArgs |> should equal [ "--yolo" ]
        config.Profiles["claude-nix"].Nix.Enable |> should equal NixEnableMode.Enabled)

[<Fact>]
let ``loadConfigFile handles nix enable false`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    nix:
      enable: false
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        config.Profiles["test"].Nix.Enable |> should equal NixEnableMode.Disabled)

[<Fact>]
let ``loadConfigFile handles nix enable auto`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    nix:
      enable: auto
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        config.Profiles["test"].Nix.Enable |> should equal NixEnableMode.Auto)

// ============================================================
// Pipeline Tests
// ============================================================

type AddArgStage(arg: string) =
    interface IStage with
        member _.Name = $"Add({arg})"
        member _.Execute(ctx) = task { return { ctx with DockerArgs = ctx.DockerArgs @ [ arg ] } }
        member _.Teardown(_) = task { return () }

[<Fact>]
let ``Pipeline runs stages in order`` () =
    task {
        let ctx = ExecutionContext.create Config.Empty Profile.Default "t" "/tmp" LogLevel.Quiet
        let! r = Pipeline.run [ AddArgStage("a"); AddArgStage("b") ] ctx
        match r with
        | Ok c -> c.DockerArgs |> should equal [ "a"; "b" ]
        | _ -> failwith "Expected Ok"
    }

type RecordingStage(name: string, order: string ResizeArray, ?shouldFail: bool) =
    interface IStage with
        member _.Name = name
        member _.Execute(ctx) = task {
            order.Add($"exec-{name}")
            if defaultArg shouldFail false then failwith "boom"
            return ctx
        }
        member _.Teardown(_) = task {
            order.Add($"teardown-{name}")
        }

[<Fact>]
let ``Pipeline calls teardown on failure for completed stages`` () =
    task {
        let order = ResizeArray<string>()
        let ctx = ExecutionContext.create Config.Empty Profile.Default "t" "/tmp" LogLevel.Quiet
        let! r = Pipeline.run [ RecordingStage("s1", order); RecordingStage("s2", order, shouldFail = true) ] ctx
        match r with
        | Error _ ->
            // s1 executed and completed, s2 executed but failed
            // s1's teardown should be called (s2 was not in completedStages)
            order |> Seq.toList |> should contain "exec-s1"
            order |> Seq.toList |> should contain "exec-s2"
            order |> Seq.toList |> should contain "teardown-s1"
        | Ok _ -> failwith "Expected Error"
    }

type NoTeardownStage(name: string, order: string ResizeArray) =
    interface IStage with
        member _.Name = name
        member _.Execute(ctx) = task {
            order.Add($"exec-{name}")
            return ctx
        }
        member _.Teardown(_) = task { return () }

[<Fact>]
let ``Pipeline runs all stages and returns final context`` () =
    task {
        let ctx = ExecutionContext.create Config.Empty Profile.Default "t" "/tmp" LogLevel.Quiet
        let! r = Pipeline.run [ AddArgStage("x"); AddArgStage("y"); AddArgStage("z") ] ctx
        match r with
        | Ok c -> c.DockerArgs |> should equal [ "x"; "y"; "z" ]
        | Error ex -> failwith $"Expected Ok, got Error: {ex.Message}"
    }

[<Fact>]
let ``Pipeline returns Error on stage failure`` () =
    task {
        let order = ResizeArray<string>()
        let ctx = ExecutionContext.create Config.Empty Profile.Default "t" "/tmp" LogLevel.Quiet
        let! r = Pipeline.run [ RecordingStage("s1", order, shouldFail = true) ] ctx
        match r with
        | Error ex -> ex.Message |> should haveSubstring "boom"
        | Ok _ -> failwith "Expected Error"
    }

[<Fact>]
let ``Pipeline teardownAll tears down in reverse order`` () =
    task {
        let order = ResizeArray<string>()
        let ctx = ExecutionContext.create Config.Empty Profile.Default "t" "/tmp" LogLevel.Quiet
        let stages : IStage list = [ RecordingStage("s1", order); RecordingStage("s2", order) ]
        do! Pipeline.teardownAll stages ctx
        // teardownAll reverses the list, so s2 teardown first, then s1
        order |> Seq.toList |> should equal [ "teardown-s2"; "teardown-s1" ]
    }

[<Fact>]
let ``ExecutionContext.create sets initial values`` () =
    let ctx = ExecutionContext.create Config.Empty Profile.Default "test" "/work" LogLevel.Normal
    ctx.ProfileName |> should equal "test"
    ctx.WorkDir |> should equal "/work"
    ctx.ImageName |> should equal "nas-sandbox"
    ctx.DockerArgs |> should be Empty
    ctx.NixEnabled |> should be False
    ctx.NetworkPromptEnabled |> should be False
    ctx.LogLevel |> should equal LogLevel.Normal

// ============================================================
// Config Deserialization Tests (parseConfig)
// ============================================================

[<Fact>]
let ``parseConfig minimal profile`` () =
    let yaml = """
default: dev
profiles:
  dev:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Default |> should equal (Some "dev")
    config.Profiles |> Map.count |> should equal 1
    let dev = config.Profiles["dev"]
    dev.Agent |> should equal AgentType.Claude
    dev.AgentArgs |> should be Empty

[<Fact>]
let ``parseConfig empty yields Empty`` () =
    let config = Load.parseConfig ""
    config.Default |> should equal None
    config.Profiles |> Map.isEmpty |> should be True

[<Fact>]
let ``parseConfig with agent-args`` () =
    let yaml = """
profiles:
  test:
    agent: copilot
    agent-args:
      - "--model"
      - "gpt-4"
"""
    let config = Load.parseConfig yaml
    let p = config.Profiles["test"]
    p.Agent |> should equal AgentType.Copilot
    p.AgentArgs |> should equal [ "--model"; "gpt-4" ]

[<Fact>]
let ``parseConfig agent-args defaults to empty`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].AgentArgs |> should be Empty

[<Fact>]
let ``parseConfig network allowlist and prompt`` () =
    let yaml = """
profiles:
  secure:
    agent: claude
    network:
      allowlist:
        - "*.github.com"
        - "api.openai.com"
      prompt:
        enable: true
        timeout-seconds: 30
        default-scope: host-port
        notify: desktop
"""
    let config = Load.parseConfig yaml
    let p = config.Profiles["secure"]
    p.Network.Allowlist |> should equal [ "*.github.com"; "api.openai.com" ]
    p.Network.Prompt.Enable |> should be True
    p.Network.Prompt.TimeoutSeconds |> should equal 30
    p.Network.Prompt.DefaultScope |> should equal ApprovalScope.HostPort
    p.Network.Prompt.Notify |> should equal NotifyMode.Desktop

[<Fact>]
let ``parseConfig network allowlist defaults to empty`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Network.Allowlist |> should be Empty

[<Fact>]
let ``parseConfig network prompt defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    let prompt = config.Profiles["test"].Network.Prompt
    prompt.Enable |> should be False
    prompt.Denylist |> should be Empty
    prompt.TimeoutSeconds |> should equal 60
    prompt.DefaultScope |> should equal ApprovalScope.Once
    prompt.Notify |> should equal NotifyMode.Auto

[<Fact>]
let ``parseConfig network prompt denylist`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    network:
      prompt:
        denylist:
          - "evil.com"
          - "*.bad.org"
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Network.Prompt.Denylist |> should equal [ "evil.com"; "*.bad.org" ]

[<Fact>]
let ``parseConfig nix enable auto`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    nix:
      enable: auto
      mount-socket: false
"""
    let config = Load.parseConfig yaml
    let p = config.Profiles["dev"]
    p.Nix.Enable |> should equal NixEnableMode.Auto
    p.Nix.MountSocket |> should be False

[<Fact>]
let ``parseConfig nix enable bool true`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    nix:
      enable: true
"""
    let config = Load.parseConfig yaml
    config.Profiles["dev"].Nix.Enable |> should equal NixEnableMode.Enabled

[<Fact>]
let ``parseConfig nix enable bool false`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    nix:
      enable: false
"""
    let config = Load.parseConfig yaml
    config.Profiles["dev"].Nix.Enable |> should equal NixEnableMode.Disabled

[<Fact>]
let ``parseConfig nix defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    let nix = config.Profiles["test"].Nix
    nix.Enable |> should equal NixEnableMode.Auto
    nix.MountSocket |> should be True

[<Fact>]
let ``parseConfig nix mount-socket override`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    nix:
      mount-socket: false
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Nix.MountSocket |> should be False

[<Fact>]
let ``parseConfig docker config`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    docker:
      enable: true
      shared: true
"""
    let config = Load.parseConfig yaml
    let p = config.Profiles["dev"]
    p.Docker.Enable |> should be True
    p.Docker.Shared |> should be True

[<Fact>]
let ``parseConfig docker defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    let d = config.Profiles["test"].Docker
    d.Enable |> should be False
    d.Shared |> should be False

[<Fact>]
let ``parseConfig docker enable true shared false`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    docker:
      enable: true
      shared: false
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Docker.Enable |> should be True
    config.Profiles["test"].Docker.Shared |> should be False

[<Fact>]
let ``parseConfig gcloud defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Gcloud.MountConfig |> should be False

[<Fact>]
let ``parseConfig gcloud enable true`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    gcloud:
      enable: true
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Gcloud.MountConfig |> should be True

[<Fact>]
let ``parseConfig aws defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Aws.MountConfig |> should be False

[<Fact>]
let ``parseConfig aws enable true`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    aws:
      enable: true
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Aws.MountConfig |> should be True

[<Fact>]
let ``parseConfig gpg defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Gpg.ForwardAgent |> should be False

[<Fact>]
let ``parseConfig gpg enable true`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    gpg:
      enable: true
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Gpg.ForwardAgent |> should be True

[<Fact>]
let ``parseConfig worktree present`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    worktree:
      base: /worktrees
      on-create: "npm install"
"""
    let config = Load.parseConfig yaml
    let wt = config.Profiles["dev"].Worktree
    wt.IsSome |> should be True
    wt.Value.Base |> should equal (Some "/worktrees")
    wt.Value.OnCreate |> should equal (Some "npm install")

[<Fact>]
let ``parseConfig worktree absent`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["dev"].Worktree |> should equal None

[<Fact>]
let ``parseConfig worktree with base only`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    worktree:
      base: develop
"""
    let config = Load.parseConfig yaml
    let wt = config.Profiles["dev"].Worktree
    wt.IsSome |> should be True
    wt.Value.Base |> should equal (Some "develop")
    wt.Value.OnCreate |> should equal None

[<Fact>]
let ``parseConfig worktree with on-create only`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    worktree:
      on-create: "make build"
"""
    let config = Load.parseConfig yaml
    let wt = config.Profiles["dev"].Worktree
    wt.IsSome |> should be True
    wt.Value.Base |> should equal None
    wt.Value.OnCreate |> should equal (Some "make build")

[<Fact>]
let ``parseConfig hostexec with rules`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    hostexec:
      prompt:
        enable: true
        timeout-seconds: 120
      rules:
        - id: git
          match:
            argv0: git
            arg-regex: "^(status|log|diff)$"
          cwd:
            mode: workspace-only
          approval: allow
          fallback: container
        - id: npm
          match:
            argv0: npm
          cwd:
            mode: any
            allow:
              - /home/user/projects
          env:
            NODE_ENV: production
          inherit-env:
            mode: minimal
            keys:
              - PATH
          approval: prompt
          fallback: deny
"""
    let config = Load.parseConfig yaml
    let he = config.Profiles["dev"].HostExec
    he.IsSome |> should be True
    let hec = he.Value
    hec.Prompt.Enable |> should be True
    hec.Prompt.TimeoutSeconds |> should equal 120
    hec.Rules.Length |> should equal 2
    let git = hec.Rules[0]
    git.Id |> should equal "git"
    git.Match.Argv0 |> should equal "git"
    git.Match.ArgRegex |> should equal (Some "^(status|log|diff)$")
    git.Cwd.Mode |> should equal HostExecCwdMode.WorkspaceOnly
    git.Approval |> should equal HostExecApproval.Allow
    git.Fallback |> should equal HostExecFallback.Container
    let npm = hec.Rules[1]
    npm.Id |> should equal "npm"
    npm.Cwd.Mode |> should equal HostExecCwdMode.Any
    npm.Cwd.Allow |> should equal [ "/home/user/projects" ]
    npm.Env |> Map.find "NODE_ENV" |> should equal "production"
    npm.InheritEnv.Mode |> should equal "minimal"
    npm.InheritEnv.Keys |> should equal [ "PATH" ]
    npm.Approval |> should equal HostExecApproval.Prompt
    npm.Fallback |> should equal HostExecFallback.Deny

[<Fact>]
let ``parseConfig hostexec absent`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["dev"].HostExec |> should equal None

[<Fact>]
let ``parseConfig ui settings`` () =
    let yaml = """
ui:
  enable: false
  port: 8080
profiles:
  dev:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Ui.Enable |> should be False
    config.Ui.Port |> should equal 8080

[<Fact>]
let ``parseConfig ui defaults when omitted`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Ui.Enable |> should be True
    config.Ui.Port |> should equal 3939

[<Fact>]
let ``parseConfig multiple profiles`` () =
    let yaml = """
default: prod
profiles:
  dev:
    agent: claude
  prod:
    agent: copilot
    agent-args:
      - "--verbose"
  test:
    agent: codex
"""
    let config = Load.parseConfig yaml
    config.Default |> should equal (Some "prod")
    config.Profiles |> Map.count |> should equal 3
    config.Profiles["dev"].Agent |> should equal AgentType.Claude
    config.Profiles["prod"].Agent |> should equal AgentType.Copilot
    config.Profiles["prod"].AgentArgs |> should equal [ "--verbose" ]
    config.Profiles["test"].Agent |> should equal AgentType.Codex

[<Fact>]
let ``parseConfig defaults for missing sections`` () =
    let yaml = """
profiles:
  minimal:
    agent: claude
"""
    let config = Load.parseConfig yaml
    let p = config.Profiles["minimal"]
    p.Nix |> should equal NixConfig.Default
    p.Docker |> should equal DockerConfig.Default
    p.Gcloud |> should equal GcloudConfig.Default
    p.Aws |> should equal AwsConfig.Default
    p.Gpg |> should equal GpgConfig.Default
    p.Network |> should equal NetworkConfig.Default
    p.Dbus |> should equal DbusConfig.Default
    p.ExtraMounts |> should be Empty
    p.Env |> should be Empty
    p.HostExec |> should equal None

[<Fact>]
let ``parseConfig dbus session`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    dbus:
      session:
        enable: true
        source-address: "unix:path=/run/user/1000/bus"
        see:
          - org.freedesktop.Notifications
        talk:
          - org.freedesktop.Notifications
"""
    let config = Load.parseConfig yaml
    let dbus = config.Profiles["dev"].Dbus
    dbus.Session.Enable |> should be True
    dbus.Session.SourceAddress |> should equal (Some "unix:path=/run/user/1000/bus")
    dbus.Session.See |> should equal [ "org.freedesktop.Notifications" ]
    dbus.Session.Talk |> should equal [ "org.freedesktop.Notifications" ]

[<Fact>]
let ``parseConfig dbus session defaults to disabled`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    let dbus = config.Profiles["test"].Dbus
    dbus.Session.Enable |> should be False
    dbus.Session.SourceAddress |> should equal None
    dbus.Session.See |> should be Empty
    dbus.Session.Talk |> should be Empty

[<Fact>]
let ``parseConfig dbus session with own calls broadcasts`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    dbus:
      session:
        enable: true
        see:
          - org.freedesktop.secrets
        talk:
          - org.freedesktop.secrets
        own:
          - org.example.Owned
"""
    let config = Load.parseConfig yaml
    let sess = config.Profiles["dev"].Dbus.Session
    sess.Enable |> should be True
    sess.See |> should equal [ "org.freedesktop.secrets" ]
    sess.Talk |> should equal [ "org.freedesktop.secrets" ]
    sess.Own |> should equal [ "org.example.Owned" ]

[<Fact>]
let ``parseConfig extra mounts and env`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    extra-mounts:
      - source: /host/data
        destination: /data
        read-only: true
    env:
      - name: FOO
        value: bar
      - name: HOME
        from-host: true
"""
    let config = Load.parseConfig yaml
    let p = config.Profiles["dev"]
    p.ExtraMounts.Length |> should equal 1
    p.ExtraMounts[0].Src |> should equal "/host/data"
    p.ExtraMounts[0].Dst |> should equal "/data"
    p.ExtraMounts[0].Mode |> should equal "ro"
    p.Env.Length |> should equal 2
    p.Env[0].Key |> should equal (Some "FOO")
    p.Env[0].Val |> should equal (Some "bar")
    p.Env[0].KeyCmd |> should equal None
    p.Env[1].Key |> should equal (Some "HOME")
    p.Env[1].Val |> should equal None
    p.Env[1].KeyCmd |> should equal None

[<Fact>]
let ``parseConfig extra mounts defaults to empty`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].ExtraMounts |> should be Empty

[<Fact>]
let ``parseConfig env defaults to empty`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Env |> should be Empty

[<Fact>]
let ``parseConfig extra mounts read-only defaults to false`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    extra-mounts:
      - source: /a
        destination: /b
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].ExtraMounts[0].Mode |> should equal "rw"

[<Fact>]
let ``parseConfig multiple extra mounts`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    extra-mounts:
      - source: /a
        destination: /b
        read-only: true
      - source: /c
        destination: /d
        read-only: false
"""
    let config = Load.parseConfig yaml
    let mounts = config.Profiles["test"].ExtraMounts
    mounts.Length |> should equal 2
    mounts[0].Src |> should equal "/a"
    mounts[0].Dst |> should equal "/b"
    mounts[0].Mode |> should equal "ro"
    mounts[1].Src |> should equal "/c"
    mounts[1].Dst |> should equal "/d"
    mounts[1].Mode |> should equal "rw"

[<Fact>]
let ``parseConfig network gradle config`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    network:
      gradle:
        enable: true
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Network.Gradle.Proxy |> should equal GradleProxyMode.On

[<Fact>]
let ``parseConfig network gradle defaults`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Network.Gradle.Proxy |> should equal GradleProxyMode.Off

[<Fact>]
let ``parseConfig comprehensive`` () =
    let yaml = """
default: main
ui:
  enable: true
  port: 4000
profiles:
  main:
    agent: copilot
    agent-args:
      - "--verbose"
    worktree:
      base: /worktrees
      on-create: "make setup"
    nix:
      enable: true
      mount-socket: false
    docker:
      enable: true
      shared: false
    gcloud:
      enable: true
    aws:
      enable: true
    gpg:
      enable: true
    network:
      allowlist:
        - "*.npmjs.org"
      prompt:
        enable: true
        denylist:
          - "evil.com"
        timeout-seconds: 45
        default-scope: host
        notify: off
      gradle:
        enable: true
    dbus:
      session:
        enable: true
        see:
          - org.example.Service
    extra-mounts:
      - source: /mnt/data
        destination: /data
        read-only: false
    env:
      - name: EDITOR
        value: vim
    hostexec:
      prompt:
        enable: true
        timeout-seconds: 90
        default-scope: capability
        notify: auto
      rules:
        - id: make
          match:
            argv0: make
          cwd:
            mode: workspace-or-session-tmp
          approval: allow
          fallback: container
"""
    let config = Load.parseConfig yaml
    config.Default |> should equal (Some "main")
    config.Ui.Port |> should equal 4000
    let p = config.Profiles["main"]
    p.Agent |> should equal AgentType.Copilot
    p.AgentArgs |> should equal [ "--verbose" ]
    p.Worktree.IsSome |> should be True
    p.Worktree.Value.Base |> should equal (Some "/worktrees")
    p.Worktree.Value.OnCreate |> should equal (Some "make setup")
    p.Nix.Enable |> should equal NixEnableMode.Enabled
    p.Nix.MountSocket |> should be False
    p.Docker.Enable |> should be True
    p.Gcloud.MountConfig |> should be True
    p.Aws.MountConfig |> should be True
    p.Gpg.ForwardAgent |> should be True
    p.Network.Allowlist |> should equal [ "*.npmjs.org" ]
    p.Network.Prompt.Enable |> should be True
    p.Network.Prompt.Denylist |> should equal [ "evil.com" ]
    p.Network.Prompt.TimeoutSeconds |> should equal 45
    p.Network.Prompt.DefaultScope |> should equal ApprovalScope.Host
    p.Network.Prompt.Notify |> should equal NotifyMode.Off
    p.Network.Gradle.Proxy |> should equal GradleProxyMode.On
    p.Dbus.Session.Enable |> should be True
    p.Dbus.Session.See |> should equal [ "org.example.Service" ]
    p.ExtraMounts.Length |> should equal 1
    p.Env.Length |> should equal 1
    p.HostExec.IsSome |> should be True
    p.HostExec.Value.Rules.Length |> should equal 1
    p.HostExec.Value.Rules[0].Id |> should equal "make"
    p.HostExec.Value.Rules[0].Cwd.Mode |> should equal HostExecCwdMode.WorkspaceOrSessionTmp

// ============================================================
// Config Deserialization: codex agent
// ============================================================

[<Fact>]
let ``parseConfig codex agent is valid`` () =
    let yaml = """
profiles:
  test:
    agent: codex
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Agent |> should equal AgentType.Codex

// ============================================================
// Config Deserialization: invalid agent throws
// ============================================================

[<Fact>]
let ``parseConfig invalid agent throws`` () =
    let yaml = """
profiles:
  test:
    agent: invalid
"""
    (fun () -> Load.parseConfig yaml |> ignore)
    |> should throw typeof<Exception>

// ============================================================
// Config Deserialization: no default is ok
// ============================================================

[<Fact>]
let ``parseConfig no default is ok`` () =
    let yaml = """
profiles:
  test:
    agent: claude
"""
    let config = Load.parseConfig yaml
    config.Default |> should equal None

// ============================================================
// Config Deserialization: env from-host default
// ============================================================

[<Fact>]
let ``parseConfig env defaults for key/val`` () =
    let yaml = """
profiles:
  test:
    agent: claude
    env:
      - name: FOO
        value: bar
"""
    let config = Load.parseConfig yaml
    config.Profiles["test"].Env[0].KeyCmd |> should equal None

// ============================================================
// Config Deserialization: hostexec secrets
// ============================================================

[<Fact>]
let ``parseConfig hostexec with secrets`` () =
    let yaml = """
profiles:
  dev:
    agent: claude
    hostexec:
      secrets:
        github_token:
          source: env
          env: GITHUB_TOKEN
      rules: []
"""
    let config = Load.parseConfig yaml
    let he = config.Profiles["dev"].HostExec
    he.IsSome |> should be True
    he.Value.Secrets.ContainsKey("github_token") |> should be True
    he.Value.Secrets["github_token"].From |> should equal "env:GITHUB_TOKEN"
    he.Value.Secrets["github_token"].Required |> should be True

// ============================================================
// Config Deserialization: hostexec cwd modes
// ============================================================

[<Theory>]
[<InlineData("workspace-only", 0)>]
[<InlineData("workspace-or-session-tmp", 1)>]
[<InlineData("allowlist", 2)>]
[<InlineData("any", 3)>]
let ``parseConfig hostexec cwd modes`` (modeStr: string, expectedOrdinal: int) =
    let yaml = $"""
profiles:
  dev:
    agent: claude
    hostexec:
      rules:
        - id: test
          match:
            argv0: test
          cwd:
            mode: {modeStr}
          approval: allow
          fallback: deny
"""
    let config = Load.parseConfig yaml
    let mode = config.Profiles["dev"].HostExec.Value.Rules[0].Cwd.Mode
    let expected =
        match expectedOrdinal with
        | 0 -> HostExecCwdMode.WorkspaceOnly
        | 1 -> HostExecCwdMode.WorkspaceOrSessionTmp
        | 2 -> HostExecCwdMode.Allowlist
        | 3 -> HostExecCwdMode.Any
        | _ -> failwith "unexpected"
    mode |> should equal expected

// ============================================================
// Config Deserialization: hostexec approval/fallback combos
// ============================================================

[<Theory>]
[<InlineData("allow", "container")>]
[<InlineData("prompt", "deny")>]
[<InlineData("deny", "container")>]
let ``parseConfig hostexec approval and fallback combos`` (approvalStr: string, fallbackStr: string) =
    let yaml = $"""
profiles:
  dev:
    agent: claude
    hostexec:
      rules:
        - id: test
          match:
            argv0: test
          cwd:
            mode: workspace-only
          approval: {approvalStr}
          fallback: {fallbackStr}
"""
    let config = Load.parseConfig yaml
    let rule = config.Profiles["dev"].HostExec.Value.Rules[0]
    let expectedApproval =
        match approvalStr with
        | "allow" -> HostExecApproval.Allow
        | "prompt" -> HostExecApproval.Prompt
        | "deny" -> HostExecApproval.Deny
        | _ -> failwith "unexpected"
    let expectedFallback =
        match fallbackStr with
        | "container" -> HostExecFallback.Container
        | "deny" -> HostExecFallback.Deny
        | _ -> failwith "unexpected"
    rule.Approval |> should equal expectedApproval
    rule.Fallback |> should equal expectedFallback

// ============================================================
// Config Deserialization: network notify modes
// ============================================================

[<Theory>]
[<InlineData("auto")>]
[<InlineData("desktop")>]
[<InlineData("off")>]
let ``parseConfig network prompt notify modes`` (notifyStr: string) =
    let yaml = $"""
profiles:
  test:
    agent: claude
    network:
      prompt:
        notify: {notifyStr}
"""
    let config = Load.parseConfig yaml
    let expected =
        match notifyStr with
        | "auto" -> NotifyMode.Auto
        | "desktop" -> NotifyMode.Desktop
        | "off" -> NotifyMode.Off
        | _ -> failwith "unexpected"
    config.Profiles["test"].Network.Prompt.Notify |> should equal expected

// ============================================================
// Config Deserialization: approval scope parsing
// ============================================================

[<Theory>]
[<InlineData("once")>]
[<InlineData("host-port")>]
[<InlineData("host")>]
let ``parseConfig network prompt default-scope`` (scopeStr: string) =
    let yaml = $"""
profiles:
  test:
    agent: claude
    network:
      prompt:
        default-scope: {scopeStr}
"""
    let config = Load.parseConfig yaml
    let expected =
        match scopeStr with
        | "once" -> ApprovalScope.Once
        | "host-port" -> ApprovalScope.HostPort
        | "host" -> ApprovalScope.Host
        | _ -> failwith "unexpected"
    config.Profiles["test"].Network.Prompt.DefaultScope |> should equal expected

// ============================================================
// Config Loading: E2E file-based tests
// ============================================================

[<Fact>]
let ``E2E load YAML and resolve default profile`` () =
    let yaml = """
default: production
profiles:
  staging:
    agent: copilot
  production:
    agent: claude
    agent-args:
      - "--verbose"
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        match Load.resolveProfile config None with
        | Ok (name, profile) ->
            name |> should equal "production"
            profile.Agent |> should equal AgentType.Claude
            profile.AgentArgs |> should equal [ "--verbose" ]
        | Error e -> failwith $"Expected Ok: {e}")

[<Fact>]
let ``E2E load YAML and resolve explicit profile`` () =
    let yaml = """
default: production
profiles:
  staging:
    agent: copilot
    agent-args:
      - "--yolo"
  production:
    agent: claude
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        match Load.resolveProfile config (Some "staging") with
        | Ok (name, profile) ->
            name |> should equal "staging"
            profile.Agent |> should equal AgentType.Copilot
            profile.AgentArgs |> should equal [ "--yolo" ]
        | Error e -> failwith $"Expected Ok: {e}")

[<Fact>]
let ``E2E load YAML with single profile auto-resolves`` () =
    let yaml = """
profiles:
  only:
    agent: claude
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        match Load.resolveProfile config None with
        | Ok (name, profile) ->
            name |> should equal "only"
            profile.Agent |> should equal AgentType.Claude
        | Error e -> failwith $"Expected Ok: {e}")

[<Fact>]
let ``E2E load complex YAML with all fields`` () =
    let yaml = """
default: full-stack
profiles:
  full-stack:
    agent: claude
    agent-args:
      - "--verbose"
    worktree:
      base: /worktrees
      on-create: "npm install && npm run build"
    nix:
      enable: true
      mount-socket: true
    docker:
      enable: true
    gcloud:
      enable: true
    aws:
      enable: true
    gpg:
      enable: true
    extra-mounts:
      - source: /host/data
        destination: /data
        read-only: false
    env:
      - name: NODE_ENV
        value: development
"""
    withTempDir (fun dir ->
        File.WriteAllText(Path.Combine(dir, ".agent-sandbox.yml"), yaml)
        let config = Load.loadConfigFile (Path.Combine(dir, ".agent-sandbox.yml"))
        match Load.resolveProfile config None with
        | Ok (_, profile) ->
            profile.Agent |> should equal AgentType.Claude
            profile.AgentArgs |> should equal [ "--verbose" ]
            profile.Worktree.IsSome |> should be True
            profile.Worktree.Value.Base |> should equal (Some "/worktrees")
            profile.Worktree.Value.OnCreate |> should equal (Some "npm install && npm run build")
            profile.Nix.Enable |> should equal NixEnableMode.Enabled
            profile.Docker.Enable |> should be True
            profile.Gcloud.MountConfig |> should be True
            profile.Aws.MountConfig |> should be True
            profile.Gpg.ForwardAgent |> should be True
            profile.ExtraMounts.Length |> should equal 1
            profile.Env.Length |> should equal 1
        | Error e -> failwith $"Expected Ok: {e}")

// ============================================================
// NotifyUtils Tests
// ============================================================

[<Fact>]
let ``NotifyUtils isWsl is a lazy value`` () =
    // Just verify it can be accessed without throwing
    let _ = NotifyUtils.isWsl.Value
    ()

[<Fact>]
let ``NotifyUtils isWsl returns bool`` () =
    let result = NotifyUtils.isWsl.Value
    // In CI/Linux this should be false (not WSL), but we just check it's a bool
    (result = true || result = false) |> should be True

// ============================================================
// RuntimeRegistry Tests
// ============================================================

[<Fact>]
let ``RuntimeRegistry getRuntimeDir returns valid path`` () =
    let dir = RuntimeRegistry.getRuntimeDir ()
    dir |> should not' (equal "")
    dir |> should haveSubstring "nas"

[<Fact>]
let ``RuntimeRegistry getDataDir returns valid path`` () =
    let dir = RuntimeRegistry.getDataDir ()
    dir |> should not' (equal "")
    dir |> should haveSubstring "nas"

[<Fact>]
let ``RuntimeRegistry writeSessionFile and removeSessionFile`` () =
    withTempDir (fun dir ->
        let path = RuntimeRegistry.writeSessionFile dir "test-session" """{"id":"test"}"""
        File.Exists(path) |> should be True
        RuntimeRegistry.removeSessionFile dir "test-session"
        File.Exists(path) |> should be False)

[<Fact>]
let ``RuntimeRegistry listSessionFiles`` () =
    withTempDir (fun dir ->
        RuntimeRegistry.writeSessionFile dir "s1" "{}" |> ignore
        RuntimeRegistry.writeSessionFile dir "s2" "{}" |> ignore
        let files = RuntimeRegistry.listSessionFiles dir
        files.Length |> should equal 2)

[<Fact>]
let ``RuntimeRegistry writePendingFile and removePendingFile`` () =
    withTempDir (fun dir ->
        let path = RuntimeRegistry.writePendingFile dir "sess1" "req1" """{"r":"1"}"""
        File.Exists(path) |> should be True
        RuntimeRegistry.removePendingFile dir "sess1" "req1"
        File.Exists(path) |> should be False)

[<Fact>]
let ``RuntimeRegistry listPendingFiles`` () =
    withTempDir (fun dir ->
        RuntimeRegistry.writePendingFile dir "sess1" "r1" "{}" |> ignore
        RuntimeRegistry.writePendingFile dir "sess1" "r2" "{}" |> ignore
        let files = RuntimeRegistry.listPendingFiles dir "sess1"
        files.Length |> should equal 2)

[<Fact>]
let ``RuntimeRegistry listPendingFiles returns empty for nonexistent session`` () =
    withTempDir (fun dir ->
        let files = RuntimeRegistry.listPendingFiles dir "nonexistent"
        files |> should be Empty)

[<Fact>]
let ``RuntimeRegistry gc cleans up orphaned pending dirs`` () =
    withTempDir (fun dir ->
        // Create a session and a pending dir for it
        RuntimeRegistry.writeSessionFile dir "active" "{}" |> ignore
        RuntimeRegistry.writePendingFile dir "active" "r1" "{}" |> ignore
        // Create an orphaned pending dir (no session file)
        RuntimeRegistry.writePendingFile dir "orphan" "r1" "{}" |> ignore
        RuntimeRegistry.gc dir
        // Active session's pending should remain
        RuntimeRegistry.listPendingFiles dir "active" |> List.length |> should equal 1
        // Orphaned pending should be cleaned up
        RuntimeRegistry.listPendingFiles dir "orphan" |> should be Empty)

// ============================================================
// Schema (FluentValidation) Tests
// ============================================================

[<Fact>]
let ``ProfileValidator accepts valid profile`` () =
    let validator = ProfileValidator()
    let result = validator.Validate(Profile.Default)
    result.IsValid |> should be True

[<Fact>]
let ``ProfileValidator rejects invalid allowlist entry`` () =
    let validator = ProfileValidator()
    let p = { Profile.Default with Network = { NetworkConfig.Default with Allowlist = [ "git*hub.com" ] } }
    let result = validator.Validate(p)
    result.IsValid |> should be False

[<Fact>]
let ``ProfileValidator accepts valid allowlist entries`` () =
    let validator = ProfileValidator()
    let p = { Profile.Default with Network = { NetworkConfig.Default with Allowlist = [ "*.github.com"; "api.openai.com" ] } }
    let result = validator.Validate(p)
    result.IsValid |> should be True

[<Fact>]
let ``ConfigValidator accepts valid config`` () =
    let validator = ConfigValidator()
    let c = { Config.Empty with Profiles = Map.ofList [ "dev", Profile.Default ] }
    let result = validator.Validate(c)
    result.IsValid |> should be True

[<Fact>]
let ``ConfigValidator rejects invalid port`` () =
    let validator = ConfigValidator()
    let c = { Config.Empty with Ui = { UiConfig.Default with Port = 0 } }
    let result = validator.Validate(c)
    result.IsValid |> should be False

[<Fact>]
let ``ConfigValidator rejects port above 65535`` () =
    let validator = ConfigValidator()
    let c = { Config.Empty with Ui = { UiConfig.Default with Port = 70000 } }
    let result = validator.Validate(c)
    result.IsValid |> should be False

[<Fact>]
let ``ProfileValidator rejects zero timeout`` () =
    let validator = ProfileValidator()
    let prompt = { NetworkPromptConfig.Default with TimeoutSeconds = 0 }
    let p = { Profile.Default with Network = { NetworkConfig.Default with Prompt = prompt } }
    let result = validator.Validate(p)
    result.IsValid |> should be False

[<Fact>]
let ``ProfileValidator accepts positive timeout`` () =
    let validator = ProfileValidator()
    let prompt = { NetworkPromptConfig.Default with TimeoutSeconds = 300 }
    let p = { Profile.Default with Network = { NetworkConfig.Default with Prompt = prompt } }
    let result = validator.Validate(p)
    result.IsValid |> should be True

// ============================================================
// Config Default Values Tests
// ============================================================

[<Fact>]
let ``Config.Empty has no default`` () =
    Config.Empty.Default |> should equal None

[<Fact>]
let ``Config.Empty has default UI`` () =
    Config.Empty.Ui |> should equal UiConfig.Default

[<Fact>]
let ``Config.Empty has no profiles`` () =
    Config.Empty.Profiles |> Map.isEmpty |> should be True

[<Fact>]
let ``Profile.Default has claude agent`` () =
    Profile.Default.Agent |> should equal AgentType.Claude

[<Fact>]
let ``Profile.Default has empty agent args`` () =
    Profile.Default.AgentArgs |> should be Empty

[<Fact>]
let ``Profile.Default has no worktree`` () =
    Profile.Default.Worktree |> should equal None

[<Fact>]
let ``Profile.Default has auto nix`` () =
    Profile.Default.Nix.Enable |> should equal NixEnableMode.Auto

[<Fact>]
let ``Profile.Default has nix mount socket true`` () =
    Profile.Default.Nix.MountSocket |> should be True

[<Fact>]
let ``Profile.Default has docker disabled`` () =
    Profile.Default.Docker.Enable |> should be False
    Profile.Default.Docker.Shared |> should be False

[<Fact>]
let ``Profile.Default has gcloud disabled`` () =
    Profile.Default.Gcloud.MountConfig |> should be False

[<Fact>]
let ``Profile.Default has aws disabled`` () =
    Profile.Default.Aws.MountConfig |> should be False

[<Fact>]
let ``Profile.Default has gpg disabled`` () =
    Profile.Default.Gpg.ForwardAgent |> should be False

[<Fact>]
let ``Profile.Default has empty network`` () =
    Profile.Default.Network |> should equal NetworkConfig.Default

[<Fact>]
let ``Profile.Default has default dbus`` () =
    Profile.Default.Dbus |> should equal DbusConfig.Default

[<Fact>]
let ``Profile.Default has empty extra mounts`` () =
    Profile.Default.ExtraMounts |> should be Empty

[<Fact>]
let ``Profile.Default has empty env`` () =
    Profile.Default.Env |> should be Empty

[<Fact>]
let ``Profile.Default has no hostexec`` () =
    Profile.Default.HostExec |> should equal None

[<Fact>]
let ``NetworkConfig.Default has empty allowlist`` () =
    NetworkConfig.Default.Allowlist |> should be Empty

[<Fact>]
let ``NetworkPromptConfig.Default values`` () =
    let d = NetworkPromptConfig.Default
    d.Enable |> should be False
    d.Denylist |> should be Empty
    d.TimeoutSeconds |> should equal 60
    d.DefaultScope |> should equal ApprovalScope.Once
    d.Notify |> should equal NotifyMode.Auto

[<Fact>]
let ``UiConfig.Default values`` () =
    UiConfig.Default.Enable |> should be True
    UiConfig.Default.Port |> should equal 3939

[<Fact>]
let ``WorktreeConfig.Default values`` () =
    WorktreeConfig.Default.Enable |> should be False
    WorktreeConfig.Default.Base |> should equal None
    WorktreeConfig.Default.OnCreate |> should equal None

[<Fact>]
let ``HostExecPromptConfig.Default values`` () =
    let d = HostExecPromptConfig.Default
    d.Enable |> should be False
    d.TimeoutSeconds |> should equal 60
    d.DefaultScope |> should equal "once"
    d.Notify |> should equal NotifyMode.Auto

[<Fact>]
let ``HostExecInheritEnvConfig.Default values`` () =
    HostExecInheritEnvConfig.Default.Mode |> should equal "minimal"
    HostExecInheritEnvConfig.Default.Keys |> should be Empty

[<Fact>]
let ``HostExecConfig.Default values`` () =
    let d = HostExecConfig.Default
    d.Prompt |> should equal HostExecPromptConfig.Default
    d.Secrets |> Map.isEmpty |> should be True
    d.Rules |> should be Empty
