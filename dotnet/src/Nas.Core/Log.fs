namespace Nas.Core

module Log =
    let mutable private currentLevel = LogLevel.Normal

    let setLevel level = currentLevel <- level
    let getLevel () = currentLevel

    let info (msg: string) =
        if currentLevel <> LogLevel.Quiet then
            eprintfn $"[nas] {msg}"

    let warn (msg: string) =
        if currentLevel <> LogLevel.Quiet then
            eprintfn $"[nas] WARNING: {msg}"

    let error (msg: string) =
        eprintfn $"[nas] ERROR: {msg}"

    let verbose (msg: string) =
        if currentLevel = LogLevel.Verbose then
            eprintfn $"[nas] DEBUG: {msg}"
