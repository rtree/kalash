using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kalash.CashMachineController;

public sealed record CashStartCommand(
    string CommandId,
    string Type,
    string State,
    string AtmId,
    string VisitId,
    string TempleId,
    string CashSessionId,
    long ExpiresAt,
    long CreatedAt)
{
    public string ContentHash()
    {
        var contents = string.Join('\n',
            CommandId, Type, AtmId, VisitId, TempleId, CashSessionId,
            ExpiresAt.ToString(System.Globalization.CultureInfo.InvariantCulture),
            CreatedAt.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(contents)));
    }

    public void Validate(string expectedAtmId, long now)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(CommandId, "^cash-start-[a-f0-9-]{36}$")
            || Type != "start_cash"
            || State is not ("pending" or "received" or "validated" or "dispatching")
            || AtmId != expectedAtmId
            || !System.Text.RegularExpressions.Regex.IsMatch(VisitId, "^[a-f0-9]{64}$")
            || !Guid.TryParseExact(CashSessionId, "D", out _)
            || ExpiresAt <= now || ExpiresAt > CreatedAt + 120_000
            || CreatedAt > now + 5_000)
        {
            throw new InvalidDataException("Central returned a malformed, expired, or unauthorized cash command.");
        }
    }
}

public sealed record CashCommandResponse(
    [property: JsonPropertyName("command")] CashStartCommand? Command);

public sealed record CashCommandObservation(string DeviceState, long ObservedAt);

public sealed record CashDevicePreflight(bool Ready, string DeviceState, string Reason);

public sealed class CashCommandJournalEntry
{
    public required CashStartCommand Command { get; init; }
    public required string ContentHash { get; init; }
    public required string State { get; set; }
    public string? PendingReportState { get; set; }
    public string? Reason { get; set; }
    public CashCommandObservation? Observation { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public interface ICashCommandCentral
{
    Task<CashStartCommand?> GetCommandAsync(CancellationToken cancellationToken);
    Task ReportAsync(
        string commandId,
        string state,
        string? reason,
        CashCommandObservation? observation,
        CancellationToken cancellationToken);
}

public interface ICashStartDevice
{
    Task<CashDevicePreflight> CheckPreconditionsAsync(
        CashStartCommand command,
        CancellationToken cancellationToken);
    Task EnableAcceptorOnceAsync(CancellationToken cancellationToken);
    Task<CashCommandObservation?> WaitForAcceptingAsync(
        string cashSessionId,
        CancellationToken cancellationToken);
    Task DisableAcceptorOnceAsync(CancellationToken cancellationToken);
}

public sealed class CentralCashCommandClient : ICashCommandCentral, IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly HttpClient client;
    private readonly string atmId;

    public CentralCashCommandClient(Uri centralUri, string atmId, string credential)
    {
        if (centralUri.Scheme != Uri.UriSchemeHttps
            || centralUri.AbsolutePath != "/"
            || !string.IsNullOrEmpty(centralUri.UserInfo)
            || !string.IsNullOrEmpty(centralUri.Query)
            || !string.IsNullOrEmpty(centralUri.Fragment)
            || !System.Text.RegularExpressions.Regex.IsMatch(atmId, "^[a-z0-9][a-z0-9-]{2,63}$")
            || !System.Text.RegularExpressions.Regex.IsMatch(credential, "^[a-f0-9]{64}$"))
        {
            throw new ArgumentException("Central HTTPS URL, ATM ID, and protected Controller credential are required.");
        }

        this.atmId = atmId;
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectTimeout = TimeSpan.FromSeconds(5)
        };
        client = new HttpClient(handler) { BaseAddress = centralUri, Timeout = TimeSpan.FromSeconds(5) };
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    }

    public async Task<CashStartCommand?> GetCommandAsync(CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/commands",
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        EnsureSuccess(response);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var result = await JsonSerializer.DeserializeAsync<CashCommandResponse>(
            stream, JsonOptions, cancellationToken);
        return result?.Command;
    }

    public async Task ReportAsync(
        string commandId,
        string state,
        string? reason,
        CashCommandObservation? observation,
        CancellationToken cancellationToken)
    {
        var body = new Dictionary<string, object?>
        {
            ["commandId"] = commandId,
            ["state"] = state
        };
        if (reason is not null) body["reason"] = reason;
        if (observation is not null)
        {
            body["observedAt"] = observation.ObservedAt;
            body["deviceState"] = observation.DeviceState;
        }

        using var response = await client.PostAsJsonAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/commands/{Uri.EscapeDataString(commandId)}",
            body,
            JsonOptions,
            cancellationToken);
        EnsureSuccess(response);
    }

    public void Dispose() => client.Dispose();

    private static void EnsureSuccess(HttpResponseMessage response)
    {
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException(
                $"Central command API returned HTTP {(int)response.StatusCode}.",
                null,
                response.StatusCode);
        }
    }
}

public sealed class CashCommandJournal(string directory)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        WriteIndented = false
    };

    public static CashCommandJournal FromLocalApplicationData()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new IOException("Windows Local Application Data is unavailable for the cash journal.");
        }

        return new CashCommandJournal(Path.Combine(root, "KALASH", "cash-command-journal"));
    }

    public async Task<CashCommandJournalEntry?> ReadAsync(
        string commandId,
        CancellationToken cancellationToken)
    {
        var path = EntryPath(commandId);
        if (!File.Exists(path)) return null;
        await using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous);
        return await JsonSerializer.DeserializeAsync<CashCommandJournalEntry>(
            stream, JsonOptions, cancellationToken)
            ?? throw new InvalidDataException("The durable cash command journal entry is invalid.");
    }

    public async Task SaveAsync(
        CashCommandJournalEntry entry,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory);
        var destination = EntryPath(entry.Command.CommandId);
        var temporary = Path.Combine(directory, $".{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, entry, JsonOptions, cancellationToken);
                await stream.FlushAsync(cancellationToken);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporary, destination, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    public async Task<IReadOnlyList<CashCommandJournalEntry>> ReadAllAsync(
        CancellationToken cancellationToken)
    {
        if (!Directory.Exists(directory)) return [];
        var entries = new List<CashCommandJournalEntry>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json", SearchOption.TopDirectoryOnly))
        {
            await using var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous);
            var entry = await JsonSerializer.DeserializeAsync<CashCommandJournalEntry>(
                stream, JsonOptions, cancellationToken)
                ?? throw new InvalidDataException("A durable cash command journal entry is invalid.");
            entries.Add(entry);
        }

        return entries;
    }

    private string EntryPath(string commandId)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(commandId, "^cash-start-[a-f0-9-]{36}$"))
        {
            throw new InvalidDataException("Invalid cash command identifier.");
        }

        var name = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(commandId)));
        return Path.Combine(directory, $"{name}.json");
    }
}

public sealed class CashStartCommandProcessor(
    string atmId,
    ICashCommandCentral central,
    ICashStartDevice device,
    CashCommandJournal journal,
    bool physicalAcceptanceAuthorized,
    TimeProvider? timeProvider = null)
{
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly SemaphoreSlim operationGate = new(1, 1);

    public async Task ProcessAsync(CashStartCommand command, CancellationToken cancellationToken)
    {
        await operationGate.WaitAsync(cancellationToken);
        try
        {
            await ProcessExclusiveAsync(command, cancellationToken);
        }
        finally
        {
            operationGate.Release();
        }
    }

    private async Task ProcessExclusiveAsync(CashStartCommand command, CancellationToken cancellationToken)
    {
        command.Validate(atmId, clock.GetUtcNow().ToUnixTimeMilliseconds());
        var fingerprint = command.ContentHash();
        var entry = await journal.ReadAsync(command.CommandId, cancellationToken);
        if (entry is not null && !CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(entry.ContentHash), Convert.FromHexString(fingerprint)))
        {
            throw new InvalidDataException("A command ID was reused with different content.");
        }

        entry ??= new CashCommandJournalEntry
        {
            Command = command,
            ContentHash = fingerprint,
            State = command.State == "dispatching" ? "dispatching" : "received",
            UpdatedAt = clock.GetUtcNow()
        };
        if (entry.State == "dispatching")
        {
            entry.State = "unknown";
            entry.Reason = "controller_restarted_during_dispatch";
            await SaveAsync(entry, cancellationToken);
            await TryReportAsync(entry, "unknown", cancellationToken);
            return;
        }

        if (entry.State is "reported" or "precondition_failed" or "failed" or "unknown")
        {
            if (entry.State != "reported") await TryReportAsync(entry, entry.State, cancellationToken);
            return;
        }
        if (entry.State == "report_pending")
        {
            var pending = entry.PendingReportState
                ?? throw new InvalidDataException("Pending Central report state is missing from the journal.");
            entry.State = pending;
            entry.PendingReportState = null;
            await SaveAsync(entry, cancellationToken);
            if (!await TryReportAsync(entry, pending, cancellationToken)) return;
            if (pending is "dispatching" or "precondition_failed" or "failed" or "unknown" or "reported")
            {
                if (pending == "dispatching")
                {
                    entry.State = "unknown";
                    entry.Reason = "dispatch_outcome_unknown_after_report_retry";
                    await SaveAsync(entry, cancellationToken);
                    await TryReportAsync(entry, "unknown", cancellationToken);
                }
                return;
            }
        }
        if (entry.State == "observed")
        {
            if (await TryReportAsync(entry, "observed", cancellationToken))
            {
                await TryReportAsync(entry, "reported", cancellationToken);
                if (entry.State == "reported") return;
            }
            return;
        }
        if (entry.State == "received")
        {
            await SaveAsync(entry, cancellationToken);
            if (!await TryReportAsync(entry, "received", cancellationToken)) return;
        }

        if (entry.State is "received" or "validated")
        {
            var latest = await central.GetCommandAsync(cancellationToken);
            if (latest is null || latest.ContentHash() != command.ContentHash()
                || latest.ExpiresAt <= clock.GetUtcNow().ToUnixTimeMilliseconds())
            {
                entry.State = "precondition_failed";
                entry.Reason = "command_is_no_longer_current";
                await SaveAsync(entry, cancellationToken);
                await TryReportAsync(entry, entry.State, cancellationToken);
                return;
            }

            var preflight = await device.CheckPreconditionsAsync(command, cancellationToken);
            if (!preflight.Ready)
            {
                entry.State = "precondition_failed";
                entry.Reason = string.IsNullOrWhiteSpace(preflight.Reason)
                    ? "device_precondition_failed" : preflight.Reason;
                await SaveAsync(entry, cancellationToken);
                await TryReportAsync(entry, entry.State, cancellationToken);
                return;
            }

            entry.State = "validated";
            await SaveAsync(entry, cancellationToken);
            if (!await TryReportAsync(entry, "validated", cancellationToken)) return;
        }

        if (!physicalAcceptanceAuthorized) return;

        entry.State = "dispatching";
        await SaveAsync(entry, cancellationToken);
        if (!await TryReportAsync(entry, "dispatching", cancellationToken)) return;
        try
        {
            await device.EnableAcceptorOnceAsync(cancellationToken);
            var observation = await device.WaitForAcceptingAsync(command.CashSessionId, cancellationToken);
            if (observation is null)
            {
                await device.DisableAcceptorOnceAsync(cancellationToken);
                entry.State = "unknown";
                entry.Reason = "acceptance_state_not_observed";
                await SaveAsync(entry, cancellationToken);
                await TryReportAsync(entry, entry.State, cancellationToken);
                return;
            }

            entry.State = "observed";
            entry.Observation = observation;
            await SaveAsync(entry, cancellationToken);
            if (await TryReportAsync(entry, "observed", cancellationToken))
            {
                await TryReportAsync(entry, "reported", cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            try
            {
                await device.DisableAcceptorOnceAsync(CancellationToken.None);
            }
            catch (Exception stopException) when (stopException is HttpRequestException or TimeoutException or InvalidDataException or InvalidOperationException)
            {
                entry.Reason = "dispatch_cancelled_and_safe_stop_outcome_unknown";
            }
            entry.State = "unknown";
            entry.Reason ??= "dispatch_cancelled_outcome_unknown";
            await SaveAsync(entry, CancellationToken.None);
            await TryReportAsync(entry, "unknown", CancellationToken.None);
            throw;
        }
        catch (Exception exception) when (exception is HttpRequestException or TimeoutException or InvalidDataException or InvalidOperationException)
        {
            try
            {
                await device.DisableAcceptorOnceAsync(CancellationToken.None);
            }
            catch (Exception stopException) when (stopException is HttpRequestException or TimeoutException or InvalidDataException or InvalidOperationException)
            {
                entry.Reason = "device_command_and_safe_stop_outcome_unknown";
            }
            entry.State = "unknown";
            entry.Reason ??= "device_command_outcome_unknown";
            await SaveAsync(entry, CancellationToken.None);
            await TryReportAsync(entry, "unknown", CancellationToken.None);
        }
    }

    private async Task<bool> TryReportAsync(
        CashCommandJournalEntry entry,
        string state,
        CancellationToken cancellationToken)
    {
        try
        {
            await central.ReportAsync(
                entry.Command.CommandId, state, entry.Reason, entry.Observation, cancellationToken);
            entry.State = state == "reported" ? "reported" : state;
            entry.PendingReportState = null;
            await SaveAsync(entry, cancellationToken);
            return true;
        }
        catch (HttpRequestException exception) when (
            exception.StatusCode is not null && (int)exception.StatusCode.Value < 500)
        {
            throw;
        }
        catch (HttpRequestException)
        {
            entry.State = "report_pending";
            entry.PendingReportState = state;
            await SaveAsync(entry, CancellationToken.None);
            return false;
        }
    }

    private Task SaveAsync(CashCommandJournalEntry entry, CancellationToken cancellationToken)
    {
        entry.UpdatedAt = clock.GetUtcNow();
        return journal.SaveAsync(entry, cancellationToken);
    }
}

public sealed class CashCommandPoller(
    ICashCommandCentral central,
    CashCommandJournal journal,
    CashStartCommandProcessor processor,
    TimeProvider? timeProvider = null)
{
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var retryDelay = TimeSpan.FromSeconds(1);
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var journalEntries = await journal.ReadAllAsync(cancellationToken);
                foreach (var entry in journalEntries.Where(entry =>
                    entry.State is not ("reported" or "precondition_failed" or "failed" or "unknown")))
                {
                    await processor.ProcessAsync(entry.Command, cancellationToken);
                }

                var command = await central.GetCommandAsync(cancellationToken);
                if (command is not null)
                {
                    await processor.ProcessAsync(command, cancellationToken);
                }

                retryDelay = TimeSpan.FromSeconds(1);
                await Task.Delay(TimeSpan.FromSeconds(2), clock, cancellationToken);
            }
            catch (HttpRequestException)
            {
                Console.Error.WriteLine(
                    $"Central cash command transport failed; retrying in {retryDelay.TotalSeconds:0} seconds.");
                await Task.Delay(retryDelay, clock, cancellationToken);
                retryDelay = TimeSpan.FromSeconds(Math.Min(retryDelay.TotalSeconds * 2, 30));
            }
        }

    }
}

public sealed class UnavailableCashStartDevice(string reason) : ICashStartDevice
{
    public Task<CashDevicePreflight> CheckPreconditionsAsync(
        CashStartCommand command,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new CashDevicePreflight(false, "unknown", reason));
    }

    public Task EnableAcceptorOnceAsync(CancellationToken cancellationToken) =>
        throw new InvalidOperationException("The cash device is unavailable; acceptance is disabled.");

    public Task<CashCommandObservation?> WaitForAcceptingAsync(
        string cashSessionId,
        CancellationToken cancellationToken) =>
        throw new InvalidOperationException("The cash device is unavailable; acceptance is disabled.");

    public Task DisableAcceptorOnceAsync(CancellationToken cancellationToken) =>
        throw new InvalidOperationException("The cash device is unavailable; no device command was sent.");
}
