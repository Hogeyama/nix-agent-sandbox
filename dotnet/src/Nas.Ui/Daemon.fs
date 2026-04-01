namespace Nas.Ui

open System
open System.IO
open System.Net.Http
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Lib

module Daemon =
    let private cacheDir () = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "nas", "ui")
    let private daemonFile () = Path.Combine(cacheDir (), "daemon.json")

    let isHealthy (port: int) = task {
        use client = new HttpClient(Timeout = TimeSpan.FromSeconds(2.0))
        try let! resp = client.GetAsync($"http://localhost:{port}/api/health") in return resp.IsSuccessStatusCode
        with _ -> return false
    }

    let ensureRunning (port: int) = task {
        let! healthy = isHealthy port
        if healthy then Log.verbose "UI daemon already running"
        else
            Log.info $"Starting UI daemon on port {port}"
            let app = Server.createApp port
            let _ = Task.Run(fun () -> app.RunAsync())
            let mutable ready = false
            let mutable attempts = 0
            while not ready && attempts < 50 do
                do! Task.Delay(200)
                let! h = isHealthy port
                ready <- h; attempts <- attempts + 1
            if ready then
                Log.info "UI daemon started"
                FsUtils.ensureDir (cacheDir ())
                File.WriteAllText(daemonFile (), $"{{\"port\":{port},\"pid\":{Environment.ProcessId}}}")
            else Log.warn "UI daemon failed to start"
    }

    let shutdown (port: int) = task {
        use client = new HttpClient(Timeout = TimeSpan.FromSeconds(2.0))
        try let! _ = client.PostAsync($"http://localhost:{port}/api/shutdown", null) in ()
        with _ -> ()
    }
