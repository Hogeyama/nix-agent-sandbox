namespace Nas.Cli.Commands

open System
open System.Text.Json
open Nas.Audit

module AuditCommand =
    let execute (since: string option) (sessionId: string option) (domain: string option) (asJson: bool) (auditDir: string option) =
        let dir = auditDir |> Option.defaultWith AuditStore.getAuditDir
        let filter: AuditLogFilter =
            { StartDate = since |> Option.bind (fun s -> match DateOnly.TryParse(s) with true, d -> Some d | _ -> None)
              EndDate = None; SessionId = sessionId; Domain = domain |> Option.bind AuditDomain.FromString }
        let entries = AuditStore.query dir filter
        if entries.IsEmpty then printfn "No audit entries found."
        elif asJson then printfn "%s" (JsonSerializer.Serialize(entries, JsonSerializerOptions(WriteIndented = true)))
        else
            for e in entries do
                let ts = e.Timestamp.ToString("O")
                let domStr = e.Domain.ToConfigString()
                let targetStr = e.Target |> Option.defaultValue (e.Command |> Option.defaultValue "")
                printfn $"[{ts}] {domStr} {e.Decision} {targetStr} ({e.Reason})"
        0
