namespace Nas.Core.Config

module Validate =
    let isValidAllowlistEntry (entry: string) =
        if entry.StartsWith("*.") then
            let domain = entry.Substring(2)
            not (System.String.IsNullOrWhiteSpace(domain)) && not (domain.Contains("*")) && domain.Contains(".")
        else
            not (System.String.IsNullOrWhiteSpace(entry)) && not (entry.Contains("*"))

    let validateAllowlist (entries: string list) =
        entries |> List.choose (fun e ->
            if isValidAllowlistEntry e then None
            else Some $"Invalid allowlist entry: '{e}'. Wildcards must use '*.domain.com' format.")

    let validateProfile (name: string) (profile: Profile) =
        let errors = ResizeArray<string>()
        profile.Network.Allowlist |> validateAllowlist |> List.iter errors.Add
        match profile.HostExec with
        | Some hostexec ->
            let ids = hostexec.Rules |> List.map (fun r -> r.Id)
            let dups = ids |> List.groupBy id |> List.filter (fun (_, g) -> g.Length > 1) |> List.map fst
            for dup in dups do errors.Add $"Profile '{name}': Duplicate hostexec rule ID '{dup}'"
        | None -> ()
        let dests = profile.ExtraMounts |> List.map (fun m -> m.Dst)
        let dupDests = dests |> List.groupBy id |> List.filter (fun (_, g) -> g.Length > 1) |> List.map fst
        for dup in dupDests do errors.Add $"Profile '{name}': Duplicate mount destination '{dup}'"
        errors |> Seq.toList

    let validateConfig (config: Config) =
        let errors = ResizeArray<string>()
        match config.Default with
        | Some d when not (config.Profiles.ContainsKey(d)) -> errors.Add $"Default profile '{d}' not found in profiles"
        | _ -> ()
        for kv in config.Profiles do validateProfile kv.Key kv.Value |> List.iter errors.Add
        errors |> Seq.toList
