namespace Nas.Core.Lib

open System
open System.Collections.Concurrent

type TtlLruCache<'TKey, 'TValue when 'TKey: equality>(maxSize: int, ttl: TimeSpan) =
    let cache = ConcurrentDictionary<'TKey, struct ('TValue * DateTime)>()
    let accessOrder = ConcurrentDictionary<'TKey, DateTime>()

    member _.TryGet(key: 'TKey) =
        match cache.TryGetValue(key) with
        | true, struct (value, expiry) when DateTime.UtcNow < expiry ->
            accessOrder.[key] <- DateTime.UtcNow
            Some value
        | true, _ ->
            cache.TryRemove(key) |> ignore
            accessOrder.TryRemove(key) |> ignore
            None
        | _ -> None

    member _.Set(key: 'TKey, value: 'TValue) =
        if cache.Count >= maxSize then
            let oldest = accessOrder |> Seq.sortBy (fun kv -> kv.Value) |> Seq.tryHead
            match oldest with
            | Some kv ->
                cache.TryRemove(kv.Key) |> ignore
                accessOrder.TryRemove(kv.Key) |> ignore
            | None -> ()
        cache.[key] <- struct (value, DateTime.UtcNow.Add(ttl))
        accessOrder.[key] <- DateTime.UtcNow

    member _.Remove(key: 'TKey) =
        cache.TryRemove(key) |> ignore
        accessOrder.TryRemove(key) |> ignore

    member _.Clear() =
        cache.Clear()
        accessOrder.Clear()

    member _.Count = cache.Count
