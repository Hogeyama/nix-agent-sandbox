namespace Nas.HostExec

open Nas.Core.Lib

module HostExecNotify =
    let notifyPending (argv0: string) (sessionId: string) =
        NotifyUtils.sendNotification "NAS: Host Exec Request" $"Session {sessionId}: {argv0}" "normal" 30000
    let notifyDecision (argv0: string) (decision: string) =
        NotifyUtils.sendNotification $"NAS: Host Exec {decision}" $"{argv0}" "low" 5000
