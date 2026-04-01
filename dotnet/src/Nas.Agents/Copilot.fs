namespace Nas.Agents

open System
open System.IO

module Copilot =
    let setup (containerHome: string) (hostHome: string) : AgentMountResult =
        let mutable dockerArgs = []
        let mutable envVars = Map.empty

        let xdgConfigHome = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME") |> Option.ofObj
        let xdgStateHome = Environment.GetEnvironmentVariable("XDG_STATE_HOME") |> Option.ofObj

        // Copilot config/state dirs (XDG-aware)
        let hostCopilotConfigDir =
            match xdgConfigHome with
            | Some xdg -> $"{xdg}/.copilot"
            | None -> $"{hostHome}/.copilot"
        let hostCopilotStateDir =
            match xdgStateHome with
            | Some xdg -> $"{xdg}/.copilot"
            | None -> $"{hostHome}/.copilot"

        let containerCopilotConfigDir = AgentUtils.remapToContainer hostCopilotConfigDir hostHome containerHome
        let containerCopilotStateDir = AgentUtils.remapToContainer hostCopilotStateDir hostHome containerHome

        // Pass XDG vars to container if set on host
        match xdgConfigHome with
        | Some xdg -> envVars <- envVars |> Map.add "XDG_CONFIG_HOME" (AgentUtils.remapToContainer xdg hostHome containerHome)
        | None -> ()
        match xdgStateHome with
        | Some xdg -> envVars <- envVars |> Map.add "XDG_STATE_HOME" (AgentUtils.remapToContainer xdg hostHome containerHome)
        | None -> ()

        // Config dir mount
        if AgentUtils.dirExistsSync hostCopilotConfigDir then
            dockerArgs <- dockerArgs @ AgentUtils.bindMount hostCopilotConfigDir containerCopilotConfigDir false

        // State dir mount (skip if same as config)
        if hostCopilotStateDir <> hostCopilotConfigDir then
            if AgentUtils.dirExistsSync hostCopilotStateDir then
                dockerArgs <- dockerArgs @ AgentUtils.bindMount hostCopilotStateDir containerCopilotStateDir false

        // Legacy ~/.copilot mount (if different from config and state dirs)
        let hostLegacyCopilotDir = $"{hostHome}/.copilot"
        if hostLegacyCopilotDir <> hostCopilotConfigDir && hostLegacyCopilotDir <> hostCopilotStateDir then
            if AgentUtils.dirExistsSync hostLegacyCopilotDir then
                let containerLegacy = AgentUtils.remapToContainer hostLegacyCopilotDir hostHome containerHome
                dockerArgs <- dockerArgs @ AgentUtils.bindMount hostLegacyCopilotDir containerLegacy false

        // copilot binary mount
        let command =
            match AgentUtils.findBinary "copilot" with
            | Some bp ->
                let real = AgentUtils.resolveSymlinks bp
                dockerArgs <- dockerArgs @ AgentUtils.bindMount real "/usr/local/bin/copilot" true
                [ "copilot" ]
            | None ->
                [ "bash"; "-c"; "echo 'copilot binary not found'; exit 1" ]

        { DockerArgs = dockerArgs; EnvVars = envVars; Command = command }
