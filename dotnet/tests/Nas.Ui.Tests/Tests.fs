module Nas.Ui.Tests.AllTests

open System
open System.IO
open System.Text.Json
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Ui
open Nas.Audit
open Nas.Network
open Nas.HostExec

// ============================================================
// Helpers
// ============================================================

let private withTempDir (f: string -> unit) =
    let dir = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory(dir) |> ignore
    try f dir
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

let private jsonOpts =
    let opts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)
    opts.Encoder <- System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    opts

let private makeAuditEntry domain sessionId requestId decision reason =
    { Id = Guid.NewGuid().ToString()
      Timestamp = DateTimeOffset.UtcNow
      Domain = domain
      SessionId = sessionId
      RequestId = requestId
      Decision = decision
      Reason = reason
      Scope = None
      Target = None
      Command = None }

// ============================================================
// Data.gatherState — original test (preserved)
// ============================================================

[<Fact>]
let ``gatherState does not throw`` () =
    let s = Data.gatherState ()
    s.NetworkSessions |> should not' (equal null)

// ============================================================
// AuditDomain — from ui_api_test.ts domain validation
// ============================================================

[<Fact>]
let ``AuditDomain FromString network`` () =
    AuditDomain.FromString "network" |> should equal (Some AuditDomain.Network)

[<Fact>]
let ``AuditDomain FromString hostexec`` () =
    AuditDomain.FromString "hostexec" |> should equal (Some AuditDomain.HostExec)

[<Fact>]
let ``AuditDomain FromString invalid returns None`` () =
    AuditDomain.FromString "invalid" |> should equal None

[<Fact>]
let ``AuditDomain ToConfigString round-trips`` () =
    AuditDomain.Network.ToConfigString() |> should equal "network"
    AuditDomain.HostExec.ToConfigString() |> should equal "hostexec"

// ============================================================
// AuditStore.query — from ui_api_test.ts GET /audit
// ============================================================

[<Fact>]
let ``AuditStore query nonexistent dir returns empty`` () =
    let result = AuditStore.query "/nonexistent/path/that/does/not/exist" AuditLogFilter.Empty
    result |> should be Empty

[<Fact>]
let ``AuditStore query empty dir returns empty`` () =
    withTempDir (fun dir ->
        let auditDir = Path.Combine(dir, "audit")
        Directory.CreateDirectory(auditDir) |> ignore
        let result = AuditStore.query auditDir AuditLogFilter.Empty
        result |> should be Empty
    )

[<Fact>]
let ``AuditStore append and query round trip`` () =
    withTempDir (fun dir ->
        let auditDir = Path.Combine(dir, "audit")
        let entry =
            { Id = "test-001"
              Timestamp = DateTimeOffset.UtcNow
              Domain = AuditDomain.Network
              SessionId = "sess-001"
              RequestId = "req-001"
              Decision = "allow"
              Reason = "allowlist match"
              Scope = None
              Target = Some "example.com:443"
              Command = None }
        AuditStore.append auditDir entry
        let results = AuditStore.query auditDir AuditLogFilter.Empty
        results.Length |> should equal 1
        results[0].Id |> should equal "test-001"
        results[0].Domain |> should equal AuditDomain.Network
        results[0].Target |> should equal (Some "example.com:443")
    )

[<Fact>]
let ``AuditStore query returns audit log entries`` () =
    withTempDir (fun dir ->
        let auditDir = Path.Combine(dir, "audit")
        let entry =
            { Id = "test-id-001"
              Timestamp = DateTimeOffset(2026, 3, 28, 12, 0, 0, TimeSpan.Zero)
              Domain = AuditDomain.Network
              SessionId = "sess-001"
              RequestId = "req-001"
              Decision = "allow"
              Reason = "allowlist match"
              Scope = None
              Target = Some "example.com:443"
              Command = None }
        AuditStore.append auditDir entry
        let results = AuditStore.query auditDir AuditLogFilter.Empty
        results.Length |> should equal 1
        results[0].Id |> should equal "test-id-001"
        results[0].Domain |> should equal AuditDomain.Network
    )

[<Fact>]
let ``AuditStore query filters by sessionId`` () =
    withTempDir (fun dir ->
        let auditDir = Path.Combine(dir, "audit")
        let entry1 = makeAuditEntry AuditDomain.Network "sess-001" "req-1" "allow" "test"
        let entry2 = makeAuditEntry AuditDomain.Network "sess-002" "req-2" "deny" "test"
        AuditStore.append auditDir entry1
        AuditStore.append auditDir entry2
        let filter = { AuditLogFilter.Empty with SessionId = Some "sess-001" }
        let results = AuditStore.query auditDir filter
        results.Length |> should equal 1
        results[0].SessionId |> should equal "sess-001"
    )

[<Fact>]
let ``AuditStore query filters by domain network`` () =
    withTempDir (fun dir ->
        let auditDir = Path.Combine(dir, "audit")
        let entry1 = makeAuditEntry AuditDomain.Network "sess-x" "req-1" "allow" "ok"
        let entry2 = makeAuditEntry AuditDomain.HostExec "sess-x" "req-2" "deny" "blocked"
        AuditStore.append auditDir entry1
        AuditStore.append auditDir entry2
        let filter = { AuditLogFilter.Empty with Domain = Some AuditDomain.Network }
        let results = AuditStore.query auditDir filter
        results.Length |> should equal 1
        results[0].Domain |> should equal AuditDomain.Network
    )

[<Fact>]
let ``AuditStore query filters by domain hostexec`` () =
    withTempDir (fun dir ->
        let auditDir = Path.Combine(dir, "audit")
        let entry1 = makeAuditEntry AuditDomain.Network "sess-x" "req-1" "allow" "ok"
        let entry2 = makeAuditEntry AuditDomain.HostExec "sess-x" "req-2" "deny" "blocked"
        AuditStore.append auditDir entry1
        AuditStore.append auditDir entry2
        let filter = { AuditLogFilter.Empty with Domain = Some AuditDomain.HostExec }
        let results = AuditStore.query auditDir filter
        results.Length |> should equal 1
        results[0].Domain |> should equal AuditDomain.HostExec
    )

// ============================================================
// NetworkRegistry — from ui_api_test.ts GET /network/*
// ============================================================

[<Fact>]
let ``NetworkRegistry listSessions empty dir returns empty`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "network")
        let result = NetworkRegistry.listSessions runtimeDir
        result |> should be Empty
    )

[<Fact>]
let ``NetworkRegistry write and list session round trip`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "network")
        let entry: Protocol.SessionEntry =
            { SessionId = "test-session-001"
              BrokerSocket = Path.Combine(dir, "broker.sock")
              ProxyEndpoint = "http://localhost:8080"
              Token = "test-token"
              CreatedAt = DateTimeOffset.UtcNow }
        NetworkRegistry.writeSession runtimeDir entry |> ignore
        let results = NetworkRegistry.listSessions runtimeDir
        results.Length |> should equal 1
        results[0].SessionId |> should equal "test-session-001"
    )

[<Fact>]
let ``NetworkRegistry listPending returns empty when no pending`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "network")
        let result = NetworkRegistry.listPending runtimeDir "nonexistent"
        result |> should be Empty
    )

[<Fact>]
let ``NetworkRegistry write and list pending round trip`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "network")
        let entry: Protocol.PendingEntry =
            { RequestId = "req-001"
              SessionId = "test-session-001"
              Target = { Host = "example.com"; Port = 443 }
              Method = "CONNECT"
              RequestKind = RequestKind.Connect
              ObservedAt = DateTimeOffset.UtcNow }
        NetworkRegistry.writePending runtimeDir entry |> ignore
        let results = NetworkRegistry.listPending runtimeDir "test-session-001"
        results.Length |> should equal 1
        results[0].RequestId |> should equal "req-001"
        results[0].Target.Host |> should equal "example.com"
        results[0].Target.Port |> should equal 443
    )

// ============================================================
// HostExecRegistry — from ui_api_test.ts GET /hostexec/*
// ============================================================

[<Fact>]
let ``HostExecRegistry listSessions empty dir returns empty`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "hostexec")
        let result = HostExecRegistry.listSessions runtimeDir
        result |> should be Empty
    )

[<Fact>]
let ``HostExecRegistry write and list session round trip`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "hostexec")
        let entry: SessionEntry =
            { SessionId = "hex-session-001"
              BrokerSocket = Path.Combine(dir, "broker.sock")
              Rules = [ "rule-1"; "rule-2" ]
              CreatedAt = DateTimeOffset.UtcNow }
        HostExecRegistry.writeSession runtimeDir entry |> ignore
        let results = HostExecRegistry.listSessions runtimeDir
        results.Length |> should equal 1
        results[0].SessionId |> should equal "hex-session-001"
    )

[<Fact>]
let ``HostExecRegistry listPending returns empty when no pending`` () =
    withTempDir (fun dir ->
        let runtimeDir = Path.Combine(dir, "hostexec")
        let result = HostExecRegistry.listPending runtimeDir "nonexistent"
        result |> should be Empty
    )
