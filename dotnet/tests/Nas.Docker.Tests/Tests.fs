module Nas.Docker.Tests.AllTests

open System.Text
open Xunit
open FsUnit.Xunit
open Nas.Core
open Nas.Docker

// ============================================================
// NasResources: naming
// ============================================================

[<Fact>]
let ``containerName Agent format`` () =
    NasResources.containerName NasResourceKind.Agent "abc"
    |> should equal "nas-agent-abc"

[<Fact>]
let ``containerName Envoy format`` () =
    NasResources.containerName NasResourceKind.Envoy "sess01"
    |> should equal "nas-envoy-sess01"

[<Fact>]
let ``containerName Dind format`` () =
    NasResources.containerName NasResourceKind.Dind "sess02"
    |> should equal "nas-dind-sess02"

[<Fact>]
let ``containerName Network format`` () =
    NasResources.containerName NasResourceKind.Network "sess03"
    |> should equal "nas-network-sess03"

[<Fact>]
let ``networkName format`` () =
    NasResources.networkName "abc" |> should equal "nas-network-abc"

[<Fact>]
let ``volumeName format`` () =
    NasResources.volumeName "sess01" "data"
    |> should equal "nas-vol-sess01-data"

// ============================================================
// NasResources: labels (ports isNasManagedSidecar / isNasManagedNetwork concepts)
// ============================================================

[<Fact>]
let ``labels for Dind include managed and kind`` () =
    let labels = NasResources.labels NasResourceKind.Dind
    labels |> should contain (NasResources.ManagedLabel, NasResources.ManagedValue)
    labels |> should contain (NasResources.KindLabel, "dind")

[<Fact>]
let ``labels for Envoy include managed and kind`` () =
    let labels = NasResources.labels NasResourceKind.Envoy
    labels |> should contain (NasResources.ManagedLabel, NasResources.ManagedValue)
    labels |> should contain (NasResources.KindLabel, "envoy")

[<Fact>]
let ``labels for Agent include managed and kind`` () =
    let labels = NasResources.labels NasResourceKind.Agent
    labels |> should contain (NasResources.ManagedLabel, NasResources.ManagedValue)
    labels |> should contain (NasResources.KindLabel, "agent")

[<Fact>]
let ``labels for Network include managed and kind`` () =
    let labels = NasResources.labels NasResourceKind.Network
    labels |> should contain (NasResources.ManagedLabel, NasResources.ManagedValue)
    labels |> should contain (NasResources.KindLabel, "network")

[<Fact>]
let ``labels always contain exactly two entries`` () =
    for kind in [ NasResourceKind.Agent; NasResourceKind.Envoy; NasResourceKind.Dind; NasResourceKind.Network ] do
        NasResources.labels kind |> List.length |> should equal 2

// ============================================================
// NasResources: constants
// ============================================================

[<Fact>]
let ``ManagedLabel constant`` () =
    NasResources.ManagedLabel |> should equal "nas.managed"

[<Fact>]
let ``KindLabel constant`` () =
    NasResources.KindLabel |> should equal "nas.kind"

[<Fact>]
let ``PwdLabel constant`` () =
    NasResources.PwdLabel |> should equal "nas.pwd"

[<Fact>]
let ``ManagedValue constant`` () =
    NasResources.ManagedValue |> should equal "nas"

// ============================================================
// NasResources: labelFilter
// ============================================================

[<Fact>]
let ``labelFilter format`` () =
    NasResources.labelFilter ()
    |> should equal "label=nas.managed=nas"

// ============================================================
// NasResourceKind: ToLabel
// ============================================================

[<Fact>]
let ``Agent kind label`` () =
    NasResourceKind.Agent.ToLabel() |> should equal "agent"

[<Fact>]
let ``Envoy kind label`` () =
    NasResourceKind.Envoy.ToLabel() |> should equal "envoy"

[<Fact>]
let ``Dind kind label`` () =
    NasResourceKind.Dind.ToLabel() |> should equal "dind"

[<Fact>]
let ``Network kind label`` () =
    NasResourceKind.Network.ToLabel() |> should equal "network"

// ============================================================
// computeEmbedHash (ports docker_client_test.ts + embed_hash_test.ts)
// ============================================================

[<Fact>]
let ``embedHash deterministic`` () =
    let f = [ "a", "hello"B ]
    DockerClient.computeEmbedHash f
    |> should equal (DockerClient.computeEmbedHash f)

[<Fact>]
let ``embedHash varies with different content`` () =
    DockerClient.computeEmbedHash [ "a", "hello"B ]
    |> should not' (equal (DockerClient.computeEmbedHash [ "a", "world"B ]))

[<Fact>]
let ``embedHash varies with different names`` () =
    DockerClient.computeEmbedHash [ "a", "hello"B ]
    |> should not' (equal (DockerClient.computeEmbedHash [ "b", "hello"B ]))

[<Fact>]
let ``embedHash returns valid SHA-256 hex string`` () =
    let hash = DockerClient.computeEmbedHash [ "test", "data"B ]
    hash.Length |> should equal 64
    hash |> Seq.forall (fun c -> "0123456789abcdef".Contains(c)) |> should be True

[<Fact>]
let ``embedHash of empty list is valid hash`` () =
    let hash = DockerClient.computeEmbedHash []
    hash.Length |> should equal 64

[<Fact>]
let ``embedHash is order independent by name`` () =
    let h1 = DockerClient.computeEmbedHash [ "b", "2"B; "a", "1"B ]
    let h2 = DockerClient.computeEmbedHash [ "a", "1"B; "b", "2"B ]
    h1 |> should equal h2

[<Fact>]
let ``embedHash with multiple files`` () =
    let files = [ "Dockerfile", "FROM alpine"B; "entrypoint.sh", "#!/bin/sh"B; "clip.sh", "echo hi"B ]
    let hash = DockerClient.computeEmbedHash files
    hash.Length |> should equal 64
    // Consistent
    DockerClient.computeEmbedHash files |> should equal hash
