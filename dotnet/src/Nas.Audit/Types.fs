namespace Nas.Audit

open System
open System.Text.Json
open System.Text.Json.Serialization

type AuditDomainConverter() =
    inherit JsonConverter<AuditDomain>()
    override _.Read(reader, _typeToConvert, _options) =
        match AuditDomain.FromString(reader.GetString()) with
        | Some d -> d
        | None -> AuditDomain.Network
    override _.Write(writer, value, _options) =
        writer.WriteStringValue(value.ToConfigString() : string)

and [<RequireQualifiedAccess; JsonConverter(typeof<AuditDomainConverter>)>]
    AuditDomain =
    | Network | HostExec
    member this.ToConfigString() = match this with Network -> "network" | HostExec -> "hostexec"
    static member FromString(s: string) =
        match s.ToLowerInvariant() with "network" -> Some Network | "hostexec" -> Some HostExec | _ -> None

type AuditLogEntry =
    { Id: string; Timestamp: DateTimeOffset; Domain: AuditDomain; SessionId: string
      RequestId: string; Decision: string; Reason: string; Scope: string option
      Target: string option; Command: string option }

type AuditLogFilter =
    { StartDate: DateOnly option; EndDate: DateOnly option; SessionId: string option; Domain: AuditDomain option }
    with static member Empty = { StartDate = None; EndDate = None; SessionId = None; Domain = None }
