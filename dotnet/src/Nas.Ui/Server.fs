namespace Nas.Ui

open System
open System.IO
open Microsoft.AspNetCore.Builder
open Microsoft.Extensions.DependencyInjection

module Server =
    let createApp (port: int) =
        let opts = WebApplicationOptions(ContentRootPath = AppContext.BaseDirectory, WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot"))
        let builder = WebApplication.CreateBuilder(opts)
        builder.Services.AddCors() |> ignore
        let app = builder.Build()
        app.UseBlazorFrameworkFiles() |> ignore
        app.UseStaticFiles() |> ignore
        Routes.Api.mapRoutes app
        Routes.Sse.mapRoutes app
        app.MapFallbackToFile("index.html") |> ignore
        app.Urls.Add($"http://0.0.0.0:{port}")
        app
