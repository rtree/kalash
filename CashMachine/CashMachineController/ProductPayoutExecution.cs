using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed class ProductPayout
{
    public required ProductPayoutCommand Command { get; init; }
    public required string Fingerprint { get; init; }
    public string State { get; set; } = "received";
    public List<ProductPayoutReport> Reports { get; init; } = [];
    public long DispatchRawSequence { get; set; }
    public long DispatchAt { get; set; }
    public long? DispensedRawSequence { get; set; }
    public long? DispensedObservedAt { get; set; }
    public long? CompletedRawSequence { get; set; }
    public long? CompletedObservedAt { get; set; }
    public long? IdleRawSequence { get; set; }
    public long? IdleObservedAt { get; set; }
    public ProductPayoutEndState? EndState { get; set; }
    public ProductPayoutReconciliationAuthorization? Reconciliation { get; set; }
    public bool Reconciled { get; set; }
    public ProductPayoutEvidence? CompletionEvidence { get; set; }
    public bool BezelHoldObserved { get; set; }
    public long? BezelHoldObservedAt { get; set; }

    public void ValidatePersisted()
    {
        Command.Validate(Command.AtmId, Command.CreatedAt);
        if (Fingerprint != Command.Fingerprint()
            || State is not ("received" or "validated" or "dispatching" or "observed" or "reported"
                or "precondition_failed" or "unknown")
            || Reports.Any(report => report.CommandId != Command.CommandId)
            || Reconciled && (State != "unknown" || Reconciliation is null || EndState is null)
            || State is "observed" or "reported" && CompletionEvidence is null
            || EndState is { } end && (!ProductPayoutInventory.Same(Command.Baseline, end.Before)
                || !ProductPayoutInventory.PartialEnd(end.Before, end.After)))
            throw new InvalidDataException("Payout journal is corrupt.");
    }
}

public sealed partial class ProductCashExecutionOwner
{
    private readonly bool physicalPayoutAuthorized;
    private long nextPayoutPoll;
    private ProductPayout? ActivePayout => State.Payouts.LastOrDefault(payout => payout.State == "dispatching");
    private bool PayoutBlocksIntake => State.Payouts.Any(payout =>
        !payout.Reconciled && payout.State is not ("reported" or "precondition_failed") || payout.Reports.Count > 0);

    private bool PayoutSafe(ProductDeviceReadback readback) => !State.Locked && State.ManualEscrowConfigured
        && !State.RouteVerificationRequired && State.Intake is not { Closed: false }
        && State.Outbox.Count == 0 && permission is null && !string.IsNullOrWhiteSpace(State.DeviceId)
        && latest?.DeviceState == "DISABLED" && lastOwnedPollAt is { } polled && Now - polled <= ProductTiming.StatusFreshnessMs
        && readback.DeviceStateCode == 4 && readback.Healthy && readback.EscrowEmpty;

    private void QueuePayout(ProductPayout payout, string state, string? reason = null,
        ProductPayoutEvidence? evidence = null)
    {
        payout.State = state;
        if (evidence is not null) payout.CompletionEvidence = evidence;
        payout.Reports.Add(new(payout.Command.CommandId, state, evidence?.IdleObservedAt, reason, evidence));
    }

    private void LockPayout(string reason)
    {
        State.Locked = true;
        if (!State.LockReasons.Contains(reason)) State.LockReasons.Add(reason);
    }

    private async Task FlushPayoutReportsAsync(IProductPayoutCentral transport, CancellationToken token)
    {
        foreach (var payout in State.Payouts)
            while (payout.Reports.Count > 0)
            {
                await transport.ReportPayoutAsync(payout.Reports[0], token);
                payout.Reports.RemoveAt(0);
                await SaveAsync();
            }
    }

    private async Task PayoutUnknownAsync(ProductPayout payout, string reason)
    {
        if (payout.State != "unknown") QueuePayout(payout, "unknown", reason);
        LockPayout(reason);
        await SaveAsync();
    }

    private async Task TickPayoutAsync(CancellationToken token, bool allowStart)
    {
        if (central is not IProductPayoutCentral transport) return;
        try
        {
            await FlushPayoutReportsAsync(transport, token);
            if (State.Payouts.LastOrDefault(payout => payout.State == "unknown" && !payout.Reconciled) is { } unknown)
            {
                await CapturePayoutEndStateAsync(unknown, token);
                await FlushPayoutReportsAsync(transport, token);
                if (physicalPayoutAuthorized && central is IProductPayoutReconciliationCentral authorizer
                    && await authorizer.GetPayoutReconciliationAsync(token) is { } authorization)
                    await ReconcilePayoutCoreAsync(authorization, unknown, transport, token);
                return;
            }
            if (State.Locked && ActivePayout is { } locked)
            {
                await PayoutUnknownAsync(locked, "payout_device_event_unknown");
                return;
            }
            if (ActivePayout is { } active)
            {
                if (Now - active.DispatchAt > ProductTiming.PayoutCompletionMs)
                {
                    await PayoutUnknownAsync(active, "payout_completion_timeout");
                    return;
                }
                if (active.IdleObservedAt is null) return;
                var after = await device.ReadAsync(token);
                if (!after.Healthy || !after.EscrowEmpty) return;
                if (!ProductPayoutInventory.Completed(active.Command.Baseline, after.Inventory))
                {
                    await PayoutUnknownAsync(active, "payout_inventory_mismatch");
                    return;
                }
                // Final evidence is a fresh DISABLED readback, never an HTTP dispatch response.
                if (latest?.DeviceState != "DISABLED" || after.DeviceStateCode != 4) return;
                var evidence = new ProductPayoutEvidence(active.Command.Baseline, after.Inventory, State.DeviceId!,
                    State.StreamId, active.DispatchRawSequence, active.DispensedRawSequence!.Value,
                    active.DispensedObservedAt!.Value, active.CompletedRawSequence!.Value,
                    active.CompletedObservedAt!.Value, active.IdleRawSequence!.Value, active.IdleObservedAt.Value,
                    "DISABLED", true);
                QueuePayout(active, "observed", evidence: evidence);
                await SaveAsync();
                QueuePayout(active, "reported", evidence: evidence);
                await SaveAsync();
                await FlushPayoutReportsAsync(transport, token);
                return;
            }
            if (!allowStart || State.Locked || PayoutBlocksIntake || Now < nextPayoutPoll
                || State.Intake is { Closed: false } || State.Outbox.Count != 0 || permission is not null) return;
            nextPayoutPoll = Now + 2_000;
            var readback = await device.ReadAsync(token);
            var command = await transport.GetPayoutCommandAsync(token);
            if (command is null && PayoutSafe(readback))
                await transport.ReportPayoutInventoryAsync(new(Now, State.DeviceId!, "DISABLED", true,
                    readback.Inventory, State.RawSequence), token);
            if (command is null) return;
            command.Validate(atmId, Now);
            var prior = State.Payouts.FirstOrDefault(payout => payout.Command.CommandId == command.CommandId
                || payout.Command.PayoutId == command.PayoutId || payout.Command.ApprovalId == command.ApprovalId);
            if (prior is not null)
            {
                if (prior.Fingerprint != command.Fingerprint())
                {
                    LockPayout("payout_command_binding_changed");
                    await SaveAsync();
                }
                return;
            }
            var pending = new ProductPayout { Command = command, Fingerprint = command.Fingerprint() };
            State.Payouts.Add(pending);
            QueuePayout(pending, "received");
            await SaveAsync();
            await FlushPayoutReportsAsync(transport, token);
            if (!physicalPayoutAuthorized || device is not IProductPayoutDevice payoutDevice)
            {
                QueuePayout(pending, "precondition_failed", "attended_payout_gate_or_device_unavailable");
                await SaveAsync();
                await FlushPayoutReportsAsync(transport, token);
                return;
            }
            // Use the same reader to drain old outcomes before any dispatch marker.
            for (var index = 0; index < 4; index++)
            {
                await PollAsync(token);
                if (index < 3) await Task.Delay(TimeSpan.FromMilliseconds(200), clock, token);
            }
            permission = await central.GetCashSessionAsync(token);
            readback = await device.ReadAsync(token);
            var current = await transport.GetPayoutCommandAsync(token);
            command.Validate(atmId, Now);
            if (!PayoutSafe(readback) || !ProductPayoutInventory.Same(command.Baseline, readback.Inventory)
                || current?.Fingerprint() != pending.Fingerprint || !healthReady)
            {
                QueuePayout(pending, "precondition_failed", "payout_preflight_not_safe_or_binding_changed");
                await SaveAsync();
                await FlushPayoutReportsAsync(transport, token);
                return;
            }
            QueuePayout(pending, "validated");
            await SaveAsync();
            await FlushPayoutReportsAsync(transport, token);
            // Re-read after Central ACK latency. Authorization and physical baseline must still match.
            permission = await central.GetCashSessionAsync(token);
            current = await transport.GetPayoutCommandAsync(token);
            await PollAsync(token);
            readback = await device.ReadAsync(token);
            command.Validate(atmId, Now);
            if (!PayoutSafe(readback) || !ProductPayoutInventory.Same(command.Baseline, readback.Inventory)
                || current?.Fingerprint() != pending.Fingerprint)
            {
                QueuePayout(pending, "precondition_failed", "payout_final_preflight_changed");
                await SaveAsync();
                return;
            }
            pending.DispatchAt = Now;
            pending.DispatchRawSequence = State.RawSequence;
            QueuePayout(pending, "dispatching");
            await SaveAsync();
            await FlushPayoutReportsAsync(transport, token);
            command.Validate(atmId, Now);
            if (Now - pending.DispatchAt > ProductTiming.StatusFreshnessMs)
                throw new InvalidOperationException("Payout dispatch acknowledgement was not fresh.");
            await PollAsync(token);
            readback = await device.ReadAsync(token);
            if (!PayoutSafe(readback) || !ProductPayoutInventory.Same(command.Baseline, readback.Inventory))
                throw new InvalidOperationException("Payout hardware changed during dispatch acknowledgement.");
            healthReady = false;
            await payoutDevice.DispenseOnceAsync(CashInventory.ParseValue(command.AmountPaise), token);
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            if (exception is IOException or UnauthorizedAccessException) throw;
            if (ActivePayout is { } active) await PayoutUnknownAsync(active, "payout_operation_unknown");
            else if (State.Payouts.LastOrDefault() is { State: "received" or "validated" } pending)
            {
                QueuePayout(pending, "precondition_failed", "payout_pre_dispatch_unavailable");
                await SaveAsync();
            }
            Log("payout_transport_or_device_failed", exception);
        }
    }

    private void ObservePayout(ProductPayout payout, JsonElement item, CashRawSnapshot raw)
    {
        try
        {
            if (raw.Sequence <= payout.DispatchRawSequence || raw.Status.ObservedAt < payout.DispatchAt)
                throw new InvalidDataException("Pre-dispatch payout event.");
            var type = ProductCashReadback.Text(item, "type");
            var name = ProductCashReadback.Text(item,
                type == "CashEventResponse" ? "eventTypeAsString" : "stateAsString").ToUpperInvariant();
            if (name is "NOTE_HELD_IN_BEZEL" or "NOTE_IN_BEZEL_HOLD"
                && type is "CashEventResponse" or "DeviceStateResponse" or "DeviceStatusResponse")
            {
                payout.BezelHoldObserved = true;
                payout.BezelHoldObservedAt = raw.Status.ObservedAt;
                payout.IdleObservedAt = null;
                payout.IdleRawSequence = null;
                return;
            }
            if (type == "CashEventResponse"
                && item.EnumerateObject().Any(property => property.Name.Equals("stateAsString", StringComparison.OrdinalIgnoreCase))
                && ProductCashReadback.Text(item, "stateAsString").ToUpperInvariant() != name)
                throw new InvalidDataException("Contradictory cash event names.");
            if (type == "CashEventResponse")
            {
                if (name is "NOTE_HELD_IN_BEZEL" or "NOTE_IN_BEZEL_HOLD" or "DISPENSING") return;
                if (name != "DISPENSED" || payout.DispensedRawSequence is not null
                    || ProductCashReadback.Integer(item, "value") != CashInventory.ParseValue(payout.Command.AmountPaise)
                    || ProductCashReadback.Text(item, "countryCode").ToUpperInvariant() != "INR")
                    throw new InvalidDataException("Payout cash outcome mismatch.");
                payout.DispensedRawSequence = raw.Sequence;
                payout.DispensedObservedAt = raw.Status.ObservedAt;
            }
            else if (type == "DispenserTransactionEventResponse")
            {
                if (name is "DISPENSING" or "STARTED" or "IN_PROGRESS") return;
                if (name != "COMPLETED" || payout.DispensedRawSequence is null || payout.CompletedRawSequence is not null)
                    throw new InvalidDataException("Payout transaction outcome mismatch.");
                payout.CompletedRawSequence = raw.Sequence;
                payout.CompletedObservedAt = raw.Status.ObservedAt;
                payout.BezelHoldObserved = false;
            }
            else if (type is not ("DeviceStateResponse" or "DeviceStatusResponse")
                || name is not ("DISABLED" or "IDLE" or "DISPENSING" or "NOTE_HELD_IN_BEZEL" or "NOTE_IN_BEZEL_HOLD"))
                throw new InvalidDataException("Unexpected payout event.");
            else if (name is "DISABLED" or "IDLE" && payout.CompletedObservedAt is { } completed
                && raw.Status.ObservedAt > completed && raw.Status.ObservedAt > payout.BezelHoldObservedAt)
                payout.BezelHoldObserved = false;
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or OverflowException)
        {
            LockPayout("payout_unexpected_or_malformed_event");
        }
    }

    private void ObservePayoutIdle(CashRawSnapshot raw)
    {
        if (ActivePayout is not { CompletedObservedAt: not null, DispensedObservedAt: not null } payout) return;
        if (payout.BezelHoldObserved) return;
        if (raw.Status.DeviceState is not ("IDLE" or "DISABLED"))
        {
            payout.IdleObservedAt = null;
            payout.IdleRawSequence = null;
            return;
        }
        // A same-batch IDLE summary is insufficient: require the subsequent owned poll.
        if (raw.Status.ObservedAt <= payout.CompletedObservedAt || raw.Status.ObservedAt <= payout.DispensedObservedAt) return;
        payout.IdleObservedAt = raw.Status.ObservedAt;
        payout.IdleRawSequence = raw.Sequence == 0 ? State.RawSequence : raw.Sequence;
    }

    private async Task CapturePayoutEndStateAsync(ProductPayout payout, CancellationToken token)
    {
        if (payout.BezelHoldObserved && latest is { DeviceState: "DISABLED" } status
            && status.ObservedAt > payout.BezelHoldObservedAt
            && status.Events.Any(item => item.TryGetProperty("type", out var type)
                && type.GetString() is "DeviceStatusResponse" or "DeviceStateResponse"
                && item.TryGetProperty("stateAsString", out var state) && state.GetString() == "DISABLED"))
            payout.BezelHoldObserved = false;
        if (payout.BezelHoldObserved) return;
        var readback = await device.ReadAsync(token);
        if (latest?.DeviceState != "DISABLED" || readback.DeviceStateCode != 4 || !readback.Healthy
            || !readback.EscrowEmpty || lastOwnedPollAt is not { } polled
            || Now - polled < 0 || Now - polled > ProductTiming.StatusFreshnessMs || !ProductPayoutInventory.PartialEnd(payout.Command.Baseline, readback.Inventory))
            return;
        if (payout.EndState is { } previous && ProductPayoutInventory.Same(previous.After, readback.Inventory)) return;
        var before = payout.Command.Baseline;
        var end = new ProductPayoutEndState(before, readback.Inventory, State.DeviceId!, State.StreamId,
            State.RawSequence, Now, "DISABLED", true,
            (ProductPayoutInventory.Value(before) - ProductPayoutInventory.Value(readback.Inventory)).ToString(
                System.Globalization.CultureInfo.InvariantCulture),
            ProductPayoutInventory.Value(readback.Inventory).ToString(System.Globalization.CultureInfo.InvariantCulture));
        payout.EndState = end;
        payout.Reports.Add(new(payout.Command.CommandId, "unknown", end.ObservedAt, "payout_end_state_requires_operator",
            EndState: end));
        await SaveAsync();
    }

    // This retires only an operator-authorized lock; it never resends the original operation.
    public async Task ReconcilePayoutAsync(ProductPayoutReconciliationAuthorization authorization, CancellationToken token)
    {
        await gate.WaitAsync(token);
        try
        {
            if (!initialized || central is not IProductPayoutCentral transport
                || central is not IProductPayoutReconciliationCentral authorizer
                || await authorizer.GetPayoutReconciliationAsync(token) is not { } current
                || JsonSerializer.Serialize(current, ProductCashJson.Options)
                    != JsonSerializer.Serialize(authorization, ProductCashJson.Options))
                throw new InvalidOperationException("No exact Central operator reconciliation authorization.");
            var payout = State.Payouts.Single(value => value.Command.CommandId == authorization.CommandId);
            await PollAsync(token);
            await CapturePayoutEndStateAsync(payout, token);
            await ReconcilePayoutCoreAsync(authorization, payout, transport, token);
        }
        finally { gate.Release(); }
    }

    private async Task ReconcilePayoutCoreAsync(ProductPayoutReconciliationAuthorization authorization,
        ProductPayout payout, IProductPayoutCentral transport, CancellationToken token)
    {
        authorization.Baseline.Validate();
        authorization.Current.Validate();
        if (!physicalPayoutAuthorized || !State.Locked || payout.State != "unknown" || payout.Reconciled
            || payout.BezelHoldObserved
            || authorization.CommandId != payout.Command.CommandId || authorization.PayoutId != payout.Command.PayoutId
            || !Guid.TryParseExact(authorization.ApprovalId, "D", out _)
            || authorization.ApprovalId == payout.Command.ApprovalId
            || State.Payouts.Any(value => value.Reconciliation?.ApprovalId == authorization.ApprovalId)
            || authorization.CreatedAt <= 0 || authorization.CreatedAt > Now + ProductTiming.ClockSkewMs
            || authorization.ExpiresAt <= Now || authorization.ExpiresAt <= authorization.CreatedAt
            || authorization.ExpiresAt - authorization.CreatedAt > ProductTiming.HumanWindowMs
            || State.Intake is { Closed: false } || State.Outbox.Count != 0
            || State.Payouts.Any(value => value != payout && !value.Reconciled
                && value.State is not ("reported" or "precondition_failed"))
            || State.LockReasons.Any(reason => !reason.StartsWith("payout_", StringComparison.Ordinal)
                && reason is not ("controller_restart_payout_unknown" or "controller_shutdown_payout_unknown"))
            || payout.EndState is not { } end
            || !ProductPayoutInventory.Same(payout.Command.Baseline, authorization.Baseline)
            || !ProductPayoutInventory.Same(end.After, authorization.Current))
            throw new InvalidOperationException("Payout operator reconciliation is not exact, fresh, and exclusively payout-related.");
        permission = await central.GetCashSessionAsync(token);
        await PollAsync(token);
        var readback = await device.ReadAsync(token);
        if (permission is not null || latest?.DeviceState != "DISABLED" || readback.DeviceStateCode != 4
            || !readback.Healthy || !readback.EscrowEmpty
            || !ProductPayoutInventory.Same(end.After, readback.Inventory))
            throw new InvalidOperationException("Payout current inventory or physical readiness changed.");
        end = end with { ObservedAt = Now, RawSequence = State.RawSequence };
        payout.Reports.Add(new(payout.Command.CommandId, "unknown", Now, "operator_reconciled_partial_end_state",
            EndState: end, ReconciliationApprovalId: authorization.ApprovalId));
        await SaveAsync();
        await FlushPayoutReportsAsync(transport, token);
        permission = await central.GetCashSessionAsync(token);
        readback = await device.ReadAsync(token);
        if (authorization.ExpiresAt <= Now || permission is not null || !readback.Healthy || !readback.EscrowEmpty
            || readback.DeviceStateCode != 4
            || !ProductPayoutInventory.Same(end.After, readback.Inventory))
            throw new InvalidOperationException("Payout reconciliation acknowledgement outlived the verified physical state.");
        payout.Reconciliation = authorization;
        payout.Reconciled = true;
        State.LockReasons.Clear();
        State.Locked = false;
        await SaveAsync();
    }
}
