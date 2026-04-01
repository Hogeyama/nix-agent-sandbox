namespace Nas.HostExec

open System
open System.IO
open Nas.Core.Config

module SecretStore =
    let resolveFromEnv (envName: string) =
        let v = Environment.GetEnvironmentVariable(envName)
        if not (String.IsNullOrEmpty(v)) then Some v else None

    let resolveFromFile (filePath: string) =
        if File.Exists(filePath) then Some(File.ReadAllText(filePath).Trim()) else None

    let resolve (config: SecretConfig) =
        if config.From.StartsWith("env:") then
            resolveFromEnv (config.From.Substring(4))
        elif config.From.StartsWith("file:") then
            resolveFromFile (config.From.Substring(5))
        else
            resolveFromEnv config.From

    let resolveAll (secrets: Map<string, SecretConfig>) =
        secrets |> Map.map (fun _ c -> resolve c) |> Map.filter (fun _ v -> v.IsSome) |> Map.map (fun _ v -> v.Value)

    let validateSecrets (secrets: Map<string, SecretConfig>) =
        let missing =
            secrets
            |> Map.toList
            |> List.choose (fun (n, c) ->
                if c.Required then
                    match resolve c with Some _ -> None | None -> Some n
                else None)
        if missing.IsEmpty then Ok() else Error(sprintf "Missing secrets: %s" (missing |> String.concat ", "))
