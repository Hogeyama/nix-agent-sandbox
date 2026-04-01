namespace Nas.HostExec

open System.IO
open System.Text.Json
open Nas.Core.Lib

module HostExecRegistry =
    let private jsonOpts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)
    let getRuntimeDir () = Path.Combine(RuntimeRegistry.getRuntimeDir (), "hostexec")

    let writeSession (dir: string) (e: SessionEntry) =
        RuntimeRegistry.writeSessionFile dir e.SessionId (JsonSerializer.Serialize(e, jsonOpts))
    let removeSession (dir: string) (sid: string) = RuntimeRegistry.removeSessionFile dir sid
    let listSessions (dir: string) =
        RuntimeRegistry.listSessionFiles dir |> List.choose (fun p ->
            try Some(JsonSerializer.Deserialize<SessionEntry>(File.ReadAllText(p), jsonOpts)) with _ -> None)

    let writePending (dir: string) (e: PendingEntry) =
        RuntimeRegistry.writePendingFile dir e.SessionId e.RequestId (JsonSerializer.Serialize(e, jsonOpts))
    let removePending (dir: string) (sid: string) (rid: string) = RuntimeRegistry.removePendingFile dir sid rid
    let listPending (dir: string) (sid: string) =
        RuntimeRegistry.listPendingFiles dir sid |> List.choose (fun p ->
            try Some(JsonSerializer.Deserialize<PendingEntry>(File.ReadAllText(p), jsonOpts)) with _ -> None)
    let gc (dir: string) = RuntimeRegistry.gc dir
