namespace Nas.Network

open System.IO
open System.Text.Json
open Nas.Core.Lib

/// File-system based network session and pending entry registry
module NetworkRegistry =
    let private jsonOptions =
        JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)

    /// Get the network runtime directory
    let getRuntimeDir () =
        Path.Combine(RuntimeRegistry.getRuntimeDir (), "network")

    /// Write session entry
    let writeSession (runtimeDir: string) (entry: Protocol.SessionEntry) =
        RuntimeRegistry.writeSessionFile runtimeDir entry.SessionId
            (JsonSerializer.Serialize(entry, jsonOptions))

    /// Remove session entry
    let removeSession (runtimeDir: string) (sessionId: string) =
        RuntimeRegistry.removeSessionFile runtimeDir sessionId

    /// List all sessions
    let listSessions (runtimeDir: string) =
        RuntimeRegistry.listSessionFiles runtimeDir
        |> List.choose (fun path ->
            try
                let json = File.ReadAllText(path)
                Some(JsonSerializer.Deserialize<Protocol.SessionEntry>(json, jsonOptions))
            with
            | _ -> None)

    /// Write pending entry
    let writePending (runtimeDir: string) (entry: Protocol.PendingEntry) =
        RuntimeRegistry.writePendingFile runtimeDir entry.SessionId entry.RequestId
            (JsonSerializer.Serialize(entry, jsonOptions))

    /// Remove pending entry
    let removePending (runtimeDir: string) (sessionId: string) (requestId: string) =
        RuntimeRegistry.removePendingFile runtimeDir sessionId requestId

    /// List pending entries for a session
    let listPending (runtimeDir: string) (sessionId: string) =
        RuntimeRegistry.listPendingFiles runtimeDir sessionId
        |> List.choose (fun path ->
            try
                let json = File.ReadAllText(path)
                Some(JsonSerializer.Deserialize<Protocol.PendingEntry>(json, jsonOptions))
            with
            | _ -> None)

    /// Garbage collect stale entries
    let gc (runtimeDir: string) =
        RuntimeRegistry.gc runtimeDir
