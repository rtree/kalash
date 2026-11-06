using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Kalash.CashMachineController;

public sealed class ItlApiException(HttpStatusCode statusCode, string? operation = null)
    : Exception($"ITL REST API returned HTTP {(int)statusCode}.")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
    public string? Operation { get; } = operation is not null && Regex.IsMatch(operation, "^[A-Za-z]{1,64}$")
        ? operation : null;
}

public sealed class ItlControllerClient : IDisposable
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

    public ItlControllerClient(
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
            ConnectTimeout = TimeSpan.FromMilliseconds(ProductTiming.HttpTimeoutMs)
        };
        httpClient = new HttpClient(ownedHandler, disposeHandler: true)
        {
            BaseAddress = BaseAddress,
            Timeout = Timeout.InfiniteTimeSpan
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

    public async Task VerifyHostFilteringAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        await requestGate.WaitAsync(cancellationToken);
        try
        {
            var allowedHostStatus = await GetUnauthenticatedProbeStatusAsync(
                "127.0.0.1:5000",
                cancellationToken);
            if (allowedHostStatus is not (HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden))
            {
                throw new InvalidOperationException(
                    "The REST API did not require authentication for the allowed loopback Host.");
            }

            var rejectedHostStatus = await GetUnauthenticatedProbeStatusAsync(
                "not-allowed.invalid",
                cancellationToken);
            if (rejectedHostStatus is not (HttpStatusCode.BadRequest or HttpStatusCode.Forbidden))
            {
                throw new InvalidOperationException(
                    "The REST API did not reject an unlisted Host header.");
            }
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

    public async Task<JsonDocument> OpenConnectionAsync(
        string comPort,
        string logFilePath,
        CancellationToken cancellationToken = default,
        IReadOnlySet<int>? enabledDenominations = null)
    {
        if (!Regex.IsMatch(comPort, "^COM[0-9]+$", RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1)))
        {
            throw new ArgumentException("A detected Windows COM port is required.", nameof(comPort));
        }

        if (string.IsNullOrWhiteSpace(logFilePath) || !Path.IsPathFullyQualified(logFilePath))
        {
            throw new ArgumentException("A dedicated absolute SSP log path is required.", nameof(logFilePath));
        }

        var denominations = new[] { 1000, 2000, 5000, 10000, 20000, 50000 };
        var payload = JsonSerializer.SerializeToUtf8Bytes(new OpenConnectionRequest(
            comPort,
            0,
            logFilePath,
            denominations.Select(value => new DenominationInhibit(
                $"{value} INR",
                enabledDenominations is not null && !enabledDenominations.Contains(value))).ToArray(),
            denominations.Select(value => new DenominationRoute($"{value} INR", 1)).ToArray(),
            false,
            false,
            true));
        using var content = new ByteArrayContent(payload);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/v2/CashDevice/OpenConnection")
        {
            Content = content
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetBearerTokenAsync(cancellationToken));
        using var timeout = CreateTimeout(cancellationToken, TimeSpan.FromSeconds(90));
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            timeout.Token);
        EnsureSuccess(response);
        return await ParseResponseAsync(response, timeout.Token);
    }

    public Task<JsonDocument> GetDeviceStatusAsync(
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        return GetDeviceAsync("GetDeviceStatus", deviceId, cancellationToken,
            TimeSpan.FromMilliseconds(ProductTiming.PollHttpTimeoutMs));
    }

    public Task EnableAcceptorOnceAsync(string deviceId, CancellationToken cancellationToken = default)
    {
        return PostDeviceCommandAsync("EnableAcceptor", deviceId, cancellationToken);
    }

    public Task DisableAcceptorOnceAsync(string deviceId, CancellationToken cancellationToken = default)
    {
        return PostDeviceCommandAsync("DisableAcceptor", deviceId, cancellationToken);
    }

    public Task AcceptFromEscrowOnceAsync(string deviceId, CancellationToken cancellationToken = default)
    {
        return PostDeviceCommandAsync("AcceptFromEscrow", deviceId, cancellationToken);
    }

    public Task ReturnFromEscrowOnceAsync(string deviceId, CancellationToken cancellationToken = default)
    {
        return PostDeviceCommandAsync("ReturnFromEscrow", deviceId, cancellationToken);
    }

    public async Task DisconnectDeviceAsync(
        string deviceId,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            throw new ArgumentException("ITL deviceID is required.", nameof(deviceId));
        }

        ThrowIfDisposed();
        await requestGate.WaitAsync(cancellationToken);
        try
        {
            var encodedDeviceId = Uri.EscapeDataString(deviceId);
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"api/v2/CashDevice/DisconnectDevice?deviceID={encodedDeviceId}");
            request.Headers.Authorization = new AuthenticationHeaderValue(
                "Bearer",
                await GetBearerTokenAsync(cancellationToken));
            using var timeout = CreateTimeout(cancellationToken, TimeSpan.FromMilliseconds(ProductTiming.HttpTimeoutMs));
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token);
            EnsureSuccess(response);
        }
        finally
        {
            requestGate.Release();
        }
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
        CancellationToken cancellationToken,
        TimeSpan? timeout = null)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            throw new ArgumentException("ITL deviceID is required.", nameof(deviceId));
        }

        var encodedDeviceId = Uri.EscapeDataString(deviceId);
        return await GetAsync(
            $"api/v2/CashDevice/{operation}?deviceID={encodedDeviceId}",
            cancellationToken,
            timeout);
    }

    private async Task<JsonDocument> GetAsync(
        string path,
        CancellationToken cancellationToken,
        TimeSpan? timeout = null)
    {
        ThrowIfDisposed();
        await requestGate.WaitAsync(cancellationToken);
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await GetBearerTokenAsync(cancellationToken));
            using var requestTimeout = CreateTimeout(cancellationToken,
                timeout ?? TimeSpan.FromMilliseconds(ProductTiming.HttpTimeoutMs));

            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                requestTimeout.Token);
            EnsureSuccess(response, path.Split('?')[0].Split('/')[^1]);
            return await ParseResponseAsync(response, requestTimeout.Token);
        }
        finally
        {
            requestGate.Release();
        }
    }

    private async Task PostDeviceCommandAsync(
        string operation,
        string deviceId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            throw new ArgumentException("ITL deviceID is required.", nameof(deviceId));
        }

        ThrowIfDisposed();
        await requestGate.WaitAsync(cancellationToken);
        try
        {
            var encodedDeviceId = Uri.EscapeDataString(deviceId);
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"api/v2/CashDevice/{operation}?deviceID={encodedDeviceId}");
            request.Headers.Authorization = new AuthenticationHeaderValue(
                "Bearer",
                await GetBearerTokenAsync(cancellationToken));
            using var timeout = CreateTimeout(cancellationToken, TimeSpan.FromMilliseconds(ProductTiming.HttpTimeoutMs));
            using var response = await httpClient.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                timeout.Token);
            EnsureSuccess(response);
        }
        finally
        {
            requestGate.Release();
        }
    }

    private async Task<string> GetBearerTokenAsync(CancellationToken cancellationToken)
    {
        await EnsureTokenAsync(cancellationToken);
        return bearerToken
            ?? throw new InvalidDataException("ITL authentication did not produce a bearer token.");
    }

    private async Task EnsureTokenAsync(CancellationToken cancellationToken)
    {
        if (bearerToken is null || timeProvider.GetUtcNow() >= refreshAt)
        {
            await RefreshTokenAsync(cancellationToken);
        }
    }

    private async Task<HttpStatusCode> GetUnauthenticatedProbeStatusAsync(
        string hostHeader,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "api/v2/CashDevice/GetConnectedUSBDevices");
        request.Headers.Host = hostHeader;
        using var timeout = CreateTimeout(cancellationToken, TimeSpan.FromMilliseconds(ProductTiming.HttpTimeoutMs));
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            timeout.Token);
        return response.StatusCode;
    }

    private async Task RefreshTokenAsync(CancellationToken cancellationToken)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new AuthenticateRequest(username, password));
        using var content = new ByteArrayContent(payload);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var timeout = CreateTimeout(cancellationToken, TimeSpan.FromMilliseconds(ProductTiming.HttpTimeoutMs));
        using var request = new HttpRequestMessage(HttpMethod.Post, "api/v2/Users/Authenticate")
        {
            Content = content
        };
        using var response = await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            timeout.Token);
        EnsureSuccess(response);

        using var document = await ParseResponseAsync(response, timeout.Token);
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

    private static CancellationTokenSource CreateTimeout(
        CancellationToken cancellationToken,
        TimeSpan timeout)
    {
        var source = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        source.CancelAfter(timeout);
        return source;
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

    private static void EnsureSuccess(HttpResponseMessage response, string? operation = null)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new ItlApiException(response.StatusCode, operation);
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(disposed, this);
    }

    private sealed record AuthenticateRequest(string Username, string Password);
    private sealed record OpenConnectionRequest(
        string ComPort,
        int SspAddress,
        string LogFilePath,
        DenominationInhibit[] SetInhibits,
        DenominationRoute[] SetRoutes,
        bool EnableAcceptor,
        bool EnableAutoAcceptEscrow,
        bool EnablePayout);
    private sealed record DenominationInhibit(string Denomination, bool Inhibit);
    private sealed record DenominationRoute(string Denomination, int Route);
}
