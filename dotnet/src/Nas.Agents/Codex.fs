namespace Nas.Agents

open System
open System.IO

module Codex =
    let setup (containerHome: string) (hostHome: string) : AgentMountResult =
        let mutable dockerArgs = []
        let mutable envVars = Map.empty

        // ~/.codex mount (auth + config)
        let codexDir = $"{hostHome}/.codex"
        if AgentUtils.dirExistsSync codexDir then
            dockerArgs <- dockerArgs @ AgentUtils.bindMount codexDir $"{containerHome}/.codex" false

        // codex binary mount
        let command =
            match AgentUtils.findBinary "codex" with
            | Some bp ->
                let real = AgentUtils.resolveSymlinks bp
                dockerArgs <- dockerArgs @ AgentUtils.bindMount real "/usr/local/bin/codex" true
                [ "codex" ]
            | None ->
                [ "bash"; "-c"; "echo 'codex binary not found'; exit 1" ]

        { DockerArgs = dockerArgs; EnvVars = envVars; Command = command }
