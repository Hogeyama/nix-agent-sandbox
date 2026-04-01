namespace Nas.Cli.Commands

open Nas.Core
open Nas.HostExec

module HostExecCommand =
    let pending () =
        let dir = HostExecRegistry.getRuntimeDir ()
        let sessions = HostExecRegistry.listSessions dir
        if sessions.IsEmpty then printfn "No active hostexec sessions."
        else
            for s in sessions do
                let e = HostExecRegistry.listPending dir s.SessionId
                if not e.IsEmpty then
                    printfn $"\nSession: {s.SessionId}"
                    for entry in e do
                        let argStr = entry.Args |> String.concat " "
                        printfn $"  [{entry.RequestId}] {entry.Argv0} {argStr}"
        0
    let gc () = HostExecRegistry.gc (HostExecRegistry.getRuntimeDir ()); Log.info "HostExec runtime garbage collected."; 0
