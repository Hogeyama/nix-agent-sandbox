namespace Nas.Core.Pipeline

open System
open System.Security.Cryptography
open Nas.Core
open Nas.Core.Config

type ExecutionContext =
    { Config: Config; Profile: Profile; ProfileName: string; SessionId: string
      WorkDir: string; MountDir: string option; ImageName: string
      DockerArgs: string list; EnvVars: Map<string, string>
      NetworkRuntimeDir: string option; NetworkPromptToken: string option
      NetworkPromptEnabled: bool; NetworkBrokerSocket: string option
      NetworkProxyEndpoint: string option; HostExecRuntimeDir: string option
      HostExecBrokerSocket: string option; HostExecSessionTmpDir: string option
      DbusProxyEnabled: bool; DbusSessionRuntimeDir: string option
      DbusSessionSocket: string option; DbusSessionSourceAddress: string option
      NixEnabled: bool
      AgentCommand: string list; LogLevel: LogLevel }

module ExecutionContext =
    let private randomHex (bytes: int) =
        let buf = RandomNumberGenerator.GetBytes(bytes)
        buf |> Array.map (fun b -> b.ToString("x2")) |> String.concat ""

    let create (config: Config) (profile: Profile) (profileName: string) (workDir: string) (logLevel: LogLevel) =
        let sessionId = SessionId.create () |> SessionId.value
        let proxyEnabled = not profile.Network.Allowlist.IsEmpty || profile.Network.Prompt.Enable
        { Config = config; Profile = profile; ProfileName = profileName; SessionId = sessionId
          WorkDir = workDir; MountDir = None; ImageName = "nas-sandbox"
          DockerArgs = []; EnvVars = Map.empty
          NetworkRuntimeDir = None
          NetworkPromptToken = if proxyEnabled then Some (randomHex 32) else None
          NetworkPromptEnabled = profile.Network.Prompt.Enable
          NetworkBrokerSocket = None; NetworkProxyEndpoint = None
          HostExecRuntimeDir = None; HostExecBrokerSocket = None; HostExecSessionTmpDir = None
          DbusProxyEnabled = profile.Dbus.Session.Enable
          DbusSessionRuntimeDir = None; DbusSessionSocket = None; DbusSessionSourceAddress = None
          NixEnabled = false; AgentCommand = []; LogLevel = logLevel }
