using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record CashRawSnapshot(long Sequence, ItlDeviceStatusSnapshot Status);

public sealed partial class ItlDeviceStatusPoller
{
    private bool ownedMode;
    private long ownedSequence;
    private string? ownedPreviousState;
    private readonly SemaphoreSlim ownedPollGate = new(1, 1);
    public TimeProvider OwnedTimeProvider { private get; init; } = TimeProvider.System;

    public async Task<IReadOnlyList<CashRawSnapshot>> RecoverOwnedAsync(CancellationToken cancellationToken)
    {
        if (worker is not null || ownedMode)
            throw new InvalidOperationException("Only one execution owner may consume ITL status.");
        ownedMode = true;
        Directory.CreateDirectory(Path.GetDirectoryName(journalPath)!);
        var recovered = new List<CashRawSnapshot>();
        if (!File.Exists(journalPath)) return recovered;
        using var reader = new StreamReader(journalPath);
        while (await reader.ReadLineAsync(cancellationToken) is { } line)
        {
            using var document = JsonDocument.Parse(line);
            var root = document.RootElement;
            var events = ProductCashReadback.Required(root, "events");
            if (events.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("The durable raw ITL event journal is invalid.");
            var status = new ItlDeviceStatusSnapshot(
                ProductCashReadback.Text(root, "deviceState"),
                events.EnumerateArray().Select(value => value.Clone()).ToArray(),
                ProductCashReadback.Integer(root, "observedAt"));
            recovered.Add(new CashRawSnapshot(++ownedSequence, status));
            ownedPreviousState = status.DeviceState;
        }
        return recovered;
    }

    public async Task<CashRawSnapshot> PollOwnedAsync(CancellationToken cancellationToken)
    {
        if (!ownedMode || worker is not null)
            throw new InvalidOperationException("Owned polling must be recovered before use; a second poller is forbidden.");
        if (!await ownedPollGate.WaitAsync(0, cancellationToken))
            throw new InvalidOperationException("Concurrent owned ITL polling is forbidden.");
        try
        {
            using var response = await client.GetDeviceStatusAsync(deviceId, cancellationToken);
            var root = response.RootElement;
            var events = ProductCashReadback.Required(root, "pollBuffer");
            if (events.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("Product status events must be an array.");
            var status = new ItlDeviceStatusSnapshot(
                ProductCashReadback.Text(root, "deviceState").ToUpperInvariant(),
                events.EnumerateArray().Select(value => value.Clone()).ToArray(),
                OwnedTimeProvider.GetUtcNow().ToUnixTimeMilliseconds());
            long sequence = 0;
            if (status.Events.Count > 0 || !status.DeviceState.Equals(ownedPreviousState, StringComparison.OrdinalIgnoreCase))
            {
                await PersistAsync(status, cancellationToken);
                sequence = ++ownedSequence;
            }
            ownedPreviousState = status.DeviceState;
            lock (latestLock) latest = status;
            return new CashRawSnapshot(sequence, status);
        }
        finally { ownedPollGate.Release(); }
    }
}
