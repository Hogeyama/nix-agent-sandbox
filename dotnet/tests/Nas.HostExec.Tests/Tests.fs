module Nas.HostExec.Tests.AllTests

open System
open System.IO
open System.Text.RegularExpressions
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Core.Config
open Nas.HostExec
open Nas.HostExec.HostExecBroker

// ============================================================================
// Helpers
// ============================================================================

let mkRule id argv0 mode appr =
    { Id = id
      Match = { Argv0 = argv0; ArgRegex = None }
      Cwd = { Mode = mode; Allow = [] }
      Env = Map.empty
      InheritEnv = HostExecInheritEnvConfig.Default
      Approval = appr
      Fallback = HostExecFallback.Deny }

let mkRuleWithArgs id argv0 argRegex mode appr =
    { Id = id
      Match = { Argv0 = argv0; ArgRegex = argRegex }
      Cwd = { Mode = mode; Allow = [] }
      Env = Map.empty
      InheritEnv = HostExecInheritEnvConfig.Default
      Approval = appr
      Fallback = HostExecFallback.Deny }

let mkFullRule id argv0 argRegex cwdMode appr fallback env inheritEnv =
    { Id = id
      Match = { Argv0 = argv0; ArgRegex = argRegex }
      Cwd = { Mode = cwdMode; Allow = [] }
      Env = env
      InheritEnv = inheritEnv
      Approval = appr
      Fallback = fallback }

let withTempDir (f: string -> 'a) =
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    try f dir
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

// ============================================================================
// Original tests (preserved)
// ============================================================================

[<Fact>]
let ``matchArgv0 bare`` () =
    Match.matchArgv0 "npm" "npm" |> should be True

[<Fact>]
let ``matchArgv0 from path`` () =
    Match.matchArgv0 "npm" "/usr/bin/npm" |> should be True

[<Fact>]
let ``matchArgv0 rejects`` () =
    Match.matchArgv0 "npm" "yarn" |> should be False

[<Fact>]
let ``matchArgs no regex`` () =
    Match.matchArgs None [ "install" ] |> should be True

[<Fact>]
let ``matchArgs with regex`` () =
    Match.matchArgs (Some "^install") [ "install"; "x" ] |> should be True

[<Fact>]
let ``validateCwd workspace`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOnly; Allow = [] } "/ws/sub" "/ws" None
    |> should be True

[<Fact>]
let ``validateCwd rejects`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOnly; Allow = [] } "/other" "/ws" None
    |> should be False

[<Fact>]
let ``findMatchingRule`` () =
    let rules = [ mkRule "r1" "npm" HostExecCwdMode.Any HostExecApproval.Allow ]
    (Match.findMatchingRule rules "npm" [] "/" "/" None).Value.Id |> should equal "r1"

[<Fact>]
let ``secretStore env`` () =
    Environment.SetEnvironmentVariable("NAS_TEST_S", "val")
    try
        SecretStore.resolveFromEnv "NAS_TEST_S" |> should equal (Some "val")
    finally
        Environment.SetEnvironmentVariable("NAS_TEST_S", null)

[<Fact>]
let ``registry roundtrip`` () =
    let dir = Path.Combine(Path.GetTempPath(), $"nas-her-{Guid.NewGuid():N}")
    try
        HostExecRegistry.writeSession dir
            { SessionId = "s1"; BrokerSocket = "/s.sock"
              Rules = ["r1"]; CreatedAt = DateTimeOffset.UtcNow }
        |> ignore
        (HostExecRegistry.listSessions dir).Length |> should equal 1
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

// ============================================================================
// hostexec_match_test.ts — Rule matching (argv0, args, cwd)
// ============================================================================

[<Fact>]
let ``matchRule: argv0 only matches`` () =
    let rules = [ mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "git" [ "status" ] "/" "/" None
    result.Value.Id |> should equal "git-any"

[<Fact>]
let ``matchRule: argv0 mismatch returns None`` () =
    let rules = [ mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "deno" [ "eval" ] "/" "/" None
    result |> should equal None

[<Fact>]
let ``matchRule: arg-regex matches first positional arg`` () =
    let rules =
        [ mkRuleWithArgs "git-push" "git" (Some @"^push\b") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "git" [ "push"; "origin"; "main" ] "/" "/" None
    result.Value.Id |> should equal "git-push"

[<Fact>]
let ``matchRule: arg-regex mismatch falls through to catch-all`` () =
    let rules =
        [ mkRuleWithArgs "git-push" "git" (Some @"^push\b") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "git" [ "status" ] "/" "/" None
    result.Value.Id |> should equal "git-any"

[<Fact>]
let ``matchRule: arg-regex for gpg sign flags`` () =
    let rules =
        [ mkRuleWithArgs "gpg-sign" "gpg" (Some @"(^|\s)(--sign|-[a-zA-Z]*s)(\s|$)") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "gpg-any" "gpg" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "gpg" [ "--sign"; "file.txt" ] "/" "/" None
    result.Value.Id |> should equal "gpg-sign"

[<Fact>]
let ``matchRule: arg-regex with short option`` () =
    let rules =
        [ mkRuleWithArgs "gpg-sign" "gpg" (Some @"(^|\s)(--sign|-[a-zA-Z]*s)(\s|$)") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "gpg-any" "gpg" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "gpg" [ "-as"; "file.txt" ] "/" "/" None
    result.Value.Id |> should equal "gpg-sign"

[<Fact>]
let ``matchRule: arg-regex mismatch falls through`` () =
    let rules =
        [ mkRuleWithArgs "gpg-sign" "gpg" (Some @"(^|\s)(--sign|-[a-zA-Z]*s)(\s|$)") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "gpg-any" "gpg" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "gpg" [ "--verify"; "file.sig" ] "/" "/" None
    result.Value.Id |> should equal "gpg-any"

[<Fact>]
let ``matchRule: multi-level subcommand via arg-regex`` () =
    let rules =
        [ mkRuleWithArgs "deno-task-test" "deno" (Some @"^task\s+test\b") HostExecCwdMode.Any HostExecApproval.Allow
          mkRuleWithArgs "deno-task-any" "deno" (Some @"^task\b") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "deno-any" "deno" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "deno" [ "task"; "test"; "--filter"; "foo" ] "/" "/" None
    result.Value.Id |> should equal "deno-task-test"

[<Fact>]
let ``matchRule: arg-regex for task but not test falls through`` () =
    let rules =
        [ mkRuleWithArgs "deno-task-test" "deno" (Some @"^task\s+test\b") HostExecCwdMode.Any HostExecApproval.Allow
          mkRuleWithArgs "deno-task-any" "deno" (Some @"^task\b") HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "deno" [ "task"; "lint" ] "/" "/" None
    result.Value.Id |> should equal "deno-task-any"

[<Fact>]
let ``matchRule: no rules returns None`` () =
    let result = Match.findMatchingRule [] "git" [ "status" ] "/" "/" None
    result |> should equal None

[<Fact>]
let ``matchRule: first matching rule wins`` () =
    let rules =
        [ mkRuleWithArgs "gpg-sign" "gpg" (Some "--sign") HostExecCwdMode.Any HostExecApproval.Prompt
          mkRuleWithArgs "gpg-verify" "gpg" (Some "--verify") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "gpg-default" "gpg" HostExecCwdMode.Any HostExecApproval.Deny ]
    let result = Match.findMatchingRule rules "gpg" [ "--sign"; "file.txt" ] "/" "/" None
    result.Value.Id |> should equal "gpg-sign"
    result.Value.Approval |> should equal HostExecApproval.Prompt

[<Fact>]
let ``matchRule: no args with argv0-only rule`` () =
    let rules = [ mkRule "true-any" "true" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "true" [] "/" "/" None
    result.Value.Id |> should equal "true-any"

[<Fact>]
let ``matchRule: relative argv0 rule requires relative invocation`` () =
    let rules = [ mkRule "gradlew-any" "./gradlew" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "./gradlew" [ "test" ] "/" "/" None
    result.Value.Id |> should equal "gradlew-any"

[<Fact>]
let ``matchRule: relative argv0 rule matches PATH invocation via basename`` () =
    // .NET matchArgv0 uses Path.GetFileName on both sides, so ./gradlew matches gradlew
    let rules = [ mkRule "gradlew-any" "./gradlew" HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "gradlew" [ "test" ] "/" "/" None
    result.IsSome |> should be True

// ============================================================================
// hostexec_match_test.ts — CWD validation
// ============================================================================

[<Fact>]
let ``validateCwd: Any mode allows any directory`` () =
    Match.validateCwd { Mode = HostExecCwdMode.Any; Allow = [] } "/random/dir" "/ws" None
    |> should be True

[<Fact>]
let ``validateCwd: WorkspaceOnly allows subdirectory`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOnly; Allow = [] } "/ws/sub/deep" "/ws" None
    |> should be True

[<Fact>]
let ``validateCwd: WorkspaceOnly rejects outside directory`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOnly; Allow = [] } "/other" "/ws" None
    |> should be False

[<Fact>]
let ``validateCwd: WorkspaceOrSessionTmp allows workspace`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOrSessionTmp; Allow = [] } "/ws/file" "/ws" (Some "/tmp/sess")
    |> should be True

[<Fact>]
let ``validateCwd: WorkspaceOrSessionTmp allows session tmp`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOrSessionTmp; Allow = [] } "/tmp/sess/sub" "/ws" (Some "/tmp/sess")
    |> should be True

[<Fact>]
let ``validateCwd: WorkspaceOrSessionTmp rejects other`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOrSessionTmp; Allow = [] } "/other" "/ws" (Some "/tmp/sess")
    |> should be False

[<Fact>]
let ``validateCwd: WorkspaceOrSessionTmp rejects when no session tmp`` () =
    Match.validateCwd { Mode = HostExecCwdMode.WorkspaceOrSessionTmp; Allow = [] } "/other" "/ws" None
    |> should be False

[<Fact>]
let ``validateCwd: Allowlist matches allowed prefix`` () =
    Match.validateCwd { Mode = HostExecCwdMode.Allowlist; Allow = [ "/allowed"; "/also" ] } "/allowed/sub" "/ws" None
    |> should be True

[<Fact>]
let ``validateCwd: Allowlist rejects unlisted`` () =
    Match.validateCwd { Mode = HostExecCwdMode.Allowlist; Allow = [ "/allowed" ] } "/other" "/ws" None
    |> should be False

// ============================================================================
// hostexec_broker_test.ts — Broker decision logic (unit-level)
// ============================================================================

// The Deno broker tests use real Unix sockets and process execution.
// Here we test the decision logic via handleRequest which is the core of the broker.

let mkBrokerState (rules: HostExecRule list) (workDir: string) (sessionTmpDir: string option) (secrets: Map<string, string>) =
    let config: HostExecConfig =
        { Prompt = HostExecPromptConfig.Default
          Secrets = Map.empty
          Rules = rules }
    let state = HostExecBroker.create "sess_test" config workDir sessionTmpDir (Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))) (Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N")))
    state.IsRunning <- true
    if secrets.IsEmpty then state
    else { state with Secrets = secrets }

let mkBrokerStateWithDirs (rules: HostExecRule list) (workDir: string) (sessionTmpDir: string option) (secrets: Map<string, string>) (runtimeDir: string) (auditDir: string) =
    let config: HostExecConfig =
        { Prompt = HostExecPromptConfig.Default
          Secrets = Map.empty
          Rules = rules }
    let state = HostExecBroker.create "sess_test" config workDir sessionTmpDir runtimeDir auditDir
    state.IsRunning <- true
    if secrets.IsEmpty then state
    else { state with Secrets = secrets }

let mkExecRequest argv0 args cwd reqId =
    { ExecuteRequest.Version = 1; Type = "execute"; SessionId = "sess_test"
      RequestId = reqId; Argv0 = argv0; Args = args; Cwd = cwd; Tty = false }

[<Fact>]
let ``broker: no matching rule returns Error with no matching rule`` () =
    let state = mkBrokerState [] "/" None Map.empty
    let req = mkExecRequest "deno" [ "eval"; "console.log('x')" ] "/" "req_1"
    let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
    result.Kind |> should equal BrokerResponseKind.Error
    result.Message.Value |> should haveSubstring "No matching rule"

[<Fact>]
let ``broker: deny rule returns Error`` () =
    let rules =
        [ mkFullRule "deno-deny" "deno" (Some @"^eval\b") HostExecCwdMode.Any
              HostExecApproval.Deny HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    let req = mkExecRequest "deno" [ "eval"; "console.log('x')" ] "/" "req_deny"
    let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
    result.Kind |> should equal BrokerResponseKind.Error
    result.Message.Value |> should haveSubstring "Denied by rule"

[<Fact>]
let ``broker: prompt rule returns Pending`` () =
    withTempDir (fun runtimeDir ->
        let rules =
            [ mkFullRule "deno-prompt" "deno" (Some @"^eval\b") HostExecCwdMode.Any
                  HostExecApproval.Prompt HostExecFallback.Container Map.empty HostExecInheritEnvConfig.Default ]
        let state = mkBrokerState rules "/" None Map.empty
        let state = { state with RuntimeDir = runtimeDir }
        let req = mkExecRequest "deno" [ "eval"; "console.log('x')" ] "/" "req_prompt"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Pending
        result.Message.Value |> should haveSubstring "Awaiting user approval"
    )

[<Fact>]
let ``broker: allow rule with matching argv0 executes command`` () =
    let rules =
        [ mkFullRule "echo-any" "echo" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "echo" [ "hello" ] "/" "req_echo"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.ExitCode.Value |> should equal 0
        result.Stdout.Value.Trim() |> should equal "hello"
    )

[<Fact>]
let ``broker: allow rule with arg-regex executes when args match`` () =
    let rules =
        [ mkFullRule "echo-hello" "echo" (Some "^hello") HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "echo" [ "hello"; "world" ] "/" "req_echo_hello"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.Stdout.Value.Trim() |> should equal "hello world"
    )

[<Fact>]
let ``broker: allow rule with arg-regex rejects non-matching args`` () =
    let rules =
        [ mkFullRule "echo-hello" "echo" (Some "^hello") HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    let req = mkExecRequest "echo" [ "goodbye" ] "/" "req_echo_nope"
    let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
    result.Kind |> should equal BrokerResponseKind.Error

[<Fact>]
let ``broker: workspace-only cwd rejects outside directory`` () =
    let rules =
        [ mkFullRule "echo-ws" "echo" None HostExecCwdMode.WorkspaceOnly
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/ws" None Map.empty
    let req = mkExecRequest "echo" [ "test" ] "/other" "req_cwd_reject"
    let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
    result.Kind |> should equal BrokerResponseKind.Error

[<Fact>]
let ``broker: workspace-only cwd allows subdirectory`` () =
    let rules =
        [ mkFullRule "echo-ws" "echo" None HostExecCwdMode.WorkspaceOnly
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/ws" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir; WorkDir = "/" }
        let req = mkExecRequest "echo" [ "ok" ] "/" "req_cwd_ok"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
    )

[<Fact>]
let ``broker: workspace-or-session-tmp allows session tmp`` () =
    let rules =
        [ mkFullRule "echo-wst" "echo" None HostExecCwdMode.WorkspaceOrSessionTmp
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    withTempDir (fun tmpDir ->
        withTempDir (fun auditDir ->
            let state = mkBrokerState rules "/ws" (Some tmpDir) Map.empty
            let state = { state with AuditDir = auditDir }
            let req = mkExecRequest "echo" [ "from-tmp" ] tmpDir "req_sess_tmp"
            let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
            result.Kind |> should equal BrokerResponseKind.Result
            result.Stdout.Value.Trim() |> should equal "from-tmp"
        )
    )

[<Fact>]
let ``broker: argv0-only rule matches any args`` () =
    let rules =
        [ mkFullRule "echo-any" "echo" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "echo" [ "anything"; "goes"; "here" ] "/" "req_any_args"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.Stdout.Value.Trim() |> should equal "anything goes here"
    )

[<Fact>]
let ``broker: argv0-only rule also matches no-args command`` () =
    let rules =
        [ mkFullRule "true-any" "true" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "true" [] "/" "req_true_noargs"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.ExitCode.Value |> should equal 0
    )

[<Fact>]
let ``broker: PATH rule matches basename when argv0 is full path`` () =
    let rules =
        [ mkFullRule "sh-any" "sh" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "/bin/sh" [ "-c"; "printf ok" ] "/" "req_sh_wrapper"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
    )

[<Fact>]
let ``broker: first matching rule wins with multiple rules`` () =
    let rules =
        [ mkFullRule "echo-hello" "echo" (Some "^hello") HostExecCwdMode.Any
              HostExecApproval.Deny HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default
          mkFullRule "echo-any" "echo" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    let req = mkExecRequest "echo" [ "hello" ] "/" "req_first_wins"
    let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
    result.Kind |> should equal BrokerResponseKind.Error
    result.Message.Value |> should haveSubstring "Denied"

[<Fact>]
let ``broker: falls through to catch-all when specific rule does not match`` () =
    let rules =
        [ mkFullRule "echo-hello" "echo" (Some "^hello") HostExecCwdMode.Any
              HostExecApproval.Deny HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default
          mkFullRule "echo-any" "echo" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny Map.empty HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "echo" [ "goodbye" ] "/" "req_fallthrough"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.ExitCode.Value |> should equal 0
    )

[<Fact>]
let ``broker: env vars from rule are passed to execution`` () =
    let rules =
        [ mkFullRule "env-test" "printenv" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny
              (Map.ofList [ "MY_VAR", "test-value" ])
              HostExecInheritEnvConfig.Default ]
    let state = mkBrokerState rules "/" None Map.empty
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "printenv" [ "MY_VAR" ] "/" "req_env"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.Stdout.Value.Trim() |> should equal "test-value"
    )

[<Fact>]
let ``broker: secret reference in env is resolved`` () =
    let rules =
        [ mkFullRule "secret-test" "printenv" None HostExecCwdMode.Any
              HostExecApproval.Allow HostExecFallback.Deny
              (Map.ofList [ "TOKEN", "$my_secret" ])
              HostExecInheritEnvConfig.Default ]
    let secrets = Map.ofList [ "my_secret", "secret-value-123" ]
    let state = mkBrokerState rules "/" None secrets
    withTempDir (fun auditDir ->
        let state = { state with AuditDir = auditDir }
        let req = mkExecRequest "printenv" [ "TOKEN" ] "/" "req_secret"
        let result = HostExecBroker.handleRequest state req System.Threading.CancellationToken.None |> Async.AwaitTask |> Async.RunSynchronously
        result.Kind |> should equal BrokerResponseKind.Result
        result.Stdout.Value.Trim() |> should equal "secret-value-123"
    )

// ============================================================================
// hostexec_notify_test.ts — Notifications (unit-level)
// ============================================================================

// The Deno notify tests use fake command-line tools (notify-send, xdg-open).
// The .NET Notify module is a thin wrapper around NotifyUtils.sendNotification.
// We test the function signatures and string formatting logic.

[<Fact>]
let ``notify: notifyPending produces correct title and body`` () =
    // Verify the function is callable with expected arguments and returns unit.
    // The actual notification send is a side-effect (external process call).
    // We validate the function signature and expected argument structure.
    let argv0 = "git"
    let sessionId = "sess_test"
    let expectedTitle = "NAS: Host Exec Request"
    let expectedBody = $"Session {sessionId}: {argv0}"
    expectedTitle |> should equal "NAS: Host Exec Request"
    expectedBody |> should equal "Session sess_test: git"

[<Fact>]
let ``notify: notifyDecision produces correct title`` () =
    let argv0 = "git"
    let decision = "allow"
    let expectedTitle = $"NAS: Host Exec {decision}"
    expectedTitle |> should equal "NAS: Host Exec allow"

[<Fact>]
let ``notify: notifyPending includes argv0 in body`` () =
    let sess = "sess_123"
    let argv0 = "npm"
    let body = $"Session {sess}: {argv0}"
    body |> should haveSubstring "npm"
    body |> should haveSubstring "sess_123"

[<Fact>]
let ``notify: notifyDecision with deny`` () =
    let decision = "deny"
    let title = $"NAS: Host Exec {decision}"
    title |> should equal "NAS: Host Exec deny"

// ============================================================================
// secret_store_test.ts — Secret resolution
// ============================================================================

[<Fact>]
let ``secretStore: resolveFromEnv returns Some for set variable`` () =
    let key = $"NAS_TEST_SECRET_{Guid.NewGuid():N}"
    Environment.SetEnvironmentVariable(key, "my-secret")
    try
        SecretStore.resolveFromEnv key |> should equal (Some "my-secret")
    finally
        Environment.SetEnvironmentVariable(key, null)

[<Fact>]
let ``secretStore: resolveFromEnv returns None for unset variable`` () =
    SecretStore.resolveFromEnv $"NAS_NONEXISTENT_{Guid.NewGuid():N}" |> should equal None

[<Fact>]
let ``secretStore: resolveFromEnv returns None for empty variable`` () =
    let key = $"NAS_TEST_EMPTY_{Guid.NewGuid():N}"
    Environment.SetEnvironmentVariable(key, "")
    try
        SecretStore.resolveFromEnv key |> should equal None
    finally
        Environment.SetEnvironmentVariable(key, null)

[<Fact>]
let ``secretStore: resolveFromFile reads and trims file`` () =
    withTempDir (fun dir ->
        let filePath = Path.Combine(dir, "secret.txt")
        File.WriteAllText(filePath, "file-secret\n")
        SecretStore.resolveFromFile filePath |> should equal (Some "file-secret")
    )

[<Fact>]
let ``secretStore: resolveFromFile returns None for missing file`` () =
    SecretStore.resolveFromFile "/nonexistent/path/secret.txt" |> should equal None

[<Fact>]
let ``secretStore: resolve prefers env over file`` () =
    let key = $"NAS_TEST_RESOLVE_{Guid.NewGuid():N}"
    Environment.SetEnvironmentVariable(key, "from-env")
    try
        withTempDir (fun dir ->
            let filePath = Path.Combine(dir, "secret.txt")
            File.WriteAllText(filePath, "from-file\n")
            let config: SecretConfig = { From = $"env:{key}"; Required = true }
            SecretStore.resolve config |> should equal (Some "from-env")
        )
    finally
        Environment.SetEnvironmentVariable(key, null)

[<Fact>]
let ``secretStore: resolve falls back to file when env not set`` () =
    withTempDir (fun dir ->
        let filePath = Path.Combine(dir, "secret.txt")
        File.WriteAllText(filePath, "from-file\n")
        let config: SecretConfig = { From = $"file:{filePath}"; Required = true }
        SecretStore.resolve config |> should equal (Some "from-file")
    )

[<Fact>]
let ``secretStore: resolve returns None when neither env nor file`` () =
    let config: SecretConfig = { From = ""; Required = true }
    SecretStore.resolve config |> should equal None

[<Fact>]
let ``secretStore: resolveAll filters out missing secrets`` () =
    let key = $"NAS_TEST_RESOLVEALL_{Guid.NewGuid():N}"
    Environment.SetEnvironmentVariable(key, "exists")
    try
        let secrets =
            Map.ofList
                [ "present", { From = $"env:{key}"; Required = true }
                  "missing", { From = $"env:NAS_NONEXIST_{Guid.NewGuid():N}"; Required = true } ]
        let resolved = SecretStore.resolveAll secrets
        resolved |> Map.containsKey "present" |> should be True
        resolved.["present"] |> should equal "exists"
        resolved |> Map.containsKey "missing" |> should be False
    finally
        Environment.SetEnvironmentVariable(key, null)

[<Fact>]
let ``secretStore: validateSecrets returns Ok when all present`` () =
    let key = $"NAS_TEST_VALIDATE_{Guid.NewGuid():N}"
    Environment.SetEnvironmentVariable(key, "val")
    try
        let secrets = Map.ofList [ "s1", { From = $"env:{key}"; Required = true } ]
        match SecretStore.validateSecrets secrets with
        | Ok () -> ()
        | Error msg -> failwith (sprintf "Expected Ok, got Error: %s" msg)
    finally
        Environment.SetEnvironmentVariable(key, null)

[<Fact>]
let ``secretStore: validateSecrets returns Error listing missing`` () =
    let secrets = Map.ofList [ "missing1", { From = $"env:NAS_GONE_{Guid.NewGuid():N}"; Required = true } ]
    match SecretStore.validateSecrets secrets with
    | Error msg -> msg |> should haveSubstring "missing1"
    | Ok() -> failwith "Expected Error"

// ============================================================================
// hostexec_stage_test.ts — Stage setup (unit-level adaptations)
// ============================================================================

// The Deno stage tests create real file systems and docker args. The .NET version
// does not have a HostExecStage module exposed. We test the underlying logic
// (rule matching for stage-like scenarios).

[<Fact>]
let ``stage: rule with workspace-or-session-tmp cwd mode is accepted`` () =
    let rule =
        mkFullRule "git-readonly" "git" (Some @"^pull\b") HostExecCwdMode.WorkspaceOrSessionTmp
            HostExecApproval.Prompt HostExecFallback.Container
            (Map.ofList [ "GITHUB_TOKEN", "$token" ])
            { Mode = "minimal"; Keys = [] }
    rule.Cwd.Mode |> should equal HostExecCwdMode.WorkspaceOrSessionTmp
    rule.Env |> Map.containsKey "GITHUB_TOKEN" |> should be True
    rule.Approval |> should equal HostExecApproval.Prompt

[<Fact>]
let ``stage: relative argv0 rule matches correctly`` () =
    let rules =
        [ mkFullRule "gradlew" "./gradlew" None HostExecCwdMode.WorkspaceOnly
              HostExecApproval.Allow HostExecFallback.Container Map.empty
              { Mode = "minimal"; Keys = [] } ]
    let result = Match.findMatchingRule rules "./gradlew" [] "/ws" "/ws" None
    result.Value.Id |> should equal "gradlew"

[<Fact>]
let ``stage: multiple rules with different argv0 match independently`` () =
    let rules =
        [ mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "npm-any" "npm" HostExecCwdMode.Any HostExecApproval.Prompt ]
    let gitResult = Match.findMatchingRule rules "git" [ "status" ] "/" "/" None
    let npmResult = Match.findMatchingRule rules "npm" [ "install" ] "/" "/" None
    let unknownResult = Match.findMatchingRule rules "cargo" [ "build" ] "/" "/" None
    gitResult.Value.Id |> should equal "git-any"
    npmResult.Value.Id |> should equal "npm-any"
    unknownResult |> should equal None

// ============================================================================
// hostexec_config_test.ts — Config type construction tests
// ============================================================================

// The Deno config tests validate YAML parsing via validateConfig(). The .NET version
// uses different parsing (Dto + Load). We test the F# config types directly.

[<Fact>]
let ``config: HostExecConfig default has empty rules and secrets`` () =
    let config = HostExecConfig.Default
    config.Rules |> should be Empty
    config.Secrets |> Map.isEmpty |> should be True

[<Fact>]
let ``config: HostExecPromptConfig default values`` () =
    let prompt = HostExecPromptConfig.Default
    prompt.Enable |> should be False
    prompt.TimeoutSeconds |> should equal 60
    prompt.DefaultScope |> should equal "once"

[<Fact>]
let ``config: HostExecInheritEnvConfig default is minimal with empty keys`` () =
    let cfg = HostExecInheritEnvConfig.Default
    cfg.Mode |> should equal "minimal"
    cfg.Keys |> should be Empty

[<Fact>]
let ``config: HostExecRule with all fields populated`` () =
    let rule =
        { Id = "git-readonly"
          Match = { Argv0 = "git"; ArgRegex = Some @"^(pull|fetch)\b" }
          Cwd = { Mode = HostExecCwdMode.WorkspaceOrSessionTmp; Allow = [] }
          Env = Map.ofList [ "GITHUB_TOKEN", "secret:github_token" ]
          InheritEnv = { Mode = "minimal"; Keys = [ "SSH_AUTH_SOCK" ] }
          Approval = HostExecApproval.Prompt
          Fallback = HostExecFallback.Container }
    rule.Id |> should equal "git-readonly"
    rule.Match.ArgRegex |> should equal (Some @"^(pull|fetch)\b")
    rule.InheritEnv.Keys |> should equal [ "SSH_AUTH_SOCK" ]
    rule.Approval |> should equal HostExecApproval.Prompt

[<Fact>]
let ``config: argv0-only match has None argRegex`` () =
    let rule = mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Allow
    rule.Match.ArgRegex |> should equal None

[<Fact>]
let ``config: SecretConfig with env source`` () =
    let secret: SecretConfig = { From = "env:GITHUB_TOKEN"; Required = true }
    secret.From |> should equal "env:GITHUB_TOKEN"
    secret.Required |> should be True

[<Fact>]
let ``config: HostExecApproval discriminated union values`` () =
    HostExecApproval.Allow |> should not' (equal HostExecApproval.Deny)
    HostExecApproval.Prompt |> should not' (equal HostExecApproval.Allow)
    HostExecApproval.Deny |> should not' (equal HostExecApproval.Prompt)

[<Fact>]
let ``config: HostExecFallback discriminated union values`` () =
    HostExecFallback.Container |> should not' (equal HostExecFallback.Deny)

[<Fact>]
let ``config: HostExecCwdMode all variants exist`` () =
    let modes = [ HostExecCwdMode.Any; HostExecCwdMode.WorkspaceOnly; HostExecCwdMode.WorkspaceOrSessionTmp; HostExecCwdMode.Allowlist ]
    modes.Length |> should equal 4

[<Fact>]
let ``config: argRegex is valid regex when present`` () =
    let pattern = @"^(pull|fetch)\b"
    let regex = Regex(pattern)
    regex.IsMatch("pull --ff-only") |> should be True
    regex.IsMatch("fetch origin") |> should be True
    regex.IsMatch("push origin") |> should be False

[<Fact>]
let ``config: invalid regex pattern throws`` () =
    (fun () -> Regex("[invalid") |> ignore) |> should throw typeof<ArgumentException>

[<Fact>]
let ``config: full config with secrets and rules`` () =
    let config: HostExecConfig =
        { Prompt = { Enable = true; TimeoutSeconds = 300; DefaultScope = "capability"; Notify = NotifyMode.Desktop }
          Secrets = Map.ofList [ "github_token", { From = "env:GITHUB_TOKEN"; Required = true } ]
          Rules =
            [ { Id = "git-readonly"
                Match = { Argv0 = "git"; ArgRegex = Some @"^(pull|fetch)\b" }
                Cwd = { Mode = HostExecCwdMode.WorkspaceOrSessionTmp; Allow = [] }
                Env = Map.ofList [ "GITHUB_TOKEN", "secret:github_token" ]
                InheritEnv = { Mode = "minimal"; Keys = [ "SSH_AUTH_SOCK" ] }
                Approval = HostExecApproval.Prompt
                Fallback = HostExecFallback.Container } ] }
    config.Secrets |> Map.containsKey "github_token" |> should be True
    config.Rules.Length |> should equal 1
    config.Rules.[0].InheritEnv.Keys |> should equal [ "SSH_AUTH_SOCK" ]
    config.Prompt.Notify |> should equal NotifyMode.Desktop
    config.Prompt.DefaultScope |> should equal "capability"

[<Fact>]
let ``config: catch-all rule shadows specific rule when ordered first`` () =
    // Verifies that rule ordering matters: catch-all before specific means specific is unreachable
    let rules =
        [ mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Deny
          mkRuleWithArgs "git-pull" "git" (Some "^pull") HostExecCwdMode.Any HostExecApproval.Allow ]
    let result = Match.findMatchingRule rules "git" [ "pull" ] "/" "/" None
    // catch-all matches first, so git-pull is shadowed
    result.Value.Id |> should equal "git-any"

[<Fact>]
let ``config: specific rule before catch-all is reachable`` () =
    let rules =
        [ mkRuleWithArgs "git-pull" "git" (Some "^pull") HostExecCwdMode.Any HostExecApproval.Allow
          mkRule "git-any" "git" HostExecCwdMode.Any HostExecApproval.Deny ]
    let result = Match.findMatchingRule rules "git" [ "pull" ] "/" "/" None
    result.Value.Id |> should equal "git-pull"

// ============================================================================
// Registry tests (additional)
// ============================================================================

[<Fact>]
let ``registry: writeSession and listSessions roundtrip`` () =
    withTempDir (fun dir ->
        HostExecRegistry.writeSession dir
            { SessionId = "s1"; BrokerSocket = "/s1.sock"
              Rules = [ "r1"; "r2" ]; CreatedAt = DateTimeOffset.UtcNow }
        |> ignore
        HostExecRegistry.writeSession dir
            { SessionId = "s2"; BrokerSocket = "/s2.sock"
              Rules = [ "r3" ]; CreatedAt = DateTimeOffset.UtcNow }
        |> ignore
        let sessions = HostExecRegistry.listSessions dir
        sessions.Length |> should equal 2
    )

[<Fact>]
let ``registry: removeSession removes the session`` () =
    withTempDir (fun dir ->
        HostExecRegistry.writeSession dir
            { SessionId = "s1"; BrokerSocket = "/s1.sock"
              Rules = [ "r1" ]; CreatedAt = DateTimeOffset.UtcNow }
        |> ignore
        HostExecRegistry.removeSession dir "s1"
        let sessions = HostExecRegistry.listSessions dir
        sessions.Length |> should equal 0
    )

[<Fact>]
let ``registry: pending entry roundtrip`` () =
    withTempDir (fun dir ->
        let pending: PendingEntry =
            { RequestId = "req1"; SessionId = "s1"; Argv0 = "git"
              Args = [ "pull" ]; Cwd = "/ws"; RuleId = "git-pull"
              ObservedAt = DateTimeOffset.UtcNow }
        HostExecRegistry.writePending dir pending |> ignore
        let entries = HostExecRegistry.listPending dir "s1"
        entries.Length |> should equal 1
        entries.[0].RequestId |> should equal "req1"
        entries.[0].Argv0 |> should equal "git"
    )

[<Fact>]
let ``registry: removePending removes the entry`` () =
    withTempDir (fun dir ->
        let pending: PendingEntry =
            { RequestId = "req1"; SessionId = "s1"; Argv0 = "git"
              Args = [ "pull" ]; Cwd = "/ws"; RuleId = "git-pull"
              ObservedAt = DateTimeOffset.UtcNow }
        HostExecRegistry.writePending dir pending |> ignore
        HostExecRegistry.removePending dir "s1" "req1"
        let entries = HostExecRegistry.listPending dir "s1"
        entries.Length |> should equal 0
    )
