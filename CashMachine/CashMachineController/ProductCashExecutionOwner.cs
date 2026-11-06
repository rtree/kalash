using System.Net;
using System.Text.Json;

namespace Kalash.CashMachineController;

// Command, readback, event consumption and note dispatch all run on this one execution owner.
public sealed class ProductCashExecutionOwner : ICashStartDevice
{
    private readonly string atmId;
    private readonly ICashCommandCentral commands;
    private readonly ICashEventCentral central;
    private readonly IControllerHealthCentral healthCentral;
    private readonly IProductCashDevice device;
    private readonly ProductCashJournal journal;
    private readonly CashCommandJournal commandJournal;
    private readonly TimeProvider clock;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CashStartCommandProcessor processor;
    private CentralCashSession? permission;
    private long permissionObservedAt;
    private long nextPermissionPoll;
    private long nextCommandPoll;
    private long nextHealthReport;
    private bool healthReady;
    private ItlDeviceStatusSnapshot? latest;
    private long? lastOwnedPollAt;
    private bool initialized;
    private bool emergencyStopAttempted;
    private string? singleHundredSession;
    private CashRawSnapshot? idleAfterEnable;
    private long? lastSuccessfulHealthAt;
    public ProductCashState State { get; private set; } = null!;
    public bool CompletedSingleHundred { get; private set; }

    public ProductCashExecutionOwner(string atmId, ICashCommandCentral commands, ICashEventCentral central,
        IProductCashDevice device, ProductCashJournal journal, CashCommandJournal commandJournal,
        bool physicalAcceptanceAuthorized, TimeProvider? timeProvider = null)
    {
        if (!physicalAcceptanceAuthorized)
            throw new InvalidOperationException("Product cash requires the explicit physical enable gate.");
        this.atmId = atmId;
        this.commands = commands;
        this.central = central;
        healthCentral = central as IControllerHealthCentral
            ?? throw new ArgumentException("The product Central transport must support authenticated health reports.", nameof(central));
        this.device = device;
        this.journal = journal;
        this.commandJournal = commandJournal;
        clock = timeProvider ?? TimeProvider.System;
        processor = new CashStartCommandProcessor(atmId, commands, this, commandJournal, true, clock);
    }

    private long Now => clock.GetUtcNow().ToUnixTimeMilliseconds();
    private Task SaveAsync() => journal.SaveAsync(State, CancellationToken.None);
    private bool Bound(CentralCashSession? session) => session is not null && State.Intake is { } intake
        && session.VisitId == intake.Command.VisitId && session.CashSessionId == intake.Command.CashSessionId;
    private bool CanAccept => healthReady && Fresh(lastOwnedPollAt ?? 0, Now)
        && Bound(permission) && permission!.State == "accepting" && !permission.CloseRequested
        && permission.Deadline > Now && Fresh(permissionObservedAt, Now);

    private static bool Fresh(long observedAt, long now) =>
        observedAt > 0 && now - observedAt <= ProductTiming.StatusFreshnessMs
        && observedAt - now <= ProductTiming.ClockSkewMs;

    private bool NeedsEscrowResolution(ProductCashIntake intake) =>
        intake.Pending is not null || latest is null || !Fresh(latest.ObservedAt, Now)
        || latest.DeviceState is "ACCEPTING" or "ESCROW";

    public async Task InitializeAsync(CancellationToken token)
    {
        if (initialized) throw new InvalidOperationException("Product owner already initialized.");
        State = await journal.LoadAsync(token);
        if (State.ConnectionDispatchPending) State.Reconcile("connection_dispatch_unknown", Now);
        var recovered = await device.RecoverAsync(token);
        if (State.PollInFlight || recovered.Any(raw => raw.Sequence > State.RawSequence)
            || (recovered.Count == 0 ? 0 : recovered.Max(raw => raw.Sequence)) != State.RawSequence)
            State.Reconcile("raw_consume_commit_gap", Now);
        if (State.Intake is { Closed: false })
            State.Reconcile("controller_restart_active_intake", Now);
        foreach (var entry in await commandJournal.ReadAllAsync(token))
        {
            if (ProductFailedStartRecovery.IsReconciledCommand(State, entry)) continue;
            if (entry.State is "dispatching" or "unknown"
                || entry.PendingReportState == "dispatching"
                || (entry.State is "observed" or "reported"
                    && !State.CompletedSessions.Contains(entry.Command.CashSessionId)
                    && State.Intake?.Command.CommandId != entry.Command.CommandId))
                State.Reconcile("unresolved_command_journal", Now);
        }
        State.RawSequence = recovered.Count == 0 ? State.RawSequence : recovered.Max(raw => raw.Sequence);
        State.PollInFlight = false;
        await SaveAsync();
        initialized = true;
        if (State.RouteVerificationRequired && !State.Locked)
        {
            var until = Now + ProductTiming.InitializationMs;
            while (Now < until && !State.Locked)
            {
                await PollAsync(token);
                if (State.SuccessfulRouteResults == 6 && latest?.DeviceState == "DISABLED")
                {
                    State.RouteVerificationRequired = false;
                    await SaveAsync();
                    break;
                }
                await Task.Delay(TimeSpan.FromMilliseconds(200), clock, token);
            }
            if (State.RouteVerificationRequired)
            {
                State.Reconcile("route_initialization_unverified", Now);
                await SaveAsync();
            }
        }
    }

    public async Task RunAsync(CancellationToken token)
    {
        await InitializeAsync(token);
        try
        {
            while (!token.IsCancellationRequested)
            {
                await TickAsync(token);
                if (await CompleteSingleHundredIfSafeAsync(token)) return;
                await Task.Delay(TimeSpan.FromMilliseconds(200), clock, token);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        finally
        {
            // Cancellation stops acceptance, not the existing event reader.
            if (State.Intake is { Closed: false })
            {
                State.Close("offline", Now);
                await SaveAsync();
                using var shutdown = new CancellationTokenSource(TimeSpan.FromMilliseconds(ProductTiming.DeviceTransitionMs));
                try
                {
                    while (State.Intake is { Closed: false } || State.Outbox.Count != 0)
                    {
                        await TickAsync(shutdown.Token, allowStart: false);
                        await Task.Delay(200, shutdown.Token);
                    }
                }
                catch (Exception exception) when (IsOperational(exception))
                {
                    State.Reconcile("shutdown_unresolved", Now);
                    await SaveAsync();
                    Log("shutdown_unresolved", exception);
                }
            }
            if (await VerifyCleanShutdownAsync(CancellationToken.None))
                await ReportUnavailableAsync(CancellationToken.None);
            else
                Console.Error.WriteLine("Product cash shutdown_unverified; unavailable health report withheld; response bodies withheld.");
        }
    }

    public async Task TickAsync(CancellationToken token, bool allowStart = true)
    {
        await gate.WaitAsync(token);
        try
        {
            if (!initialized) throw new InvalidOperationException("Product owner is not initialized.");
            if (State.Intake is not { Closed: false }) await PollAsync(token);
            var permissionRefreshed = false;
            try
            {
                permissionRefreshed = await RefreshPermissionIfDueAsync(token);
                ApplyPermission();
                await SaveAsync();
            }
            catch (Exception exception) when (IsOperational(exception))
            {
                await HandlePermissionFailureAsync(exception);
            }
            try { await FlushOutboxAsync(token); }
            catch (Exception exception) when (IsOperational(exception))
            {
                if (State.Intake is { Closed: false }) State.Close("offline", Now, "cash_event_report_failed");
                await SaveAsync();
                await StopIfClosingAsync(CancellationToken.None);
                Log("cash_outbox_unacknowledged", exception);
            }
            await ReportHealthIfDueAsync(token);

            if (State.Intake is { Closed: false } active)
            {
                try
                {
                    if (await RefreshPermissionIfDueAsync(token))
                    {
                        ApplyPermission();
                        await SaveAsync();
                    }
                }
                catch (Exception exception) when (IsOperational(exception))
                {
                    await HandlePermissionFailureAsync(exception);
                }
                if (active.Deadline <= Now) State.Close("deadline", Now, "reception_deadline_elapsed");
                await PollAsync(token);
                await StopIfClosingAsync(token);
                await DispatchPendingAsync(token);
                await StopIfClosingAsync(token);
                await FinishIfClosedAsync(token);
            }
            else if (allowStart && healthReady && permissionRefreshed && Now >= nextCommandPoll && !State.Locked
                && (!State.SingleHundred || singleHundredSession is null)
                && State.Outbox.Count == 0 && permission is { State: "awaiting_device", CloseRequested: false })
            {
                nextCommandPoll = Now + 2_000;
                var command = await commands.GetCommandAsync(token);
                if (command is not null)
                {
                    await processor.ProcessAsync(command, token);
                    nextPermissionPoll = 0;
                    try
                    {
                        await RefreshPermissionIfDueAsync(token);
                        ApplyPermission();
                        await SaveAsync();
                    }
                    catch (Exception exception) when (IsOperational(exception))
                    {
                        await HandlePermissionFailureAsync(exception);
                    }
                }
                if (State.Intake is { Closed: false } started
                    && await commandJournal.ReadAsync(started.Command.CommandId, token) is { } entry
                    && entry.State is not ("reported" or "observed"))
                {
                    State.Reconcile("start_command_not_observed", Now);
                    await SaveAsync();
                    await StopIfClosingAsync(token);
                }
            }
            else if (State.Locked && State.Intake is null)
            {
                Log("product_cash_locked_without_intake");
            }
            try { await FlushOutboxAsync(token); }
            catch (Exception exception) when (IsOperational(exception))
            {
                if (State.Intake is { Closed: false }) State.Close("offline", Now, "cash_event_report_failed");
                await SaveAsync();
                await StopIfClosingAsync(CancellationToken.None);
                Log("cash_outbox_unacknowledged", exception);
            }
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            if (exception is IOException or UnauthorizedAccessException)
            {
                // Disk failure cannot make a physical operation safe to repeat. Stop once in this process,
                // retain the pre-dispatch/raw-poll marker on disk and terminate for reconciliation.
                Log("durable_journal_failed", exception);
                if (!emergencyStopAttempted && State.Intake is { EnableDispatchStarted: true, DisableDispatchStarted: false })
                {
                    emergencyStopAttempted = true;
                    try { await device.DisableAsync(CancellationToken.None); }
                    catch (Exception stopException) when (IsOperational(stopException)) { Log("emergency_disable_unknown", stopException); }
                }
                throw;
            }
            if (IsTransientTransport(exception) && !token.IsCancellationRequested)
            {
                healthReady = false;
                if (State.Intake is { Closed: false } intake && !Fresh(lastOwnedPollAt ?? 0, Now))
                    State.Close("offline", Now, "device_observation_stale");
                await SaveAsync();
                await StopIfClosingAsync(CancellationToken.None);
                Log("product_owner_transient_transport_retry", exception);
            }
            else
            {
                State.Reconcile("product_owner_operation_failed", Now);
                await SaveAsync();
                await StopIfClosingAsync(CancellationToken.None);
                Log("product_owner_operation_failed", exception);
            }
        }
        finally { gate.Release(); }
    }

    private async Task<bool> RefreshPermissionIfDueAsync(CancellationToken token)
    {
        if (Now < nextPermissionPoll) return false;
        nextPermissionPoll = Now + 1_000;
        permission = await central.GetCashSessionAsync(token);
        permissionObservedAt = Now;
        return true;
    }

    private async Task HandlePermissionFailureAsync(Exception exception)
    {
        if (IsTransientTransport(exception))
        {
            if (State.Intake is { Closed: false } && !Fresh(permissionObservedAt, Now))
                State.Close("offline", Now, "permission_observation_stale");
            await SaveAsync();
            Log("central_permission_refresh_retry", exception);
            return;
        }

        permission = null;
        if (State.Intake is { Closed: false })
            State.Reconcile("central_permission_invalid", Now);
        else
            healthReady = false;
        await SaveAsync();
        Log("central_permission_invalid", exception);
    }

    private void ApplyPermission()
    {
        if (State.Intake is not { Closed: false } intake) return;
        if (!Bound(permission)) { State.Reconcile("central_intake_binding_changed", Now); return; }
        if (!Fresh(permissionObservedAt, Now))
            State.Close("offline", Now, "permission_observation_stale");
        if (permission!.Deadline is { } deadline && deadline <= Now)
            State.Close("deadline", Now, "permission_expired");
        if (permission.CloseRequested || permission.State is "closing" or "reconciling")
            State.Close(permission.CloseReason ?? "fault", Now, "central_close_requested");
        else if (permission.State == "expired")
            State.Close("deadline", Now, "permission_expired");
        else if (permission.State is not ("awaiting_device" or "accepting"))
            State.Reconcile("central_intake_not_active", Now);
        if (permission.Deadline is { } intakeDeadline)
            intake.Deadline = Math.Min(intake.Deadline ?? intakeDeadline, intakeDeadline);
    }

    public async Task<CashDevicePreflight> CheckPreconditionsAsync(CashStartCommand command, CancellationToken token)
    {
        command.Validate(atmId, Now);
        if (!healthReady || State.Locked || !State.ManualEscrowConfigured || State.Intake is { Closed: false } || State.Outbox.Count != 0
            || State.CompletedSessions.Contains(command.CashSessionId))
            return new(false, "unknown", "product_journal_not_clear");
        permission = await central.GetCashSessionAsync(token);
        permissionObservedAt = Now;
        if (permission is null || permission.VisitId != command.VisitId || permission.CashSessionId != command.CashSessionId
            || permission.CloseRequested || permission.State != "awaiting_device")
            return new(false, "unknown", "cash_consent_binding_not_current");
        // Drain the existing reader, including old cash events; nothing is discarded as initialization noise.
        for (var index = 0; index < 4; index++)
        {
            await PollAsync(token);
            if (State.Locked) return new(false, latest?.DeviceState ?? "unknown", "unattributed_device_event");
            if (index < 3) await Task.Delay(TimeSpan.FromMilliseconds(200), clock, token);
        }
        var readback = await device.ReadAsync(token);
        if (latest?.DeviceState != "DISABLED" || readback.DeviceStateCode != 4 || !readback.Healthy || !readback.EscrowEmpty
            || readback.Inventory.Paise >= 100_000 || readback.Inventory.Notes >= 10
            || State.SingleHundred && (!readback.EnabledValues.SequenceEqual([10_000L]) || readback.Inventory.Paise + 10_000 > 100_000)
            || readback.EnabledValues.Length == 0)
            return new(false, latest?.DeviceState ?? "unknown", "device_preconditions_not_safe");
        State.Begin(command, readback.Inventory, readback.EnabledValues);
        State.Intake!.DisabledObservedAt = latest.ObservedAt;
        State.Intake.DisabledRawSequence = State.RawSequence;
        if (State.SingleHundred) singleHundredSession = command.CashSessionId;
        await SaveAsync();
        return new(true, "DISABLED", "");
    }

    public async Task EnableAcceptorOnceAsync(CancellationToken token)
    {
        var intake = State.Intake ?? throw new InvalidOperationException("No bound intake.");
        var current = await commands.GetCommandAsync(token);
        permission = await central.GetCashSessionAsync(token);
        permissionObservedAt = Now;
        await PollAsync(token);
        if (current is null || current.ContentHash() != intake.Command.ContentHash()
            || current.ExpiresAt <= Now || !Bound(permission) || permission!.State != "awaiting_device"
            || permission.CloseRequested || !Fresh(permissionObservedAt, Now)
            || latest?.DeviceState != "DISABLED" || !Fresh(latest.ObservedAt, Now)
            || State.Locked || intake.CloseReason is not null || intake.EnableDispatchStarted)
            throw new InvalidOperationException("Cash enable is no longer authorized.");
        intake.EnableDispatchStarted = true;
        intake.EnableDispatchedAt = Now;
        idleAfterEnable = null;
        await SaveAsync();
        await device.EnableAsync(token);
        intake.EnableAcknowledgedAt = Now;
        await SaveAsync();
    }

    public async Task<CashCommandObservation?> WaitForAcceptingAsync(string cashSessionId, CancellationToken token)
    {
        var until = Now + ProductTiming.DeviceTransitionMs;
        await Task.Delay(TimeSpan.FromMilliseconds(1), clock, token);
        while (Now < until)
        {
            await PollAsync(token);
            if (State.Locked || State.Intake?.Command.CashSessionId != cashSessionId) return null;
            var intake = State.Intake;
            if (latest?.DeviceState == "ACCEPTING")
            {
                State.Ready(latest.ObservedAt);
                await SaveAsync();
                return new("ACCEPTING", latest.ObservedAt);
            }
            if (latest?.DeviceState == "IDLE")
            {
                if (idleAfterEnable is null || intake.EnableAcknowledgedAt is null
                    || intake.DisabledObservedAt is null || intake.DisabledRawSequence is null
                    || intake.EnableDispatchedAt is null || !State.ManualEscrowConfigured
                    || State.RouteVerificationRequired || State.SuccessfulRouteResults != 6)
                    break;
                var health = await device.ReadHealthAsync(token);
                var readback = health.Readback;
                var current = await commands.GetCommandAsync(token);
                permission = await central.GetCashSessionAsync(token);
                permissionObservedAt = Now;
                if (current?.ContentHash() != intake.Command.ContentHash() || current.ExpiresAt <= Now
                    || !Bound(permission) || permission!.State != "awaiting_device" || permission.CloseRequested
                    || !readback.EnabledValues.SequenceEqual(intake.EnabledValues))
                    break;
                var evidence = new ProductCashReadinessEvidence("itl-idle-after-enable-v1",
                    intake.Command.CommandId, cashSessionId, State.DeviceId!,
                    intake.DisabledObservedAt.Value, intake.DisabledRawSequence.Value, intake.EnableDispatchedAt.Value,
                    intake.EnableAcknowledgedAt.Value, idleAfterEnable.Status.ObservedAt, idleAfterEnable.Sequence,
                    readback.DeviceStateCode, State.ManualEscrowConfigured, !State.RouteVerificationRequired,
                    readback.EscrowEmpty, health.UsbConnected && health.ConnectionOpen && health.DeviceStarted && readback.Healthy,
                    intake.Baseline, readback.Inventory);
                evidence.Validate(intake.Command, State.DeviceId!, Now);
                intake.ReadinessEvidence = evidence;
                State.Ready(evidence.IdleObservedAt);
                await SaveAsync();
                return new("IDLE", evidence.IdleObservedAt, evidence);
            }
            await Task.Delay(TimeSpan.FromMilliseconds(200), clock, token);
        }
        State.Reconcile("ready_not_observed", Now);
        await SaveAsync();
        return null;
    }

    public async Task DisableAcceptorOnceAsync(CancellationToken token)
    {
        if (State.Intake is not { } intake || intake.DisableDispatchStarted) return;
        if (intake.CloseReason is null) State.Close("fault", Now, "device_disable_requested");
        intake.DisableDispatchStarted = true;
        intake.DisabledObserved = false;
        await SaveAsync();
        await device.DisableAsync(token);
    }

    private async Task StopIfClosingAsync(CancellationToken token)
    {
        if (State.Intake is not { Closed: false, CloseReason: not null } intake) return;
        if (NeedsEscrowResolution(intake))
        {
            if (intake.ClosingAt is { } closingAt && Now - closingAt < ProductTiming.DeviceTransitionMs) return;
            State.Reconcile("close_resolution_timeout", Now);
            await SaveAsync();
        }
        if (intake.DisableDispatchStarted) return;
        try { await DisableAcceptorOnceAsync(token); }
        catch (Exception exception) when (IsOperational(exception))
        {
            State.Reconcile("disable_outcome_unknown", Now);
            await SaveAsync();
            Log("disable_outcome_unknown", exception);
        }
    }

    private async Task PollAsync(CancellationToken token)
    {
        State.PollInFlight = true;
        await SaveAsync();
        var raw = await device.PollAsync(token);
        lastOwnedPollAt = raw.Status.ObservedAt;
        latest = raw.Status;
        var acceptanceObserved = State.Intake is { Started: true };
        if (State.Intake is { Started: false, EnableDispatchStarted: true, EnableAcknowledgedAt: not null, CloseReason: null }
            && raw.Status.DeviceState == "ACCEPTING") State.Ready(raw.Status.ObservedAt);
        if (State.Intake is { Started: true } readyIntake && raw.Status.DeviceState == "ACCEPTING")
            State.ObserveAccepting(raw.Status.ObservedAt);
        if (State.Intake is { Started: true, DisableDispatchStarted: false }
            && raw.Status.DeviceState == "DISABLED") State.Reconcile("unexpected_acceptor_disabled", Now);
        (string Type, string State)? lastStateEvent = null;
        if (raw.Sequence != 0)
        {
            if (raw.Sequence != State.RawSequence + 1) State.Reconcile("raw_sequence_gap", Now);
            foreach (var item in raw.Status.Events)
                Observe(item, raw.Status.ObservedAt, ref acceptanceObserved, ref lastStateEvent);
            State.RawSequence = raw.Sequence;
        }
        if (lastStateEvent is { } last && last.State != raw.Status.DeviceState)
            State.Reconcile("device_state_summary_mismatch", raw.Status.ObservedAt);
        if (!State.Locked && State.Intake is { Started: false, EnableAcknowledgedAt: not null, CloseReason: null } starting
            && raw.Sequence > starting.DisabledRawSequence && raw.Status.DeviceState == "IDLE"
            && lastStateEvent is { Type: "DeviceStatusResponse", State: "IDLE" })
            idleAfterEnable = raw;
        if (State.Intake is { Closed: false } intake)
        {
            if (intake.DisableDispatchStarted)
                intake.DisabledObserved = raw.Status.DeviceState == "DISABLED";
            if (raw.Status.DeviceState is not ("DISABLED" or "ACCEPTING" or "IDLE" or "ESCROW"))
                State.Reconcile("unexpected_device_state", Now);
        }
        State.PollInFlight = false;
        await SaveAsync();
    }

    private void Observe(JsonElement item, long observedAt, ref bool acceptanceObserved,
        ref (string Type, string State)? lastStateEvent)
    {
        try
        {
            var type = ProductCashReadback.Text(item, "type");
            if (type == "SetDenominationRouteFinishedEventResponse")
            {
                if (ProductCashReadback.Required(item, "result").ValueKind != JsonValueKind.True)
                    State.Reconcile("route_configuration_failed", observedAt);
                else if (State.RouteVerificationRequired)
                {
                    State.SuccessfulRouteResults++;
                    if (State.SuccessfulRouteResults > 6) State.Reconcile("ambiguous_route_results", observedAt);
                }
                return;
            }
            if (type is "DeviceStateResponse" or "DeviceStatusResponse")
            {
                var state = ProductCashReadback.Text(item, "stateAsString").ToUpperInvariant();
                lastStateEvent = (type, state);
                if (state is not ("CONNECTING" or "CONNECTED" or "STARTING" or "STARTED" or "DISABLED" or "IDLE" or "ACCEPTING" or "ESCROW"))
                    State.Reconcile("unexpected_device_state_event", observedAt);
                else if (State.Intake is { Closed: false, EnableDispatchStarted: true }
                    && state is "CONNECTING" or "CONNECTED" or "STARTING" or "STARTED")
                    State.Reconcile("device_reinitialized_during_intake", observedAt);
                else if (state == "DISABLED" && acceptanceObserved
                    && State.Intake is { Closed: false, DisableDispatchStarted: false })
                    State.Reconcile("unexpected_acceptor_disabled", observedAt);
                if (state is "IDLE" or "ACCEPTING"
                    && State.Intake is { Closed: false, EnableAcknowledgedAt: not null })
                    acceptanceObserved = true;
                if (state == "ACCEPTING" && State.Intake is { Started: true })
                    State.ObserveAccepting(observedAt);
                return;
            }
            if (type != "CashEventResponse") { State.Reconcile("unknown_device_event", observedAt); return; }
            var names = item.EnumerateObject().Where(property =>
                property.Name.Equals("eventTypeAsString", StringComparison.OrdinalIgnoreCase)
                || property.Name.Equals("stateAsString", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (names.Length == 0 || names.Any(property => property.Value.ValueKind != JsonValueKind.String)
                || names.Select(property => property.Value.GetString()!.ToUpperInvariant()).Distinct().Count() != 1)
                throw new InvalidDataException("A cash event omitted or contradicted its name.");
            var name = names[0].Value.GetString()!.ToUpperInvariant();
            if (State.Intake is null || State.Intake.Closed)
            {
                State.Reconcile("cash_event_outside_intake", observedAt);
                return;
            }
            if (name is not ("ESCROW" or "STORED" or "RETURNED"))
            {
                State.Reconcile(name == "STACKED" ? "unexpected_stacked" : "unexpected_cash_event", observedAt);
                return;
            }
            var value = ProductCashReadback.Integer(item, "value");
            var currency = ProductCashReadback.Text(item, "countryCode").ToUpperInvariant();
            if (name == "ESCROW") State.Escrow(value, currency, CanAccept, observedAt);
            else
            {
                // STORED denotes payout storage; a contradictory explicit route is never ignored.
                var routeFields = item.EnumerateObject().Where(property =>
                    property.Name.Equals("acceptRoute", StringComparison.OrdinalIgnoreCase)).ToArray();
                var payout = routeFields.Length == 0 || routeFields.Length == 1 && ItlProductCashDevice.IsPayout(routeFields[0].Value);
                State.Resolve(name, value, currency, payout, observedAt);
            }
        }
        catch (Exception exception) when (exception is InvalidDataException or InvalidOperationException or OverflowException)
        {
            State.Reconcile("malformed_or_ambiguous_cash_event", observedAt);
        }
    }

    private async Task DispatchPendingAsync(CancellationToken token)
    {
        if (State.Intake is not { Closed: false } intake || intake.Pending is not { DispatchStarted: false } note
            || State.Locked) return;
        await PollAsync(token);
        if (State.Locked || !ReferenceEquals(intake.Pending, note)) return;
        var readback = await device.ReadAsync(token);
        if (!Fresh(latest?.ObservedAt ?? 0, Now) || latest?.DeviceState is not ("IDLE" or "ACCEPTING" or "ESCROW")
            || !readback.Healthy || readback.DeviceStateCode == 4 || readback.EscrowEmpty)
        {
            State.Reconcile("escrow_pre_dispatch_state_unknown", Now);
            await SaveAsync();
            return;
        }
        note.DispatchStarted = true;
        await SaveAsync();
        try
        {
            if (note.Decision == "accept") await device.AcceptAsync(token);
            else await device.ReturnAsync(token);
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            State.Reconcile("escrow_dispatch_outcome_unknown", Now);
            await SaveAsync();
            Log("escrow_dispatch_outcome_unknown", exception);
        }
    }

    private async Task FinishIfClosedAsync(CancellationToken token)
    {
        if (State.Intake is not { Closed: false, CloseReason: not null } intake) return;
        var timedOut = intake.ClosingAt is { } closingAt && Now - closingAt >= ProductTiming.DeviceTransitionMs;
        if (timedOut) { State.Reconcile("close_observation_timeout", Now); await SaveAsync(); }
        if (!intake.DisabledObserved) return;
        if (intake.Pending is not null)
        {
            State.Reconcile("close_unresolved_note_outcome", Now);
            await SaveAsync();
            return;
        }
        var readback = await device.ReadAsync(token);
        // A second read through the same consuming owner catches STORED racing the inventory call.
        await PollAsync(token);
        if (!intake.DisabledObserved) return;
        readback = await device.ReadAsync(token);
        if (!readback.Healthy) State.Reconcile("close_device_fault", Now);
        if (!readback.EscrowEmpty)
        {
            if (timedOut) State.Reconcile("close_escrow_not_empty", Now);
            await SaveAsync();
            return;
        }
        State.Finish(readback.Inventory, readback.EscrowEmpty, Now);
        await SaveAsync();
    }

    public async Task FlushOutboxAsync(CancellationToken token)
    {
        while (State.Outbox.Count > 0)
        {
            var ack = await central.PostCashEventAsync(State.Outbox[0], token);
            State.Acknowledge(ack);
            await SaveAsync();
        }
    }

    private async Task ReportHealthIfDueAsync(CancellationToken token)
    {
        if (Now < nextHealthReport) return;
        nextHealthReport = Now + 5_000;
        var healthReportAttempted = false;
        try
        {
            var health = await device.ReadHealthAsync(token);
            var readback = health.Readback;
            if (State.Intake is { Closed: false } && await RefreshPermissionIfDueAsync(token))
            {
                ApplyPermission();
                await SaveAsync();
            }
            var idle = State.Intake is not { Closed: false };
            var stateMismatch = !idle
                && (latest?.DeviceState == "IDLE" && readback.DeviceStateCode != 5
                    || latest?.DeviceState == "ACCEPTING" && readback.DeviceStateCode == 5);
            var acceptorDisabledDuringIntake = !idle && readback.DeviceStateCode == 4
                && State.Intake is { CloseReason: null, DisableDispatchStarted: false };
            var explicitFault = !health.UsbConnected || !health.ConnectionOpen || !health.DeviceStarted
                || !readback.Healthy || readback.EnabledValues.Length == 0
                || State.RouteVerificationRequired || !State.ManualEscrowConfigured || acceptorDisabledDuringIntake;
            if (explicitFault && State.Intake is { Closed: false })
            {
                State.Reconcile("explicit_device_health_failure", Now);
                await SaveAsync();
                await StopIfClosingAsync(token);
            }
            var routes = readback.Healthy && readback.EnabledValues.Length > 0
                && (idle ? readback.DeviceStateCode == 4
                    : latest?.DeviceState is "IDLE" or "ACCEPTING" && readback.DeviceStateCode != 4)
                && (!State.SingleHundred || readback.EnabledValues.SequenceEqual([10_000L]))
                && (!State.SingleHundred || !idle || readback.Inventory.Paise + 10_000 <= 100_000)
                && !State.RouteVerificationRequired && State.ManualEscrowConfigured
                && !State.Locked && State.Intake is not { CloseReason: not null, Closed: false }
                && (idle
                    ? readback.Inventory.Paise < 100_000 && readback.Inventory.Notes < 10
                    : readback.Inventory.Paise <= 100_000 && readback.Inventory.Notes <= 10);
            if (!health.UsbConnected || !health.ConnectionOpen || !health.DeviceStarted || !routes)
                healthReady = false;
            var stateChangedSincePoll = stateMismatch;
            if (lastOwnedPollAt is null || !Fresh(lastOwnedPollAt.Value, Now)
                || Now - lastOwnedPollAt.Value > ProductTiming.EscrowDecisionMs || stateChangedSincePoll)
            {
                // Refresh a stale or superseded observation through the existing consuming owner.
                // Keep verified health while this same owner consumes events; only real failures revoke it.
                await StopIfClosingAsync(token);
                await PollAsync(token);
                await DispatchPendingAsync(token);
                await StopIfClosingAsync(token);
            }
            routes = routes && !State.Locked && State.Intake is not { CloseReason: not null, Closed: false }
                && (idle
                    ? readback.EscrowEmpty && latest?.DeviceState == "DISABLED" && readback.DeviceStateCode == 4
                    : latest?.DeviceState is "IDLE" or "ACCEPTING" && readback.DeviceStateCode != 4);
            var freshPoll = lastOwnedPollAt is { } observed && Fresh(observed, Now);
            var report = new ControllerHealthReport(await NextHealthSequenceAsync(), Now,
                health.UsbConnected, health.ConnectionOpen, health.DeviceStarted, routes,
                freshPoll, State.DeviceId);
            healthReportAttempted = true;
            await healthCentral.ReportHealthAsync(report, token);
            var reportReady = report.UsbConnected && report.ConnectionOpen && report.DeviceStarted
                && report.RoutesVerified && report.PollerOwned;
            if (reportReady) lastSuccessfulHealthAt = Now;
            healthReady = reportReady || !explicitFault
                && lastSuccessfulHealthAt is { } successfulAt && Fresh(successfulAt, Now);
            if (!reportReady && !explicitFault && State.Intake is { Closed: false }
                && (lastSuccessfulHealthAt is null || Now - lastSuccessfulHealthAt.Value > ProductTiming.StatusFreshnessMs))
            {
                State.Close("offline", Now, "health_observation_or_report_stale");
                await SaveAsync();
                await StopIfClosingAsync(token);
            }
            if (!healthReady)
            {
                var age = lastOwnedPollAt is { } poll ? (Now - poll).ToString(
                    System.Globalization.CultureInfo.InvariantCulture) : "missing";
                Console.Error.WriteLine($"Product cash health_not_ready; usbConnected={report.UsbConnected}; "
                    + $"connectionOpen={report.ConnectionOpen}; deviceStarted={report.DeviceStarted}; "
                    + $"routesVerified={report.RoutesVerified}; pollerOwned={report.PollerOwned}; lastPollAgeMs={age}; "
                    + "response bodies withheld.");
            }
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            healthReady = !IsExplicitInvalidObservation(exception)
                && lastSuccessfulHealthAt is { } successfulAt && Fresh(successfulAt, Now);
            Log("health_readback_or_report_failed", exception);
            if (IsTransientTransport(exception))
            {
                if (State.Intake is { Closed: false }
                    && (lastSuccessfulHealthAt is null || Now - lastSuccessfulHealthAt.Value > ProductTiming.StatusFreshnessMs))
                {
                    State.Close("offline", Now, "health_observation_or_report_stale");
                    await SaveAsync();
                    await StopIfClosingAsync(token);
                }
                return;
            }

            if (State.Intake is { Closed: false })
            {
                State.Reconcile("health_readback_invalid", Now);
                await SaveAsync();
                await StopIfClosingAsync(token);
            }
            if (!healthReportAttempted)
                await ReportUnavailableAsync(token);
        }
    }

    private async Task<bool> VerifyCleanShutdownAsync(CancellationToken token)
    {
        if (State.Locked || State.Outbox.Count != 0
            || State.Intake is { } intake
                && (!intake.Closed || !intake.DisabledObserved || intake.FinalInventory is null
                    || intake.Pending is not null || intake.Reasons.Count != 0))
            return false;

        try
        {
            await PollAsync(token);
            var health = await device.ReadHealthAsync(token);
            var readback = health.Readback;
            if (State.Locked || State.Outbox.Count != 0 || !health.UsbConnected || !health.ConnectionOpen
                || !health.DeviceStarted || !readback.Healthy || !readback.EscrowEmpty
                || readback.DeviceStateCode != 4 || latest?.DeviceState != "DISABLED"
                || !Fresh(latest.ObservedAt, Now))
                return false;
            if (State.Intake is { FinalInventory: { } final }
                && (readback.Inventory.Counters != final.Counters
                    || !readback.Inventory.Levels.OrderBy(level => level.ValuePaise)
                        .SequenceEqual(final.Levels.OrderBy(level => level.ValuePaise))))
                return false;
            return State.Outbox.Count == 0 && !State.Locked;
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            Log("shutdown_readback_failed", exception);
            return false;
        }
    }

    public async Task ReportUnavailableAsync(CancellationToken token)
    {
        healthReady = false;
        try
        {
            await healthCentral.ReportHealthAsync(new ControllerHealthReport(
                await NextHealthSequenceAsync(), Now, false, false, false, false, false, State.DeviceId), token);
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            Log("unavailable_health_report_failed", exception);
        }
    }

    private Task<long> NextHealthSequenceAsync() =>
        ProductCashHealth.NextSequenceAsync(State, journal, Now, CancellationToken.None);

    private async Task<bool> CompleteSingleHundredIfSafeAsync(CancellationToken token)
    {
        if (!State.SingleHundred || singleHundredSession is null || State.Locked || State.Outbox.Count != 0
            || State.Intake is not { Closed: true, DisabledObserved: true, FinalInventory: not null } intake
            || intake.Command.CashSessionId != singleHundredSession || intake.Reasons.Count != 0 || intake.Pending is not null)
            return false;
        try
        {
            await PollAsync(token);
            var readback = await device.ReadAsync(token);
            if (State.Locked || latest?.DeviceState != "DISABLED" || !readback.Healthy || !readback.EscrowEmpty
                || readback.Inventory.Counters != intake.FinalInventory.Counters
                || !readback.Inventory.Levels.OrderBy(level => level.ValuePaise)
                    .SequenceEqual(intake.FinalInventory.Levels.OrderBy(level => level.ValuePaise)))
            {
                State.Reconcile("single_note_shutdown_unverified", Now);
                await SaveAsync();
                return false;
            }
            // The final physical readbacks must not bypass a newly queued reconciliation event.
            if (State.Outbox.Count != 0) return false;
            CompletedSingleHundred = true;
            return true;
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            State.Reconcile("single_note_shutdown_unverified", Now);
            await SaveAsync();
            Log("single_note_shutdown_unverified", exception);
            return false;
        }
    }

    private static bool IsOperational(Exception exception) => exception is HttpRequestException or ItlApiException or TimeoutException
        or InvalidDataException or InvalidOperationException or OperationCanceledException or IOException
        or UnauthorizedAccessException or JsonException or OverflowException;

    private static bool IsTransientTransport(Exception exception) => exception switch
    {
        TimeoutException => true,
        OperationCanceledException => true,
        HttpRequestException { StatusCode: null } => true,
        HttpRequestException { StatusCode: HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests } => true,
        HttpRequestException { StatusCode: { } status } => (int)status >= 500,
        ItlApiException { StatusCode: HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests } => true,
        ItlApiException { StatusCode: var status } => (int)status >= 500,
        _ => false
    };

    private static bool IsExplicitInvalidObservation(Exception exception) =>
        exception is InvalidDataException or JsonException or InvalidOperationException or OverflowException;
    private static void Log(string code, Exception? exception = null)
    {
        var status = exception switch
        {
            HttpRequestException { StatusCode: { } http } => $"; HTTP {(int)http}",
            ItlApiException itl => $"; ITL HTTP {(int)itl.StatusCode}"
                + (itl.Operation is { } operation ? $"; operation={operation}" : ""),
            _ => ""
        };
        Console.Error.WriteLine($"Product cash fail-closed: {code}{status}; at={DateTimeOffset.UtcNow:O}; response bodies withheld.");
    }
}
