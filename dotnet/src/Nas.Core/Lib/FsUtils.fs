namespace Nas.Core.Lib

open System.IO

module FsUtils =
    let ensureDir (path: string) =
        if not (Directory.Exists path) then
            Directory.CreateDirectory(path) |> ignore

    let tryReadAllText (path: string) =
        if File.Exists path then Some(File.ReadAllText path) else None

    let searchUpward (startDir: string) (predicate: string -> bool) =
        let rec search (dir: string) =
            let files = Directory.GetFiles(dir)
            match files |> Array.tryFind predicate with
            | Some f -> Some f
            | None ->
                let parent = Directory.GetParent(dir)
                if isNull parent || parent.FullName = dir then None
                else search parent.FullName
        search (Path.GetFullPath startDir)
