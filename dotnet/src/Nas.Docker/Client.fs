namespace Nas.Docker

open System
open System.IO
open System.Security.Cryptography
open System.Text
open System.Threading
open System.Threading.Tasks
open CliWrap
open CliWrap.Buffered
open Nas.Core

module DockerClient =
    let private docker = "docker"

    let private exec (args: string list) (ct: CancellationToken) =
        task {
            let argsStr = args |> String.concat " "
            Log.verbose $"docker {argsStr}"
            let! result =
                Cli.Wrap(docker).WithArguments(args)
                    .WithValidation(CommandResultValidation.None)
                    .ExecuteBufferedAsync(ct)
            return result
        }

    let imageExists (imageName: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "image"; "inspect"; imageName ] ct
            return result.ExitCode = 0
        }

    let getImageLabel (imageName: string) (label: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "inspect"; "--format"; $"{{{{index .Config.Labels \"{label}\"}}}}"; imageName ] ct
            if result.ExitCode = 0 then
                let v = result.StandardOutput.Trim()
                return if String.IsNullOrEmpty(v) || v = "<no value>" then None else Some v
            else return None
        }

    let build (contextDir: string) (imageName: string) (labels: (string * string) list) (ct: CancellationToken) =
        task {
            let labelArgs = labels |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
            let! result = exec ([ "build"; "-t"; imageName ] @ labelArgs @ [ contextDir ]) ct
            if result.ExitCode <> 0 then failwith $"Docker build failed: {result.StandardError}"
            return result
        }

    let run (imageName: string) (containerName: string) (dockerArgs: string list) (envVars: Map<string, string>) (command: string list) (ct: CancellationToken) =
        task {
            let envArgs = envVars |> Map.toList |> List.collect (fun (k, v) -> [ "-e"; $"{k}={v}" ])
            let args = [ "run"; "--rm"; "-it"; "--name"; containerName ] @ dockerArgs @ envArgs @ [ imageName ] @ command
            let psi = System.Diagnostics.ProcessStartInfo(docker, args |> String.concat " ", UseShellExecute = false)
            use p = System.Diagnostics.Process.Start(psi)
            do! p.WaitForExitAsync(ct)
            return p.ExitCode
        }

    let runDetached (imageName: string) (containerName: string) (dockerArgs: string list) (envVars: Map<string, string>) (command: string list) (ct: CancellationToken) =
        task {
            let envArgs = envVars |> Map.toList |> List.collect (fun (k, v) -> [ "-e"; $"{k}={v}" ])
            let! result = exec ([ "run"; "-d"; "--name"; containerName ] @ dockerArgs @ envArgs @ [ imageName ] @ command) ct
            if result.ExitCode <> 0 then failwith $"Docker run failed: {result.StandardError}"
            return result.StandardOutput.Trim()
        }

    let isRunning (containerName: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "inspect"; "--format"; "{{.State.Running}}"; containerName ] ct
            return result.ExitCode = 0 && result.StandardOutput.Trim() = "true"
        }

    let stopAndRemove (containerName: string) (ct: CancellationToken) =
        task {
            let! _ = exec [ "stop"; containerName ] ct
            let! _ = exec [ "rm"; "-f"; containerName ] ct
            return ()
        }

    let networkCreate (name: string) (ct: CancellationToken) =
        task {
            let labelArgs = NasResources.labels NasResourceKind.Network |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
            let! result = exec ([ "network"; "create" ] @ labelArgs @ [ name ]) ct
            if result.ExitCode <> 0 then failwith $"Network create failed: {result.StandardError}"
        }

    let networkConnect (network: string) (container: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "network"; "connect"; network; container ] ct
            if result.ExitCode <> 0 then failwith $"Network connect failed: {result.StandardError}"
        }

    let networkRemove (name: string) (ct: CancellationToken) =
        task { let! _ = exec [ "network"; "rm"; name ] ct in return () }

    let volumeCreate (name: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "volume"; "create"; name ] ct
            if result.ExitCode <> 0 then failwith $"Volume create failed: {result.StandardError}"
        }

    let volumeRemove (name: string) (ct: CancellationToken) =
        task { let! _ = exec [ "volume"; "rm"; "-f"; name ] ct in return () }

    let computeEmbedHash (files: (string * byte array) list) =
        use sha256 = SHA256.Create()
        let combined = files |> List.sortBy fst |> List.collect (fun (n, c) -> [ Encoding.UTF8.GetBytes(n); c ]) |> Array.concat
        sha256.ComputeHash(combined) |> Array.map (fun b -> b.ToString("x2")) |> String.concat ""

    let listNasContainers (ct: CancellationToken) =
        task {
            let! result = exec [ "ps"; "-a"; "--filter"; NasResources.labelFilter (); "--format"; "{{.Names}}\t{{.Status}}\t{{.Labels}}" ] ct
            if result.ExitCode = 0 then
                return result.StandardOutput.Trim().Split('\n', StringSplitOptions.RemoveEmptyEntries) |> Array.toList
            else return []
        }

    let stop (containerName: string) (timeoutSeconds: int) (ct: CancellationToken) =
        task {
            let! _ = exec [ "stop"; "-t"; string timeoutSeconds; containerName ] ct
            return ()
        }

    let rm (containerName: string) (ct: CancellationToken) =
        task {
            let! _ = exec [ "rm"; "-f"; containerName ] ct
            return ()
        }

    let containerExists (containerName: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "inspect"; containerName ] ct
            return result.ExitCode = 0
        }

    let containerIp (containerName: string) (ct: CancellationToken) =
        task {
            let! result = exec [ "inspect"; "--format"; "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"; containerName ] ct
            if result.ExitCode = 0 then
                let ip = result.StandardOutput.Trim()
                return if String.IsNullOrEmpty(ip) then None else Some ip
            else return None
        }

    let logs (containerName: string) (tail: int) (ct: CancellationToken) =
        task {
            let! result = exec [ "logs"; "--tail"; string tail; containerName ] ct
            return if result.ExitCode = 0 then result.StandardOutput + result.StandardError else ""
        }

    let dockerExec (containerName: string) (command: string list) (user: string option) (ct: CancellationToken) =
        task {
            let userArgs = match user with Some u -> [ "--user"; u ] | None -> []
            let! result = exec ([ "exec" ] @ userArgs @ [ containerName ] @ command) ct
            return result.ExitCode, result.StandardOutput, result.StandardError
        }

    let networkCreateWithLabels (name: string) (labels: (string * string) list) (internal': bool) (ct: CancellationToken) =
        task {
            let labelArgs = labels |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
            let internalArg = if internal' then [ "--internal" ] else []
            let! result = exec ([ "network"; "create" ] @ labelArgs @ internalArg @ [ name ]) ct
            if result.ExitCode <> 0 then failwith $"Network create failed: {result.StandardError}"
        }

    let networkConnectWithAliases (network: string) (container: string) (aliases: string list) (ct: CancellationToken) =
        task {
            let aliasArgs = aliases |> List.collect (fun a -> [ "--alias"; a ])
            let! result = exec ([ "network"; "connect" ] @ aliasArgs @ [ network; container ]) ct
            if result.ExitCode <> 0 then failwith $"Network connect failed: {result.StandardError}"
        }

    let networkDisconnect (network: string) (container: string) (ct: CancellationToken) =
        task {
            let! _ = exec [ "network"; "disconnect"; network; container ] ct
            return ()
        }

    let volumeCreateWithLabels (name: string) (labels: (string * string) list) (ct: CancellationToken) =
        task {
            let labelArgs = labels |> List.collect (fun (k, v) -> [ "--label"; $"{k}={v}" ])
            let! result = exec ([ "volume"; "create" ] @ labelArgs @ [ name ]) ct
            if result.ExitCode <> 0 then failwith $"Volume create failed: {result.StandardError}"
        }

    let imageRemove (imageName: string) (force: bool) (ct: CancellationToken) =
        task {
            let args = if force then [ "rmi"; "--force"; imageName ] else [ "rmi"; imageName ]
            let! result = exec args ct
            return result.ExitCode = 0
        }
