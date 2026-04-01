namespace Nas.Core

open System
open System.Text.Json
open System.Text.Json.Serialization

[<RequireQualifiedAccess>]
type AgentType =
    | Claude
    | Copilot
    | Codex

    member this.ToConfigString() =
        match this with
        | Claude -> "claude"
        | Copilot -> "copilot"
        | Codex -> "codex"

    static member FromString(s: string) =
        match s.ToLowerInvariant() with
        | "claude" -> Some Claude
        | "copilot" -> Some Copilot
        | "codex" -> Some Codex
        | _ -> None

[<RequireQualifiedAccess>]
type LogLevel =
    | Quiet
    | Normal
    | Verbose

[<RequireQualifiedAccess>]
type Decision =
    | Allow
    | Deny

[<RequireQualifiedAccess>]
type ApprovalScope =
    | Once
    | HostPort
    | Host

    member this.ToConfigString() =
        match this with
        | Once -> "once"
        | HostPort -> "host-port"
        | Host -> "host"

    static member FromString(s: string) =
        match s.ToLowerInvariant() with
        | "once" -> Some Once
        | "host-port" -> Some HostPort
        | "host" -> Some Host
        | _ -> None

[<RequireQualifiedAccess>]
type HostExecApproval =
    | Allow
    | Prompt
    | Deny

[<RequireQualifiedAccess>]
type HostExecFallback =
    | Container
    | Deny

[<RequireQualifiedAccess>]
type HostExecCwdMode =
    | WorkspaceOnly
    | WorkspaceOrSessionTmp
    | Allowlist
    | Any

[<RequireQualifiedAccess>]
type NixEnableMode =
    | Auto
    | Enabled
    | Disabled

type RequestKindConverter() =
    inherit JsonConverter<RequestKind>()
    override _.Read(reader, _typeToConvert, _options) =
        match reader.GetString().ToLowerInvariant() with
        | "connect" -> RequestKind.Connect
        | "direct" -> RequestKind.Direct
        | _ -> RequestKind.Connect
    override _.Write(writer, value, _options) =
        writer.WriteStringValue(match value with RequestKind.Connect -> "connect" | RequestKind.Direct -> "direct")

and [<RequireQualifiedAccess; JsonConverter(typeof<RequestKindConverter>)>]
    RequestKind =
    | Connect
    | Direct

[<RequireQualifiedAccess>]
type NotifyMode =
    | Auto
    | Desktop
    | Off

[<RequireQualifiedAccess>]
type NasResourceKind =
    | Agent
    | Envoy
    | Dind
    | Network

    member this.ToLabel() =
        match this with
        | Agent -> "agent"
        | Envoy -> "envoy"
        | Dind -> "dind"
        | Network -> "network"

type SessionId = SessionId of string

module SessionId =
    let create () = SessionId(Guid.NewGuid().ToString("N")[..7])
    let value (SessionId id) = id
