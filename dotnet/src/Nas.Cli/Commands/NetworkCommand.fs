namespace Nas.Cli.Commands

open Nas.Core
open Nas.Network

module NetworkCommand =
    let pending () =
        let dir = NetworkRegistry.getRuntimeDir ()
        let sessions = NetworkRegistry.listSessions dir
        if sessions.IsEmpty then printfn "No active network sessions."
        else for s in sessions do let e = NetworkRegistry.listPending dir s.SessionId in if not e.IsEmpty then printfn $"\nSession: {s.SessionId}"; for entry in e do printfn $"  [{entry.RequestId}] {entry.Target} ({entry.Method})"
        0
    let gc () = NetworkRegistry.gc (NetworkRegistry.getRuntimeDir ()); Log.info "Network runtime garbage collected."; 0
