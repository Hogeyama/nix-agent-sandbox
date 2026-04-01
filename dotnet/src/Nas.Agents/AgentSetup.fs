namespace Nas.Agents

module AgentSetup =
    /// Dispatch to the correct agent configurator
    let configureAgent (agentType: Nas.Core.AgentType) (containerHome: string) (hostHome: string) : AgentMountResult =
        match agentType with
        | Nas.Core.AgentType.Claude -> Claude.setup containerHome hostHome
        | Nas.Core.AgentType.Copilot -> Copilot.setup containerHome hostHome
        | Nas.Core.AgentType.Codex -> Codex.setup containerHome hostHome
