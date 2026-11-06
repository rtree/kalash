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
    private bool CanAccept => healthReady && Bound(permission) && permission!.State == "accepting" && !permission.CloseRequested
        && permission.Deadline > Now && Now - permissionObservedAt <= 2_000;

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
            var until = Now + 15_000;
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
                using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                try
                {
                    while (State.Intake is { Closed: false })
                    {
                        await TickAsync(shutdown.Token, allowStart: false);
                        await Task.Delay(200, shutdown.Token);
                    }
                }
                catch (Exception exception) when (IsOperational(exception))
                {
                    State.Reconcile("shutdown_unresolved", Now);
                    await SaveAsync();
                    Log("shutdown_unresolved");
                }
            }
            await ReportUnavailableAsync(CancellationToken.None);
        }
    }

    public async Task TickAsync(CancellationToken token, bool allowStart = true)
    {
        await gate.WaitAsync(token);
        try
        {
            if (!initialized) throw new InvalidOperationException("Product owner is not initialized.");
            if (State.Intake is not { Closed: false }) await PollAsync(token);
            await ReportHealthIfDueAsync(token);
            var permissionRefreshed = false;
            try
            {
                if (Now >= nextPermissionPoll)
                {
                    nextPermissionPoll = Now + 1_000;
                    permission = await central.GetCashSessionAsync(token);
                    permissionObservedAt = Now;
                    permissionRefreshed = true;
                }
                ApplyPermission();
                await SaveAsync();
                await FlushOutboxAsync(token);
            }
            catch (Exception exception) when (IsOperational(exception))
            {
                permission = null;
                if (State.Intake is { Closed: false }) State.Close("offline", Now);
                await SaveAsync();
                Log("central_unavailable_or_invalid_receipt");
            }

            if (State.Intake is { Closed: false } active)
            {
                if (active.Deadline <= Now) State.Close("deadline", Now);
                await StopIfClosingAsync(token);
                await PollAsync(token);
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
                if (command is not null) await processor.ProcessAsync(command, token);
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
                if (State.Intake is { Closed: false }) State.Close("offline", Now);
                await SaveAsync();
                await StopIfClosingAsync(CancellationToken.None);
                Log("cash_outbox_unacknowledged");
            }
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            if (exception is IOException or UnauthorizedAccessException)
            {
                // Disk failure cannot make a physical operation safe to repeat. Stop once in this process,
                // retain the pre-dispatch/raw-poll marker on disk and terminate for reconciliation.
                Log("durable_journal_failed");
                if (!emergencyStopAttempted && State.Intake is { EnableDispatchStarted: true, DisableDispatchStarted: false })
                {
                    emergencyStopAttempted = true;
                    try { await device.DisableAsync(CancellationToken.None); }
                    catch (Exception stopException) when (IsOperational(stopException)) { Log("emergency_disable_unknown"); }
                }
                throw;
            }
            State.Reconcile("product_owner_operation_failed", Now);
            await SaveAsync();
            await StopIfClosingAsync(CancellationToken.None);
            Log("product_owner_operation_failed");
        }
        finally { gate.Release(); }
    }

    private void ApplyPermission()
    {
        if (State.Intake is not { Closed: false } intake) return;
        if (!Bound(permission)) { State.Reconcile("central_intake_binding_changed", Now); return; }
        if (permission!.CloseRequested || permission.State is "closing" or "reconciling")
            State.Close(permission.CloseReason ?? "fault", Now);
        else if (permission.State is not ("awaiting_device" or "accepting"))
            State.Reconcile("central_intake_not_active", Now);
        if (permission.Deadline is { } deadline)
            intake.Deadline = Math.Min(intake.Deadline ?? deadline, deadline);
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
        if (latest?.DeviceState != "DISABLED" || !readback.Healthy || !readback.EscrowEmpty
            || readback.Inventory.Paise >= 100_000 || readback.Inventory.Notes >= 10
            || State.SingleHundred && (!readback.EnabledValues.SequenceEqual([10_000L]) || readback.Inventory.Paise + 10_000 > 100_000)
            || readback.EnabledValues.Length == 0)
            return new(false, latest?.DeviceState ?? "unknown", "device_preconditions_not_safe");
        State.Begin(command, readback.Inventory, readback.EnabledValues);
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
        if (current is null || current.ContentHash() != intake.Command.ContentHash()
            || current.ExpiresAt <= Now || !Bound(permission) || permission!.State != "awaiting_device"
            || permission.CloseRequested || State.Locked || intake.CloseReason is not null || intake.EnableDispatchStarted)
            throw new InvalidOperationException("Cash enable is no longer authorized.");
        intake.EnableDispatchStarted = true;
        await SaveAsync();
        await device.EnableAsync(token);
    }

    public async Task<CashCommandObservation?> WaitForAcceptingAsync(string cashSessionId, CancellationToken token)
    {
        var until = Now + 10_000;
        while (Now < until)
        {
            await PollAsync(token);
            if (State.Locked || State.Intake?.Command.CashSessionId != cashSessionId) return null;
            if (latest?.DeviceState == "ACCEPTING")
            {
                State.Ready(latest.ObservedAt);
                await SaveAsync();
                return new("ACCEPTING", latest.ObservedAt);
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
        State.Close("fault", Now);
        intake.DisableDispatchStarted = true;
        intake.DisabledObserved = false;
        await SaveAsync();
        await device.DisableAsync(token);
    }

    private async Task StopIfClosingAsync(CancellationToken token)
    {
        if (State.Intake is not { Closed: false, CloseReason: not null, DisableDispatchStarted: false }) return;
        try { await DisableAcceptorOnceAsync(token); }
        catch (Exception exception) when (IsOperational(exception))
        {
            State.Reconcile("disable_outcome_unknown", Now);
            await SaveAsync();
            Log("disable_outcome_unknown");
        }
    }

    private async Task PollAsync(CancellationToken token)
    {
        State.PollInFlight = true;
        await SaveAsync();
        var raw = await device.PollAsync(token);
        lastOwnedPollAt = Now;
        latest = raw.Status;
        if (State.Intake is { Started: false, EnableDispatchStarted: true, CloseReason: null }
            && raw.Status.DeviceState == "ACCEPTING") State.Ready(raw.Status.ObservedAt);
        if (State.Intake is { Started: true, DisableDispatchStarted: false, CloseReason: null }
            && raw.Status.DeviceState == "DISABLED") State.Reconcile("unexpected_acceptor_disabled", Now);
        if (raw.Sequence != 0)
        {
            if (raw.Sequence != State.RawSequence + 1) State.Reconcile("raw_sequence_gap", Now);
            foreach (var item in raw.Status.Events) Observe(item, raw.Status.ObservedAt);
            State.RawSequence = raw.Sequence;
        }
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

    private void Observe(JsonElement item, long observedAt)
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
            if (type == "DeviceStateResponse")
            {
                var state = ProductCashReadback.Text(item, "stateAsString").ToUpperInvariant();
                if (state is not ("CONNECTED" or "STARTING" or "STARTED" or "DISABLED" or "IDLE" or "ACCEPTING"))
                    State.Reconcile("unexpected_device_state_event", observedAt);
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
        if (note.Decision == "accept" && (!CanAccept || intake.CloseReason is not null || intake.Deadline <= Now))
        {
            // The accepted decision is durable already. Do not rewrite its identity or replay it as a return.
            State.Reconcile("accept_permission_lost_before_dispatch", Now);
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
            Log("escrow_dispatch_outcome_unknown");
        }
    }

    private async Task FinishIfClosedAsync(CancellationToken token)
    {
        if (State.Intake is not { Closed: false, CloseReason: not null } intake) return;
        var timedOut = Now - intake.ClosingAt >= 10_000;
        if (timedOut) { State.Reconcile("close_observation_timeout", Now); await SaveAsync(); }
        if (!intake.DisabledObserved || intake.Pending is not null && !timedOut) return;
        var readback = await device.ReadAsync(token);
        // A second read through the same consuming owner catches STORED racing the inventory call.
        await PollAsync(token);
        if (!intake.DisabledObserved) return;
        readback = await device.ReadAsync(token);
        if (!readback.Healthy) State.Reconcile("close_device_fault", Now);
        if (!readback.EscrowEmpty && !timedOut) return;
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
        healthReady = false;
        try
        {
            var health = await device.ReadHealthAsync(token);
            var readback = health.Readback;
            var idle = State.Intake is not { Closed: false };
            var routes = readback.Healthy && readback.EnabledValues.Length > 0
                && (!State.SingleHundred || readback.EnabledValues.SequenceEqual([10_000L]))
                && (!State.SingleHundred || !idle || readback.Inventory.Paise + 10_000 <= 100_000)
                && !State.RouteVerificationRequired && State.ManualEscrowConfigured
                && !State.Locked && State.Intake is not { CloseReason: not null, Closed: false }
                && (idle
                    ? readback.Inventory.Paise < 100_000 && readback.Inventory.Notes < 10
                    : readback.Inventory.Paise <= 100_000 && readback.Inventory.Notes <= 10)
                && (!idle || readback.EscrowEmpty && latest?.DeviceState == "DISABLED");
            var freshPoll = lastOwnedPollAt is { } observed && Now - observed is >= 0 and <= 2_000;
            var report = new ControllerHealthReport(await NextHealthSequenceAsync(), Now,
                health.UsbConnected, health.ConnectionOpen, health.DeviceStarted, routes,
                freshPoll, State.DeviceId);
            await healthCentral.ReportHealthAsync(report, token);
            healthReady = report.UsbConnected && report.ConnectionOpen && report.DeviceStarted
                && report.RoutesVerified && report.PollerOwned;
            if (!healthReady && State.Intake is { Closed: false, CloseReason: null })
            {
                State.Close("offline", Now);
                await SaveAsync();
            }
        }
        catch (Exception exception) when (IsOperational(exception))
        {
            healthReady = false;
            if (State.Intake is { Closed: false }) State.Close("offline", Now);
            await SaveAsync();
            Log("health_readback_or_report_failed");
            await ReportUnavailableAsync(token);
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
            Log("unavailable_health_report_failed");
        }
    }

    private async Task<long> NextHealthSequenceAsync()
    {
        State.HealthSequence = Math.Max(checked(State.HealthSequence + 1), Now);
        await SaveAsync();
        return State.HealthSequence;
    }

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
            Log("single_note_shutdown_unverified");
            return false;
        }
    }

    private static bool IsOperational(Exception exception) => exception is HttpRequestException or TimeoutException
        or InvalidDataException or InvalidOperationException or OperationCanceledException or IOException
        or UnauthorizedAccessException or JsonException or OverflowException;
    private static void Log(string code) => Console.Error.WriteLine($"Product cash fail-closed: {code}; response bodies withheld.");
}
