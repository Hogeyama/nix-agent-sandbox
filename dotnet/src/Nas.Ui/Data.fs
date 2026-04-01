namespace Nas.Ui

open Nas.Network
open Nas.HostExec
open Nas.Audit

module Data =
    type UiState =
        { NetworkSessions: Protocol.SessionEntry list; NetworkPending: (string * Protocol.PendingEntry list) list
          HostExecSessions: SessionEntry list; HostExecPending: (string * PendingEntry list) list
          AuditEntries: AuditLogEntry list }

    let gatherState () =
        let netDir = NetworkRegistry.getRuntimeDir ()
        let hexDir = HostExecRegistry.getRuntimeDir ()
        let audDir = AuditStore.getAuditDir ()
        let netSess = NetworkRegistry.listSessions netDir
        let netPend = netSess |> List.map (fun s -> s.SessionId, NetworkRegistry.listPending netDir s.SessionId) |> List.filter (fun (_, e) -> not e.IsEmpty)
        let hexSess = HostExecRegistry.listSessions hexDir
        let hexPend = hexSess |> List.map (fun s -> s.SessionId, HostExecRegistry.listPending hexDir s.SessionId) |> List.filter (fun (_, e) -> not e.IsEmpty)
        { NetworkSessions = netSess; NetworkPending = netPend; HostExecSessions = hexSess; HostExecPending = hexPend; AuditEntries = AuditStore.query audDir AuditLogFilter.Empty }
