using System.Security.Cryptography;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record ProductInitializationRecoveryReceipt(
    string ArchiveFile, string OriginalRawSha256, string OriginalReason, long VerifiedAt,
    string DeviceId, ItlDeviceStatusSnapshot Before, ItlDeviceStatusSnapshot After,
    ProductDeviceHealth Readback, bool Disconnected);

public sealed class ProductInitializationRecovery(
    ProductCashJournal journal, CashCommandJournal commands, IProductInitializationDevice device,
    string rawPath, string evidenceDirectory)
{
    public static void ValidateStartupOnly(ProductCashState state, IReadOnlyList<CashRawSnapshot> raw, int commandCount)
    {
        if (!state.Locked || !state.LockReasons.SequenceEqual(["unknown_device_event"])
            || !state.SingleHundred || !state.ManualEscrowConfigured || string.IsNullOrWhiteSpace(state.DeviceId)
            || state.Intake is not null || state.Outbox.Count != 0 || state.CompletedSessions.Count != 0
            || state.NextSequence != 1 || state.AcknowledgedSequence != 0 || commandCount != 0
            || state.PollInFlight || state.ConnectionDispatchPending || state.RouteVerificationRequired
            || state.SuccessfulRouteResults != 6 || state.RawSequence != 1
            || state.InitializationRecoveryPhase is not null || state.InitializationRecovery is not null
            || raw.Count != 1 || raw[0].Sequence != 1 || raw[0].Status.DeviceState != "DISABLED"
            || raw[0].Status.Events.Count != 11)
            throw new InvalidOperationException("Only the retained, cash-free one-100 initialization parser lock is eligible.");

        string[] states = ["CONNECTING", "CONNECTED", "STARTING", "STARTED", "DISABLED"];
        for (var index = 0; index < 5; index++)
        {
            var item = raw[0].Status.Events[index];
            if (ProductCashReadback.Text(item, "type") != "DeviceStatusResponse"
                || ProductCashReadback.Text(item, "stateAsString") != states[index])
                throw new InvalidDataException("Retained initialization state transitions do not match the observed ordered shape.");
        }
        foreach (var item in raw[0].Status.Events.Skip(5))
            if (ProductCashReadback.Text(item, "type") != "SetDenominationRouteFinishedEventResponse"
                || ProductCashReadback.Required(item, "result").ValueKind != JsonValueKind.True)
                throw new InvalidDataException("Retained initialization requires six successful route results and no cash events.");
    }

    public async Task<ProductInitializationRecoveryReceipt> ReconcileAndDisconnectAsync(CancellationToken token)
    {
        var state = await journal.LoadAsync(token);
        var raw = await device.RecoverAsync(token);
        ValidateStartupOnly(state, raw, (await commands.ReadAllAsync(token)).Count);
        var originalBytes = await File.ReadAllBytesAsync(rawPath, token);
        var hash = Convert.ToHexString(SHA256.HashData(originalBytes));
        Directory.CreateDirectory(evidenceDirectory);
        var archiveFile = $"initialization-{Guid.NewGuid():N}.json";
        await using (var archive = new FileStream(Path.Combine(evidenceDirectory, archiveFile),
            FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096,
            FileOptions.Asynchronous | FileOptions.WriteThrough))
        {
            await JsonSerializer.SerializeAsync(archive, new
            {
                originalState = state, rawJournalSha256 = hash,
                rawJournalBase64 = Convert.ToBase64String(originalBytes)
            }, ProductCashJson.Options, token);
            await archive.FlushAsync(token);
            archive.Flush(true);
        }

        state.InitializationRecoveryPhase = "checking";
        state.PollInFlight = true;
        await journal.SaveAsync(state, token);
        try
        {
            var before = await device.PollAsync(token);
            if (before.Sequence != 0) state.RawSequence = before.Sequence;
            RequireDisabledAndQuiet(before.Status);
            var health = await device.ReadHealthAsync(token);
            health.Readback.Inventory.Validate();
            if (!health.UsbConnected || !health.ConnectionOpen || !health.DeviceStarted
                || !health.Readback.Healthy || !health.Readback.EscrowEmpty
                || !health.Readback.EnabledValues.SequenceEqual([10_000L]))
                throw new InvalidDataException("Current one-100 identity, escrow, routes or connection cannot be verified.");
            var after = await device.PollAsync(token);
            if (after.Sequence != 0) state.RawSequence = after.Sequence;
            RequireDisabledAndQuiet(after.Status);
            if ((await commands.ReadAllAsync(token)).Count != 0)
                throw new InvalidOperationException("A command journal appeared during startup reconciliation.");

            state.PollInFlight = false;
            state.InitializationRecoveryPhase = "disconnecting";
            await journal.SaveAsync(state, token);
            await device.DisconnectOnceAsync(token);
            if (!await device.IsDisconnectedAsync(token))
                throw new InvalidDataException("The startup device was not observed disconnected.");

            var receipt = new ProductInitializationRecoveryReceipt(archiveFile, hash, "unknown_device_event",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), state.DeviceId!, before.Status, after.Status, health, true);
            state.InitializationRecovery = receipt;
            state.InitializationRecoveryPhase = "completed";
            state.ManualEscrowConfigured = false;
            state.LockReasons.Remove("unknown_device_event");
            state.Locked = false;
            await journal.SaveAsync(state, token);
            return receipt;
        }
        catch (Exception exception) when (exception is HttpRequestException or InvalidDataException or InvalidOperationException
            or IOException or UnauthorizedAccessException or OperationCanceledException or TimeoutException)
        {
            state.Reconcile("initialization_reconciliation_incomplete", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await journal.SaveAsync(state, CancellationToken.None);
            throw;
        }
    }

    private static void RequireDisabledAndQuiet(ItlDeviceStatusSnapshot snapshot)
    {
        if (snapshot.DeviceState != "DISABLED" || snapshot.Events.Count != 0)
            throw new InvalidDataException("Startup reconciliation requires observed DISABLED with no new events.");
    }
}
