namespace Nas.Network

open Nas.Core.Lib

/// Network approval notification helpers
module NetworkNotify =
    /// Send a notification about a pending network request
    let notifyPending (target: Protocol.NormalizedTarget) (sessionId: string) =
        NotifyUtils.sendNotification
            "NAS: Network Request"
            $"Session {sessionId}: {target}"
            "normal"
            30000

    /// Send a notification about a decision
    let notifyDecision (target: Protocol.NormalizedTarget) (decision: string) =
        NotifyUtils.sendNotification
            $"NAS: Network {decision}"
            $"{target}"
            "low"
            5000
