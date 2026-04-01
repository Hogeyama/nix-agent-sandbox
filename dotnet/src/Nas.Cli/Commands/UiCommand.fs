namespace Nas.Cli.Commands

open Nas.Core

module UiCommand =
    let execute (port: int) (_noOpen: bool) = task {
        Log.info $"Starting UI on port {port}"
        let app = Nas.Ui.Server.createApp port
        do! app.RunAsync()
        return 0
    }
