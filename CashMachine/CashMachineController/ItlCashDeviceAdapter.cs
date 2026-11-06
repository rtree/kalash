using System.Text.Json;
using System.Threading.Channels;

namespace Kalash.CashMachineController;

public sealed record ItlDeviceStatusSnapshot(
    string DeviceState,
    IReadOnlyList<JsonElement> Events,
    long ObservedAt);

public sealed partial class ItlDeviceStatusPoller : IAsyncDisposable
{
    private readonly ItlControllerClient client;
    private readonly string deviceId;
    private readonly string journalPath;
    private readonly Channel<ItlDeviceStatusSnapshot> snapshots =
        Channel.CreateBounded<ItlDeviceStatusSnapshot>(new BoundedChannelOptions(256)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = true,
            SingleWriter = true
        });
    private readonly CancellationTokenSource stop = new();
    private readonly object latestLock = new();
    private Task? worker;
    private ItlDeviceStatusSnapshot? latest;

    public ItlDeviceStatusPoller(ItlControllerClient client, string deviceId, string journalPath)
    {
        this.client = client;
        this.deviceId = string.IsNullOrWhiteSpace(deviceId)
            ? throw new ArgumentException("ITL deviceID is required.", nameof(deviceId))
            : deviceId;
        this.journalPath = Path.GetFullPath(journalPath);
    }

    public ItlDeviceStatusSnapshot? Latest
    {
        get
        {
            lock (latestLock) return latest;
        }
    }

    public void Start()
    {
        if (worker is not null || ownedMode) throw new InvalidOperationException("The ITL status poller is already owned.");
        Directory.CreateDirectory(Path.GetDirectoryName(journalPath)!);
        worker = RunAsync(stop.Token);
    }

    public async ValueTask<ItlDeviceStatusSnapshot> ReadNextAsync(CancellationToken cancellationToken)
    {
        return await snapshots.Reader.ReadAsync(cancellationToken);
    }

    public async ValueTask<ItlDeviceStatusSnapshot?> ReadNextAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var boundedWait = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        boundedWait.CancelAfter(timeout);
        try
        {
            return await snapshots.Reader.ReadAsync(boundedWait.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        if (worker is not null)
        {
            try
            {
                await worker;
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
            }
        }

        stop.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        try
        {
            string? previousState = null;
            while (!cancellationToken.IsCancellationRequested)
            {
                using var response = await client.GetDeviceStatusAsync(deviceId, cancellationToken);
                var snapshot = Parse(response.RootElement);
                var stateChanged = !string.Equals(
                    previousState, snapshot.DeviceState, StringComparison.OrdinalIgnoreCase);
                if (snapshot.Events.Count > 0 || stateChanged)
                {
                    await PersistAsync(snapshot, cancellationToken);
                    lock (latestLock) latest = snapshot;
                    await snapshots.Writer.WriteAsync(snapshot, cancellationToken);
                }
                else
                {
                    lock (latestLock) latest = snapshot;
                }
                previousState = snapshot.DeviceState;
                await Task.Delay(TimeSpan.FromMilliseconds(200), cancellationToken);
            }
        }
        catch (Exception exception)
        {
            snapshots.Writer.TryComplete(exception);
            throw;
        }
    }

    private static ItlDeviceStatusSnapshot Parse(JsonElement response)
    {
        if (response.ValueKind != JsonValueKind.Object
            || !TryGetString(response, "deviceState", out var state)
            || !response.TryGetProperty("pollBuffer", out var pollBuffer)
            || pollBuffer.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException(
                "GetDeviceStatus omitted its string state or event array; device events are not considered processed.");
        }

        var events = pollBuffer.EnumerateArray().Select(value => value.Clone()).ToArray();
        return new ItlDeviceStatusSnapshot(
            state!,
            events,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    private async Task PersistAsync(
        ItlDeviceStatusSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        var line = JsonSerializer.SerializeToUtf8Bytes(new
        {
            observedAt = snapshot.ObservedAt,
            deviceState = snapshot.DeviceState,
            events = snapshot.Events
        });
        await using var stream = new FileStream(
            journalPath,
            FileMode.Append,
            FileAccess.Write,
            FileShare.Read,
            4096,
            FileOptions.Asynchronous | FileOptions.WriteThrough);
        await stream.WriteAsync(line, cancellationToken);
        await stream.WriteAsync("\n"u8.ToArray(), cancellationToken);
        await stream.FlushAsync(cancellationToken);
        stream.Flush(flushToDisk: true);
    }

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
                    return !string.IsNullOrWhiteSpace(result);
                }
            }
        }

        result = null;
        return false;
    }
}

public sealed class ItlCashStartDevice(
    ItlControllerClient client,
    ItlDeviceStatusPoller statusPoller,
    string deviceId) : ICashStartDevice, ILocalCashDiagnosticDevice
{
    private static readonly TimeSpan StatusFreshness = TimeSpan.FromMilliseconds(ProductTiming.StatusFreshnessMs);

    public async Task<CashDevicePreflight> CheckPreconditionsAsync(
        CashStartCommand command,
        CancellationToken cancellationToken)
    {
        var status = statusPoller.Latest;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (status is null
            || now - status.ObservedAt > StatusFreshness.TotalMilliseconds
            || status.ObservedAt - now > ProductTiming.ClockSkewMs)
        {
            return new CashDevicePreflight(false, "unknown", "device_status_not_fresh");
        }

        if (!string.Equals(status.DeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
        {
            return new CashDevicePreflight(false, status.DeviceState, "device_not_disabled");
        }

        using var complete = await client.GetCompleteCashDeviceAsync(deviceId, cancellationToken);
        var readback = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
        if (readback.DeviceModel != 2
            || readback.DeviceType != 3
            || readback.BaseDeviceType != 0
            || !string.Equals(readback.Firmware, "NVS2004321016000", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(readback.Dataset, "INR02006", StringComparison.OrdinalIgnoreCase)
            || !readback.IsOpen
            || !readback.IsStarted
            || readback.DeviceError != 0
            || readback.DispenseState != 0
            || readback.NoteInEscrow)
        {
            return new CashDevicePreflight(false, status.DeviceState, "device_identity_or_state_mismatch");
        }

        using var levels = await client.GetAllLevelsAsync(deviceId, cancellationToken);
        if (!HasVerifiedInrLevels(levels.RootElement))
        {
            return new CashDevicePreflight(false, status.DeviceState, "denomination_configuration_unverified");
        }

        using var counters = await client.GetCountersAsync(deviceId, cancellationToken);
        using var currency = await client.GetCurrencyAssignmentAsync(deviceId, cancellationToken);
        if (!IsObjectOrArray(counters.RootElement) || !IsObjectOrArray(currency.RootElement))
        {
            return new CashDevicePreflight(false, status.DeviceState, "inventory_or_counter_readback_invalid");
        }

        return new CashDevicePreflight(true, status.DeviceState, string.Empty);
    }

    public Task<CashDevicePreflight> CheckPreconditionsAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var command = new CashStartCommand(
            $"cash-start-{Guid.NewGuid():D}",
            "start_cash",
            "pending",
            "atm-diagnostic",
            new string('0', 64),
            "temple-diagnostic",
            Guid.NewGuid().ToString("D"),
            now + 60_000,
            now);
        return CheckPreconditionsAsync(command, cancellationToken);
    }

    public async Task<CashDiagnosticInventory> ReadInventoryAsync(CancellationToken cancellationToken)
    {
        using var levels = await client.GetAllLevelsAsync(deviceId, cancellationToken);
        using var counters = await client.GetCountersAsync(deviceId, cancellationToken);
        if (levels.RootElement.ValueKind != JsonValueKind.Array
            || levels.RootElement.GetArrayLength() != 6
            || counters.RootElement.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object))
        {
            throw new InvalidDataException("Cash diagnostic inventory or counter readback is incomplete.");
        }

        var levelMap = new Dictionary<long, CashDiagnosticLevel>();
        foreach (var level in levels.RootElement.EnumerateArray())
        {
            if (!TryGetString(level, "countryCode", out var country)
                || !string.Equals(country, "INR", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("A diagnostic inventory row did not report INR.");
            }

            var value = RequiredInteger(level, "value");
            var storedInPayout = RequiredInteger(level, "storedInPayout", allowZero: true);
            var storedInCashbox = RequiredInteger(level, "storedInCashbox", allowZero: true);
            if (!levelMap.TryAdd(value, new CashDiagnosticLevel(value, storedInPayout, storedInCashbox)))
            {
                throw new InvalidDataException("Diagnostic inventory returned duplicate denomination rows.");
            }
        }

        var stored = FindCounterTotals(counters.RootElement, "stored");
        var stacked = FindCounterTotals(counters.RootElement, "stacked");
        return new CashDiagnosticInventory(levelMap, stored, stacked);
    }

    public async Task<bool> ReadNoteInEscrowAsync(CancellationToken cancellationToken)
    {
        using var complete = await client.GetCompleteCashDeviceAsync(deviceId, cancellationToken);
        if (!TryGetBoolean(complete.RootElement, "noteInEscrow", out var noteInEscrow))
        {
            throw new InvalidDataException("GetCompleteCashDevice omitted noteInEscrow.");
        }

        return noteInEscrow;
    }

    public ValueTask<ItlDeviceStatusSnapshot?> ReadNextStatusAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken) =>
        statusPoller.ReadNextAsync(timeout, cancellationToken);

    public Task EnableAcceptorOnceAsync(CancellationToken cancellationToken)
    {
        return client.EnableAcceptorOnceAsync(deviceId, cancellationToken);
    }

    public Task AcceptFromEscrowOnceAsync(CancellationToken cancellationToken) =>
        client.AcceptFromEscrowOnceAsync(deviceId, cancellationToken);

    public async Task<CashCommandObservation?> WaitForAcceptingAsync(
        string cashSessionId,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromMilliseconds(ProductTiming.DeviceTransitionMs);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await statusPoller.ReadNextAsync(deadline - DateTimeOffset.UtcNow, cancellationToken);
            if (status is null) return null;
            if (string.Equals(status.DeviceState, "ACCEPTING", StringComparison.OrdinalIgnoreCase))
            {
                return new CashCommandObservation(status.DeviceState, status.ObservedAt);
            }
        }

        return null;
    }

    public Task DisableAcceptorOnceAsync(CancellationToken cancellationToken)
    {
        return client.DisableAcceptorOnceAsync(deviceId, cancellationToken);
    }

    private static long RequiredInteger(JsonElement value, string name, bool allowZero = false)
    {
        if (!value.TryGetProperty(name, out var property))
        {
            throw new InvalidDataException($"The ITL readback omitted {name}.");
        }

        var text = property.ValueKind switch
        {
            JsonValueKind.Number => property.GetRawText(),
            JsonValueKind.String => property.GetString(),
            _ => null
        };
        if (!long.TryParse(text, System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture, out var result)
            || result < 0 || (!allowZero && result == 0))
        {
            throw new InvalidDataException($"The ITL readback {name} is not a valid integer.");
        }

        return result;
    }

    private static long FindCounterTotals(JsonElement value, string name)
    {
        var values = new List<long>();
        CollectCounterValues(value, name, values);
        if (values.Count == 0)
        {
            throw new InvalidDataException($"GetCounters omitted the {name} counter.");
        }

        return values.Aggregate(0L, (total, current) => checked(total + current));
    }

    private static void CollectCounterValues(JsonElement value, string name, ICollection<long> values)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase))
                {
                    var text = property.Value.ValueKind switch
                    {
                        JsonValueKind.Number => property.Value.GetRawText(),
                        JsonValueKind.String => property.Value.GetString(),
                        _ => null
                    };
                    if (!long.TryParse(text, System.Globalization.NumberStyles.None,
                            System.Globalization.CultureInfo.InvariantCulture, out var count)
                        || count < 0)
                    {
                        throw new InvalidDataException($"GetCounters returned an invalid {name} counter.");
                    }

                    values.Add(count);
                }

                CollectCounterValues(property.Value, name, values);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray()) CollectCounterValues(item, name, values);
        }
    }

    private static bool HasVerifiedInrLevels(JsonElement levels)
    {
        if (levels.ValueKind != JsonValueKind.Array || levels.GetArrayLength() != 6) return false;
        var observedValues = new HashSet<long>();
        foreach (var level in levels.EnumerateArray())
        {
            if (!TryGetString(level, "countryCode", out var country)
                || !string.Equals(country, "INR", StringComparison.OrdinalIgnoreCase)
                || !TryGetBoolean(level, "isInhibited", out var inhibited)
                || !TryGetNumber(level, "value", out var denomination)
                || !long.TryParse(denomination, out var value)
                || !observedValues.Add(value)
                || inhibited != (value != 10_000)
                || !TryGetString(level, "acceptRoute", out var route)
                    && !TryGetNumber(level, "acceptRoute", out route))
            {
                return false;
            }
        }

        return observedValues.SetEquals([1_000L, 2_000L, 5_000L, 10_000L, 20_000L, 50_000L]);
    }

    private static bool IsObjectOrArray(JsonElement value) =>
        value.ValueKind is JsonValueKind.Array or JsonValueKind.Object;

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

    private static bool TryGetBoolean(JsonElement value, string name, out bool result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    result = property.Value.GetBoolean();
                    return true;
                }
            }
        }

        result = false;
        return false;
    }

    private static bool TryGetNumber(JsonElement value, string name, out string? result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Number)
                {
                    result = property.Value.ToString();
                    return true;
                }
            }
        }

        result = null;
        return false;
    }
}
