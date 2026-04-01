namespace Nas.Core.Lib

open System
open System.Diagnostics
open System.IO
open System.Runtime.InteropServices

module NotifyUtils =
    let isWsl =
        lazy (RuntimeInformation.IsOSPlatform(OSPlatform.Linux)
              && File.Exists("/proc/version")
              && (File.ReadAllText("/proc/version").Contains("microsoft", StringComparison.OrdinalIgnoreCase)))

    let findNotifySend () =
        let candidates = if isWsl.Value then [ "notify-send-wsl"; "notify-send" ] else [ "notify-send" ]
        candidates |> List.tryFind (fun cmd ->
            try
                let psi = ProcessStartInfo(cmd, "--version", RedirectStandardOutput = true, UseShellExecute = false)
                use p = Process.Start(psi)
                p.WaitForExit(2000) |> ignore
                p.ExitCode = 0
            with _ -> false)

    let sendNotification (summary: string) (body: string) (urgency: string) (timeout: int) =
        match findNotifySend () with
        | Some cmd ->
            try
                let psi = ProcessStartInfo(cmd, $"--urgency={urgency} --expire-time={timeout} \"{summary}\" \"{body}\"", UseShellExecute = false, CreateNoWindow = true)
                Process.Start(psi) |> ignore
                true
            with _ -> false
        | None -> false
