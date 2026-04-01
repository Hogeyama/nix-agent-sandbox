using System.Text.Json;

namespace Nas.Ui.Client.Services;

public class SseService : IDisposable
{
    private readonly HttpClient _http;
    private CancellationTokenSource? _cts;
    private readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public event Action<UiState>? OnStateUpdated;

    public SseService(HttpClient http)
    {
        _http = http;
    }

    public async Task StartAsync()
    {
        _cts = new CancellationTokenSource();
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, "/sse/updates");
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, _cts.Token);
            using var stream = await response.Content.ReadAsStreamAsync(_cts.Token);
            using var reader = new StreamReader(stream);

            while (!_cts.Token.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(_cts.Token);
                if (line is null) break;

                if (line.StartsWith("data: "))
                {
                    var json = line["data: ".Length..];
                    try
                    {
                        var state = JsonSerializer.Deserialize<UiState>(json, _jsonOpts);
                        if (state is not null)
                        {
                            OnStateUpdated?.Invoke(state);
                        }
                    }
                    catch (JsonException)
                    {
                        // Skip malformed data
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on stop
        }
        catch (Exception)
        {
            // Connection lost, caller can retry
        }
    }

    public void Stop()
    {
        _cts?.Cancel();
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _cts?.Dispose();
    }
}

public record UiState(
    List<SessionEntry> NetworkSessions,
    List<object[]> NetworkPending,
    List<SessionEntry> HostExecSessions,
    List<object[]> HostExecPending,
    List<AuditEntry> AuditEntries);
