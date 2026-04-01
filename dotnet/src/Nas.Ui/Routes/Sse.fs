namespace Nas.Ui.Routes

open System
open System.Text.Json
open System.Threading
open System.Threading.Tasks
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Http
open Nas.Ui

module Sse =
    let private jsonOpts = JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)
    let mapRoutes (app: WebApplication) =
        app.MapGet("/sse/updates", Func<HttpContext, CancellationToken, Task>(fun ctx ct -> task {
            ctx.Response.ContentType <- "text/event-stream"
            ctx.Response.Headers.["Cache-Control"] <- "no-cache"
            ctx.Response.Headers.["Connection"] <- "keep-alive"
            while not ct.IsCancellationRequested do
                let state = Data.gatherState ()
                do! ctx.Response.WriteAsync($"data: {JsonSerializer.Serialize(state, jsonOpts)}\n\n", ct)
                do! ctx.Response.Body.FlushAsync(ct)
                do! Task.Delay(500, ct)
        })) |> ignore
