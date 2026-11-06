using System.Security.Cryptography;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record ProductFailedStartProof(
    string Version, string AtmId, string VisitId, string CashSessionId, string CommandId, string StreamId, string DeviceId,
    long AcknowledgedSequence, long NextSequence, bool Started, bool Closed, bool DisabledObserved, bool PollInFlight,
    int OutboxCount, int NoteCount, string DeviceState, bool EscrowEmpty, long ObservedAt,
    CashInventory Baseline, CashInventory FinalInventory, CashInventory CurrentInventory,
    string ControllerStateSha256, string RawJournalSha256, string CommandJournalSha256, bool OperatorConfirmedNoNotes);

public sealed record ProductFailedStartRecoveryReceipt(
    string ArchiveDirectory, string CommandId, string CashSessionId, string CommandContentHash,
    ProductFailedStartProof Proof, bool Disconnected);

// Explicit operator reconciliation only; neither this service nor its CLI starts or enables a device.
public sealed class ProductFailedStartRecovery(
    ProductCashJournal journal, CashCommandJournal commands, IProductInitializationDevice device,
    string rawPath, string evidenceDirectory, string atmId, string cashSessionId, bool operatorConfirmedNoNotes)
{
    private static readonly string[] Reasons = ["ready_not_observed", "start_command_not_observed"];

    public static bool IsReconciledCommand(ProductCashState state, CashCommandJournalEntry entry) =>
        state.FailedStartRecoveryPhase == "completed" && state.FailedStartRecovery is { Disconnected: true } receipt
        && receipt.CommandId == entry.Command.CommandId && receipt.CashSessionId == entry.Command.CashSessionId
        && receipt.CommandContentHash == entry.ContentHash && entry.ContentHash == entry.Command.ContentHash()
        && state.CompletedSessions.Contains(entry.Command.CashSessionId)
        && entry.State == "unknown" && entry.Reason == "acceptance_state_not_observed"
        && entry.PendingReportState is null && entry.Observation is null;

    public static void ValidateFailedZeroStart(ProductCashState state, CashCommandJournalEntry entry,
        IReadOnlyList<CashRawSnapshot> raw, string atmId, string cashSessionId, bool confirmed)
    {
        var intake = state.Intake;
        if (!confirmed || !Guid.TryParseExact(cashSessionId, "D", out _)
            || !state.Locked || !SameReasons(state.LockReasons) || !state.SingleHundred
            || !state.ManualEscrowConfigured || string.IsNullOrWhiteSpace(state.DeviceId)
            || state.PollInFlight || state.ConnectionDispatchPending || state.RouteVerificationRequired
            || state.SuccessfulRouteResults != 6 || state.Outbox.Count != 0
            || state.AcknowledgedSequence < 3 || state.NextSequence != state.AcknowledgedSequence + 1
            || state.FailedStartRecoveryPhase is not null || state.FailedStartRecovery is not null
            || intake is not { Started: false, Closed: true, DisabledObserved: true, EnableDispatchStarted: true,
                DisableDispatchStarted: true, Deadline: null, CloseReason: "fault", FinalInventory: not null }
            || intake.Notes.Count != 0 || intake.NoteSequence != 0 || !SameReasons(intake.Reasons)
            || intake.ReadinessEvidence is not null || !intake.SingleHundred
            || !intake.EnabledValues.SequenceEqual([10_000L])
            || !state.CompletedSessions.Contains(cashSessionId)
            || intake.Command.AtmId != atmId || intake.Command.CashSessionId != cashSessionId
            || intake.Command.CommandId != $"cash-start-{cashSessionId}" || intake.Command.Type != "start_cash"
            || entry.Command.ContentHash() != intake.Command.ContentHash() || entry.ContentHash != entry.Command.ContentHash()
            || entry.State != "unknown" || entry.Reason != "acceptance_state_not_observed"
            || entry.PendingReportState is not null || entry.Observation is not null
            || !ProductCashReadinessEvidence.SameInventory(intake.Baseline, intake.FinalInventory))
            throw new InvalidOperationException("Only the explicitly confirmed, closed zero-note failed start with exact retained evidence is eligible.");

        if (raw.Count < 3 || state.RawSequence != raw.Count
            || raw.Where((item, index) => item.Sequence != index + 1).Any()
            || raw[^1].Status.DeviceState != "DISABLED")
            throw new InvalidDataException("Failed-start raw evidence is missing, interrupted or non-contiguous.");
        long previous = 0;
        var idle = false;
        var disabled = false;
        foreach (var item in raw)
        {
            var status = item.Status;
            if (status.ObservedAt <= 0 || status.ObservedAt < previous)
                throw new InvalidDataException("Failed-start raw observation times are inconsistent.");
            previous = status.ObservedAt;
            if (status.ObservedAt < intake.Command.CreatedAt && status.DeviceState == "DISABLED" && !idle)
            {
                if (status.Events.Count == 0) continue;
                string[] initialization = ["CONNECTING", "CONNECTED", "STARTING", "STARTED", "DISABLED"];
                if (status.Events.Count != 11
                    || status.Events.Take(5).Where((value, index) =>
                        ProductCashReadback.Text(value, "type") != "DeviceStatusResponse"
                        || ProductCashReadback.Text(value, "stateAsString") != initialization[index]).Any()
                    || status.Events.Skip(5).Any(value =>
                        ProductCashReadback.Text(value, "type") != "SetDenominationRouteFinishedEventResponse"
                        || ProductCashReadback.Required(value, "result").ValueKind != JsonValueKind.True))
                    throw new InvalidDataException("Retained pre-command evidence is not initialization-only.");
                continue;
            }
            if (status.Events.Count != 1
                || ProductCashReadback.Text(status.Events[0], "type") != "DeviceStatusResponse"
                || ProductCashReadback.Text(status.Events[0], "stateAsString") != status.DeviceState)
                throw new InvalidDataException("Retained failed-start evidence contains cash, unknown or ambiguous events.");
            if (!idle && status.DeviceState == "IDLE" && status.ObservedAt >= intake.Command.CreatedAt
                && status.ObservedAt < intake.Command.ExpiresAt)
                idle = true;
            else if (idle && !disabled && status.DeviceState == "DISABLED")
                disabled = true;
            else
                throw new InvalidDataException("Retained failed-start evidence is not one IDLE then one DISABLED transition.");
        }
        if (!idle || !disabled)
            throw new InvalidDataException("Both actual failed-start IDLE and subsequent DISABLED evidence are required.");
    }

    public async Task<ProductFailedStartRecoveryReceipt> ReconcileAndDisconnectAsync(CancellationToken token)
    {
        var state = await journal.LoadAsync(token);
        var commandId = $"cash-start-{cashSessionId}";
        var entry = await commands.ReadAsync(commandId, token)
            ?? throw new InvalidDataException("The original failed-start command journal is required.");
        var raw = await device.RecoverAsync(token);
        ValidateFailedZeroStart(state, entry, raw, atmId, cashSessionId, operatorConfirmedNoNotes);
        if ((await commands.ReadAllAsync(token)).Any(other => other.Command.CommandId != commandId
            && (other.State is "unknown" or "dispatching" or "report_pending"
                || other.PendingReportState is not null)))
            throw new InvalidDataException("Another unresolved command prevents failed-start reconciliation.");

        var stateBytes = await journal.ReadEvidenceAsync(token);
        var rawBytes = await File.ReadAllBytesAsync(rawPath, token);
        var commandBytes = await commands.ReadEvidenceAsync(commandId, token);
        var archive = Path.Combine(evidenceDirectory, $"{cashSessionId}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(archive);
        await WriteOnceAsync(Path.Combine(archive, "state.json"), stateBytes, token);
        await WriteOnceAsync(Path.Combine(archive, "raw.jsonl"), rawBytes, token);
        await WriteOnceAsync(Path.Combine(archive, "command.json"), commandBytes, token);

        state.FailedStartRecoveryPhase = "checking";
        state.PollInFlight = true;
        await journal.SaveAsync(state, token);
        try
        {
            var before = await device.PollAsync(token);
            if (before.Sequence != 0) state.RawSequence = before.Sequence;
            RequireDisabledAndQuiet(before.Status);
            var health = await device.ReadHealthAsync(token);
            var readback = health.Readback;
            if (!health.UsbConnected || !health.ConnectionOpen || !health.DeviceStarted
                || !readback.Healthy || !readback.EscrowEmpty || readback.DeviceStateCode != 4
                || !readback.EnabledValues.SequenceEqual([10_000L])
                || !ProductCashReadinessEvidence.SameInventory(state.Intake!.Baseline, readback.Inventory))
                throw new InvalidDataException("Current disabled/empty identity, one-100 profile, six levels or four counters do not match.");
            var after = await device.PollAsync(token);
            if (after.Sequence != 0) state.RawSequence = after.Sequence;
            RequireDisabledAndQuiet(after.Status);
            var currentCommandBytes = await commands.ReadEvidenceAsync(commandId, token);
            if (!commandBytes.SequenceEqual(currentCommandBytes))
                throw new InvalidDataException("The original terminal command changed during reconciliation.");
            var currentRawBytes = await File.ReadAllBytesAsync(rawPath, token);
            if (!rawBytes.SequenceEqual(currentRawBytes))
                throw new InvalidDataException("New raw evidence appeared during zero-note reconciliation.");

            var proof = new ProductFailedStartProof("failed-cash-start-zero-v1", atmId, entry.Command.VisitId,
                cashSessionId, commandId, state.StreamId, state.DeviceId!, state.AcknowledgedSequence, state.NextSequence,
                false, true, true, false, 0, 0, "DISABLED", true, after.Status.ObservedAt,
                state.Intake!.Baseline, state.Intake.FinalInventory!, readback.Inventory,
                Hash(stateBytes), Hash(rawBytes), Hash(commandBytes), true);
            await WriteOnceAsync(Path.Combine(archive, "proof.json"),
                JsonSerializer.SerializeToUtf8Bytes(proof, ProductCashJson.Options), token);
            await WriteOnceAsync(Path.Combine(archive, "readback.json"),
                JsonSerializer.SerializeToUtf8Bytes(new { before = before.Status, after = after.Status, health },
                    ProductCashJson.Options), token);
            state.PollInFlight = false;
            state.FailedStartRecoveryPhase = "disconnecting";
            await journal.SaveAsync(state, token);
            await device.DisconnectOnceAsync(token);
            if (!await device.IsDisconnectedAsync(token))
                throw new InvalidDataException("The reconciled device was not observed disconnected.");

            var receipt = new ProductFailedStartRecoveryReceipt(archive, commandId, cashSessionId, entry.ContentHash, proof, true);
            state.FailedStartRecovery = receipt;
            state.FailedStartRecoveryPhase = "completed";
            state.ManualEscrowConfigured = false;
            state.LockReasons.Clear();
            state.Locked = false;
            await journal.SaveAsync(state, token);
            return receipt;
        }
        catch (Exception exception) when (exception is HttpRequestException or ItlApiException or InvalidDataException
            or InvalidOperationException or IOException or UnauthorizedAccessException or OperationCanceledException or TimeoutException)
        {
            state.Reconcile("failed_start_reconciliation_incomplete", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await journal.SaveAsync(state, CancellationToken.None);
            throw;
        }
    }

    private static bool SameReasons(IEnumerable<string> reasons) => reasons.Order().SequenceEqual(Reasons.Order());
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static void RequireDisabledAndQuiet(ItlDeviceStatusSnapshot status)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (status.DeviceState != "DISABLED" || status.Events.Count != 0 || status.ObservedAt > now + 5_000
            || status.ObservedAt < now - 2_000)
            throw new InvalidDataException("Recovery requires fresh owned DISABLED observations with no new events.");
    }

    private static async Task WriteOnceAsync(string path, byte[] bytes, CancellationToken token)
    {
        await using var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            4096, FileOptions.Asynchronous | FileOptions.WriteThrough);
        await file.WriteAsync(bytes, token);
        await file.FlushAsync(token);
        file.Flush(true);
    }
}
