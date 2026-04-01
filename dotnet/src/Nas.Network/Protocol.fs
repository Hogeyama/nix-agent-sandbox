namespace Nas.Network

open System
open System.Security.Cryptography
open System.Text
open Nas.Core

/// Network protocol types and utilities
module Protocol =
    /// Normalized target (host + port)
    type NormalizedTarget =
        { Host: string
          Port: int }

        override this.ToString() = $"{this.Host}:{this.Port}"

    /// Authorization request from Envoy ext_authz
    type AuthorizeRequest =
        { Version: int
          Type: string
          RequestId: string
          SessionId: string
          Target: NormalizedTarget
          Method: string
          RequestKind: RequestKind
          ObservedAt: DateTimeOffset }

    /// Decision response sent back to ext_authz
    type DecisionResponse =
        { Version: int
          Type: string
          RequestId: string
          Decision: Decision
          Scope: ApprovalScope option
          Reason: string
          Message: string option }

    /// Pending network approval entry
    type PendingEntry =
        { RequestId: string
          SessionId: string
          Target: NormalizedTarget
          Method: string
          RequestKind: RequestKind
          ObservedAt: DateTimeOffset }

    /// Session registry entry
    type SessionEntry =
        { SessionId: string
          BrokerSocket: string
          ProxyEndpoint: string
          Token: string
          CreatedAt: DateTimeOffset }

    /// Normalize a target from CONNECT authority or URL
    let normalizeTarget (authority: string) (requestKind: RequestKind) =
        let parts = authority.Split(':')
        match parts with
        | [| host; portStr |] ->
            match Int32.TryParse(portStr) with
            | true, port -> Some { Host = host; Port = port }
            | _ -> None
        | [| host |] ->
            let defaultPort =
                match requestKind with
                | RequestKind.Connect -> 443
                | RequestKind.Direct -> 80
            Some { Host = host; Port = defaultPort }
        | _ -> None

    /// Check if a target matches an allowlist entry
    let matchesAllowlistEntry (target: NormalizedTarget) (entry: string) =
        if entry.StartsWith("*.") then
            let domain = entry.Substring(2)
            target.Host.EndsWith($".{domain}", StringComparison.OrdinalIgnoreCase)
            || target.Host.Equals(domain, StringComparison.OrdinalIgnoreCase)
        else
            target.Host.Equals(entry, StringComparison.OrdinalIgnoreCase)

    /// Check if a target is allowed by the allowlist
    let isAllowedByList (target: NormalizedTarget) (allowlist: string list) =
        allowlist |> List.exists (matchesAllowlistEntry target)

    /// Check if a target matches any denylist entry
    let isDeniedByList (target: NormalizedTarget) (denylist: string list) =
        denylist |> List.exists (matchesAllowlistEntry target)

    /// Generate a random token for session authentication
    let generateToken () =
        let bytes = RandomNumberGenerator.GetBytes(32)
        Convert.ToBase64String(bytes)

    /// Hash a token for storage
    let hashToken (token: string) =
        use sha256 = SHA256.Create()
        let hash = sha256.ComputeHash(Encoding.UTF8.GetBytes(token))
        Convert.ToHexString(hash).ToLowerInvariant()

    /// Create a cache key for a target + scope combination
    let cacheKey (target: NormalizedTarget) (scope: ApprovalScope) =
        match scope with
        | ApprovalScope.Once -> $"once:{target}"
        | ApprovalScope.HostPort -> $"hp:{target}"
        | ApprovalScope.Host -> $"host:{target.Host}"
