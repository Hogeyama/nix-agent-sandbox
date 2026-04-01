namespace Nas.Core.Lib

open System
open System.IO

module RuntimeRegistry =
    let getRuntimeDir () =
        let xdg = Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR")
        let baseDir = if not (String.IsNullOrEmpty(xdg)) then xdg
                      else Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache")
        Path.Combine(baseDir, "nas")

    let getDataDir () =
        let xdg = Environment.GetEnvironmentVariable("XDG_DATA_HOME")
        let baseDir = if not (String.IsNullOrEmpty(xdg)) then xdg
                      else Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share")
        Path.Combine(baseDir, "nas")

    let writeSessionFile (dir: string) (sessionId: string) (content: string) =
        let sessionsDir = Path.Combine(dir, "sessions")
        FsUtils.ensureDir sessionsDir
        let filePath = Path.Combine(sessionsDir, $"{sessionId}.json")
        File.WriteAllText(filePath, content)
        filePath

    let removeSessionFile (dir: string) (sessionId: string) =
        let filePath = Path.Combine(dir, "sessions", $"{sessionId}.json")
        if File.Exists(filePath) then File.Delete(filePath)

    let listSessionFiles (dir: string) =
        let sessionsDir = Path.Combine(dir, "sessions")
        if Directory.Exists(sessionsDir) then Directory.GetFiles(sessionsDir, "*.json") |> Array.toList
        else []

    let writePendingFile (dir: string) (sessionId: string) (requestId: string) (content: string) =
        let pendingDir = Path.Combine(dir, "pending", sessionId)
        FsUtils.ensureDir pendingDir
        let filePath = Path.Combine(pendingDir, $"{requestId}.json")
        File.WriteAllText(filePath, content)
        filePath

    let removePendingFile (dir: string) (sessionId: string) (requestId: string) =
        let filePath = Path.Combine(dir, "pending", sessionId, $"{requestId}.json")
        if File.Exists(filePath) then File.Delete(filePath)

    let listPendingFiles (dir: string) (sessionId: string) =
        let pendingDir = Path.Combine(dir, "pending", sessionId)
        if Directory.Exists(pendingDir) then Directory.GetFiles(pendingDir, "*.json") |> Array.toList
        else []

    let gc (dir: string) =
        let sessionsDir = Path.Combine(dir, "sessions")
        let pendingDir = Path.Combine(dir, "pending")
        let activeSessions =
            if Directory.Exists(sessionsDir) then
                Directory.GetFiles(sessionsDir, "*.json") |> Array.map Path.GetFileNameWithoutExtension |> Set.ofArray
            else Set.empty
        if Directory.Exists(pendingDir) then
            Directory.GetDirectories(pendingDir) |> Array.iter (fun d ->
                let sid = Path.GetFileName(d)
                if not (activeSessions.Contains(sid)) then Directory.Delete(d, true))
