namespace Nas.Agents

open System
open System.IO

module Claude =
    let private defaultContainerPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

    let setup (containerHome: string) (hostHome: string) : AgentMountResult =
        let mutable dockerArgs = []
        let mutable envVars = Map.empty
        let containerLocalBin = $"{containerHome}/.local/bin"

        envVars <- envVars |> Map.add "PATH" $"{containerLocalBin}:{defaultContainerPath}"

        // ~/.claude/ mount (auth + session history)
        let claudeDir = $"{hostHome}/.claude"
        if AgentUtils.dirExistsSync claudeDir then
            dockerArgs <- dockerArgs @ AgentUtils.bindMount claudeDir $"{containerHome}/.claude" false

        // ~/.claude.json mount (settings)
        let claudeJson = $"{hostHome}/.claude.json"
        if AgentUtils.fileExistsSync claudeJson then
            dockerArgs <- dockerArgs @ AgentUtils.bindMount claudeJson $"{containerHome}/.claude.json" false

        // claude binary mount
        let command =
            match AgentUtils.findBinary "claude" with
            | Some bp ->
                let real = AgentUtils.resolveSymlinks bp
                dockerArgs <- dockerArgs @ AgentUtils.bindMount real $"{containerLocalBin}/claude" true
                [ "claude" ]
            | None ->
                [ "bash"; "-c"; "curl -fsSL https://claude.ai/install.sh | bash && claude" ]

        { DockerArgs = dockerArgs; EnvVars = envVars; Command = command }
