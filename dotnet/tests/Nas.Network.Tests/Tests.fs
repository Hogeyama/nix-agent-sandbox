module Nas.Network.Tests.AllTests

open System
open System.IO
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Core.Config
open Nas.Network

let withTempDir (f: string -> 'a) =
    let dir = Path.Combine(Path.GetTempPath(), $"nas-test-{Guid.NewGuid():N}")
    Directory.CreateDirectory(dir) |> ignore
    try f dir
    finally
        if Directory.Exists(dir) then Directory.Delete(dir, true)

let mkAuthorizeReq sessionId requestId host port : Protocol.AuthorizeRequest =
    { Version = 1; Type = "authorize"; RequestId = requestId; SessionId = sessionId
      Target = { Host = host; Port = port }
      Method = "CONNECT"; RequestKind = RequestKind.Connect
      ObservedAt = DateTimeOffset.UtcNow }

// ── Protocol: normalizeTarget ──────────────────────────────────────

[<Fact>]
let ``normalizeTarget host:port`` () =
    let r = Protocol.normalizeTarget "example.com:443" RequestKind.Connect
    r.Value.Host |> should equal "example.com"
    r.Value.Port |> should equal 443

[<Fact>]
let ``normalizeTarget defaults 443 for CONNECT`` () =
    (Protocol.normalizeTarget "example.com" RequestKind.Connect).Value.Port |> should equal 443

[<Fact>]
let ``normalizeTarget defaults 80 for Direct`` () =
    (Protocol.normalizeTarget "example.com" RequestKind.Direct).Value.Port |> should equal 80

[<Fact>]
let ``normalizeTarget parses CONNECT authority with port`` () =
    let t = Protocol.normalizeTarget "api.openai.com:443" RequestKind.Connect
    t.Value.Host |> should equal "api.openai.com"
    t.Value.Port |> should equal 443

[<Fact>]
let ``normalizeTarget returns None for garbage input`` () =
    let t = Protocol.normalizeTarget "a:b:c:d" RequestKind.Connect
    t |> should equal None

// ── Protocol: matchesAllowlistEntry ────────────────────────────────

[<Fact>]
let ``wildcard match`` () =
    Protocol.matchesAllowlistEntry { Host = "api.example.com"; Port = 443 } "*.example.com"
    |> should be True

[<Fact>]
let ``wildcard rejects non-matching`` () =
    Protocol.matchesAllowlistEntry { Host = "other.com"; Port = 443 } "*.example.com"
    |> should be False

[<Fact>]
let ``wildcard includes base domain`` () =
    Protocol.matchesAllowlistEntry { Host = "github.com"; Port = 443 } "*.github.com"
    |> should be True

[<Fact>]
let ``matchesAllowlistEntry exact domain match`` () =
    Protocol.matchesAllowlistEntry { Host = "example.com"; Port = 443 } "example.com"
    |> should be True

[<Fact>]
let ``matchesAllowlistEntry rejects different exact domain`` () =
    Protocol.matchesAllowlistEntry { Host = "other.com"; Port = 443 } "example.com"
    |> should be False

// ── Protocol: isAllowedByList / isDeniedByList ─────────────────────

[<Fact>]
let ``isAllowedByList returns true when entry matches`` () =
    Protocol.isAllowedByList { Host = "api.github.com"; Port = 443 } [ "*.github.com" ]
    |> should be True

[<Fact>]
let ``isAllowedByList returns false for empty list`` () =
    Protocol.isAllowedByList { Host = "api.github.com"; Port = 443 } []
    |> should be False

[<Fact>]
let ``isDeniedByList matches denylist entry`` () =
    Protocol.isDeniedByList { Host = "evil.com"; Port = 443 } [ "evil.com" ]
    |> should be True

[<Fact>]
let ``isDeniedByList returns false when no match`` () =
    Protocol.isDeniedByList { Host = "good.com"; Port = 443 } [ "evil.com" ]
    |> should be False

// ── Protocol: token / hash ─────────────────────────────────────────

[<Fact>]
let ``token generation non-empty`` () =
    Protocol.generateToken().Length |> should be (greaterThan 0)

[<Fact>]
let ``hashToken deterministic`` () =
    Protocol.hashToken "t" |> should equal (Protocol.hashToken "t")

[<Fact>]
let ``hashToken different inputs produce different hashes`` () =
    Protocol.hashToken "a" |> should not' (equal (Protocol.hashToken "b"))

// ── Protocol: cacheKey ─────────────────────────────────────────────

[<Fact>]
let ``cacheKey HostPort includes host and port`` () =
    let key = Protocol.cacheKey { Host = "example.com"; Port = 443 } ApprovalScope.HostPort
    key |> should equal "hp:example.com:443"

[<Fact>]
let ``cacheKey Host includes only host`` () =
    let key = Protocol.cacheKey { Host = "example.com"; Port = 443 } ApprovalScope.Host
    key |> should equal "host:example.com"

// ── Registry ───────────────────────────────────────────────────────

[<Fact>]
let ``registry roundtrip`` () =
    withTempDir (fun dir ->
        let e: Protocol.SessionEntry =
            { SessionId = "s1"; BrokerSocket = "/run/s.sock"
              ProxyEndpoint = "http://localhost"; Token = "h"
              CreatedAt = DateTimeOffset.UtcNow }
        NetworkRegistry.writeSession dir e |> ignore
        (NetworkRegistry.listSessions dir).Length |> should equal 1)

[<Fact>]
let ``registry list empty returns empty list`` () =
    withTempDir (fun dir ->
        (NetworkRegistry.listSessions dir).Length |> should equal 0)

[<Fact>]
let ``registry write and remove session`` () =
    withTempDir (fun dir ->
        let e: Protocol.SessionEntry =
            { SessionId = "s-rm"; BrokerSocket = "/run/s.sock"
              ProxyEndpoint = "http://localhost"; Token = "h"
              CreatedAt = DateTimeOffset.UtcNow }
        NetworkRegistry.writeSession dir e |> ignore
        (NetworkRegistry.listSessions dir).Length |> should equal 1
        NetworkRegistry.removeSession dir "s-rm"
        (NetworkRegistry.listSessions dir).Length |> should equal 0)

[<Fact>]
let ``registry pending entry roundtrip`` () =
    withTempDir (fun dir ->
        let pe: Protocol.PendingEntry =
            { RequestId = "r1"; SessionId = "s1"
              Target = { Host = "example.com"; Port = 443 }
              Method = "CONNECT"; RequestKind = RequestKind.Connect
              ObservedAt = DateTimeOffset.UtcNow }
        NetworkRegistry.writePending dir pe |> ignore
        let pending = NetworkRegistry.listPending dir "s1"
        pending.Length |> should equal 1
        pending.[0].RequestId |> should equal "r1"
        NetworkRegistry.removePending dir "s1" "r1"
        (NetworkRegistry.listPending dir "s1").Length |> should equal 0)

// ── Broker: evaluate ───────────────────────────────────────────────

[<Fact>]
let ``broker allows on allowlist`` () =
    withTempDir (fun dir ->
        let cfg = { NetworkConfig.Default with Allowlist = [ "*.example.com" ] }
        let state = NetworkBroker.create "s1" cfg dir dir
        let req = mkAuthorizeReq "s1" "r1" "api.example.com" 443
        let resp = NetworkBroker.evaluate state req
        resp.Decision |> should equal Decision.Allow
        resp.Reason |> should equal "allowlist")

[<Fact>]
let ``broker denies on denylist`` () =
    withTempDir (fun dir ->
        let cfg =
            { NetworkConfig.Default with
                Prompt = { NetworkPromptConfig.Default with Enable = true; Denylist = [ "evil.com" ] } }
        let state = NetworkBroker.create "s1" cfg dir dir
        let req = mkAuthorizeReq "s1" "r1" "evil.com" 443
        let resp = NetworkBroker.evaluate state req
        resp.Decision |> should equal Decision.Deny
        resp.Reason |> should equal "denylist")

[<Fact>]
let ``broker allowlist takes priority over denylist`` () =
    withTempDir (fun dir ->
        let cfg =
            { NetworkConfig.Default with
                Allowlist = [ "*.example.com" ]
                Prompt = { NetworkPromptConfig.Default with Enable = true; Denylist = [ "sub.example.com" ] } }
        let state = NetworkBroker.create "s1" cfg dir dir
        let req = mkAuthorizeReq "s1" "r1" "sub.example.com" 443
        let resp = NetworkBroker.evaluate state req
        resp.Decision |> should equal Decision.Allow
        resp.Reason |> should equal "allowlist")

[<Fact>]
let ``broker allowlist sub but denylist wildcard denies other`` () =
    withTempDir (fun dir ->
        let cfg =
            { NetworkConfig.Default with
                Allowlist = [ "sub.example.com" ]
                Prompt = { NetworkPromptConfig.Default with Enable = true; Denylist = [ "*.example.com" ] } }
        let state = NetworkBroker.create "s1" cfg dir dir
        // sub.example.com is in allowlist → allow
        let respAllow = NetworkBroker.evaluate state (mkAuthorizeReq "s1" "r1" "sub.example.com" 443)
        respAllow.Decision |> should equal Decision.Allow
        respAllow.Reason |> should equal "allowlist"
        // other.example.com matches denylist → deny
        let respDeny = NetworkBroker.evaluate state (mkAuthorizeReq "s1" "r2" "other.example.com" 443)
        respDeny.Decision |> should equal Decision.Deny
        respDeny.Reason |> should equal "denylist")

[<Fact>]
let ``broker denies when prompt disabled and not listed`` () =
    withTempDir (fun dir ->
        let cfg = NetworkConfig.Default // prompt.enable=false by default, empty allowlist
        let state = NetworkBroker.create "s1" cfg dir dir
        let req = mkAuthorizeReq "s1" "r1" "unknown.com" 443
        let resp = NetworkBroker.evaluate state req
        resp.Decision |> should equal Decision.Deny
        resp.Reason |> should equal "no-prompt")

[<Fact>]
let ``broker caches allow after allowlist hit`` () =
    withTempDir (fun dir ->
        let cfg = { NetworkConfig.Default with Allowlist = [ "cached.com" ] }
        let state = NetworkBroker.create "s1" cfg dir dir
        let first = NetworkBroker.evaluate state (mkAuthorizeReq "s1" "r1" "cached.com" 443)
        first.Decision |> should equal Decision.Allow
        first.Reason |> should equal "allowlist"
        let second = NetworkBroker.evaluate state (mkAuthorizeReq "s1" "r2" "cached.com" 443)
        second.Decision |> should equal Decision.Allow
        second.Reason |> should equal "cached")

[<Fact>]
let ``broker caches deny after denylist hit`` () =
    withTempDir (fun dir ->
        let cfg =
            { NetworkConfig.Default with
                Prompt = { NetworkPromptConfig.Default with Enable = true; Denylist = [ "bad.com" ] } }
        let state = NetworkBroker.create "s1" cfg dir dir
        let first = NetworkBroker.evaluate state (mkAuthorizeReq "s1" "r1" "bad.com" 443)
        first.Decision |> should equal Decision.Deny
        first.Reason |> should equal "denylist"
        let second = NetworkBroker.evaluate state (mkAuthorizeReq "s1" "r2" "bad.com" 443)
        second.Decision |> should equal Decision.Deny
        second.Reason |> should equal "cached-deny")
