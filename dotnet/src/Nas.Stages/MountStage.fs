namespace Nas.Stages

open System
open System.Diagnostics
open System.IO
open System.Runtime.InteropServices
open System.Text.RegularExpressions
open System.Threading.Tasks
open Nas.Core
open Nas.Core.Config
open Nas.Core.Pipeline
open Nas.Agents

module private MountHelpers =
    let fileExists (path: string) = try File.Exists(path) || Directory.Exists(path) with _ -> false
    let dirExists (path: string) = try Directory.Exists(path) with _ -> false

    let getUid () =
        if RuntimeInformation.IsOSPlatform(OSPlatform.Linux) then
            try
                let psi = ProcessStartInfo("id", "-u", RedirectStandardOutput = true, UseShellExecute = false)
                use p = Process.Start(psi)
                let output = p.StandardOutput.ReadToEnd().Trim()
                p.WaitForExit()
                if p.ExitCode = 0 then Some output else None
            with _ -> None
        else None

    let getGid () =
        if RuntimeInformation.IsOSPlatform(OSPlatform.Linux) then
            try
                let psi = ProcessStartInfo("id", "-g", RedirectStandardOutput = true, UseShellExecute = false)
                use p = Process.Start(psi)
                let output = p.StandardOutput.ReadToEnd().Trim()
                p.WaitForExit()
                if p.ExitCode = 0 then Some output else None
            with _ -> None
        else None

    let resolveRealPath (path: string) =
        try
            let psi = ProcessStartInfo("readlink", $"-f {path}", RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false)
            use p = Process.Start(psi)
            let output = p.StandardOutput.ReadToEnd().Trim()
            p.WaitForExit()
            if p.ExitCode = 0 && not (String.IsNullOrEmpty(output)) then Some output else None
        with _ -> None

    let resolveGpgAgentSocket () =
        try
            let psi = ProcessStartInfo("gpgconf", "--list-dir agent-socket", RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false)
            use p = Process.Start(psi)
            let output = p.StandardOutput.ReadToEnd().Trim()
            p.WaitForExit()
            if p.ExitCode = 0 && not (String.IsNullOrEmpty(output)) then Some output
            else
                match getUid () with
                | Some uid ->
                    let path = $"/run/user/{uid}/gnupg/S.gpg-agent"
                    if fileExists path then Some path else None
                | None -> None
        with _ -> None

    let resolveNixBinPath () =
        match resolveRealPath "/run/current-system/sw/bin/nix" with
        | Some p when p.StartsWith("/nix/store/") -> Some p
        | _ ->
            [ "/nix/var/nix/profiles/default/bin/nix"; "/root/.nix-profile/bin/nix" ]
            |> List.tryFind fileExists

    let runCommandForEnv (command: string) (sourceName: string) =
        try
            let psi = ProcessStartInfo("sh", $"-c \"{command}\"",
                        RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false)
            use p = Process.Start(psi)
            let output = p.StandardOutput.ReadToEnd().Trim()
            let stderr = p.StandardError.ReadToEnd().Trim()
            p.WaitForExit()
            if p.ExitCode <> 0 then
                let msg = if String.IsNullOrEmpty(stderr) then $"exit code {p.ExitCode}" else stderr
                failwith $"[nas] Failed to execute {sourceName}: {msg}"
            if String.IsNullOrEmpty(output) then
                failwith $"[nas] {sourceName} returned empty output"
            output
        with :? System.ComponentModel.Win32Exception as ex ->
            failwith $"[nas] Failed to execute {sourceName}: {ex.Message}"

    let envVarNameRe = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

type MountStage() =
    interface IStage with
        member _.Name = "Mount"
        member _.Execute(ctx) = task {
            let mutable args = ctx.DockerArgs
            let mutable env = ctx.EnvVars

            let containerUser =
                let u = Environment.GetEnvironmentVariable("USER")
                if not (String.IsNullOrWhiteSpace(u)) then u.Trim() else "nas"
            let containerHome = $"/home/{containerUser}"
            env <- env |> Map.add "NAS_USER" containerUser
                       |> Map.add "NAS_HOME" containerHome
                       |> Map.add "NAS_LOG_LEVEL" (match ctx.LogLevel with LogLevel.Quiet -> "quiet" | LogLevel.Verbose -> "verbose" | _ -> "normal")

            // Workspace mount
            let mountSource = Path.GetFullPath(ctx.MountDir |> Option.defaultValue ctx.WorkDir)
            let containerWorkDir = Path.GetFullPath(ctx.WorkDir)
            args <- args @ [ "-v"; $"{mountSource}:{mountSource}"; "-w"; containerWorkDir ]
            env <- env |> Map.add "WORKSPACE" containerWorkDir

            // UID/GID
            let uid = MountHelpers.getUid () |> Option.defaultValue "1000"
            let gid = MountHelpers.getGid () |> Option.defaultValue "1000"
            env <- env |> Map.add "NAS_UID" uid |> Map.add "NAS_GID" gid

            // Nix mount
            let home = Environment.GetEnvironmentVariable("HOME") |> Option.ofObj |> Option.defaultValue "/root"
            if ctx.NixEnabled && ctx.Profile.Nix.MountSocket then
                if MountHelpers.dirExists "/nix" then
                    args <- args @ [ "-v"; "/nix:/nix" ]
                    // Resolve nix.conf real path
                    match MountHelpers.resolveRealPath "/etc/nix/nix.conf" with
                    | Some nixConfPath when not (nixConfPath.StartsWith("/nix/")) ->
                        let containerNixConfPath = "/tmp/nas-host-nix.conf"
                        args <- args @ [ "-v"; $"{nixConfPath}:{containerNixConfPath}:ro" ]
                        env <- env |> Map.add "NIX_CONF_PATH" containerNixConfPath
                    | Some nixConfPath ->
                        env <- env |> Map.add "NIX_CONF_PATH" nixConfPath
                    | None -> ()
                    env <- env |> Map.add "NIX_REMOTE" "daemon" |> Map.add "NIX_ENABLED" "true"
                    // Cache directories
                    let xdgCache = Environment.GetEnvironmentVariable("XDG_CACHE_HOME") |> Option.ofObj |> Option.defaultValue $"{home}/.cache"
                    let nasCacheDir = $"{xdgCache}/nas"
                    try Directory.CreateDirectory(nasCacheDir) |> ignore with _ -> ()
                    args <- args @ [ "-v"; $"{nasCacheDir}:{containerHome}/.cache/nas" ]
                    let hostNixCache = $"{xdgCache}/nix"
                    try Directory.CreateDirectory(hostNixCache) |> ignore with _ -> ()
                    args <- args @ [ "-v"; $"{hostNixCache}:{containerHome}/.cache/nix" ]
                    // Extra packages
                    let nixExtraPkgs = ctx.Profile.Nix.ExtraPackages |> List.filter (fun s -> not (String.IsNullOrWhiteSpace(s)))
                    if not nixExtraPkgs.IsEmpty then
                        env <- env |> Map.add "NIX_EXTRA_PACKAGES" (nixExtraPkgs |> String.concat "\n")
                    // Nix binary path
                    match MountHelpers.resolveNixBinPath () with
                    | Some p -> env <- env |> Map.add "NIX_BIN_PATH" p
                    | None -> ()

            // Git config mount
            let gitConfigDir = $"{home}/.config/git"
            if MountHelpers.dirExists gitConfigDir then
                args <- args @ [ "-v"; $"{gitConfigDir}:{containerHome}/.config/git:ro" ]

            // Gcloud config mount
            if ctx.Profile.Gcloud.MountConfig then
                let d = $"{home}/.config/gcloud"
                if MountHelpers.dirExists d then
                    args <- args @ [ "-v"; $"{d}:{containerHome}/.config/gcloud" ]

            // GPG agent forwarding
            if ctx.Profile.Gpg.ForwardAgent then
                match MountHelpers.resolveGpgAgentSocket () with
                | Some socketPath when MountHelpers.fileExists socketPath ->
                    args <- args @ [ "-v"; $"{socketPath}:{containerHome}/.gnupg/S.gpg-agent" ]
                    env <- env |> Map.add "GPG_AGENT_INFO" $"{containerHome}/.gnupg/S.gpg-agent"
                | _ -> ()
                let gpgConf = $"{home}/.gnupg/gpg.conf"
                if MountHelpers.fileExists gpgConf then args <- args @ [ "-v"; $"{gpgConf}:{containerHome}/.gnupg/gpg.conf:ro" ]
                let gpgAgentConf = $"{home}/.gnupg/gpg-agent.conf"
                if MountHelpers.fileExists gpgAgentConf then args <- args @ [ "-v"; $"{gpgAgentConf}:{containerHome}/.gnupg/gpg-agent.conf:ro" ]
                let pubring = $"{home}/.gnupg/pubring.kbx"
                if MountHelpers.fileExists pubring then args <- args @ [ "-v"; $"{pubring}:{containerHome}/.gnupg/pubring.kbx:ro" ]
                let trustdb = $"{home}/.gnupg/trustdb.gpg"
                if MountHelpers.fileExists trustdb then args <- args @ [ "-v"; $"{trustdb}:{containerHome}/.gnupg/trustdb.gpg:ro" ]

            // AWS config mount
            if ctx.Profile.Aws.MountConfig then
                let d = $"{home}/.aws"
                if MountHelpers.dirExists d then
                    args <- args @ [ "-v"; $"{d}:{containerHome}/.aws" ]

            // Extra mounts
            for mount in ctx.Profile.ExtraMounts do
                let modeSuffix = if mount.Mode = "ro" then ":ro" else ""
                let src = if mount.Src.StartsWith("~/") then Path.Combine(home, mount.Src.Substring(2)) elif mount.Src = "~" then home else mount.Src
                let src = Path.GetFullPath(src)
                if MountHelpers.fileExists src then
                    let dst = if mount.Dst.StartsWith("~/") then Path.Combine(containerHome, mount.Dst.Substring(2)) elif mount.Dst = "~" then containerHome else mount.Dst
                    args <- args @ [ "-v"; $"{src}:{dst}{modeSuffix}" ]
                else
                    Log.warn $"[nas] Skipping extra-mount because src does not exist: {src}"

            // Profile env vars (key/key_cmd × val/val_cmd)
            for (i, envCfg) in ctx.Profile.Env |> List.indexed do
                let key =
                    match envCfg.Key, envCfg.KeyCmd with
                    | Some k, _ -> k
                    | None, Some cmd -> MountHelpers.runCommandForEnv cmd $"profile.env[{i}].key_cmd"
                    | None, None -> failwith $"[nas] profile.env[{i}]: neither key nor key_cmd specified"
                if not (MountHelpers.envVarNameRe.IsMatch(key)) then
                    failwith $"[nas] Invalid env var name from profile.env[{i}]: {key}"
                let value =
                    match envCfg.Val, envCfg.ValCmd with
                    | Some v, _ -> v
                    | None, Some cmd -> MountHelpers.runCommandForEnv cmd $"profile.env[{i}].val_cmd"
                    | None, None -> failwith $"[nas] profile.env[{i}]: neither val nor val_cmd specified"
                env <- env |> Map.add key value

            // DBus proxy mount
            if ctx.DbusProxyEnabled then
                match ctx.DbusSessionRuntimeDir with
                | Some runtimeDir ->
                    let containerRuntimeDir = $"/run/user/{uid}"
                    args <- args @ [ "-v"; $"{runtimeDir}:{containerRuntimeDir}" ]
                    env <- env |> Map.add "XDG_RUNTIME_DIR" containerRuntimeDir
                           |> Map.add "DBUS_SESSION_BUS_ADDRESS" $"unix:path={containerRuntimeDir}/bus"
                | None -> ()

            // TMUX env forwarding
            if not (String.IsNullOrEmpty(Environment.GetEnvironmentVariable("TMUX"))) then
                env <- env |> Map.add "NAS_HOST_TMUX" "1"

            // Agent-specific configuration (at end, like Deno)
            let agentResult = AgentSetup.configureAgent ctx.Profile.Agent containerHome home
            args <- args @ agentResult.DockerArgs
            env <- agentResult.EnvVars |> Map.fold (fun acc k v -> Map.add k v acc) env
            let agentCommand = if ctx.AgentCommand.IsEmpty then agentResult.Command else ctx.AgentCommand

            return { ctx with DockerArgs = args; EnvVars = env; AgentCommand = agentCommand }
        }
        member _.Teardown(_ctx) = task { return () }
