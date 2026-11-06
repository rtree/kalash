using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed class ItlApiException(HttpStatusCode statusCode)
    : Exception($"ITL REST API returned HTTP {(int)statusCode}.")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}

public sealed class ItlReadOnlyClient : IDisposable
{
    private static readonly Uri BaseAddress = new("http://127.0.0.1:5000/");

    private readonly HttpClient httpClient;
    private readonly string username;
    private readonly string password;
    private readonly TimeProvider timeProvider;
    private readonly SemaphoreSlim requestGate = new(1, 1);
    private string? bearerToken;
    private DateTimeOffset refreshAt;
    private bool disposed;

    public ItlReadOnlyClient(
        string username,
        string password,
        HttpMessageHandler? handler = null,
        TimeProvider? timeProvider = null)
    {
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            throw new ArgumentException("ITL credentials must be provided from protected local configuration.");
        }

        this.username = username;
        this.password = password;
        this.timeProvider = timeProvider ?? TimeProvider.System;

        var ownedHandler = handler ?? new SocketsHttpHandler
        {
            UseProxy = false,
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5)
        };
        httpClient = new HttpClient(ownedHandler, disposeHandler: true)
        {
            BaseAddress = BaseAddress,
            Timeout = TimeSpan.FromSeconds(5)
        };
    }

    public async Task AuthenticateAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        await requestGate.WaitAsync(cancellationToken);
        try
        {
            await RefreshTokenAsync(cancellationToken);
        }
        finally
        {
            requestGate.Release();
        }
    }

    public Task<JsonDocument> GetConnectedUsbDevicesAsync(CancellationToken cancellationToken = default)
    {
        return GetAsync("api/v2/CashDevice/GetConnectedUSBDevices", cancellationToken);
    }

    public Task<JsonDocument> GetAllCashDevicesAsync(CancellationToken cancellationToken = default)
    {
        return GetAsync("api/v2/CashDevice/GetAllCashDevices", cancellationToken);
    }

    public Task<JsonDocument> GetCompleteCashDeviceAsync(
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        return GetDeviceAsync("GetCompleteCashDevice", deviceId, cancellationToken);
    }

    public Task<JsonDocument> GetAllLevelsAsync(
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        return GetDeviceAsync("GetAllLevels", deviceId, cancellationToken);
    }

    public Task<JsonDocument> GetCountersAsync(
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        return GetDeviceAsync("GetCounters", deviceId, cancellationToken);
    }

    public Task<JsonDocument> GetCurrencyAssignmentAsync(
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        return GetDeviceAsync("GetCurrencyAssignment", deviceId, cancellationToken);
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        httpClient.Dispose();
        requestGate.Dispose();
        bearerToken = null;
    }

    private async Task<JsonDocument> GetDeviceAsync(
        string operation,
        string deviceId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            throw new ArgumentException("ITL deviceID is required.", nameof(deviceId));
        }

        var encodedDeviceId = Uri.EscapeDataString(deviceId);
        return await GetAsync(
            $"api/v2/CashDevice/{operation}?deviceID={encodedDeviceId}",
            cancellationToken);
    }

    private async Task<JsonDocument> GetAsync(string path, CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        await requestGate.WaitAsync(cancellationToken);
        try
        {
            await EnsureTokenAsync(cancellationToken);
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bearerToken);

            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken);
            EnsureSuccess(response);
            return await ParseResponseAsync(response, cancellationToken);
        }
        finally
        {
            requestGate.Release();
        }
    }

    private async Task EnsureTokenAsync(CancellationToken cancellationToken)
    {
        if (bearerToken is null || timeProvider.GetUtcNow() >= refreshAt)
        {
            await RefreshTokenAsync(cancellationToken);
        }
    }

    private async Task RefreshTokenAsync(CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new AuthenticateRequest(username, password));
        using var content = new ByteArrayContent(payload);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var response = await httpClient.PostAsync(
            "api/v2/Users/Authenticate",
            content,
            cancellationToken);
        EnsureSuccess(response);

        using var document = await ParseResponseAsync(response, cancellationToken);
        var root = document.RootElement;
        if (!root.TryGetProperty("token", out var tokenElement)
            || tokenElement.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(tokenElement.GetString())
            || !root.TryGetProperty("expires_seconds", out var expiryElement)
            || !expiryElement.TryGetInt32(out var expiresSeconds)
            || expiresSeconds <= 0)
        {
            throw new InvalidDataException("ITL authentication response omitted a valid token or expiry.");
        }

        bearerToken = tokenElement.GetString();
        var expiry = TimeSpan.FromSeconds(expiresSeconds);
        var refreshBuffer = TimeSpan.FromSeconds(Math.Min(30, expiresSeconds / 2.0));
        refreshAt = timeProvider.GetUtcNow() + expiry - refreshBuffer;
    }

    private static async Task<JsonDocument> ParseResponseAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            return await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        }
        catch (JsonException)
        {
            throw new InvalidDataException("ITL REST API returned invalid JSON.");
        }
    }

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new ItlApiException(response.StatusCode);
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
    }

    private sealed record AuthenticateRequest(string Username, string Password);
}
