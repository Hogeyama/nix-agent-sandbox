namespace Nas.Ui.Routes

open System
open System.Text.Json
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Http
open Microsoft.Extensions.Hosting
open Nas.Ui

module Api =
    let private jsonOpts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true)
    let mapRoutes (app: WebApplication) =
        app.MapGet("/api/health", Func<IResult>(fun () -> Results.Ok({| status = "ok" |}))) |> ignore
        app.MapGet("/api/sessions", Func<IResult>(fun () -> let s = Data.gatherState () in Results.Json({| network = s.NetworkSessions; hostexec = s.HostExecSessions |}, jsonOpts))) |> ignore
        app.MapGet("/api/pending", Func<IResult>(fun () -> let s = Data.gatherState () in Results.Json({| network = s.NetworkPending; hostexec = s.HostExecPending |}, jsonOpts))) |> ignore
        app.MapGet("/api/audit", Func<IResult>(fun () -> Results.Json((Data.gatherState ()).AuditEntries, jsonOpts))) |> ignore
        app.MapPost("/api/shutdown", Func<IHostApplicationLifetime, IResult>(fun lt -> lt.StopApplication(); Results.Ok({| status = "shutting down" |}))) |> ignore
