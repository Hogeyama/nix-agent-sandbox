namespace Nas.Agents

open System
open System.IO

type AgentMountResult = { DockerArgs: string list; EnvVars: Map<string, string>; Command: string list }

module AgentUtils =
    let findBinary (name: string) =
        try
            let psi = System.Diagnostics.ProcessStartInfo("which", name, RedirectStandardOutput = true, UseShellExecute = false)
            use p = System.Diagnostics.Process.Start(psi)
            let output = p.StandardOutput.ReadToEnd().Trim()
            p.WaitForExit()
            if p.ExitCode = 0 && not (String.IsNullOrEmpty(output)) then Some output else None
        with _ -> None

    let resolveSymlinks (path: string) =
        try
            let psi = System.Diagnostics.ProcessStartInfo("readlink", $"-f {path}",
                        RedirectStandardOutput = true, UseShellExecute = false)
            use p = System.Diagnostics.Process.Start(psi)
            let output = p.StandardOutput.ReadToEnd().Trim()
            p.WaitForExit()
            if p.ExitCode = 0 && not (String.IsNullOrEmpty(output)) then output else path
        with _ -> path

    let bindMount (source: string) (dest: string) (readOnly: bool) =
        let ro = if readOnly then ":ro" else ""
        [ "-v"; $"{source}:{dest}{ro}" ]

    let fileExistsSync (path: string) = try File.Exists(path) with _ -> false
    let dirExistsSync (path: string) = try Directory.Exists(path) with _ -> false

    /// Remap a host path to container, replacing hostHome prefix with containerHome
    let remapToContainer (hostPath: string) (hostHome: string) (containerHome: string) =
        if hostPath.StartsWith(hostHome + "/") then
            $"{containerHome}/{hostPath.Substring(hostHome.Length + 1)}"
        else hostPath
