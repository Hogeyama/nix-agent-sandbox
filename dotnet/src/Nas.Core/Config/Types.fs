namespace Nas.Core.Config

open Nas.Core

type WorktreeConfig = { Enable: bool; Base: string option; OnCreate: string option }
    with static member Default = { Enable = false; Base = None; OnCreate = None }

type NixConfig = { Enable: NixEnableMode; MountSocket: bool; ExtraPackages: string list }
    with static member Default = { Enable = NixEnableMode.Auto; MountSocket = true; ExtraPackages = [] }

type DockerConfig = { Enable: bool; Shared: bool }
    with static member Default = { Enable = false; Shared = false }

type GcloudConfig = { MountConfig: bool }
    with static member Default = { MountConfig = false }

type AwsConfig = { MountConfig: bool }
    with static member Default = { MountConfig = false }

type GpgConfig = { ForwardAgent: bool }
    with static member Default = { ForwardAgent = false }

type NetworkPromptConfig =
    { Enable: bool; Denylist: string list; TimeoutSeconds: int; DefaultScope: ApprovalScope; Notify: NotifyMode }
    with static member Default =
            { Enable = false; Denylist = []; TimeoutSeconds = 300; DefaultScope = ApprovalScope.HostPort; Notify = NotifyMode.Auto }

/// Gradle proxy: true/false/auto
[<RequireQualifiedAccess>]
type GradleProxyMode =
    | On
    | Off
    | Auto
    member this.IsEnabled (isGradleWorkspace: unit -> bool) =
        match this with
        | On -> true
        | Off -> false
        | Auto -> isGradleWorkspace ()

type NetworkGradleConfig = { Proxy: GradleProxyMode }
    with static member Default = { Proxy = GradleProxyMode.Auto }

type NetworkConfig = { Allowlist: string list; Prompt: NetworkPromptConfig; Gradle: NetworkGradleConfig }
    with static member Default = { Allowlist = []; Prompt = NetworkPromptConfig.Default; Gradle = NetworkGradleConfig.Default }

type DbusRuleConfig = { Name: string; Rule: string }

type DbusSessionConfig =
    { Enable: bool; SourceAddress: string option; See: string list; Talk: string list
      Own: string list; Calls: DbusRuleConfig list; Broadcasts: DbusRuleConfig list }
    with static member Default =
            { Enable = false; SourceAddress = None; See = []; Talk = []; Own = []; Calls = []; Broadcasts = [] }

type DbusConfig = { Session: DbusSessionConfig }
    with static member Default = { Session = DbusSessionConfig.Default }

type ExtraMountConfig = { Src: string; Dst: string; Mode: string }

/// Environment variable entry: key/key_cmd × val/val_cmd
type EnvConfig =
    { Key: string option; KeyCmd: string option; Val: string option; ValCmd: string option }

type HostExecPromptConfig =
    { Enable: bool; TimeoutSeconds: int; DefaultScope: string; Notify: NotifyMode }
    with static member Default = { Enable = true; TimeoutSeconds = 300; DefaultScope = "capability"; Notify = NotifyMode.Auto }

type SecretConfig = { From: string; Required: bool }

type HostExecCwdConfig = { Mode: HostExecCwdMode; Allow: string list }

type HostExecInheritEnvConfig = { Mode: string; Keys: string list }
    with static member Default = { Mode = "minimal"; Keys = [] }

type HostExecMatchConfig = { Argv0: string; ArgRegex: string option }

type HostExecRule =
    { Id: string; Match: HostExecMatchConfig; Cwd: HostExecCwdConfig; Env: Map<string, string>
      InheritEnv: HostExecInheritEnvConfig; Approval: HostExecApproval; Fallback: HostExecFallback }

type HostExecConfig = { Prompt: HostExecPromptConfig; Secrets: Map<string, SecretConfig>; Rules: HostExecRule list }
    with static member Default = { Prompt = HostExecPromptConfig.Default; Secrets = Map.empty; Rules = [] }

type UiConfig = { Enable: bool; Port: int; IdleTimeout: int }
    with static member Default = { Enable = true; Port = 3939; IdleTimeout = 300 }

type Profile =
    { Agent: AgentType; AgentArgs: string list; Worktree: WorktreeConfig option; Nix: NixConfig
      Docker: DockerConfig; Gcloud: GcloudConfig; Aws: AwsConfig; Gpg: GpgConfig
      Network: NetworkConfig; Dbus: DbusConfig; ExtraMounts: ExtraMountConfig list
      Env: EnvConfig list; HostExec: HostExecConfig option }
    with static member Default =
            { Agent = AgentType.Claude; AgentArgs = []; Worktree = None; Nix = NixConfig.Default
              Docker = DockerConfig.Default; Gcloud = GcloudConfig.Default; Aws = AwsConfig.Default
              Gpg = GpgConfig.Default; Network = NetworkConfig.Default; Dbus = DbusConfig.Default
              ExtraMounts = []; Env = []; HostExec = None }

type Config = { Default: string option; Ui: UiConfig; Profiles: Map<string, Profile> }
    with static member Empty = { Default = None; Ui = UiConfig.Default; Profiles = Map.empty }
