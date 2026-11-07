using System.Globalization;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record CashDiagnosticLevel(long Value, long StoredInPayout, long StoredInCashbox);

public sealed record CashDiagnosticInventory(
    IReadOnlyDictionary<long, CashDiagnosticLevel> Levels,
    long StoredCounter,
    long StackedCounter,
    long DispensedCounter)
{
    public long TotalPaise => Levels.Values.Sum(level =>
        level.Value * (level.StoredInPayout + level.StoredInCashbox));
    public long TotalNotes => Levels.Values.Sum(level => level.StoredInPayout + level.StoredInCashbox);
    public long PayoutPaise => Levels.Values.Sum(level => level.Value * level.StoredInPayout);
    public long PayoutNotes => Levels.Values.Sum(level => level.StoredInPayout);
}

public sealed record CashDiagnosticEvent(string Name, long Value, string CountryCode, long ObservedAt);

public interface ILocalCashDiagnosticDevice
{
    Task<CashDevicePreflight> CheckPreconditionsAsync(CancellationToken cancellationToken);
    Task<CashDiagnosticInventory> ReadInventoryAsync(CancellationToken cancellationToken);
    Task<bool> ReadNoteInEscrowAsync(CancellationToken cancellationToken);
    ValueTask<ItlDeviceStatusSnapshot?> ReadNextStatusAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken);
    Task EnableAcceptorOnceAsync(CancellationToken cancellationToken);
    Task AcceptFromEscrowOnceAsync(CancellationToken cancellationToken);
    Task DisableAcceptorOnceAsync(CancellationToken cancellationToken);
}

public interface ILocalCashRecoveryDevice
{
    Task<CashDevicePreflight> CheckPreconditionsAsync(CancellationToken cancellationToken);
    Task<CashDiagnosticInventory> ReadInventoryAsync(CancellationToken cancellationToken);
    Task<bool> ReadNoteInEscrowAsync(CancellationToken cancellationToken);
    ValueTask<ItlDeviceStatusSnapshot?> ReadNextStatusAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken);
    Task DispenseValueOnceAsync(long amountPaise, CancellationToken cancellationToken);
}

public sealed class CashDiagnosticJournal(string directory)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false,
        WriteIndented = false
    };

    public static CashDiagnosticJournal FromLocalApplicationData()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new IOException("Windows Local Application Data is unavailable for the cash diagnostic journal.");
        }

        return new CashDiagnosticJournal(Path.Combine(root, "KALASH", "cash-diagnostics"));
    }

    public async Task<CashDiagnosticRecord> BeginAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory);
        var prior = await ReadAllAsync(cancellationToken);
        if (prior.Any(record => record.State is not ("reconciled" or "precondition_failed" or "preflight")
            || record.RecoveryState is "dispatching" or "needs_reconciliation"))
        {
            throw new InvalidOperationException(
                "A previous cash diagnostic is unresolved; reconcile it before another intake.");
        }

        return new CashDiagnosticRecord
        {
            SessionId = Guid.NewGuid().ToString("N"),
            State = "preflight",
            CreatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            PriorDiagnosticPaise = prior.Sum(record => record.AcceptedPaise),
            PriorDiagnosticNotes = prior.Sum(record => record.AcceptedNotes)
        };
    }

    public async Task<CashDiagnosticRecord> GetRecoveryCandidateAsync(CancellationToken cancellationToken)
    {
        var records = await ReadAllAsync(cancellationToken);
        if (records.Any(record => record.RecoveryState is "dispatching" or "needs_reconciliation"))
        {
            throw new InvalidOperationException(
                "A prior diagnostic recovery has an unknown outcome; do not retry its payout command.");
        }

        var candidates = records.Where(record =>
            record.State == "reconciled"
            && record.RecoveryState == "none"
            && record.AcceptedPaise == 10_000
            && record.AcceptedNotes == 1).ToArray();
        return candidates.Length == 1
            ? candidates[0]
            : throw new InvalidOperationException(
                "Recovery requires exactly one unrecovered, reconciled ₹100 diagnostic session.");
    }

    public async Task SaveAsync(CashDiagnosticRecord record, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(directory);
        var destination = Path.Combine(directory, $"cash-diagnostic-{record.SessionId}.json");
        var temporary = Path.Combine(directory, $".{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporary,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                4096,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await JsonSerializer.SerializeAsync(stream, record, JsonOptions, cancellationToken);
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

    private async Task<IReadOnlyList<CashDiagnosticRecord>> ReadAllAsync(
        CancellationToken cancellationToken)
    {
        if (!Directory.Exists(directory)) return [];
        var records = new List<CashDiagnosticRecord>();
        foreach (var path in Directory.EnumerateFiles(directory, "cash-diagnostic-*.json"))
        {
            await using var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous);
            records.Add(await JsonSerializer.DeserializeAsync<CashDiagnosticRecord>(
                stream, JsonOptions, cancellationToken)
                ?? throw new InvalidDataException("A cash diagnostic journal record is invalid."));
        }

        return records;
    }
}

public sealed class CashDiagnosticRecord
{
    public required string SessionId { get; init; }
    public required string State { get; set; }
    public required long CreatedAt { get; init; }
    public long AcceptedPaise { get; set; }
    public int AcceptedNotes { get; set; }
    public long PriorDiagnosticPaise { get; init; }
    public int PriorDiagnosticNotes { get; init; }
    public string? Outcome { get; set; }
    public List<CashDiagnosticLevel> BaselineLevels { get; set; } = [];
    public List<CashDiagnosticLevel> FinalLevels { get; set; } = [];
    public long BaselineStoredCounter { get; set; }
    public long FinalStoredCounter { get; set; }
    public long BaselineStackedCounter { get; set; }
    public long FinalStackedCounter { get; set; }
    public long BaselineDispensedCounter { get; set; }
    public long FinalDispensedCounter { get; set; }
    public string RecoveryState { get; set; } = "none";
    public long RecoveryAmountPaise { get; set; }
    public long RecoveryDispensedCounterBefore { get; set; }
    public long RecoveryDispensedCounterAfter { get; set; }
}

public sealed class CashReceptionDiagnostic(
    ILocalCashDiagnosticDevice device,
    CashDiagnosticJournal journal)
{
    private const long FirstNotePaise = 10_000;
    private const long MaximumStoredPaise = 100_000;
    private const int MaximumStoredNotes = 10;

    public async Task<CashDiagnosticRecord> RunFirstNoteAsync(
        Func<CancellationToken, Task> waitForDoneAsync,
        CancellationToken cancellationToken,
        Action? acceptingObserved = null)
    {
        var record = await journal.BeginAsync(cancellationToken);
        await journal.SaveAsync(record, cancellationToken);

        var preflight = await device.CheckPreconditionsAsync(cancellationToken);
        if (!preflight.Ready)
        {
            record.State = "precondition_failed";
            record.Outcome = preflight.Reason;
            await journal.SaveAsync(record, cancellationToken);
            throw new InvalidOperationException(
                $"Cash diagnostic preflight failed: {preflight.Reason}.");
        }

        var before = await device.ReadInventoryAsync(cancellationToken);
        if (await device.ReadNoteInEscrowAsync(cancellationToken))
        {
            record.State = "needs_reconciliation";
            record.Outcome = "note_in_escrow_before_diagnostic";
            await journal.SaveAsync(record, cancellationToken);
            throw new InvalidOperationException(
                "A note is already in escrow; cash diagnostic acceptance remains disabled.");
        }

        if (before.PayoutNotes != 0)
        {
            record.State = "precondition_failed";
            record.Outcome = "payout_not_empty_before_diagnostic";
            await journal.SaveAsync(record, cancellationToken);
            throw new InvalidOperationException(
                "The local diagnostic requires an empty Payout so its single note can be recovered unambiguously.");
        }

        if (before.TotalPaise + record.PriorDiagnosticPaise + FirstNotePaise > MaximumStoredPaise
            || before.TotalNotes + record.PriorDiagnosticNotes + 1 > MaximumStoredNotes)
        {
            record.State = "precondition_failed";
            record.Outcome = "machine_cash_cap_would_be_exceeded";
            await journal.SaveAsync(record, cancellationToken);
            throw new InvalidOperationException(
                "The diagnostic intake would exceed the ₹1,000 / 10-note total device cap.");
        }

        record.BaselineLevels = before.Levels.Values.OrderBy(level => level.Value).ToList();
        record.BaselineStoredCounter = before.StoredCounter;
        record.BaselineStackedCounter = before.StackedCounter;
        record.BaselineDispensedCounter = before.DispensedCounter;
        await journal.SaveAsync(record, cancellationToken);

        var enableMayHaveDispatched = false;
        var disableMayHaveDispatched = false;
        try
        {
            record.State = "enable_dispatching";
            await journal.SaveAsync(record, cancellationToken);
            var enableStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            enableMayHaveDispatched = true;
            await device.EnableAcceptorOnceAsync(cancellationToken);

            var acceptingAt = await WaitForAcceptingAsync(enableStartedAt, cancellationToken);
            acceptingObserved?.Invoke();
            var escrow = await WaitForEventAsync(
                "ESCROW",
                acceptingAt,
                timeout: TimeSpan.FromMinutes(2),
                cancellationToken);
            if (escrow.Value != FirstNotePaise
                || !string.Equals(escrow.CountryCode, "INR", StringComparison.OrdinalIgnoreCase))
            {
                record.Outcome = "unexpected_escrow_note";
                throw new InvalidDataException(
                    "Only one ₹100 INR note is permitted in the initial cash diagnostic.");
            }

            record.State = "accept_dispatching";
            await journal.SaveAsync(record, cancellationToken);
            await device.AcceptFromEscrowOnceAsync(cancellationToken);

            var stored = await WaitForEventAsync(
                "STORED",
                escrow.ObservedAt,
                timeout: TimeSpan.FromSeconds(30),
                cancellationToken);
            if (stored.Value != escrow.Value
                || !string.Equals(stored.CountryCode, escrow.CountryCode, StringComparison.OrdinalIgnoreCase))
            {
                record.Outcome = "stored_event_mismatch";
                throw new InvalidDataException("STORED did not match the single observed escrow note.");
            }

            record.AcceptedPaise = stored.Value;
            record.AcceptedNotes = 1;
            record.State = "stored";
            await journal.SaveAsync(record, cancellationToken);
            await waitForDoneAsync(cancellationToken);

            record.State = "disable_dispatching";
            await journal.SaveAsync(record, cancellationToken);
            var disableStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            disableMayHaveDispatched = true;
            await device.DisableAcceptorOnceAsync(cancellationToken);
            await WaitForDisabledAsync(disableStartedAt, cancellationToken);

            var after = await device.ReadInventoryAsync(cancellationToken);
            var noteStillEscrowed = await device.ReadNoteInEscrowAsync(cancellationToken);
            if (noteStillEscrowed || !MatchesOneNoteDelta(before, after))
            {
                record.State = "needs_reconciliation";
                record.Outcome = "inventory_or_counter_mismatch";
                await journal.SaveAsync(record, cancellationToken);
                throw new InvalidOperationException(
                    "Cash diagnostic stopped safely but storage/counter reconciliation failed; no donation was created.");
            }

            record.State = "reconciled";
            record.Outcome = "local_diagnostic_only";
            record.FinalLevels = after.Levels.Values.OrderBy(level => level.Value).ToList();
            record.FinalStoredCounter = after.StoredCounter;
            record.FinalStackedCounter = after.StackedCounter;
            record.FinalDispensedCounter = after.DispensedCounter;
            await journal.SaveAsync(record, cancellationToken);
            return record;
        }
        catch (Exception failure)
        {
            record.State = "needs_reconciliation";
            record.Outcome ??= "diagnostic_operation_outcome_unknown";
            Exception? journalFailure = null;
            try
            {
                await journal.SaveAsync(record, CancellationToken.None);
            }
            catch (Exception exception)
            {
                journalFailure = exception;
            }

            Exception? stopFailure = null;
            if (enableMayHaveDispatched && !disableMayHaveDispatched)
            {
                disableMayHaveDispatched = true;
                try
                {
                    await device.DisableAcceptorOnceAsync(CancellationToken.None);
                }
                catch (Exception exception)
                {
                    stopFailure = exception;
                }
            }

            if (journalFailure is not null || stopFailure is not null)
            {
                var failures = new[] { failure, journalFailure, stopFailure }
                    .Where(exception => exception is not null)
                    .Cast<Exception>()
                    .ToArray();
                throw new AggregateException(
                    "Cash diagnostic stopped with a command or journal outcome requiring reconciliation.",
                    failures);
            }

            throw;
        }
    }

    private async Task<CashDiagnosticEvent> WaitForEventAsync(
        string expectedName,
        long notBefore,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await device.ReadNextStatusAsync(deadline - DateTimeOffset.UtcNow, cancellationToken);
            if (status is null) break;
            if (status.ObservedAt < notBefore) continue;
            foreach (var item in status.Events)
            {
                if (!IsCashEvent(item)) continue;
                var name = EventName(item);
                if (name is null)
                {
                    throw new InvalidDataException(
                        "A cash event omitted its type; diagnostic requires reconciliation.");
                }

                if (name != expectedName)
                {
                    throw new InvalidDataException(
                        $"Unexpected cash event {name}; diagnostic requires reconciliation.");
                }

                return new CashDiagnosticEvent(
                    name,
                    RequiredInteger(item, "value"),
                    RequiredString(item, "countryCode"),
                    status.ObservedAt);
            }

            if (status.DeviceState == "DISABLED")
            {
                throw new InvalidOperationException(
                    $"The device became DISABLED before {expectedName} was observed.");
            }
        }

        throw new TimeoutException($"The device did not report {expectedName} before the diagnostic timeout.");
    }

    private async Task<long> WaitForAcceptingAsync(long notBefore, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(10);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await device.ReadNextStatusAsync(deadline - DateTimeOffset.UtcNow, cancellationToken);
            if (status is null) break;
            if (status.ObservedAt < notBefore) continue;
            if (status.Events.Any(IsCashEvent))
            {
                throw new InvalidDataException(
                    "A cash event arrived before ACCEPTING was observed; diagnostic requires reconciliation.");
            }
            if (string.Equals(status.DeviceState, "ACCEPTING", StringComparison.OrdinalIgnoreCase))
            {
                return status.ObservedAt;
            }

        }

        throw new TimeoutException("The device did not report ACCEPTING after the single enable request.");
    }

    private async Task WaitForDisabledAsync(long notBefore, CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(10);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await device.ReadNextStatusAsync(deadline - DateTimeOffset.UtcNow, cancellationToken);
            if (status is null) break;
            if (status.Events.Any(IsCashEvent))
            {
                throw new InvalidDataException(
                    "An additional cash event arrived during closing; diagnostic requires reconciliation.");
            }
            if (status.ObservedAt >= notBefore
                && string.Equals(status.DeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase)) return;
        }

        throw new TimeoutException("The device did not report DISABLED after the single stop request.");
    }

    private static bool MatchesOneNoteDelta(
        CashDiagnosticInventory before,
        CashDiagnosticInventory after)
    {
        if (before.StoredCounter + 1 != after.StoredCounter
            || before.StackedCounter != after.StackedCounter
            || before.DispensedCounter != after.DispensedCounter
            || before.Levels.Count != after.Levels.Count)
        {
            return false;
        }

        foreach (var (value, beforeLevel) in before.Levels)
        {
            if (!after.Levels.TryGetValue(value, out var afterLevel)) return false;
            var expectedPayout = beforeLevel.StoredInPayout + (value == FirstNotePaise ? 1 : 0);
            if (afterLevel.StoredInPayout != expectedPayout
                || afterLevel.StoredInCashbox != beforeLevel.StoredInCashbox)
            {
                return false;
            }
        }

        return true;
    }

    private static string? EventName(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object) return null;
        if (TryGetString(value, "type", out var type)
            && !string.Equals(type, "CashEventResponse", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return TryGetString(value, "eventTypeAsString", out var eventType)
            || TryGetString(value, "stateAsString", out eventType)
            ? eventType!.ToUpperInvariant()
            : null;
    }

    private static bool IsCashEvent(JsonElement value)
    {
        if (TryGetString(value, "type", out var type))
        {
            return string.Equals(type, "CashEventResponse", StringComparison.OrdinalIgnoreCase);
        }

        return TryGetString(value, "eventTypeAsString", out _)
            || TryGetString(value, "stateAsString", out _);
    }

    private static long RequiredInteger(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var property))
        {
            throw new InvalidDataException($"The cash event omitted {name}.");
        }

        var text = property.ValueKind switch
        {
            JsonValueKind.Number => property.GetRawText(),
            JsonValueKind.String => property.GetString(),
            _ => null
        };
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var result)
            || result <= 0)
        {
            throw new InvalidDataException($"The cash event {name} was not a positive integer.");
        }

        return result;
    }

    private static string RequiredString(JsonElement value, string name) =>
        TryGetString(value, name, out var result) && !string.IsNullOrWhiteSpace(result)
            ? result
            : throw new InvalidDataException($"The cash event omitted {name}.");

    private static bool TryGetString(JsonElement value, string name, out string? result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.String)
                {
                    result = property.Value.GetString();
                    return true;
                }
            }
        }

        result = null;
        return false;
    }
}
