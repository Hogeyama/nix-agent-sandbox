namespace Nas.Core.Config.Dto

open System.Collections.Generic
open YamlDotNet.Serialization

/// Mutable DTO classes for YamlDotNet deserialization.
/// YamlDotNet cannot directly deserialize into F# records/options/DUs,
/// so we deserialize into these CLR classes first, then map to F# records.

[<CLIMutable>]
type WorktreeDto =
    { [<YamlMember(Alias = "enable")>] Enable: System.Nullable<bool>
      [<YamlMember(Alias = "base")>] Base: string
      [<YamlMember(Alias = "on-create")>] OnCreate: string }

[<CLIMutable>]
type NixDto =
    { [<YamlMember(Alias = "enable")>] Enable: obj
      [<YamlMember(Alias = "mount-socket")>] MountSocket: System.Nullable<bool>
      [<YamlMember(Alias = "extra-packages")>] ExtraPackages: List<string> }

[<CLIMutable>]
type DockerDto =
    { [<YamlMember(Alias = "enable")>] Enable: System.Nullable<bool>
      [<YamlMember(Alias = "shared")>] Shared: System.Nullable<bool> }

[<CLIMutable>]
type GcloudDto =
    { [<YamlMember(Alias = "mount-config")>] MountConfig: System.Nullable<bool> }

[<CLIMutable>]
type AwsDto =
    { [<YamlMember(Alias = "mount-config")>] MountConfig: System.Nullable<bool> }

[<CLIMutable>]
type GpgDto =
    { [<YamlMember(Alias = "forward-agent")>] ForwardAgent: System.Nullable<bool> }

[<CLIMutable>]
type NetworkPromptDto =
    { [<YamlMember(Alias = "enable")>] Enable: System.Nullable<bool>
      [<YamlMember(Alias = "denylist")>] Denylist: List<string>
      [<YamlMember(Alias = "timeout-seconds")>] TimeoutSeconds: System.Nullable<int>
      [<YamlMember(Alias = "default-scope")>] DefaultScope: string
      [<YamlMember(Alias = "notify")>] Notify: string }

[<CLIMutable>]
type NetworkGradleDto =
    { [<YamlMember(Alias = "proxy")>] Proxy: obj }

[<CLIMutable>]
type NetworkDto =
    { [<YamlMember(Alias = "allowlist")>] Allowlist: List<string>
      [<YamlMember(Alias = "prompt")>] Prompt: NetworkPromptDto
      [<YamlMember(Alias = "gradle")>] Gradle: NetworkGradleDto }

[<CLIMutable>]
type DbusRuleDto =
    { [<YamlMember(Alias = "name")>] Name: string
      [<YamlMember(Alias = "rule")>] Rule: string }

[<CLIMutable>]
type DbusSessionDto =
    { [<YamlMember(Alias = "enable")>] Enable: System.Nullable<bool>
      [<YamlMember(Alias = "source-address")>] SourceAddress: string
      [<YamlMember(Alias = "see")>] See: List<string>
      [<YamlMember(Alias = "talk")>] Talk: List<string>
      [<YamlMember(Alias = "own")>] Own: List<string>
      [<YamlMember(Alias = "calls")>] Calls: List<DbusRuleDto>
      [<YamlMember(Alias = "broadcasts")>] Broadcasts: List<DbusRuleDto> }

[<CLIMutable>]
type DbusDto =
    { [<YamlMember(Alias = "session")>] Session: DbusSessionDto }

[<CLIMutable>]
type ExtraMountDto =
    { [<YamlMember(Alias = "src")>] Src: string
      [<YamlMember(Alias = "dst")>] Dst: string
      [<YamlMember(Alias = "mode")>] Mode: string }

[<CLIMutable>]
type EnvDto =
    { [<YamlMember(Alias = "key")>] Key: string
      [<YamlMember(Alias = "key_cmd")>] KeyCmd: string
      [<YamlMember(Alias = "val")>] Val: string
      [<YamlMember(Alias = "val_cmd")>] ValCmd: string }

[<CLIMutable>]
type HostExecPromptDto =
    { [<YamlMember(Alias = "enable")>] Enable: System.Nullable<bool>
      [<YamlMember(Alias = "timeout-seconds")>] TimeoutSeconds: System.Nullable<int>
      [<YamlMember(Alias = "default-scope")>] DefaultScope: string
      [<YamlMember(Alias = "notify")>] Notify: string }

[<CLIMutable>]
type SecretDto =
    { [<YamlMember(Alias = "from")>] From: string
      [<YamlMember(Alias = "required")>] Required: System.Nullable<bool> }

[<CLIMutable>]
type HostExecCwdDto =
    { [<YamlMember(Alias = "mode")>] Mode: string
      [<YamlMember(Alias = "allow")>] Allow: List<string> }

[<CLIMutable>]
type HostExecInheritEnvDto =
    { [<YamlMember(Alias = "mode")>] Mode: string
      [<YamlMember(Alias = "keys")>] Keys: List<string> }

[<CLIMutable>]
type HostExecMatchDto =
    { [<YamlMember(Alias = "argv0")>] Argv0: string
      [<YamlMember(Alias = "arg-regex")>] ArgRegex: string }

[<CLIMutable>]
type HostExecRuleDto =
    { [<YamlMember(Alias = "id")>] Id: string
      [<YamlMember(Alias = "match")>] Match: HostExecMatchDto
      [<YamlMember(Alias = "cwd")>] Cwd: HostExecCwdDto
      [<YamlMember(Alias = "env")>] Env: Dictionary<string, string>
      [<YamlMember(Alias = "inherit-env")>] InheritEnv: HostExecInheritEnvDto
      [<YamlMember(Alias = "approval")>] Approval: string
      [<YamlMember(Alias = "fallback")>] Fallback: string }

[<CLIMutable>]
type HostExecDto =
    { [<YamlMember(Alias = "prompt")>] Prompt: HostExecPromptDto
      [<YamlMember(Alias = "secrets")>] Secrets: Dictionary<string, SecretDto>
      [<YamlMember(Alias = "rules")>] Rules: List<HostExecRuleDto> }

[<CLIMutable>]
type UiDto =
    { [<YamlMember(Alias = "enable")>] Enable: System.Nullable<bool>
      [<YamlMember(Alias = "port")>] Port: System.Nullable<int>
      [<YamlMember(Alias = "idle-timeout")>] IdleTimeout: System.Nullable<int> }

[<CLIMutable>]
type ProfileDto =
    { [<YamlMember(Alias = "agent")>] Agent: string
      [<YamlMember(Alias = "agent-args")>] AgentArgs: List<string>
      [<YamlMember(Alias = "worktree")>] Worktree: WorktreeDto
      [<YamlMember(Alias = "nix")>] Nix: NixDto
      [<YamlMember(Alias = "docker")>] Docker: DockerDto
      [<YamlMember(Alias = "gcloud")>] Gcloud: GcloudDto
      [<YamlMember(Alias = "aws")>] Aws: AwsDto
      [<YamlMember(Alias = "gpg")>] Gpg: GpgDto
      [<YamlMember(Alias = "network")>] Network: NetworkDto
      [<YamlMember(Alias = "dbus")>] Dbus: DbusDto
      [<YamlMember(Alias = "extra-mounts")>] ExtraMounts: List<ExtraMountDto>
      [<YamlMember(Alias = "env")>] Env: List<EnvDto>
      [<YamlMember(Alias = "hostexec")>] HostExec: HostExecDto }

[<CLIMutable>]
type ConfigDto =
    { [<YamlMember(Alias = "default")>] Default: string
      [<YamlMember(Alias = "ui")>] Ui: UiDto
      [<YamlMember(Alias = "profiles")>] Profiles: Dictionary<string, ProfileDto> }
