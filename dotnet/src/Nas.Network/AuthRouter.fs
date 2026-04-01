namespace Nas.Network

open System
open System.IO
open System.Net.Sockets
open System.Text
open System.Text.Json
open System.Threading
open System.Threading.Tasks
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Http
open Microsoft.Extensions.Hosting
open Nas.Core

/// Envoy ext_authz HTTP service implementation
module AuthRouter =
    let private jsonOptions =
        JsonSerializerOptions(PropertyNamingPolicy = JsonNamingPolicy.CamelCase)

    /// Extract target from ext_authz check request
    let extractTarget (ctx: HttpContext) =
        // CONNECT requests: authority header
        let authority =
            match ctx.Request.Headers.TryGetValue(":authority") with
            | true, values -> Some (values.ToString())
            | _ ->
                match ctx.Request.Headers.TryGetValue("host") with
                | true, values -> Some (values.ToString())
                | _ -> None

        let method =
            match ctx.Request.Headers.TryGetValue(":method") with
            | true, values -> values.ToString()
            | _ -> "GET"

        let requestKind =
            if method.Equals("CONNECT", StringComparison.OrdinalIgnoreCase) then
                RequestKind.Connect
            else
                RequestKind.Direct

        match authority with
        | Some auth -> Protocol.normalizeTarget auth requestKind
        | None -> None

    /// Send a request to the broker via Unix socket
    let private queryBroker (socketPath: string) (request: Protocol.AuthorizeRequest) (ct: CancellationToken) =
        task {
            use socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified)
            let endpoint = System.Net.Sockets.UnixDomainSocketEndPoint(socketPath)
            do! socket.ConnectAsync(endpoint, ct)

            use stream = new NetworkStream(socket)
            use reader = new StreamReader(stream, Encoding.UTF8)
            use writer = new StreamWriter(stream, Encoding.UTF8, AutoFlush = true)

            let reqJson = JsonSerializer.Serialize(request, jsonOptions)
            do! writer.WriteLineAsync(reqJson)
            let! respLine = reader.ReadLineAsync()
            return JsonSerializer.Deserialize<Protocol.DecisionResponse>(respLine, jsonOptions)
        }

    /// Build and start the auth router web application
    let start (brokerSocket: string) (listenPort: int) (_ct: CancellationToken) =
        task {
            let builder = WebApplication.CreateBuilder()
            let app = builder.Build()

            app.MapGet("/health", Func<IResult>(fun () -> Results.Ok("ok"))) |> ignore

            app.MapGet("/check", Func<HttpContext, CancellationToken, Task<IResult>>(fun ctx ct ->
                task {
                    match extractTarget ctx with
                    | Some target ->
                        let req: Protocol.AuthorizeRequest =
                            { Version = 1
                              Type = "authorize"
                              RequestId = Guid.NewGuid().ToString()
                              SessionId = ""
                              Target = target
                              Method = "CONNECT"
                              RequestKind = RequestKind.Connect
                              ObservedAt = DateTimeOffset.UtcNow }

                        try
                            let! resp = queryBroker brokerSocket req ct
                            match resp.Decision with
                            | Decision.Allow -> return Results.Ok()
                            | Decision.Deny -> return Results.StatusCode(403)
                        with
                        | ex ->
                            Log.warn $"Auth router error: {ex.Message}"
                            return Results.StatusCode(500)
                    | None ->
                        return Results.BadRequest("Cannot extract target")
                })) |> ignore

            do! app.RunAsync($"http://0.0.0.0:{listenPort}")
        }
