namespace Nas.Core.Config

open System
open System.IO
open System.Collections.Generic
open System.Text.Json
open Nas.Core
open Nas.Core.Lib
open Nas.Core.Config.Dto
open YamlDotNet.Serialization
open YamlDotNet.Serialization.NamingConventions

module Load =
    let private configFileNames = [| ".agent-sandbox.yml"; ".agent-sandbox.yaml"; ".agent-sandbox.nix" |]

    let findConfigFile (startDir: string) =
        FsUtils.searchUpward startDir (fun path ->
            let name = Path.GetFileName(path)
            Array.contains name configFileNames)

    let findGlobalConfigFile () =
        let configHome =
            let xdg = Environment.GetEnvironmentVariable("XDG_CONFIG_HOME")
            if not (String.IsNullOrEmpty(xdg)) then xdg
            else Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".config")
        let nasDir = Path.Combine(configHome, "nas")
        [| "agent-sandbox.yml"; "agent-sandbox.yaml"; "agent-sandbox.nix" |]
        |> Array.tryPick (fun name ->
            let path = Path.Combine(nasDir, name)
            if File.Exists(path) then Some path else None)

    // --- Helpers for nullable / null-safe conversion ---

    let inline private nullableOr (defaultVal: 'T) (n: Nullable<'T>) =
        if n.HasValue then n.Value else defaultVal

    let inline private optionOfObj (x: 'T) =
        if obj.ReferenceEquals(x, null) then None else Some x

    let inline private listOfSeq (xs: IEnumerable<'T>) =
        if obj.ReferenceEquals(xs, null) then [] else xs |> Seq.toList

    let inline private isNull' x = obj.ReferenceEquals(x, null)

    // --- DU parsers with defaults ---

    let private parseAgentType (s: string) =
        if isNull' s then AgentType.Claude
        else
            match AgentType.FromString s with
            | Some a -> a
            | None -> failwith $"Unknown agent type: '{s}'"

    let private parseNixEnableMode (o: obj) =
        match o with
        | null -> NixEnableMode.Auto
        | :? bool as b -> if b then NixEnableMode.Enabled else NixEnableMode.Disabled
        | :? string as s ->
            match s.ToLowerInvariant() with
            | "auto" -> NixEnableMode.Auto
            | "true" -> NixEnableMode.Enabled
            | "false" -> NixEnableMode.Disabled
            | _ -> failwith $"Unknown nix enable mode: '{s}'"
        | _ -> NixEnableMode.Auto

    let private parseApprovalScope (s: string) =
        if isNull' s then ApprovalScope.HostPort
        else
            match ApprovalScope.FromString s with
            | Some a -> a
            | None -> failwith $"Unknown approval scope: '{s}'"

    let private parseNotifyMode (s: string) =
        if isNull' s then NotifyMode.Auto
        else
            match s.ToLowerInvariant() with
            | "auto" -> NotifyMode.Auto
            | "desktop" -> NotifyMode.Desktop
            | "off" -> NotifyMode.Off
            | _ -> failwith $"Unknown notify mode: '{s}'"

    let private parseHostExecApproval (s: string) =
        if isNull' s then HostExecApproval.Deny
        else
            match s.ToLowerInvariant() with
            | "allow" -> HostExecApproval.Allow
            | "prompt" -> HostExecApproval.Prompt
            | "deny" -> HostExecApproval.Deny
            | _ -> failwith $"Unknown hostexec approval: '{s}'"

    let private parseHostExecFallback (s: string) =
        if isNull' s then HostExecFallback.Deny
        else
            match s.ToLowerInvariant() with
            | "container" -> HostExecFallback.Container
            | "deny" -> HostExecFallback.Deny
            | _ -> failwith $"Unknown hostexec fallback: '{s}'"

    let private parseHostExecCwdMode (s: string) =
        if isNull' s then HostExecCwdMode.WorkspaceOnly
        else
            match s.ToLowerInvariant() with
            | "workspace-only" -> HostExecCwdMode.WorkspaceOnly
            | "workspace-or-session-tmp" -> HostExecCwdMode.WorkspaceOrSessionTmp
            | "allowlist" -> HostExecCwdMode.Allowlist
            | "any" -> HostExecCwdMode.Any
            | _ -> failwith $"Unknown hostexec cwd mode: '{s}'"

    let private parseGradleProxyMode (o: obj) =
        match o with
        | null -> GradleProxyMode.Auto
        | :? bool as b -> if b then GradleProxyMode.On else GradleProxyMode.Off
        | :? string as s ->
            match s.ToLowerInvariant() with
            | "auto" -> GradleProxyMode.Auto
            | "true" -> GradleProxyMode.On
            | "false" -> GradleProxyMode.Off
            | _ -> failwith $"Unknown gradle proxy mode: '{s}'"
        | _ -> GradleProxyMode.Auto

    // --- DTO → F# record mappers ---

    let private mapWorktree (dto: WorktreeDto) : WorktreeConfig option =
        if isNull' (box dto) then None
        else
            Some
                { Enable = nullableOr false dto.Enable
                  Base = optionOfObj dto.Base
                  OnCreate = optionOfObj dto.OnCreate }

    let private mapNix (dto: NixDto) : NixConfig =
        if isNull' (box dto) then NixConfig.Default
        else
            { Enable = parseNixEnableMode dto.Enable
              MountSocket = nullableOr NixConfig.Default.MountSocket dto.MountSocket
              ExtraPackages = listOfSeq dto.ExtraPackages }

    let private mapDocker (dto: DockerDto) : DockerConfig =
        if isNull' (box dto) then DockerConfig.Default
        else
            { Enable = nullableOr false dto.Enable
              Shared = nullableOr false dto.Shared }

    let private mapGcloud (dto: GcloudDto) : GcloudConfig =
        if isNull' (box dto) then GcloudConfig.Default
        else { MountConfig = nullableOr false dto.MountConfig }

    let private mapAws (dto: AwsDto) : AwsConfig =
        if isNull' (box dto) then AwsConfig.Default
        else { MountConfig = nullableOr false dto.MountConfig }

    let private mapGpg (dto: GpgDto) : GpgConfig =
        if isNull' (box dto) then GpgConfig.Default
        else { ForwardAgent = nullableOr false dto.ForwardAgent }

    let private mapNetworkPrompt (dto: NetworkPromptDto) : NetworkPromptConfig =
        if isNull' (box dto) then NetworkPromptConfig.Default
        else
            { Enable = nullableOr false dto.Enable
              Denylist = listOfSeq dto.Denylist
              TimeoutSeconds = nullableOr NetworkPromptConfig.Default.TimeoutSeconds dto.TimeoutSeconds
              DefaultScope = parseApprovalScope dto.DefaultScope
              Notify = parseNotifyMode dto.Notify }

    let private mapNetworkGradle (dto: NetworkGradleDto) : NetworkGradleConfig =
        if isNull' (box dto) then NetworkGradleConfig.Default
        else { Proxy = parseGradleProxyMode dto.Proxy }

    let private mapNetwork (dto: NetworkDto) : NetworkConfig =
        if isNull' (box dto) then NetworkConfig.Default
        else
            { Allowlist = listOfSeq dto.Allowlist
              Prompt = mapNetworkPrompt dto.Prompt
              Gradle = mapNetworkGradle dto.Gradle }

    let private mapDbusRule (dto: DbusRuleDto) : DbusRuleConfig =
        { Name = if isNull' dto.Name then "" else dto.Name
          Rule = if isNull' dto.Rule then "" else dto.Rule }

    let private mapDbusSession (dto: DbusSessionDto) : DbusSessionConfig =
        if isNull' (box dto) then DbusSessionConfig.Default
        else
            { Enable = nullableOr false dto.Enable
              SourceAddress = optionOfObj dto.SourceAddress
              See = listOfSeq dto.See
              Talk = listOfSeq dto.Talk
              Own = listOfSeq dto.Own
              Calls = listOfSeq dto.Calls |> List.map mapDbusRule
              Broadcasts = listOfSeq dto.Broadcasts |> List.map mapDbusRule }

    let private mapDbus (dto: DbusDto) : DbusConfig =
        if isNull' (box dto) then DbusConfig.Default
        else { Session = mapDbusSession dto.Session }

    let private mapExtraMount (dto: ExtraMountDto) : ExtraMountConfig =
        { Src = if isNull' dto.Src then "" else dto.Src
          Dst = if isNull' dto.Dst then "" else dto.Dst
          Mode = if isNull' dto.Mode then "ro" else dto.Mode }

    let private mapEnv (dto: EnvDto) : EnvConfig =
        { Key = optionOfObj dto.Key
          KeyCmd = optionOfObj dto.KeyCmd
          Val = optionOfObj dto.Val
          ValCmd = optionOfObj dto.ValCmd }

    let private mapHostExecPrompt (dto: HostExecPromptDto) : HostExecPromptConfig =
        if isNull' (box dto) then HostExecPromptConfig.Default
        else
            { Enable = nullableOr HostExecPromptConfig.Default.Enable dto.Enable
              TimeoutSeconds = nullableOr HostExecPromptConfig.Default.TimeoutSeconds dto.TimeoutSeconds
              DefaultScope = if isNull' dto.DefaultScope then HostExecPromptConfig.Default.DefaultScope else dto.DefaultScope
              Notify = parseNotifyMode dto.Notify }

    let private mapSecret (dto: SecretDto) : SecretConfig =
        { From = if isNull' dto.From then "" else dto.From
          Required = nullableOr true dto.Required }

    let private mapHostExecCwd (dto: HostExecCwdDto) : HostExecCwdConfig =
        if isNull' (box dto) then
            { Mode = HostExecCwdMode.WorkspaceOnly; Allow = [] }
        else
            { Mode = parseHostExecCwdMode dto.Mode
              Allow = listOfSeq dto.Allow }

    let private mapHostExecInheritEnv (dto: HostExecInheritEnvDto) : HostExecInheritEnvConfig =
        if isNull' (box dto) then HostExecInheritEnvConfig.Default
        else
            { Mode = if isNull' dto.Mode then "minimal" else dto.Mode
              Keys = listOfSeq dto.Keys }

    let private mapHostExecMatch (dto: HostExecMatchDto) : HostExecMatchConfig =
        if isNull' (box dto) then
            { Argv0 = ""; ArgRegex = None }
        else
            { Argv0 = if isNull' dto.Argv0 then "" else dto.Argv0
              ArgRegex = optionOfObj dto.ArgRegex }

    let private mapHostExecRule (dto: HostExecRuleDto) : HostExecRule =
        { Id = if isNull' dto.Id then "" else dto.Id
          Match = mapHostExecMatch dto.Match
          Cwd = mapHostExecCwd dto.Cwd
          Env =
            if isNull' dto.Env then Map.empty
            else dto.Env |> Seq.map (fun kv -> kv.Key, kv.Value) |> Map.ofSeq
          InheritEnv = mapHostExecInheritEnv dto.InheritEnv
          Approval = parseHostExecApproval dto.Approval
          Fallback = parseHostExecFallback dto.Fallback }

    let private mapHostExec (dto: HostExecDto) : HostExecConfig option =
        if isNull' (box dto) then None
        else
            Some
                { Prompt = mapHostExecPrompt dto.Prompt
                  Secrets =
                    if isNull' dto.Secrets then Map.empty
                    else dto.Secrets |> Seq.map (fun kv -> kv.Key, mapSecret kv.Value) |> Map.ofSeq
                  Rules = listOfSeq dto.Rules |> List.map mapHostExecRule }

    let private mapUi (dto: UiDto) : UiConfig =
        if isNull' (box dto) then UiConfig.Default
        else
            { Enable = nullableOr UiConfig.Default.Enable dto.Enable
              Port = nullableOr UiConfig.Default.Port dto.Port
              IdleTimeout = nullableOr UiConfig.Default.IdleTimeout dto.IdleTimeout }

    let private mapProfile (dto: ProfileDto) : Profile =
        { Agent = parseAgentType dto.Agent
          AgentArgs = listOfSeq dto.AgentArgs
          Worktree = mapWorktree dto.Worktree
          Nix = mapNix dto.Nix
          Docker = mapDocker dto.Docker
          Gcloud = mapGcloud dto.Gcloud
          Aws = mapAws dto.Aws
          Gpg = mapGpg dto.Gpg
          Network = mapNetwork dto.Network
          Dbus = mapDbus dto.Dbus
          ExtraMounts = listOfSeq dto.ExtraMounts |> List.map mapExtraMount
          Env = listOfSeq dto.Env |> List.map mapEnv
          HostExec = mapHostExec dto.HostExec }

    let private mapConfig (dto: ConfigDto) : Config =
        { Default = optionOfObj dto.Default
          Ui = mapUi dto.Ui
          Profiles =
            if isNull' dto.Profiles then Map.empty
            else dto.Profiles |> Seq.map (fun kv -> kv.Key, mapProfile kv.Value) |> Map.ofSeq }

    // --- Public API ---

    let private buildDeserializer () =
        DeserializerBuilder()
            .WithNamingConvention(HyphenatedNamingConvention.Instance)
            .IgnoreUnmatchedProperties()
            .Build()

    /// Parse a YAML string into a typed Config record.
    let parseConfig (content: string) : Config =
        let deserializer = buildDeserializer ()
        let dto = deserializer.Deserialize<ConfigDto>(content)
        if isNull' (box dto) then Config.Empty
        else mapConfig dto

    /// Parse a YAML string into a raw dictionary (kept for backward compat).
    let parseYaml (content: string) =
        let deserializer = buildDeserializer ()
        deserializer.Deserialize<Dictionary<string, obj>>(content)

    /// Check if 'nix' command is available on PATH.
    let private nixCommandExists () =
        try
            let psi = System.Diagnostics.ProcessStartInfo("nix", "--version",
                        RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false)
            use p = System.Diagnostics.Process.Start(psi)
            p.WaitForExit(5000) |> ignore
            p.ExitCode = 0
        with _ -> false

    /// Evaluate a .nix config file via `nix eval --impure --json --file`.
    let loadNixConfigFile (path: string) : Config =
        if not (nixCommandExists ()) then
            failwith $"Found .agent-sandbox.nix at {path}, but 'nix' command is not available on PATH. Install Nix or use .agent-sandbox.yml instead."
        let psi = System.Diagnostics.ProcessStartInfo("nix",
                    $"eval --impure --json --file \"{path}\"",
                    RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false)
        use p = System.Diagnostics.Process.Start(psi)
        let stdout = p.StandardOutput.ReadToEnd()
        let stderr = p.StandardError.ReadToEnd()
        p.WaitForExit()
        if p.ExitCode <> 0 then
            failwith $"Failed to evaluate {path}: nix eval exited with code {p.ExitCode}\n{stderr.Trim()}"
        // Parse JSON output into ConfigDto via System.Text.Json
        let options = JsonSerializerOptions(PropertyNameCaseInsensitive = true)
        options.PropertyNamingPolicy <- JsonNamingPolicy.KebabCaseLower
        let dto = JsonSerializer.Deserialize<ConfigDto>(stdout, options)
        if isNull' (box dto) then Config.Empty
        else mapConfig dto

    /// Load and parse a config file from disk (YAML or Nix).
    let loadConfigFile (path: string) : Config =
        if path.EndsWith(".nix") then
            loadNixConfigFile path
        else
            let content = File.ReadAllText(path)
            parseConfig content

    /// Merge two Config records (global and local), local takes precedence.
    let mergeConfigs (globalCfg: Config) (localCfg: Config) : Config =
        let mergedProfiles =
            let allNames =
                Set.union
                    (globalCfg.Profiles |> Map.keys |> Set.ofSeq)
                    (localCfg.Profiles |> Map.keys |> Set.ofSeq)
            allNames |> Seq.fold (fun acc name ->
                let gp = globalCfg.Profiles |> Map.tryFind name
                let lp = localCfg.Profiles |> Map.tryFind name
                match gp, lp with
                | Some _, Some local -> acc |> Map.add name local
                | None, Some local -> acc |> Map.add name local
                | Some g, None -> acc |> Map.add name g
                | None, None -> acc
            ) Map.empty
        { Default = localCfg.Default |> Option.orElse globalCfg.Default
          Ui = localCfg.Ui
          Profiles = mergedProfiles }

    /// Load config searching local (upward) and global dirs, merging if both exist.
    let loadConfig (startDir: string) : Config =
        let localPath = findConfigFile startDir
        let globalPath = findGlobalConfigFile ()
        match localPath, globalPath with
        | None, None ->
            failwith ".agent-sandbox.yml (or .agent-sandbox.nix) not found in current directory or parent directories, and no global config found in ~/.config/nas/"
        | Some lp, None -> loadConfigFile lp
        | None, Some gp -> loadConfigFile gp
        | Some lp, Some gp ->
            let local = loadConfigFile lp
            let globalCfg = loadConfigFile gp
            mergeConfigs globalCfg local

    let resolveProfile (config: Config) (profileName: string option) =
        let availableNames = config.Profiles |> Map.keys |> String.concat ", "
        match profileName with
        | Some name ->
            match config.Profiles.TryFind(name) with
            | Some profile -> Ok(name, profile)
            | None -> Error $"Profile '{name}' not found. Available: {availableNames}"
        | None ->
            match config.Default with
            | Some defaultName ->
                match config.Profiles.TryFind(defaultName) with
                | Some profile -> Ok(defaultName, profile)
                | None -> Error $"Default profile '{defaultName}' not found"
            | None ->
                match config.Profiles |> Map.toList with
                | [ (name, profile) ] -> Ok(name, profile)
                | [] -> Error "No profiles defined"
                | _ -> Error $"Multiple profiles exist but no default specified. Available: {availableNames}"
