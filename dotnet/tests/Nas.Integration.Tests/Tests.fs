module Nas.Integration.Tests.AllTests

open Xunit
open FsUnit.Xunit

[<Fact>]
let ``Smoke test`` () =
    1 + 1 |> should equal 2
