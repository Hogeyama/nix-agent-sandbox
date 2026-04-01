using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nas.Ui.Client.Services;

public record SessionEntry(
    string SessionId,
    string AgentType,
    string ProfileName,
    string StartedAt);

public record PendingEntry(
    string Domain,
    string Timestamp);

public record AuditEntry(
    string Timestamp,
    string SessionId,
    string Category,
    string Domain,
    string Action,
    string Detail);

public record SessionsResponse(
    List<SessionEntry> Network,
    List<SessionEntry> Hostexec);

public record PendingResponse(
    List<PendingGroup> Network,
    List<PendingGroup> Hostexec);

public record PendingGroup(string SessionId, List<PendingEntry> Entries);

public class NasApiService : IDisposable
{
    private readonly HttpClient _http;
    private readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    public NasApiService(HttpClient http)
    {
        _http = http;
    }

    public async Task<SessionsResponse?> GetSessionsAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync<SessionsResponse>("/api/sessions", _jsonOpts);
        }
        catch (HttpRequestException)
        {
            return null;
        }
    }

    public async Task<PendingResponse?> GetPendingAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync<PendingResponse>("/api/pending", _jsonOpts);
        }
        catch (HttpRequestException)
        {
            return null;
        }
    }

    public async Task<List<AuditEntry>?> GetAuditAsync()
    {
        try
        {
            return await _http.GetFromJsonAsync<List<AuditEntry>>("/api/audit", _jsonOpts);
        }
        catch (HttpRequestException)
        {
            return null;
        }
    }

    public async Task<bool> CheckHealthAsync()
    {
        try
        {
            var resp = await _http.GetAsync("/api/health");
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    public void Dispose()
    {
        _http.Dispose();
    }
}
