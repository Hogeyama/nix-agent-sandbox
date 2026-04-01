namespace Nas.Dbus

open System
open System.IO
open Nas.Core.Lib

module DbusRegistry =
    let getSessionDir (runtimeDir: string) (sessionId: string) = Path.Combine(runtimeDir, "dbus", sessionId)
    let getSocketPath (sessionDir: string) = Path.Combine(sessionDir, "bus")
    let ensureSessionDir (runtimeDir: string) (sessionId: string) =
        let dir = getSessionDir runtimeDir sessionId
        FsUtils.ensureDir dir; dir
    let cleanup (runtimeDir: string) (sessionId: string) =
        let dir = getSessionDir runtimeDir sessionId
        if Directory.Exists(dir) then try Directory.Delete(dir, true) with _ -> ()
    let getDefaultBusAddress () =
        let addr = Environment.GetEnvironmentVariable("DBUS_SESSION_BUS_ADDRESS")
        if not (String.IsNullOrEmpty(addr)) then Some addr
        else
            let uid = Environment.GetEnvironmentVariable("UID")
            let path = if not (String.IsNullOrEmpty(uid)) then $"/run/user/{uid}/bus" else "/run/user/1000/bus"
            if File.Exists(path) then Some $"unix:path={path}" else None
