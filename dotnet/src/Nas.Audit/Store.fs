namespace Nas.Audit

open System
open System.IO
open System.Text.Json
open Nas.Core.Lib

module AuditStore =
    let private jsonOptions =
        let opts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)
        opts.Encoder <- System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        opts

    let getAuditDir () = Path.Combine(RuntimeRegistry.getDataDir (), "audit")

    let private auditFilePath (dir: string) (date: DateOnly) =
        let dateStr = date.ToString("yyyy-MM-dd")
        Path.Combine(dir, $"{dateStr}.jsonl")

    let append (auditDir: string) (entry: AuditLogEntry) =
        FsUtils.ensureDir auditDir
        let path = auditFilePath auditDir (DateOnly.FromDateTime(entry.Timestamp.DateTime))
        File.AppendAllText(path, JsonSerializer.Serialize(entry, jsonOptions) + "\n")

    let private parseLine (line: string) =
        try Some(JsonSerializer.Deserialize<AuditLogEntry>(line, jsonOptions)) with _ -> None

    let query (auditDir: string) (filter: AuditLogFilter) =
        if not (Directory.Exists(auditDir)) then []
        else
            Directory.GetFiles(auditDir, "*.jsonl") |> Array.sort
            |> Array.filter (fun f ->
                match DateOnly.TryParse(Path.GetFileNameWithoutExtension(f)) with
                | true, date ->
                    (match filter.StartDate with Some s -> date >= s | None -> true) &&
                    (match filter.EndDate with Some e -> date <= e | None -> true)
                | _ -> false)
            |> Array.collect (fun f -> File.ReadAllLines(f) |> Array.choose parseLine)
            |> Array.filter (fun e ->
                (match filter.SessionId with Some sid -> e.SessionId = sid | None -> true) &&
                (match filter.Domain with Some d -> e.Domain = d | None -> true))
            |> Array.toList
