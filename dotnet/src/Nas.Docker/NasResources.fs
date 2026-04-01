namespace Nas.Docker

open Nas.Core

module NasResources =
    [<Literal>]
    let ManagedLabel = "nas.managed"
    [<Literal>]
    let KindLabel = "nas.kind"
    [<Literal>]
    let PwdLabel = "nas.pwd"
    [<Literal>]
    let ManagedValue = "nas"

    let containerName (kind: NasResourceKind) (sessionId: string) = $"nas-{kind.ToLabel()}-{sessionId}"
    let networkName (sessionId: string) = $"nas-network-{sessionId}"
    let volumeName (sessionId: string) (suffix: string) = $"nas-vol-{sessionId}-{suffix}"
    let labels (kind: NasResourceKind) = [ ManagedLabel, ManagedValue; KindLabel, kind.ToLabel() ]
    let labelFilter () = $"label={ManagedLabel}={ManagedValue}"
