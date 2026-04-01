module Nas.Audit.Tests.AllTests

open System
open System.IO
open Xunit
open FsUnit.Xunit
open Nas.Audit

let withTempDir (f: string -> 'a) =
    let dir = Path.Combine(Path.GetTempPath(), $"nas-aud-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore
    try f dir
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

let mkEntry domain sid =
    { Id = Guid.NewGuid().ToString()
      Timestamp = DateTimeOffset.UtcNow
      Domain = domain; SessionId = sid; RequestId = "r1"
      Decision = "allow"; Reason = "test"
      Scope = None; Target = None; Command = None }

// ── Append and query roundtrip ─────────────────────────────────────

[<Fact>]
let ``append and query roundtrip`` () =
    withTempDir (fun dir ->
        let entry = mkEntry AuditDomain.Network "s1"
        AuditStore.append dir entry
        let results = AuditStore.query dir AuditLogFilter.Empty
        results.Length |> should equal 1
        results.[0].Id |> should equal entry.Id
        results.[0].Domain |> should equal AuditDomain.Network)

[<Fact>]
let ``multiple entries go to same date file`` () =
    withTempDir (fun dir ->
        let e1 = { mkEntry AuditDomain.Network "s1" with RequestId = "req-1" }
        let e2 = { mkEntry AuditDomain.Network "s1" with RequestId = "req-2" }
        AuditStore.append dir e1
        AuditStore.append dir e2
        let results = AuditStore.query dir AuditLogFilter.Empty
        results.Length |> should equal 2)

[<Fact>]
let ``different dates go to different files`` () =
    withTempDir (fun dir ->
        let e1 = { mkEntry AuditDomain.Network "s1" with Timestamp = DateTimeOffset.Parse("2026-03-27T10:00:00Z") }
        let e2 = { mkEntry AuditDomain.Network "s1" with Timestamp = DateTimeOffset.Parse("2026-03-28T10:00:00Z") }
        AuditStore.append dir e1
        AuditStore.append dir e2
        let all = AuditStore.query dir AuditLogFilter.Empty
        all.Length |> should equal 2
        let day27 = AuditStore.query dir { AuditLogFilter.Empty with StartDate = Some(DateOnly(2026, 3, 27)); EndDate = Some(DateOnly(2026, 3, 27)) }
        day27.Length |> should equal 1
        let day28 = AuditStore.query dir { AuditLogFilter.Empty with StartDate = Some(DateOnly(2026, 3, 28)); EndDate = Some(DateOnly(2026, 3, 28)) }
        day28.Length |> should equal 1)

// ── Query filters ──────────────────────────────────────────────────

[<Fact>]
let ``query filters by domain`` () =
    withTempDir (fun dir ->
        AuditStore.append dir (mkEntry AuditDomain.Network "s1")
        AuditStore.append dir (mkEntry AuditDomain.HostExec "s1")
        let networkOnly = AuditStore.query dir { AuditLogFilter.Empty with Domain = Some AuditDomain.Network }
        networkOnly.Length |> should equal 1
        networkOnly.[0].Domain |> should equal AuditDomain.Network
        let hostexecOnly = AuditStore.query dir { AuditLogFilter.Empty with Domain = Some AuditDomain.HostExec }
        hostexecOnly.Length |> should equal 1
        hostexecOnly.[0].Domain |> should equal AuditDomain.HostExec)

[<Fact>]
let ``query filters by session`` () =
    withTempDir (fun dir ->
        AuditStore.append dir (mkEntry AuditDomain.Network "sa")
        AuditStore.append dir (mkEntry AuditDomain.Network "sb")
        let results = AuditStore.query dir { AuditLogFilter.Empty with SessionId = Some "sa" }
        results.Length |> should equal 1
        results.[0].SessionId |> should equal "sa")

[<Fact>]
let ``query filters by date range`` () =
    withTempDir (fun dir ->
        AuditStore.append dir { mkEntry AuditDomain.Network "s1" with Timestamp = DateTimeOffset.Parse("2026-03-26T10:00:00Z") }
        AuditStore.append dir { mkEntry AuditDomain.Network "s1" with Timestamp = DateTimeOffset.Parse("2026-03-27T10:00:00Z") }
        AuditStore.append dir { mkEntry AuditDomain.Network "s1" with Timestamp = DateTimeOffset.Parse("2026-03-28T10:00:00Z") }
        let results = AuditStore.query dir { AuditLogFilter.Empty with StartDate = Some(DateOnly(2026, 3, 27)); EndDate = Some(DateOnly(2026, 3, 27)) }
        results.Length |> should equal 1)

[<Fact>]
let ``query compound filter sessionId and domain`` () =
    withTempDir (fun dir ->
        AuditStore.append dir (mkEntry AuditDomain.Network "sess-a")
        AuditStore.append dir (mkEntry AuditDomain.HostExec "sess-a")
        AuditStore.append dir (mkEntry AuditDomain.Network "sess-b")
        let results = AuditStore.query dir { AuditLogFilter.Empty with SessionId = Some "sess-a"; Domain = Some AuditDomain.Network }
        results.Length |> should equal 1
        results.[0].SessionId |> should equal "sess-a"
        results.[0].Domain |> should equal AuditDomain.Network)

// ── Edge cases ─────────────────────────────────────────────────────

[<Fact>]
let ``query empty directory returns empty list`` () =
    withTempDir (fun dir ->
        let results = AuditStore.query dir AuditLogFilter.Empty
        results |> should be Empty)

[<Fact>]
let ``query non-existent directory returns empty list`` () =
    let nonExistent = Path.Combine(Path.GetTempPath(), $"nas-aud-nonexistent-{Guid.NewGuid():N}")
    let results = AuditStore.query nonExistent AuditLogFilter.Empty
    results |> should be Empty

[<Fact>]
let ``query skips malformed JSON lines`` () =
    withTempDir (fun dir ->
        let entry = { mkEntry AuditDomain.Network "s1" with Timestamp = DateTimeOffset.Parse("2026-03-28T12:00:00Z") }
        AuditStore.append dir entry
        let filePath = Path.Combine(dir, "2026-03-28.jsonl")
        File.AppendAllText(filePath, "NOT VALID JSON\n")
        let results = AuditStore.query dir AuditLogFilter.Empty
        results.Length |> should equal 1
        results.[0].Id |> should equal entry.Id)

// ── getAuditDir env resolution ─────────────────────────────────────

[<Fact>]
let ``getAuditDir uses XDG_DATA_HOME when set`` () =
    let original = Environment.GetEnvironmentVariable("XDG_DATA_HOME")
    try
        Environment.SetEnvironmentVariable("XDG_DATA_HOME", "/custom/data")
        let result = AuditStore.getAuditDir ()
        result |> should equal (Path.Combine("/custom/data", "nas", "audit"))
    finally
        Environment.SetEnvironmentVariable("XDG_DATA_HOME", original)

[<Fact>]
let ``getAuditDir falls back to UserProfile when XDG_DATA_HOME unset`` () =
    let originalXdg = Environment.GetEnvironmentVariable("XDG_DATA_HOME")
    try
        Environment.SetEnvironmentVariable("XDG_DATA_HOME", null)
        let result = AuditStore.getAuditDir ()
        let home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
        result |> should equal (Path.Combine(home, ".local", "share", "nas", "audit"))
    finally
        Environment.SetEnvironmentVariable("XDG_DATA_HOME", originalXdg)
