using System.Net;
using System.Text;
using System.Text.Json;
using Kalash.CashMachineController;

namespace Kalash.CashMachineController.Tests;

internal static class ProductCashTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static int passed;

    public static async Task ExportIdleReadinessAsync(string relativePath)
    {
        var path = Path.GetFullPath(relativePath);
        if (Path.IsPathFullyQualified(relativePath)
            || !path.StartsWith(Directory.GetCurrentDirectory() + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Synthetic wire export must be a project-relative path.");
        const string session = "20000000-0000-4000-8000-000000000001";
        var command = Command() with { CommandId = $"cash-start-{session}", CashSessionId = session };
        await using var fixture = await OwnerFixture.Create(command: command, deviceId: "local-double");
        await fixture.Start();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var report = fixture.Central.CommandReportBodies.Single(value => value.GetProperty("state").GetString() == "observed");
        await File.WriteAllTextAsync(path, report.GetRawText());
        Console.WriteLine("PASS synthetic actual CentralCashCommandClient IDLE report exported; no hardware evidence.");
    }

    public static async Task ExportWireAsync(string relativePath)
    {
        var path = Path.GetFullPath(relativePath);
        if (Path.IsPathFullyQualified(relativePath)
            || !path.StartsWith(Directory.GetCurrentDirectory() + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Synthetic wire export must be a project-relative path.");
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Itl.Enqueue("ESCROW");
        await fixture.Tick();
        fixture.Central.Done = true;
        fixture.Itl.Stored = 1;
        fixture.Itl.Enqueue("STORED");
        await fixture.Tick();
        ValidateSuccessfulWire(fixture);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new
        {
            synthetic = true,
            evidence = "C# product owner through synthetic HTTP transports; not hardware or live Central evidence",
            requestPaths = fixture.Central.RequestPaths,
            commandReports = fixture.Central.CommandReportBodies,
            cashSessionResponses = fixture.Central.CashSessionBodies,
            events = fixture.Central.Events.Select(text => JsonSerializer.Deserialize<JsonElement>(text)).ToArray()
        }, ProductCashJson.Options));
        Console.WriteLine("PASS synthetic C# wire export: five ordered command reports, cash-session responses, four cash events.");
    }

    public static async Task RunAsync(bool includePayout = true)
    {
        passed = 0;
        if (includePayout) await ProductPayoutTests.RunAsync();
        await Run("same denomination has distinct note keys and session cap", SameDenomination);
        await Run("in-flight note prevents a second physical decision", InFlight);
        await Run("INR value, session, demo value and demo note caps", Limits);
        await Run("STORED requires pending dispatched identity and payout", StoredIdentity);
        await Run("fault latches and late STORED never resurrects credit", NoResurrection);
        await Run("close reconciles all counters and denomination levels", CloseMismatch);
        await Run("strict cash policy keeps historical reconciliation locked", StrictHistoricalMismatch);
        await Run("interim policy retires only verified closed intake as unresolved audit", InterimHistoricalMismatch);
        await Run("interim policy does not retire hardware faults or unknown dispatch", InterimUnsafeHistoricalMismatch);
        await Run("inventory wire fields and mandatory counters", InventoryContract);
        await Run("legacy readback stays unknown rather than inventing a device state", LegacyReadback);
        await Run("readiness permits bounded server clock skew but never stale observations", ReadinessClock);
        await Run("outbox replay after lost receipt survives restart", OutboxRestart);
        await Run("journal ownership and exact ordered acknowledgements", JournalAndAck);
        await Run("consumed raw crash gap latches reconciliation", RawGap);
        await Run("unknown Accept restart does not repeat physical operation", UnknownAcceptRestart);
        await Run("synthetic HTTP intake and Done/STORED race", EndToEndDoneRace);
        await Run("Done before ESCROW returns without Accept", DoneBeforeEscrow);
        await Run("offline while storing stops then observes same reader", OfflineWhileStored);
        await Run("timeout without DISABLED is not closed success", MissingDisabled);
        await Run("bad ACK cannot retire durable event", BadCentralAck);
        await Run("host gate selects exactly one execution worker", HostGate);
        await Run("single consuming poller ownership is enforced", PollerOwnership);
        await Run("route, four-counter and signed binding failures stop Enable", PreflightFailures);
        await Run("idle heartbeat derives readiness without another event reader", IdleHealth);
        await Run("heartbeat sequence persists and shutdown reports unavailable", HealthSequenceAndShutdown);
        await Run("unverified USB, routes, counters or health ACK never enable", FailedHealth);
        await Run("one-100 profile inhibits other values and closes after one stored note", SingleHundredProfile);
        await Run("one-100 Run exits naturally only after exact close ACK and safe readback", NaturalSingleHundredShutdown);
        await Run("regular or unreconciled Run never claims bounded completion", ResidentOrUnknownShutdown);
        await Run("observed DeviceStatusResponse initialization is accepted; unknown states are not", ObservedInitialization);
        await Run("startup-only recovery archives proof and disconnects without cash commands", InitializationRecovery);
        await Run("initialization recovery refuses cash history, other locks and altered raw evidence", RejectNonStartupRecovery);
        await Run("initialization recovery fails closed on current readbacks and unknown disconnect", FailedInitializationRecovery);
        await Run("all Central POST paths carry the canonical configured Origin", CanonicalCentralOrigin);
        await Run("Central unavailable-health POST must pass before startup may continue", CentralPreStartupPost);
        await Run("HTTP failure logs expose status but never response bodies or credentials", SanitizedHttpStatus);
        await Run("actual IDLE after durable Enable produces immutable bound observation", IdleReadiness);
        await Run("ordered multi-event IDLE readiness preserves binding and rejects contradictions", BatchedIdleReadiness);
        await Run("preexisting IDLE or missing transition never becomes Ready", UnboundIdle);
        await Run("IDLE readiness rejects changed routes, escrow, counters or numeric state", UnsafeIdleReadiness);
        await Run("legacy actual ACCEPTING observations remain supported", ActualAccepting);
        await Run("uncommanded DISABLED inside a later IDLE batch requires reconciliation", UnexpectedDisabledInBatch);
        await Run("explicit failed-start zero-note recovery archives exact bytes without command replay", FailedZeroStartRecovery);
        await Run("zero-note recovery refuses other locks, gaps, notes and altered raw transitions", RejectOtherFailedStarts);
        await Run("zero-note recovery keeps unknown readbacks and disconnects fail-closed", UnsafeFailedStartRecovery);
        await Run("start-report latency and repeated heartbeat readbacks retain ready waiting intake", DelayedActiveHeartbeats);
        await Run("heartbeat accepts real-order IDLE to ESCROW and STORED transitions", ActiveNoteDuringHeartbeat);
        await Run("active heartbeat uses fresh named status without guessing numeric mappings", UnmappedActiveReadback);
        await Run("actual health loss closes intake with explicit sanitized components", ActualHealthLoss);
        await Run("transient health report outage waits for freshness timeout", TransientHealthReportFailure);
        await Run("transient permission GET retains only a fresh cached authorization", TransientPermissionFailure);
        await Run("deadline waits for accepting and in-flight notes to resolve", DeadlineResolution);
        await CashTimingTests.RunAsync();
        Console.WriteLine($"{passed} product cash tests passed (synthetic fixtures; no hardware evidence).");
    }

    private static async Task Run(string name, Func<Task> test)
    {
        await test();
        passed++;
        Console.WriteLine($"PASS product: {name}");
    }

    private static void Check(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }

    private static async Task Reject<T>(Func<Task> test) where T : Exception
    {
        try { await test(); }
        catch (T) { return; }
        throw new InvalidOperationException($"Expected {typeof(T).Name}.");
    }

    private static CashStartCommand Command()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var session = Guid.NewGuid().ToString("D");
        return new($"cash-start-{session}", "start_cash", "pending", "atm-test",
            new string('b', 64), "temple-01", session, now + ProductTiming.HumanWindowMs, now);
    }

    private static CashInventory Inventory(int hundreds = 0) =>
        new(CashInventory.Denominations.Select(value => new CashInventoryLevel(value.ToString(),
            value == 10_000 ? hundreds : 0, 0)).ToArray(), new(hundreds, 0, 0, 0));

    private static ProductCashState Started(CashInventory? baseline = null)
    {
        var state = new ProductCashState { StreamId = Guid.NewGuid().ToString("D"), ManualEscrowConfigured = true };
        var command = Command();
        state.Begin(command, baseline ?? Inventory(), CashInventory.Denominations);
        state.Ready(command.CreatedAt);
        return state;
    }

    private static void Store(ProductCashState state, long value = 10_000)
    {
        var now = state.Intake!.Command.CreatedAt + 1;
        var note = state.Escrow(value, "INR", true, now)!;
        Check(note.Decision == "accept", "Expected accept.");
        note.DispatchStarted = true;
        state.Resolve("STORED", value, "INR", true, now + 1);
    }

    private static Task SameDenomination()
    {
        var state = Started();
        for (var i = 0; i < 4; i++) Store(state);
        Check(state.Intake!.Notes.Select(note => note.Key).Distinct().Count() == 4, "Same denomination deduplicated.");
        Check(state.Intake.Notes.Count(note => note.Credited) == 4 && state.Intake.CloseReason == "capacity", "Session cap not closed.");
        Check(state.Escrow(10_000, "INR", true, state.Intake.Command.CreatedAt + 3)!.Decision == "return", "Fifth note accepted.");
        return Task.CompletedTask;
    }

    private static Task InFlight()
    {
        var state = Started();
        var now = state.Intake!.Command.CreatedAt + 1;
        var pending = state.Escrow(20_000, "INR", true, now)!;
        Check(state.Intake.CommittedPaise == 20_000, "Pending note not reserved.");
        Check(state.Escrow(20_000, "INR", true, now + 1) is null && state.Locked, "Concurrent same-value escrow was guessed.");
        Check(!pending.DispatchStarted && state.Intake.Notes.Count == 1, "Ambiguous note dispatched.");
        return Task.CompletedTask;
    }

    private static Task Limits()
    {
        var state = Started();
        Check(state.Escrow(50_000, "INR", true, state.Intake!.Command.CreatedAt + 1)!.Decision == "return", "₹500 exceeds session.");
        state = Started(Inventory(9));
        Check(state.Escrow(20_000, "INR", true, state.Intake!.Command.CreatedAt + 1)!.Decision == "return", "₹1000 demo cap exceeded.");
        state = Started(Inventory(9));
        Store(state);
        Check(state.Intake!.CloseReason == "capacity", "10-note demo cap not closed.");
        state = Started();
        Store(state, 20_000); Store(state, 20_000);
        Check(state.Intake!.CommittedPaise == 40_000, "Two ₹200 notes should fit.");
        state = Started();
        Check(state.Escrow(10_000, "USD", true, state.Intake!.Command.CreatedAt + 1) is null && state.Locked, "Foreign currency accepted.");
        state = Started();
        Check(state.Escrow(10_000, "INR", false, state.Intake!.Command.CreatedAt + 1)!.Decision == "return", "Offline accepted.");
        state = Started();
        Check(state.Escrow(10_000, "INR", true, state.Intake!.Deadline!.Value)!.Decision == "return", "Expired session accepted.");
        return Task.CompletedTask;
    }

    private static Task StoredIdentity()
    {
        foreach (var mismatch in new[] { "value", "currency", "route", "dispatch", "pending" })
        {
            var state = Started();
            var now = state.Intake!.Command.CreatedAt + 1;
            if (mismatch != "pending")
                state.Escrow(10_000, "INR", true, now)!.DispatchStarted = mismatch != "dispatch";
            state.Resolve("STORED", mismatch == "value" ? 20_000 : 10_000, mismatch == "currency" ? "USD" : "INR",
                mismatch != "route", now + 1);
            Check(state.Locked && state.Intake.Notes.All(note => !note.Credited), $"Mismatched {mismatch} credited.");
        }
        return Task.CompletedTask;
    }

    private static Task NoResurrection()
    {
        var state = Started();
        var now = state.Intake!.Command.CreatedAt + 1;
        state.Escrow(10_000, "INR", true, now)!.DispatchStarted = true;
        state.Reconcile("unexpected_stacked", now + 1);
        state.Resolve("STORED", 10_000, "INR", true, now + 2);
        Check(state.Locked && state.Intake.Notes.Single().Stored && !state.Intake.Notes.Single().Credited, "Late STORED resurrected credit.");
        Check(state.Outbox.All(item => item.Type != "note_stored"), "Uncredited note posted as credit.");
        return Task.CompletedTask;
    }

    private static Task CloseMismatch()
    {
        foreach (var mismatch in new[] { "stored", "stacked", "dispensed", "transferred", "cashbox", "denomination", "disabled", "escrow" })
        {
            var state = Started();
            Store(state);
            state.Close("done", state.Intake!.Command.CreatedAt + 3);
            state.Intake.DisabledObserved = mismatch != "disabled";
            var after = Inventory(1);
            var counters = after.Counters;
            after = after with { Counters = counters with
            {
                Stored = mismatch == "stored" ? 2 : 1,
                Stacked = mismatch == "stacked" ? 1 : 0,
                Dispensed = mismatch == "dispensed" ? 1 : 0,
                TransferredToStack = mismatch == "transferred" ? 1 : 0
            }};
            if (mismatch == "cashbox") after.Levels[0] = after.Levels[0] with { Cashbox = 1 };
            if (mismatch == "denomination")
            {
                after.Levels[3] = after.Levels[3] with { Payout = 0 };
                after.Levels[4] = after.Levels[4] with { Payout = 1 };
            }
            state.Finish(after, mismatch != "escrow", state.Intake.Command.CreatedAt + 4);
            Check(state.Locked && state.Outbox[^1].Type == "intake_closed", $"Close {mismatch} falsely confirmed.");
            Check(state.Outbox[^2].Type == "needs_reconciliation", "Reasons must precede close.");
        }
        return Task.CompletedTask;
    }

    private static async Task StrictHistoricalMismatch()
    {
        using var policy = new CashPolicyEnvironment(null);
        Check(!ProductCashPolicy.InterimEnabled, "An absent cash policy must remain strict.");
        await using var fixture = await OwnerFixture.Create();
        SeedHistoricalMismatch(fixture.Owner.State);
        Check(ProductCashPolicy.BlocksOperations(fixture.Owner.State),
            "Strict policy did not block a historical reconciliation lock.");
        Check(!ProductCashPolicy.CanReobserveClosedIntake(fixture.Owner.State),
            "Strict policy allowed a locked historical intake to reopen for physical observation.");
        await fixture.Journal.SaveAsync(fixture.Owner.State, None);

        await fixture.Owner.TickAsync(None, allowStart: false);
        Check(fixture.Owner.State.Locked && !fixture.Owner.State.HistoricalAuditRetired
            && fixture.Owner.State.Intake!.Pending is not null
            && fixture.Owner.State.Intake.Notes.Single() is { Stored: false, Returned: false, Credited: false }
            && fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0 && fixture.Itl.ReturnCount == 0,
            "Strict policy retired a historical lock or replayed a physical command.");
    }

    private static async Task InterimHistoricalMismatch()
    {
        using var policy = new CashPolicyEnvironment("interim-ledger");
        Check(ProductCashPolicy.InterimEnabled, "The exact interim-ledger policy was not recognized.");
        await using var fixture = await OwnerFixture.Create();
        SeedHistoricalMismatch(fixture.Owner.State);
        Check(ProductCashPolicy.BlocksOperations(fixture.Owner.State),
            "Interim classification bypassed the required physical audit readback.");
        Check(ProductCashPolicy.CanReobserveClosedIntake(fixture.Owner.State),
            "Interim policy did not permit a qualifying closed intake to reopen for readback.");
        var oldIntake = fixture.Owner.State.Intake!;
        var oldInventory = oldIntake.FinalInventory;
        var oldSequence = fixture.Owner.State.NextSequence;
        var oldAcknowledged = fixture.Owner.State.AcknowledgedSequence;
        await fixture.Journal.SaveAsync(fixture.Owner.State, None);

        await fixture.Owner.TickAsync(None, allowStart: false);
        Check(!fixture.Owner.State.Locked && fixture.Owner.State.HistoricalAuditRetired
            && !ProductCashPolicy.BlocksOperations(fixture.Owner.State)
            && fixture.Owner.State.AuditWarnings.Contains("inventory_mismatch")
            && fixture.Owner.State.AuditWarnings.Contains("unresolved_note_audit:" + oldIntake.Notes.Single().Key)
            && oldIntake.FinalInventory == oldInventory
            && oldIntake.Reasons.Contains("unexpected_device_state_event")
            && oldIntake.Notes.Single() is
                { Decision: "return", DispatchStarted: true, Stored: false, Returned: false, Credited: false,
                    AuditDisposition: "unresolved_audit" }
            && fixture.Owner.State.NextSequence == oldSequence
            && fixture.Owner.State.AcknowledgedSequence == oldAcknowledged
            && fixture.Owner.State.Outbox.Count == 0
            && fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0 && fixture.Itl.ReturnCount == 0,
            "Verified historical intake was not archived without fabricating a note outcome or changing the ledger.");

        await fixture.Journal.SaveAsync(fixture.Owner.State, None);
        var recoveredAudit = await fixture.Journal.LoadAsync(None);
        Check(recoveredAudit.HistoricalAuditRetired && !recoveredAudit.Locked
            && recoveredAudit.Intake!.Pending is null
            && recoveredAudit.Intake.Notes.Single() is
                { Stored: false, Returned: false, Credited: false, AuditDisposition: "unresolved_audit" }
            && recoveredAudit.NextSequence == oldSequence
            && recoveredAudit.AcknowledgedSequence == oldAcknowledged,
            "Audit retirement did not survive journal reload with sequence and non-credit intact.");

        var nextCommand = fixture.Central.Command;
        var preflight = await fixture.Owner.CheckPreconditionsAsync(nextCommand, None);
        Check(preflight.Ready && fixture.Owner.State.Intake?.Command.CommandId == nextCommand.CommandId
            && fixture.Owner.State.Intake.Notes.Count == 0
            && fixture.Owner.State.HistoricalIntakes.Single() is
                { Closed: true, AuditRetiredAt: not null, Notes.Count: 1, FinalInventory.Counters.Stored: 57 }
            && fixture.Owner.State.HistoricalIntakes.Single().Notes.Single() is
                { Stored: false, Returned: false, Credited: false, AuditDisposition: "unresolved_audit" },
            "Interim policy did not preserve the old ledger and allow a distinct signed intake after safe audit retirement.");

        var afterNextIntake = await fixture.Journal.LoadAsync(None);
        Check(afterNextIntake.Intake is { Closed: false }
            && afterNextIntake.HistoricalIntakes.Single().FinalInventory!.Counters == new CashInventoryCounters(57, 2, 53, 1)
            && afterNextIntake.HistoricalIntakes.Single().Notes.Single().AuditDisposition == "unresolved_audit",
            "A new intake overwrote the retired historical ledger or unresolved note audit.");
    }

    private static async Task InterimUnsafeHistoricalMismatch()
    {
        using var policy = new CashPolicyEnvironment("interim-ledger");
        await using (var fault = await OwnerFixture.Create())
        {
            SeedHistoricalMismatch(fault.Owner.State);
            fault.Itl.UsbDisconnected = true;
            await fault.Journal.SaveAsync(fault.Owner.State, None);
            await fault.Owner.TickAsync(None, allowStart: false);
            Check(fault.Owner.State.Locked && !fault.Owner.State.HistoricalAuditRetired
                && ProductCashPolicy.BlocksOperations(fault.Owner.State)
                && fault.Itl.EnableCount == 0 && fault.Itl.AcceptCount == 0 && fault.Itl.ReturnCount == 0,
                "Interim policy retired history despite a live USB fault.");
        }

        await using (var unknown = await OwnerFixture.Create())
        {
            SeedHistoricalMismatch(unknown.Owner.State);
            await new CashCommandJournal(unknown.Files.File("commands")).SaveAsync(new CashCommandJournalEntry
            {
                Command = unknown.Central.Command,
                ContentHash = unknown.Central.Command.ContentHash(),
                State = "unknown",
                Reason = "synthetic_unknown_dispatch",
                UpdatedAt = DateTimeOffset.UtcNow
            }, None);
            await unknown.Journal.SaveAsync(unknown.Owner.State, None);
            await unknown.Owner.TickAsync(None, allowStart: false);
            Check(unknown.Owner.State.Locked && !unknown.Owner.State.HistoricalAuditRetired
                && ProductCashPolicy.BlocksOperations(unknown.Owner.State)
                && unknown.Itl.EnableCount == 0 && unknown.Itl.AcceptCount == 0 && unknown.Itl.ReturnCount == 0,
                "Interim policy retired an unresolved command dispatch.");
        }
    }

    private static void SeedHistoricalMismatch(ProductCashState state)
    {
        var command = Command();
        state.Begin(command, Inventory(), [10_000]);
        var intake = state.Intake!;
        intake.CloseReason = "fault";
        intake.CloseDetail = "historical_device_mismatch";
        intake.ClosingAt = command.CreatedAt + 1;
        intake.DisableDispatchStarted = true;
        intake.DisabledObserved = true;
        intake.Closed = true;
        intake.FinalInventory = new CashInventory(CashInventory.Denominations.Select(value =>
            new CashInventoryLevel(value.ToString(), value == 10_000 ? 57 : 0, 0)).ToArray(),
            new CashInventoryCounters(57, 2, 53, 1));
        intake.Notes.Add(new ProductCashNote
        {
            Key = $"{command.CashSessionId}:1",
            Value = 10_000,
            Currency = "INR",
            Decision = "return",
            DispatchStarted = true
        });
        var reasons = new[]
        {
            "unexpected_device_state_event", "unexpected_device_state", "close_observation_timeout",
            "unresolved_escrow", "counter_mismatch", "inventory_mismatch", "uncredited_notes"
        };
        intake.Reasons.AddRange(reasons);
        state.LockReasons.AddRange(reasons);
        state.Locked = true;
        state.CompletedSessions.Add(command.CashSessionId);
        state.NextSequence = 7;
        state.AcknowledgedSequence = 6;
    }

    private static Task ReadinessClock()
    {
        var command = Command();
        var disabled = command.CreatedAt - ProductTiming.ClockSkewMs;
        var now = command.CreatedAt + 10;
        var evidence = new ProductCashReadinessEvidence("itl-idle-after-enable-v1",
            command.CommandId, command.CashSessionId, "device", disabled, 1,
            disabled + 1, disabled + 2, now, 2, 5, true, true, true, true, Inventory(), Inventory());
        evidence.Validate(command, "device", now);
        var rejected = false;
        try { (evidence with { DisabledObservedAt = disabled - 1 }).Validate(command, "device", now); }
        catch (InvalidDataException) { rejected = true; }
        Check(rejected, "Readiness outside the configured clock-skew tolerance must be rejected.");
        return Task.CompletedTask;
    }

    private static Task LegacyReadback()
    {
        var oldJson = JsonSerializer.Serialize(new
        {
            inventory = Inventory(), enabledValues = new long[] { 10_000 }, escrowEmpty = true, healthy = true
        }, ProductCashJson.Options);
        var readback = JsonSerializer.Deserialize<ProductDeviceReadback>(oldJson, ProductCashJson.Options)!;
        Check(readback.DeviceStateCode is null, "Old readback must preserve unknown numeric state.");
        Check(readback.DeviceStateCode != 4 && readback.DeviceStateCode != 5, "Unknown must not prove DISABLED or IDLE.");
        var command = Command();
        var now = command.CreatedAt + 10;
        var evidence = new ProductCashReadinessEvidence("itl-idle-after-enable-v1",
            command.CommandId, command.CashSessionId, "device", command.CreatedAt, 1,
            command.CreatedAt + 1, command.CreatedAt + 2, now, 2, readback.DeviceStateCode,
            true, true, true, true, Inventory(), Inventory());
        var rejected = false;
        try { evidence.Validate(command, "device", now); }
        catch (InvalidDataException) { rejected = true; }
        Check(rejected, "Historical unknown readback cannot authorize readiness.");
        return Task.CompletedTask;
    }

    private static Task InventoryContract()
    {
        var element = JsonSerializer.SerializeToElement(Inventory(), ProductCashJson.Options);
        Check(element.EnumerateObject().Select(property => property.Name).SequenceEqual(["levels", "counters"]), "Computed inventory fields leaked.");
        var incomplete = """{"levels":[],"counters":{"stored":0,"stacked":0,"dispensed":0}}""";
        return Reject<JsonException>(() => Task.FromResult(JsonSerializer.Deserialize<CashInventory>(incomplete, ProductCashJson.Options)));
    }

    private static async Task OutboxRestart()
    {
        using var files = new FixtureDirectory();
        var state = Started();
        Store(state);
        state.Close("done", state.Intake!.Command.CreatedAt + 3);
        state.Intake.DisabledObserved = true;
        state.Finish(Inventory(1), true, state.Intake.Command.CreatedAt + 4);
        var original = state.Outbox.Select(item => JsonSerializer.Serialize(item, ProductCashJson.Options)).ToArray();
        var central = new SyntheticCentral(state.Intake.Command) { LoseReceiptOnce = true };
        using var centralClient = central.Client();
        using var itl = new ItlControllerClient("synthetic-user", "synthetic-password", new SyntheticItl());
        await using (var poller = new ItlDeviceStatusPoller(itl, "synthetic-device", files.File("raw.jsonl")))
        using (var journal = new ProductCashJournal(files.File("product")))
        {
            await journal.SaveAsync(state, None);
            var owner = new ProductCashExecutionOwner("atm-test", centralClient, centralClient,
                new ItlProductCashDevice(itl, poller, "synthetic-device"), journal, new(files.File("commands")), true);
            await owner.InitializeAsync(None);
            await Reject<HttpRequestException>(() => owner.FlushOutboxAsync(None));
            Check(owner.State.Outbox.Count == original.Length, "Lost receipt discarded event.");
        }
        await using (var poller = new ItlDeviceStatusPoller(itl, "synthetic-device", files.File("raw.jsonl")))
        using (var journal = new ProductCashJournal(files.File("product")))
        {
            var owner = new ProductCashExecutionOwner("atm-test", centralClient, centralClient,
                new ItlProductCashDevice(itl, poller, "synthetic-device"), journal, new(files.File("commands")), true);
            await owner.InitializeAsync(None);
            await owner.FlushOutboxAsync(None);
            Check(owner.State.Outbox.Count == 0 && owner.State.AcknowledgedSequence == original.Length, "Restart did not ACK outbox.");
            Check(central.Attempts[0] == central.Attempts[1] && central.Events.SequenceEqual(original), "Replay changed durable event bytes.");
        }
    }

    private static async Task JournalAndAck()
    {
        using var files = new FixtureDirectory();
        using var journal = new ProductCashJournal(files.File("product"));
        await Reject<IOException>(() => Task.Run(() => { using var second = new ProductCashJournal(files.File("product")); }));
        var state = Started();
        await journal.SaveAsync(state, None);
        foreach (var ack in new[] { new CashEventAck(false, state.StreamId, 1), new(true, Guid.NewGuid().ToString(), 1), new(true, state.StreamId, 2) })
            await Reject<InvalidDataException>(() => Task.Run(() => state.Acknowledge(ack)));
        Check(state.Outbox.Count == 1, "Bad receipt changed outbox.");
        state.Acknowledge(new(true, state.StreamId, 1));
        await journal.SaveAsync(state, None);
        Check((await journal.LoadAsync(None)).AcknowledgedSequence == 1, "Ack was not durable.");
    }

    private static async Task RawGap()
    {
        await using var fixture = await OwnerFixture.Create();
        fixture.Owner.State.PollInFlight = true;
        await fixture.Journal.SaveAsync(fixture.Owner.State, None);
        await fixture.Restart();
        Check(fixture.Owner.State.Locked && fixture.Owner.State.LockReasons.Contains("raw_consume_commit_gap"), "Raw gap ignored.");
        await fixture.Tick();
        Check(fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0, "Restart replayed physical command.");
    }

    private static async Task UnknownAcceptRestart()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Itl.AcceptFails = true;
        fixture.Itl.Enqueue("ESCROW");
        await fixture.Tick();
        Check(fixture.Itl.AcceptCount == 1 && fixture.Owner.State.Locked, "Unknown Accept not latched.");
        await fixture.Restart();
        fixture.Itl.Enqueue("STORED");
        fixture.Itl.Stored = 1;
        await fixture.Tick();
        Check(fixture.Itl.AcceptCount == 1 && fixture.Itl.EnableCount == 1, "Unknown operation replayed.");
        Check(fixture.Owner.State.Intake!.Notes.All(note => !note.Credited), "Late restart storage resurrected.");
    }

    private static async Task EndToEndDoneRace()
    {
        await using var fixture = await OwnerFixture.Create();
        var pollsBeforeEscrowDispatch = fixture.Itl.StatusCount;
        await fixture.Start();
        fixture.Itl.BeforeAccept = async () =>
        {
            Check(fixture.Itl.StatusCount > pollsBeforeEscrowDispatch,
                "Accept did not have a same-owner status poll immediately before dispatch.");
            var durable = await fixture.Journal.LoadAsync(None);
            Check(durable.Intake!.Pending is { DispatchStarted: true, Decision: "accept" }, "Accept occurred before durable dispatch.");
            Check(durable.Outbox.Any(item => item.Type == "note_escrow"), "Escrow not durably queued.");
        };
        fixture.Itl.Enqueue("ESCROW");
        await fixture.Tick();
        Check(fixture.Itl.AcceptCount == 1, "No physical Accept.");
        fixture.Central.Done = true;
        fixture.Itl.Stored = 1;
        fixture.Itl.Enqueue("STORED");
        await fixture.Tick();
        await fixture.Tick();
        Check(fixture.Owner.State.Intake is { Closed: true } && !fixture.Owner.State.Locked, "Done/STORED race failed.");
        Check(fixture.Itl.DisableCount == 1 && fixture.Itl.MaximumConcurrentStatus == 1, "Duplicate execution owner.");
        Check(fixture.Central.Types.SequenceEqual(["intake_started", "note_escrow", "note_stored", "intake_closed"]), "Outbox event order changed.");
        Check(fixture.Owner.State.Intake!.Notes.Single().Credited, "Stored note was not credited.");
        ValidateSuccessfulWire(fixture);
        var persisted = await fixture.Journal.LoadAsync(None);
        Check(persisted.Intake!.Closed && persisted.Outbox.Count == 0, "Completion not persistent.");
    }

    private static void ValidateSuccessfulWire(OwnerFixture fixture)
    {
        Check(fixture.Owner.State.Intake is { Closed: true } && !fixture.Owner.State.Locked, "Wire fixture failed reconciliation.");
        Check(fixture.Central.CommandReportBodies.Select(body => body.GetProperty("state").GetString())
            .SequenceEqual(["received", "validated", "dispatching", "observed", "reported"]), "Command report wire order differs.");
        foreach (var report in fixture.Central.CommandReportBodies)
        {
            var observed = report.GetProperty("state").GetString() is "observed" or "reported";
            Fields(report, observed ? ["commandId", "state", "observedAt", "deviceState", "readinessEvidence"] : ["commandId", "state"]);
            if (observed) Check(report.GetProperty("deviceState").GetString() == "IDLE"
                && report.GetProperty("observedAt").GetInt64() > 0, "Ready report omitted physical observation.");
        }
        Check(fixture.Central.CashSessionBodies.Any(body => body.GetProperty("session").GetProperty("state").GetString() == "awaiting_device")
            && fixture.Central.CashSessionBodies.Any(body => body.GetProperty("session").GetProperty("state").GetString() == "accepting")
            && fixture.Central.CashSessionBodies.Any(body => body.GetProperty("session").GetProperty("closeRequested").GetBoolean()),
            "Cash-session HTTP wire did not include permission, accepting and Done.");
        Check(fixture.Central.Types.SequenceEqual(["intake_started", "note_escrow", "note_stored", "intake_closed"]), "Cash event wire order differs.");
        foreach (var text in fixture.Central.Events)
        {
            using var document = JsonDocument.Parse(text);
            var value = document.RootElement;
            Fields(value, ["streamId", "sequence", "deviceEventId", "occurredAt", "visitId", "cashSessionId", "type", "data"]);
            var data = value.GetProperty("data");
            Fields(data, value.GetProperty("type").GetString() switch
            {
                "intake_started" => ["inventory"],
                "note_escrow" => ["noteKey", "valuePaise", "currency", "decision"],
                "note_stored" => ["noteKey", "valuePaise", "currency", "route"],
                "intake_closed" => ["reason", "inventory", "creditedNotes", "creditedPaise", "uncreditedNotes", "disabled", "escrowEmpty", "reconciliationReasons"],
                _ => throw new InvalidOperationException("Unexpected successful fixture event.")
            });
            if (data.TryGetProperty("inventory", out var inventory))
            {
                Fields(inventory, ["levels", "counters"]);
                Fields(inventory.GetProperty("counters"), ["stored", "stacked", "dispensed", "transferredToStack"]);
                foreach (var row in inventory.GetProperty("levels").EnumerateArray()) Fields(row, ["valuePaise", "payout", "cashbox"]);
            }
        }
    }

    private static void Fields(JsonElement value, string[] expected) =>
        Check(value.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(expected.Order()),
            "Synthetic HTTP JSON has missing or extra fields.");

    private static async Task DoneBeforeEscrow()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Central.Done = true;
        fixture.Itl.Enqueue("ESCROW");
        await fixture.Tick();
        Check(fixture.Itl.AcceptCount == 0 && fixture.Itl.ReturnCount == 1, "Done accepted a new note.");
        fixture.Itl.Enqueue("RETURNED");
        await fixture.Tick();
        await fixture.Tick();
        Check(fixture.Owner.State.Intake is { Closed: true } && !fixture.Owner.State.Locked, "Returned note did not close cleanly.");
    }

    private static async Task OfflineWhileStored()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Itl.Enqueue("ESCROW");
        await fixture.Tick();
        fixture.Central.Offline = true;
        fixture.Itl.Enqueue("STORED");
        fixture.Itl.Stored = 1;
        fixture.AdvanceHealthInterval();
        await fixture.Tick();
        Check(fixture.Itl.DisableCount == 1 && fixture.Owner.State.Intake!.Notes.Single().Stored, "Offline abandoned device events.");
        Check(!fixture.Owner.State.Locked && fixture.Owner.State.Intake!.Notes.Single().Credited,
            "Unavailable heartbeat discarded a known in-flight STORED outcome.");
        Check(fixture.Owner.State.Outbox.Count > 0, "Offline events were discarded.");
        fixture.Central.Offline = false;
        await fixture.Tick();
        Check(fixture.Owner.State.Outbox.Count == 0, "Reconnect did not replay outbox.");
    }

    private static async Task MissingDisabled()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Itl.IgnoreDisable = true;
        fixture.Central.Done = true;
        await fixture.Tick();
        fixture.Owner.State.Intake!.ClosingAt = fixture.ClockNow - ProductTiming.DeviceTransitionMs - 1;
        await fixture.Tick();
        Check(fixture.Owner.State.Locked && !fixture.Owner.State.Intake.Closed
            && !fixture.Central.Types.Contains("intake_closed"), "Timeout fabricated disabled close.");
    }

    private static async Task BadCentralAck()
    {
        await using var fixture = await OwnerFixture.Create();
        fixture.Central.BadAck = true;
        await fixture.Start(expectClosed: true);
        Check(fixture.Owner.State.Outbox.Count > 0 && fixture.Itl.DisableCount == 1, "Bad ACK retired an event or left intake enabled.");
    }

    private static async Task HostGate()
    {
        Check(!CashControllerConfiguration.ParseProductCashGate(null), "Physical gate defaults on.");
        Check(CashControllerConfiguration.ParseProductCashGate(CashControllerConfiguration.ProductCashEnableValue), "Explicit gate not recognized.");
        await Reject<ControllerConfigurationException>(() => Task.Run(() => CashControllerConfiguration.ParseProductCashGate("true")));
        var product = 0; var noCash = 0;
        await ProductCashHost.RunSelectedAsync(false, () => { product++; return Task.CompletedTask; }, () => { noCash++; return Task.CompletedTask; });
        Check(product == 0 && noCash == 1, "No-cash host invoked product.");
        await ProductCashHost.RunSelectedAsync(true, () => { product++; return Task.CompletedTask; }, () => { noCash++; return Task.CompletedTask; });
        Check(product == 1 && noCash == 1, "Product host launched competing worker.");
    }

    private static async Task PollerOwnership()
    {
        using var files = new FixtureDirectory();
        using var itl = new ItlControllerClient("synthetic", "synthetic", new SyntheticItl());
        await using var poller = new ItlDeviceStatusPoller(itl, "synthetic-device", files.File("raw.jsonl"));
        await poller.RecoverOwnedAsync(None);
        await Reject<InvalidOperationException>(() => Task.Run(poller.Start));
        await Reject<InvalidOperationException>(() => poller.RecoverOwnedAsync(None));
    }

    private static async Task PreflightFailures()
    {
        foreach (var failure in new[] { "route", "counter", "binding" })
        {
            await using var fixture = await OwnerFixture.Create();
            fixture.Itl.BadRoute = failure == "route";
            fixture.Itl.MissingCounter = failure == "counter";
            fixture.Central.WrongBinding = failure == "binding";
            await fixture.Tick();
            Check(fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0, $"Preflight {failure} enabled cash.");
        }
    }

        private static async Task IdleHealth()
        {
            await using var fixture = await OwnerFixture.Create();
            fixture.Central.NoSession = true;
            var polls = fixture.Itl.StatusCount;
            await fixture.Tick();
            Check(fixture.Itl.StatusCount == polls + 1, "Health consumed device events separately from the owner.");
            var health = fixture.Central.HealthBodies.Single();
            Check(health.GetProperty("usbConnected").GetBoolean() && health.GetProperty("connectionOpen").GetBoolean()
                && health.GetProperty("deviceStarted").GetBoolean() && health.GetProperty("routesVerified").GetBoolean()
                && health.GetProperty("pollerOwned").GetBoolean(), "Verified idle readbacks were not advertised ready.");
            Check(fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0, "Heartbeat enabled cash.");
            Check(fixture.Owner.State.HealthSequence == health.GetProperty("sequence").GetInt64(), "Health sequence not durable.");
            fixture.Itl.UsbDisconnected = true;
            fixture.AdvanceHealthInterval();
            await fixture.Tick();
            Check(!fixture.Central.HealthBodies[^1].GetProperty("usbConnected").GetBoolean(), "Disconnected USB still advertised ready.");
        }

        private static async Task HealthSequenceAndShutdown()
        {
            await using var fixture = await OwnerFixture.Create();
            fixture.Central.NoSession = true;
            await fixture.Tick();
            var before = fixture.Owner.State.HealthSequence;
            await fixture.Restart();
            await fixture.Tick();
            Check(fixture.Owner.State.HealthSequence > before, "Restart reset heartbeat sequence.");
            await fixture.Owner.ReportUnavailableAsync(None);
            var health = fixture.Central.HealthBodies[^1];
            Check(!health.GetProperty("routesVerified").GetBoolean() && !health.GetProperty("pollerOwned").GetBoolean(),
                "Shutdown left readiness advertised.");
            Check((await fixture.Journal.LoadAsync(None)).HealthSequence == health.GetProperty("sequence").GetInt64(),
                "Shutdown heartbeat was not persisted.");
        }

        private static async Task FailedHealth()
        {
            foreach (var failure in new[] { "usb", "route", "counter", "ack", "locked" })
            {
                await using var fixture = await OwnerFixture.Create();
                fixture.Itl.UsbDisconnected = failure == "usb";
                fixture.Itl.BadRoute = failure == "route";
                fixture.Itl.MissingCounter = failure == "counter";
                fixture.Central.RejectHealth = failure == "ack";
                if (failure == "locked") fixture.Owner.State.Reconcile("synthetic_locked", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                await fixture.Tick();
                Check(fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0, $"Invalid {failure} health enabled cash.");
                Check(fixture.Central.HealthBodies.Count > 0, "Unavailable heartbeat was omitted.");
            }
        }

        private static async Task SingleHundredProfile()
        {
            await using var fixture = await OwnerFixture.Create(singleHundred: true);
            Check(fixture.Itl.EnabledValues.SetEquals([10_000L]), "One-100 bootstrap did not inhibit other values.");
            await fixture.Start();
            fixture.Itl.Enqueue("ESCROW");
            await fixture.Tick();
            Check(fixture.Itl.AcceptCount == 1 && fixture.Owner.State.Intake!.SingleHundred, "One-note restriction not persisted.");
            fixture.Itl.Stored = 1;
            fixture.Itl.Enqueue("STORED");
            await fixture.Tick();
            await fixture.Tick();
            Check(fixture.Owner.State.Intake is { Closed: true, CloseReason: "capacity" } && !fixture.Owner.State.Locked,
                "Single stored ₹100 did not stop/reconcile the intake.");
            Check(fixture.Itl.DisableCount == 1 && fixture.Itl.AcceptCount == 1, "One-note profile repeated a physical action.");
            fixture.Itl.Enqueue("ESCROW");
            await fixture.Tick();
            Check(fixture.Itl.AcceptCount == 1 && fixture.Owner.State.Locked, "A second note was accepted after single-note completion.");
        }

    private static async Task NaturalSingleHundredShutdown()
    {
        await using var fixture = await OwnerFixture.Create(singleHundred: true, initialize: false, systemClock: true);
        ArrangeAutomaticNote(fixture);
        fixture.Central.BadCloseAck = true;
        var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Central.ClosePosted = () => closed.TrySetResult();
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var worker = fixture.Owner.RunAsync(stop.Token);
        try
        {
            await closed.Task.WaitAsync(TimeSpan.FromSeconds(6));
            Check(!worker.IsCompleted && !fixture.Owner.CompletedSingleHundred, "Worker exited before exact close ACK.");
            Check(fixture.Owner.State.Outbox.Any(item => item.Type == "intake_closed"), "Unacknowledged close was retired.");
            fixture.Central.BadCloseAck = false;
            await worker.WaitAsync(TimeSpan.FromSeconds(6));
            Check(fixture.Owner.CompletedSingleHundred && !fixture.Owner.State.Locked
                && fixture.Owner.State.Outbox.Count == 0 && fixture.Owner.State.Intake is { Closed: true, DisabledObserved: true },
                "Natural completion omitted safe close or durable acknowledgement.");
            var durable = await fixture.Journal.LoadAsync(None);
            Check(durable.AcknowledgedSequence == durable.NextSequence - 1 && durable.Intake!.FinalInventory is not null,
                "Natural completion was not durable.");
            Check(fixture.Itl.EnableCount == 1 && fixture.Itl.AcceptCount == 1 && fixture.Itl.DisableCount == 1,
                "Bounded worker opened another intake or repeated a command.");
            Check(!fixture.Central.HealthBodies[^1].GetProperty("pollerOwned").GetBoolean(), "Natural exit omitted unavailable heartbeat.");
        }
        finally
        {
            stop.Cancel();
            await worker;
        }
    }

    private static async Task ResidentOrUnknownShutdown()
    {
        foreach (var singleHundred in new[] { false, true })
        {
            await using var fixture = await OwnerFixture.Create(singleHundred, initialize: false, systemClock: true);
            ArrangeAutomaticNote(fixture, done: !singleHundred);
            var closed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            fixture.Central.ClosePosted = () =>
            {
                if (singleHundred) fixture.Itl.ForceEscrow = true;
                closed.TrySetResult();
            };
            using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var worker = fixture.Owner.RunAsync(stop.Token);
            try
            {
                await closed.Task.WaitAsync(TimeSpan.FromSeconds(6));
                await Task.Delay(350);
                Check(!worker.IsCompleted && !fixture.Owner.CompletedSingleHundred,
                    "Regular or unverified shutdown exited as a clean bounded run.");
                if (singleHundred)
                    Check(fixture.Owner.State.Locked && fixture.Owner.State.LockReasons.Contains("single_note_shutdown_unverified"),
                        "Unverified final escrow did not persist reconciliation.");
            }
            finally
            {
                stop.Cancel();
                await worker;
            }
        }
    }

    private static void ArrangeAutomaticNote(OwnerFixture fixture, bool done = false)
    {
        fixture.Central.AcceptingSessionRead = () =>
        {
            fixture.Central.AcceptingSessionRead = null;
            fixture.Itl.Enqueue("ESCROW");
        };
        fixture.Itl.BeforeAccept = () =>
        {
            fixture.Itl.Stored = 1;
            fixture.Itl.Enqueue("STORED");
            fixture.Central.Done = done;
            return Task.CompletedTask;
        };
    }

    private static async Task ObservedInitialization()
    {
        await using var fixture = await OwnerFixture.Create(singleHundred: true);
        Check(!fixture.Owner.State.Locked && fixture.Owner.State.SuccessfulRouteResults == 6
            && !fixture.Owner.State.RouteVerificationRequired && fixture.Owner.State.RawSequence == 1,
            "Observed five-state/six-route initialization was misclassified.");
        using var raw = JsonDocument.Parse(await File.ReadAllTextAsync(fixture.Files.File("raw.jsonl")));
        var events = raw.RootElement.GetProperty("events");
        Check(events.GetArrayLength() == 11 && events.EnumerateArray().Take(5)
            .Select(item => item.GetProperty("stateAsString").GetString())
            .SequenceEqual(["CONNECTING", "CONNECTED", "STARTING", "STARTED", "DISABLED"]), "Observed event ordering not exercised.");
        fixture.Central.NoSession = true;
        fixture.Itl.EnqueueState("UNKNOWN_STATE");
        await fixture.Tick();
        Check(fixture.Owner.State.Locked && fixture.Owner.State.LockReasons.Contains("unexpected_device_state_event")
            && fixture.Itl.EnableCount == 0, "Unknown device status was allowed.");
    }

    private static async Task InitializationRecovery()
    {
        await using var fixture = await OwnerFixture.Create(singleHundred: true);
        fixture.Owner.State.Reconcile("unknown_device_event", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        await fixture.Journal.SaveAsync(fixture.Owner.State, None);
        var originalRaw = await File.ReadAllBytesAsync(fixture.Files.File("raw.jsonl"));
        var receipt = await fixture.RecoverStartup();
        var state = await fixture.Journal.LoadAsync(None);
        Check(!state.Locked && state.LockReasons.Count == 0 && state.InitializationRecoveryPhase == "completed"
            && state.InitializationRecovery is { Disconnected: true } && !state.ManualEscrowConfigured,
            "Verified startup recovery did not persist its narrow outcome.");
        Check(fixture.Itl.DisconnectCount == 1 && fixture.Itl.EnableCount == 0 && fixture.Itl.AcceptCount == 0
            && fixture.Itl.ReturnCount == 0 && state.Intake is null && state.Outbox.Count == 0,
            "Recovery issued or invented a cash operation.");
        var afterRaw = await File.ReadAllBytesAsync(fixture.Files.File("raw.jsonl"));
        Check(originalRaw.SequenceEqual(afterRaw), "Original raw evidence changed.");
        using var archive = JsonDocument.Parse(await File.ReadAllTextAsync(fixture.Files.File(Path.Combine("evidence", receipt.ArchiveFile))));
        Check(archive.RootElement.GetProperty("originalState").GetProperty("locked").GetBoolean()
            && Convert.FromBase64String(archive.RootElement.GetProperty("rawJournalBase64").GetString()!).SequenceEqual(originalRaw),
            "Original locked state/raw bytes were not archived.");
        await Reject<InvalidOperationException>(() => fixture.RecoverStartup());
        Check(fixture.Itl.DisconnectCount == 1, "Successful recovery was replayed.");
    }

    private static async Task RejectNonStartupRecovery()
    {
        await using var fixture = await OwnerFixture.Create(singleHundred: true);
        fixture.Owner.State.Reconcile("unknown_device_event", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(fixture.Files.File("raw.jsonl")));
        var observed = new CashRawSnapshot(1, new ItlDeviceStatusSnapshot("DISABLED",
            document.RootElement.GetProperty("events").EnumerateArray().Select(item => item.Clone()).ToArray(),
            document.RootElement.GetProperty("observedAt").GetInt64()));
        foreach (var mutation in new Action<ProductCashState>[]
        {
            state => state.Intake = Started().Intake,
            state => state.Outbox.Add(Started().Outbox[0]),
            state => state.CompletedSessions.Add(Guid.NewGuid().ToString()),
            state => state.NextSequence = 2,
            state => state.LockReasons.Add("raw_consume_commit_gap"),
            state => state.PollInFlight = true,
            state => state.ConnectionDispatchPending = true,
            state => state.InitializationRecoveryPhase = "disconnecting",
            state => state.SingleHundred = false
        })
        {
            var state = JsonSerializer.Deserialize<ProductCashState>(
                JsonSerializer.Serialize(fixture.Owner.State, ProductCashJson.Options), ProductCashJson.Options)!;
            mutation(state);
            await Reject<InvalidOperationException>(() => Task.Run(() =>
                ProductInitializationRecovery.ValidateStartupOnly(state, [observed], 0)));
        }
        await Reject<InvalidOperationException>(() => Task.Run(() =>
            ProductInitializationRecovery.ValidateStartupOnly(fixture.Owner.State, [observed], 1)));
        var changed = observed.Status.Events.ToArray();
        changed[0] = JsonSerializer.SerializeToElement(new { type = "CashEventResponse", eventTypeAsString = "STORED", value = 10000, countryCode = "INR" });
        await Reject<InvalidDataException>(() => Task.Run(() => ProductInitializationRecovery.ValidateStartupOnly(
            fixture.Owner.State, [observed with { Status = observed.Status with { Events = changed } }], 0)));
    }

    private static async Task FailedInitializationRecovery()
    {
        foreach (var failure in new[] { "counter", "cash", "escrow", "inhibit", "disconnect" })
        {
            await using var fixture = await OwnerFixture.Create(singleHundred: true);
            fixture.Owner.State.Reconcile("unknown_device_event", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            await fixture.Journal.SaveAsync(fixture.Owner.State, None);
            fixture.Itl.MissingCounter = failure == "counter";
            fixture.Itl.ForceEscrow = failure == "escrow";
            fixture.Itl.DisconnectFails = failure == "disconnect";
            if (failure == "cash") fixture.Itl.Enqueue("STORED");
            if (failure == "inhibit") fixture.Itl.EnabledValues.Add(20_000);
            if (failure == "disconnect") await Reject<HttpRequestException>(() => fixture.RecoverStartup());
            else await Reject<InvalidDataException>(() => fixture.RecoverStartup());
            var state = await fixture.Journal.LoadAsync(None);
            Check(state.Locked && state.InitializationRecovery is null
                && state.LockReasons.Contains("initialization_reconciliation_incomplete"), "Unverified startup lock was cleared.");
            await Reject<InvalidOperationException>(() => fixture.RecoverStartup());
            Check(fixture.Itl.DisconnectCount == (failure == "disconnect" ? 1 : 0), "Unknown or unsafe disconnect was retried.");
        }
    }

    private static async Task CanonicalCentralOrigin()
    {
        var command = Command();
        var transport = new SyntheticCentral(command) { ExpectedOrigin = "https://central.example:8443" };
        using var client = transport.Client(new Uri("https://central.example:8443/"));
        await client.GetCommandAsync(None);
        await client.GetCashSessionAsync(None);
        await client.ReportHealthAsync(new(1, command.CreatedAt, false, false, false, false, false, null), None);
        await client.ReportAsync(command.CommandId, "received", null, null, None);
        var state = new ProductCashState { StreamId = Guid.NewGuid().ToString("D") };
        state.Begin(command, Inventory(), CashInventory.Denominations);
        state.Ready(command.CreatedAt);
        await client.PostCashEventAsync(state.Outbox[0], None);
        Check(transport.RequestPaths.Count(path => path.StartsWith("POST ", StringComparison.Ordinal)) == 3,
            "Health, command and event POST origins were not all exercised.");
    }

    private static async Task CentralPreStartupPost()
    {
        using var files = new FixtureDirectory();
        using var journal = new ProductCashJournal(files.File("product"));
        var transport = new SyntheticCentral(Command()) { HealthFailureStatus = HttpStatusCode.Forbidden };
        using var client = transport.Client();
        var startupContinued = false;
        await Reject<HttpRequestException>(async () =>
        {
            await ProductCashHealth.VerifyCentralBeforeStartupAsync(journal, client, None);
            startupContinued = true;
        });
        var refused = await journal.LoadAsync(None);
        Check(!startupContinued && refused.HealthSequence > 0 && refused.Intake is null
            && !refused.ConnectionDispatchPending, "Failed POST did not stop before device startup.");
        transport.HealthFailureStatus = null;
        await ProductCashHealth.VerifyCentralBeforeStartupAsync(journal, client, None);
        var accepted = await journal.LoadAsync(None);
        Check(accepted.HealthSequence > refused.HealthSequence, "Pre-start health sequence did not remain monotonic.");
        var health = transport.HealthBodies[^1];
        Check(!health.GetProperty("usbConnected").GetBoolean() && !health.GetProperty("connectionOpen").GetBoolean()
            && !health.GetProperty("deviceStarted").GetBoolean() && !health.GetProperty("routesVerified").GetBoolean()
            && !health.GetProperty("pollerOwned").GetBoolean() && health.GetProperty("deviceId").ValueKind == JsonValueKind.Null,
            "Pre-start POST claimed an attached/ready device.");
    }

    private static async Task SanitizedHttpStatus()
    {
        await using var fixture = await OwnerFixture.Create();
        fixture.Central.HealthFailureStatus = HttpStatusCode.Forbidden;
        var original = Console.Error;
        using var captured = new StringWriter();
        try
        {
            Console.SetError(captured);
            await fixture.Tick();
        }
        finally { Console.SetError(original); }
        var output = captured.ToString();
        Check(output.Contains("health_readback_or_report_failed; HTTP 403", StringComparison.Ordinal),
            "HTTP status was collapsed into a generic health failure.");
        Check(!output.Contains(SyntheticCentral.SensitiveErrorBody, StringComparison.Ordinal)
            && !output.Contains(new string('a', 64), StringComparison.Ordinal)
            && fixture.Itl.EnableCount == 0, "HTTP error handling leaked sensitive content or enabled cash.");
    }

    private static async Task IdleReadiness()
    {
        await using var fixture = await OwnerFixture.Create();
        var preflightPollCount = fixture.Itl.StatusCount;
        fixture.Itl.BeforeEnable = async () =>
        {
            Check(fixture.Itl.StatusCount == preflightPollCount + 6,
                "Enable lacked exactly one final same-owner poll after its four preflight polls.");
            var state = await fixture.Journal.LoadAsync(None);
            Check(state.Intake is { EnableDispatchStarted: true, EnableDispatchedAt: not null,
                DisabledObservedAt: not null, DisabledRawSequence: not null, Started: false, EnableAcknowledgedAt: null },
                "Enable was not preceded by durable signed-command/disabled binding.");
            var command = await new CashCommandJournal(fixture.Files.File("commands")).ReadAsync(state.Intake!.Command.CommandId, None);
            Check(command?.State == "dispatching", "Command dispatch was not durable before physical Enable.");
        };
        await fixture.Start();
        var intake = fixture.Owner.State.Intake!;
        var evidence = intake.ReadinessEvidence!;
        evidence.Validate(intake.Command, fixture.Itl.DeviceId, evidence.IdleObservedAt);
        Check(intake.Deadline == evidence.IdleObservedAt + ProductTiming.HumanWindowMs && fixture.Itl.AcceptCount == 0,
            "IDLE deadline was invented or a note was accepted before ESCROW.");
        var journal = await new CashCommandJournal(fixture.Files.File("commands")).ReadAsync(intake.Command.CommandId, None);
        Check(journal?.Observation is { DeviceState: "IDLE", ReadinessEvidence: not null },
            "Actual IDLE evidence was not persisted with the command.");
        var observed = fixture.Central.CommandReportBodies.Single(value => value.GetProperty("state").GetString() == "observed");
        var reported = fixture.Central.CommandReportBodies.Single(value => value.GetProperty("state").GetString() == "reported");
        Check(observed.GetProperty("readinessEvidence").GetRawText() == reported.GetProperty("readinessEvidence").GetRawText(),
            "Idempotent report changed readiness evidence.");
        Check(fixture.Central.RequestPaths.FindIndex(path => path.EndsWith("/cash-events", StringComparison.Ordinal))
            > fixture.Central.RequestPaths.FindLastIndex(path => path.Contains("/commands/cash-start-", StringComparison.Ordinal)),
            "Intake baseline was posted before observed/reported command acceptance.");
        for (var index = 0; index < 6; index++) await fixture.Tick();
        Check(fixture.Central.HealthBodies[^1].GetProperty("routesVerified").GetBoolean()
            && fixture.Owner.State.Intake!.CloseReason is null, "Bound active IDLE did not retain truthful ready heartbeat.");
    }

    private static async Task BatchedIdleReadiness()
    {
        await using (var fixture = await OwnerFixture.Create())
        {
            fixture.Itl.BeforeEnable = () =>
            {
                fixture.Itl.EnqueueState("DISABLED");
                return Task.CompletedTask;
            };
            fixture.Itl.AfterEnable = () => fixture.Itl.EnqueueRouteResult(true);
            await fixture.Start();
            var intake = fixture.Owner.State.Intake!;
            var evidence = intake.ReadinessEvidence!;
            evidence.Validate(intake.Command, fixture.Itl.DeviceId, evidence.IdleObservedAt);
            Check(evidence.RawSequence > evidence.DisabledRawSequence && !fixture.Owner.State.Locked
                && fixture.Itl.EnableCount == 1 && fixture.Itl.AcceptCount == 0,
                "Ordered DISABLED, IDLE and route-result events did not yield bound IDLE readiness.");
        }

        Action<SyntheticItl>[] contradictions =
        [
            itl => itl.EnqueueState("DISABLED"),
            itl => itl.EnqueueRouteResult(false),
            itl => itl.EnqueueState("ERROR")
        ];
        foreach (var contradiction in contradictions)
        {
            await using var fixture = await OwnerFixture.Create();
            fixture.Itl.AfterEnable = () => contradiction(fixture.Itl);
            await fixture.Tick();
            Check(fixture.Owner.State.Intake is { Started: false } && fixture.Owner.State.Locked
                && fixture.Itl.DisableCount == 1 && fixture.Itl.AcceptCount == 0
                && !fixture.Central.CommandReportBodies.Any(value => value.GetProperty("state").GetString() == "observed"),
                "Contradictory or unsafe batched events were reported as IDLE readiness.");
        }
    }

    private static async Task UnboundIdle()
    {
        await using (var fixture = await OwnerFixture.Create())
        {
            fixture.Itl.State = "IDLE";
            await fixture.Tick();
            Check(fixture.Itl.EnableCount == 0 && fixture.Owner.State.Intake is null
                && !fixture.Central.HealthBodies[^1].GetProperty("routesVerified").GetBoolean(),
                "Preexisting unbound IDLE was treated as ready.");
        }
        await using (var fixture = await OwnerFixture.Create())
        {
            fixture.Itl.SuppressEnableEvent = true;
            await fixture.Tick();
            Check(fixture.Itl.EnableCount == 1 && fixture.Itl.DisableCount == 1
                && fixture.Owner.State.Intake is { Started: false } && fixture.Owner.State.Locked
                && !fixture.Central.CommandReportBodies.Any(value => value.GetProperty("state").GetString() == "observed"),
                "Bare IDLE/HTTP success without new raw transition became ready.");
        }
    }

    private static async Task UnsafeIdleReadiness()
    {
        Action<OwnerFixture>[] changes =
        [
            fixture => fixture.Itl.ForceEscrow = true,
            fixture => fixture.Itl.Stored = 1,
            fixture => fixture.Itl.BadRoute = true,
            fixture => fixture.Itl.MissingCounter = true,
            fixture => fixture.Itl.ReadbackState = 4,
            fixture => fixture.Itl.UsbDisconnected = true,
            fixture => fixture.Central.Done = true,
            fixture => fixture.Itl.EnabledValues.Remove(10_000)
        ];
        foreach (var change in changes)
        {
            await using var fixture = await OwnerFixture.Create();
            fixture.Itl.AfterEnable = () => change(fixture);
            await fixture.Tick();
            Check(fixture.Owner.State.Intake is { Started: false } && fixture.Owner.State.Locked
                && fixture.Itl.DisableCount == 1 && fixture.Itl.AcceptCount == 0
                && !fixture.Central.CommandReportBodies.Any(value => value.GetProperty("state").GetString() == "observed"),
                "Unsafe or no-longer-authorized IDLE readback was reported ready.");
        }
    }

    private static async Task ActualAccepting()
    {
        await using var fixture = await OwnerFixture.Create();
        fixture.Itl.EnableState = "ACCEPTING";
        await fixture.Start();
        var report = fixture.Central.CommandReportBodies.Single(value => value.GetProperty("state").GetString() == "observed");
        Check(report.GetProperty("deviceState").GetString() == "ACCEPTING" && !report.TryGetProperty("readinessEvidence", out _),
            "Actual ACCEPTING observation compatibility changed.");
        fixture.Itl.State = "IDLE";
        fixture.Itl.EnqueueState("IDLE");
        for (var index = 0; index < 6; index++) await fixture.Tick();
        Check(fixture.Owner.State.Intake!.CloseReason is null, "Observed ACCEPTING followed by IDLE lost its command binding.");
    }

    private static async Task UnexpectedDisabledInBatch()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Itl.EnqueueState("DISABLED");
        fixture.Itl.EnqueueState("IDLE");
        await fixture.Tick();
        Check(fixture.Owner.State.Locked && fixture.Owner.State.LockReasons.Contains("unexpected_acceptor_disabled")
            && fixture.Itl.DisableCount == 1 && fixture.Itl.AcceptCount == 0,
            "An uncommanded DISABLED was hidden by a later IDLE summary.");
        var raw = await File.ReadAllTextAsync(fixture.Files.File("raw.jsonl"));
        Check(raw.Contains("\"stateAsString\":\"DISABLED\"", StringComparison.Ordinal)
            && raw.Contains("\"stateAsString\":\"IDLE\"", StringComparison.Ordinal),
            "The event sequence was not retained for reconciliation.");
    }

    private static async Task FailedZeroStartRecovery()
    {
        await using var fixture = await OwnerFixture.Create(singleHundred: true, systemClock: true);
        var command = await fixture.SeedFailedStart();
        var commands = new CashCommandJournal(fixture.Files.File("commands"));
        var originalState = await fixture.Journal.ReadEvidenceAsync(None);
        var originalRaw = await File.ReadAllBytesAsync(fixture.Files.File("raw.jsonl"));
        var originalCommand = await commands.ReadEvidenceAsync(command.CommandId, None);
        var receipt = await fixture.RecoverFailedStart(command.CashSessionId);
        var state = await fixture.Journal.LoadAsync(None);
        Check(!state.Locked && state.FailedStartRecoveryPhase == "completed" && receipt.Disconnected
            && !state.ManualEscrowConfigured && state.Intake is { Started: false, Closed: true }
            && state.CompletedSessions.Contains(command.CashSessionId)
            && state.NextSequence == 4 && state.AcknowledgedSequence == 3 && state.Outbox.Count == 0,
            "Recovery reset stream/session history or omitted safe disconnect.");
        Check(fixture.Itl.EnableCount == 1 && fixture.Itl.DisableCount == 1 && fixture.Itl.DisconnectCount == 1
            && fixture.Itl.AcceptCount == 0 && fixture.Itl.ReturnCount == 0, "Recovery replayed a physical cash operation.");
        var currentCommand = await commands.ReadEvidenceAsync(command.CommandId, None);
        Check(originalCommand.SequenceEqual(currentCommand),
            "Recovery altered the original terminal unknown command.");
        foreach (var (name, bytes) in new[] { ("state.json", originalState), ("raw.jsonl", originalRaw), ("command.json", originalCommand) })
        {
            var archived = await File.ReadAllBytesAsync(Path.Combine(receipt.ArchiveDirectory, name));
            Check(bytes.SequenceEqual(archived), "Evidence archive did not preserve original exact bytes.");
        }
        var proof = JsonSerializer.Deserialize<JsonElement>(await File.ReadAllTextAsync(Path.Combine(receipt.ArchiveDirectory, "proof.json")));
        Fields(proof, ["version", "atmId", "visitId", "cashSessionId", "commandId", "streamId", "deviceId",
            "acknowledgedSequence", "nextSequence", "started", "closed", "disabledObserved", "pollInFlight",
            "outboxCount", "noteCount", "deviceState", "escrowEmpty", "observedAt", "baseline", "finalInventory",
            "currentInventory", "controllerStateSha256", "rawJournalSha256", "commandJournalSha256", "operatorConfirmedNoNotes"]);
        Check(ProductFailedStartRecovery.IsReconciledCommand(state, (await commands.ReadAsync(command.CommandId, None))!),
            "Exact reconciled unknown command was not recognized.");
        await fixture.Restart();
        Check(!fixture.Owner.State.Locked, "Explicitly reconciled unknown command relocked on restart.");
        fixture.Central.NoSession = true;
        await fixture.Tick();
        Check(fixture.Itl.EnableCount == 1 && fixture.Itl.AcceptCount == 0, "Restart replayed the old physical start.");
    }

    private static async Task RejectOtherFailedStarts()
    {
        Action<ProductCashState>[] changes =
        [
            state => state.LockReasons.Add("other_lock"),
            state => state.PollInFlight = true,
            state => state.Intake!.Started = true,
            state => state.Intake!.NoteSequence = 1,
            state => state.Intake!.DisabledObserved = false,
            state => state.Intake!.FinalInventory = Inventory(1),
            state => state.FailedStartRecoveryPhase = "disconnecting"
        ];
        foreach (var change in changes)
        {
            await using var fixture = await OwnerFixture.Create(singleHundred: true, systemClock: true);
            var command = await fixture.SeedFailedStart();
            change(fixture.Owner.State);
            await fixture.Journal.SaveAsync(fixture.Owner.State, None);
            var polls = fixture.Itl.StatusCount;
            await Reject<InvalidOperationException>(() => fixture.RecoverFailedStart(command.CashSessionId));
            Check(fixture.Itl.StatusCount == polls && fixture.Itl.DisconnectCount == 0, "Ineligible recovery consumed or changed the device.");
        }
        await using (var fixture = await OwnerFixture.Create(singleHundred: true, systemClock: true))
        {
            var command = await fixture.SeedFailedStart();
            await Reject<InvalidOperationException>(() => fixture.RecoverFailedStart(command.CashSessionId, false));
        }
        await using (var fixture = await OwnerFixture.Create(singleHundred: true, systemClock: true))
        {
            var command = await fixture.SeedFailedStart();
            var raw = await File.ReadAllTextAsync(fixture.Files.File("raw.jsonl"));
            await File.WriteAllTextAsync(fixture.Files.File("raw.jsonl"), raw.Replace("\"IDLE\"", "\"ACCEPTING\"", StringComparison.Ordinal));
            await Reject<InvalidDataException>(() => fixture.RecoverFailedStart(command.CashSessionId));
            Check(fixture.Itl.DisconnectCount == 0, "Changed retained raw evidence was accepted.");
        }
    }

    private static async Task UnsafeFailedStartRecovery()
    {
        Action<SyntheticItl>[] changes =
        [
            itl => itl.Stored = 1,
            itl => itl.ForceEscrow = true,
            itl => itl.MissingCounter = true,
            itl => itl.BadRoute = true,
            itl => itl.UsbDisconnected = true,
            itl => itl.DisconnectFails = true,
            itl => itl.EnqueueState("IDLE")
        ];
        foreach (var change in changes)
        {
            await using var fixture = await OwnerFixture.Create(singleHundred: true, systemClock: true);
            var command = await fixture.SeedFailedStart();
            change(fixture.Itl);
            if (fixture.Itl.DisconnectFails)
                await Reject<HttpRequestException>(() => fixture.RecoverFailedStart(command.CashSessionId));
            else
                await Reject<InvalidDataException>(() => fixture.RecoverFailedStart(command.CashSessionId));
            var state = await fixture.Journal.LoadAsync(None);
            Check(state.Locked && state.FailedStartRecovery is null
                && state.LockReasons.Contains("failed_start_reconciliation_incomplete")
                && fixture.Itl.EnableCount == 1 && fixture.Itl.AcceptCount == 0,
                "Unknown recovery was cleared or a physical command replayed.");
        }
    }

    private static async Task DelayedActiveHeartbeats()
    {
        await using var fixture = await OwnerFixture.Create();
        fixture.Itl.ReadbackCompleted = () => fixture.AdvanceBy(600);
        fixture.Central.ResponseLatency = operation => fixture.AdvanceBy(operation switch
        {
            "observed" or "reported" => 2_500,
            "intake_started" => 3_000,
            "health" => 600,
            "cash-session" => 300,
            _ => 0
        });
        await fixture.Start();
        var healthBefore = fixture.Central.HealthBodies.Count;
        for (var cycle = 0; cycle < 3; cycle++)
        {
            if (cycle > 0) fixture.AdvanceHealthInterval();
            await fixture.Tick();
            Check(fixture.Owner.State.Intake is { Started: true, Closed: false, CloseReason: null }
                && !fixture.Owner.State.Locked && fixture.Owner.State.Intake.Notes.Count == 0
                && fixture.Itl.EnableCount == 1 && fixture.Itl.DisableCount == 0,
                "Healthy waiting intake closed after delayed start reports or heartbeat scheduling.");
            Check(fixture.Central.HealthBodies[^1].GetProperty("pollerOwned").GetBoolean(),
                "Heartbeat used stale prior-tick status rather than refreshing the owned reader.");
        }
        Check(fixture.Central.HealthBodies.Count >= healthBefore + 3, "Two subsequent heartbeat cycles were not exercised.");

        var inserted = false;
        fixture.Itl.ReadbackCompleted = () =>
        {
            fixture.AdvanceBy(2_200);
            if (inserted) return;
            inserted = true;
            fixture.Itl.Enqueue("ESCROW");
        };
        fixture.Itl.BeforeAccept = async () =>
        {
            var durable = await fixture.Journal.LoadAsync(None);
            Check(durable.Intake!.Pending is { Decision: "accept", DispatchStarted: true }
                && durable.Outbox.Any(value => value.Type == "note_escrow"),
                "Heartbeat-consumed ESCROW was not persisted before Accept.");
        };
        fixture.Central.ResponseLatency = operation =>
        {
            if (operation == "health")
            {
                Check(fixture.Itl.AcceptCount == 1, "An owned heartbeat ESCROW waited on a cloud heartbeat before dispatch.");
                fixture.AdvanceBy(2_500);
            }
            else if (operation == "cash-session") fixture.AdvanceBy(300);
        };
        fixture.AdvanceHealthInterval();
        await fixture.Tick();
        Check(fixture.Itl.AcceptCount == 1 && fixture.Itl.ReturnCount == 0
            && fixture.Owner.State.Intake!.CloseReason is null && !fixture.Owner.State.Locked
            && fixture.Itl.MaximumConcurrentStatus == 1,
            "Heartbeat refresh made real ESCROW falsely offline or introduced another consuming owner.");
    }

    private static async Task ActiveNoteDuringHeartbeat()
    {
        await using var fixture = await OwnerFixture.Create(singleHundred: true);
        await fixture.Start();
        var reportedAt = fixture.Central.HealthBodies[^1].GetProperty("reportedAt").GetInt64();
        var untilRecentPoll = reportedAt + 4_000 - fixture.ClockNow;
        Check(untilRecentPoll >= 0, "Fixture start took too long to position the pre-heartbeat poll.");
        fixture.AdvanceBy(untilRecentPoll);
        await fixture.Owner.TickAsync(None);
        var healthBefore = fixture.Central.HealthBodies.Count;
        fixture.Itl.State = "ACCEPTING";
        fixture.Itl.EnqueueState("ACCEPTING");
        fixture.Itl.Enqueue("ESCROW");
        var healthPostedAfterAccept = false;
        fixture.Central.ResponseLatency = operation =>
        {
            if (operation != "health") return;
            Check(fixture.Itl.AcceptCount == 1, "The heartbeat POST preceded the local ESCROW decision.");
            healthPostedAfterAccept = true;
        };
        fixture.AdvanceBy(1_100);
        await fixture.Owner.TickAsync(None);
        Check(fixture.Central.HealthBodies.Count > healthBefore
            && fixture.Central.HealthBodies[^1].GetProperty("routesVerified").GetBoolean()
            && healthPostedAfterAccept
            && fixture.Itl.AcceptCount == 1 && fixture.Itl.ReturnCount == 0
            && fixture.Itl.DisableCount == 0 && !fixture.Owner.State.Locked
            && fixture.Owner.State.Intake!.CloseReason is null,
            $"A fresh prior IDLE poll disrupted ACCEPTING/ESCROW: reports={healthBefore}->{fixture.Central.HealthBodies.Count}, "
            + $"routes={fixture.Central.HealthBodies[^1].GetProperty("routesVerified").GetBoolean()}, "
            + $"accept={fixture.Itl.AcceptCount}, return={fixture.Itl.ReturnCount}, disable={fixture.Itl.DisableCount}, "
            + $"locked={fixture.Owner.State.Locked}, close={fixture.Owner.State.Intake?.CloseReason}.");
        var note = fixture.Owner.State.Intake!.Notes.Single();
        Check(note.Decision == "accept" && note.DispatchStarted && !note.Stored,
            "ESCROW was not durably dispatched without prematurely crediting the note.");

        fixture.AdvanceBy(3_500);
        fixture.Itl.Stored = 1;
        fixture.Itl.State = "IDLE";
        fixture.Itl.Enqueue("STORED");
        fixture.Itl.EnqueueState("IDLE");
        await fixture.Tick();
        for (var index = 0; index < 5 && !fixture.Owner.State.Intake!.Closed; index++) await fixture.Tick();
        Check(fixture.Owner.State.Intake is { Closed: true } && !fixture.Owner.State.Locked
            && note.Stored && note.Credited && fixture.Itl.AcceptCount == 1
            && fixture.Itl.DisableCount == 1 && fixture.Itl.MaximumConcurrentStatus == 1,
            "The same note was not reconciled after STORED and IDLE in one poll.");
        var envelopes = fixture.Central.Events.Select(text =>
            JsonSerializer.Deserialize<CashEventEnvelope>(text, ProductCashJson.Options)!).ToArray();
        Check(envelopes.Single(value => value.Type == "note_escrow").Data.GetProperty("noteKey").GetString() == note.Key
            && envelopes.Single(value => value.Type == "note_stored").Data.GetProperty("noteKey").GetString() == note.Key,
            "ESCROW and STORED did not preserve the same durable note identity.");
    }

    private static async Task UnmappedActiveReadback()
    {
        await using (var fixture = await OwnerFixture.Create())
        {
            await fixture.Start();
            fixture.Itl.ReadbackState = 42;
            fixture.Itl.State = "ACCEPTING";
            fixture.Itl.EnqueueState("ACCEPTING");
            fixture.Itl.Enqueue("ESCROW");
            fixture.AdvanceHealthInterval();
            await fixture.Tick();
            Check(fixture.Itl.AcceptCount == 1 && fixture.Itl.ReturnCount == 0
                && !fixture.Owner.State.Locked && fixture.Owner.State.Intake!.CloseReason is null
                && fixture.Central.HealthBodies[^1].GetProperty("routesVerified").GetBoolean()
                && fixture.Itl.MaximumConcurrentStatus == 1,
                "A fresh authoritative ACCEPTING event was rejected by an unverified numeric mapping.");
        }

        await using (var fixture = await OwnerFixture.Create())
        {
            await fixture.Start();
            fixture.Itl.ReadbackState = 42;
            fixture.Itl.State = "ERROR";
            fixture.Itl.EnqueueState("ERROR");
            fixture.Itl.Enqueue("ESCROW");
            fixture.AdvanceHealthInterval();
            await fixture.Tick();
            Check(fixture.Owner.State.Locked && fixture.Itl.AcceptCount == 0
                && fixture.Owner.State.LockReasons.Contains("unexpected_device_state_event"),
                "An unmapped numeric readback overrode an unsafe named device event.");
        }
    }

    private static async Task ActualHealthLoss()
    {
        foreach (var failure in new[] { "usb", "state", "central" })
        {
            await using var fixture = await OwnerFixture.Create();
            await fixture.Start();
            fixture.AdvanceHealthInterval();
            fixture.Itl.UsbDisconnected = failure == "usb";
            if (failure == "state") fixture.Itl.ReadbackState = 4;
            if (failure == "central") fixture.Central.HealthFailureStatus = HttpStatusCode.ServiceUnavailable;
            else fixture.Itl.Enqueue("ESCROW");
            var previous = Console.Error;
            using var log = new StringWriter();
            try { Console.SetError(log); await fixture.Tick(); }
            finally { Console.SetError(previous); }
            if (failure == "central")
            {
                Check(fixture.Owner.State.Intake!.CloseReason is null && fixture.Itl.DisableCount == 0
                    && fixture.Itl.AcceptCount == 0,
                    "A single transient health report failure closed the active intake.");
            }
            else
            {
                Check(fixture.Owner.State.Intake!.CloseReason == "fault" && fixture.Itl.DisableCount == 1
                    && fixture.Itl.AcceptCount == 0, "Explicit hardware health loss did not stop with fault.");
            }
            var output = log.ToString();
            if (failure == "usb")
                Check(output.Contains("health_not_ready", StringComparison.Ordinal)
                    && output.Contains("usbConnected=False", StringComparison.Ordinal)
                    && output.Contains("connectionOpen=True", StringComparison.Ordinal)
                    && output.Contains("deviceStarted=True", StringComparison.Ordinal)
                    && output.Contains("routesVerified=", StringComparison.Ordinal)
                    && output.Contains("pollerOwned=True", StringComparison.Ordinal)
                    && output.Contains("lastPollAgeMs=", StringComparison.Ordinal),
                    "False health close omitted explicit readiness components and last poll age.");
            else if (failure == "state")
                Check(output.Contains("health_not_ready", StringComparison.Ordinal)
                    && output.Contains("routesVerified=False", StringComparison.Ordinal),
                    "Contradictory current device state was not logged unavailable before handling ESCROW.");
            else
                Check(output.Contains("HTTP 503", StringComparison.Ordinal), "Genuine health transport failure omitted status.");
            Check(!output.Contains(SyntheticCentral.SensitiveErrorBody, StringComparison.Ordinal)
                && !output.Contains(new string('a', 64), StringComparison.Ordinal),
                "Health diagnostics exposed sensitive transport content.");
        }
    }

    private static async Task TransientHealthReportFailure()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.AdvanceHealthInterval();
        fixture.Central.HealthFailureStatus = HttpStatusCode.ServiceUnavailable;
        await fixture.Tick();
        Check(fixture.Owner.State.Intake is { CloseReason: null, Closed: false }
            && fixture.Itl.DisableCount == 0,
            "A transient report failure stopped acceptance before the freshness window elapsed.");

        fixture.Central.HealthFailureStatus = null;
        fixture.AdvanceHealthInterval();
        await fixture.Tick();
        Check(fixture.Owner.State.Intake is { CloseReason: null, Closed: false }
            && fixture.Owner.State.Outbox.Count == 0,
            "A later successful report did not recover current health.");

        fixture.Central.HealthFailureStatus = HttpStatusCode.ServiceUnavailable;
        fixture.AdvanceBy(ProductTiming.StatusFreshnessMs + 1);
        await fixture.Tick();
        Check(fixture.Owner.State.Intake!.CloseReason == "offline" && fixture.Itl.DisableCount == 1,
            $"Health report outage did not close after the 30,001 ms freshness boundary: close={fixture.Owner.State.Intake.CloseReason}, "
            + $"disable={fixture.Itl.DisableCount}, locked={fixture.Owner.State.Locked}.");
    }

    private static async Task TransientPermissionFailure()
    {
        await using var fixture = await OwnerFixture.Create();
        await fixture.Start();
        fixture.Central.CashSessionFailureStatus = HttpStatusCode.ServiceUnavailable;
        fixture.Itl.Enqueue("ESCROW");
        await fixture.Tick();
        Check(fixture.Owner.State.Intake is { CloseReason: null, Closed: false }
            && fixture.Itl.AcceptCount == 1 && fixture.Itl.DisableCount == 0,
            "A transient permission GET failure closed a session with a current cached authorization.");

        fixture.Central.CashSessionFailureStatus = null;
        fixture.Central.Done = true;
        fixture.Itl.Stored = 1;
        fixture.Itl.Enqueue("STORED");
        await fixture.Tick();
        await fixture.Tick();
        Check(fixture.Owner.State.Intake is { Closed: true } && !fixture.Owner.State.Locked,
            "Permission refresh recovery did not reconcile the same pending note.");

        await using var stale = await OwnerFixture.Create();
        await stale.Start();
        stale.Central.CashSessionFailureStatus = HttpStatusCode.ServiceUnavailable;
        stale.AdvanceBy(ProductTiming.StatusFreshnessMs + 1);
        await stale.Tick();
        Check(stale.Owner.State.Intake!.CloseReason == "offline" && stale.Itl.AcceptCount == 0
            && stale.Itl.DisableCount == 1,
            "Expired cached permission remained usable after 30,001 ms.");
    }

    private static async Task DeadlineResolution()
    {
        await using (var fixture = await OwnerFixture.Create())
        {
            await fixture.Start();
            fixture.Itl.State = "ACCEPTING";
            fixture.Itl.Enqueue("ESCROW");
            fixture.AdvanceBy(ProductTiming.HumanWindowMs + 1);
            await fixture.Tick();
            Check(fixture.Owner.State.Intake!.CloseReason == "deadline" && fixture.Itl.ReturnCount == 1
                && fixture.Itl.AcceptCount == 0 && fixture.Itl.DisableCount == 0,
                "Post-deadline ESCROW was not returned exactly once before disabling.");

            fixture.Itl.State = "IDLE";
            fixture.Itl.Enqueue("RETURNED");
            await fixture.Tick();
            await fixture.Tick();
            Check(fixture.Itl.ReturnCount == 1 && fixture.Itl.DisableCount == 1
                && fixture.Owner.State.Intake is { Closed: true },
                "Acceptor did not wait for the actual RETURNED outcome before close.");
        }

        await using (var fixture = await OwnerFixture.Create())
        {
            await fixture.Start();
            fixture.Itl.Enqueue("ESCROW");
            await fixture.Tick();
            Check(fixture.Itl.AcceptCount == 1 && fixture.Owner.State.Intake!.Pending is not null,
                "Pre-deadline accept was not durably dispatched.");
            fixture.AdvanceBy(ProductTiming.HumanWindowMs + 1);
            await fixture.Tick();
            Check(fixture.Owner.State.Intake!.CloseReason == "deadline" && fixture.Itl.DisableCount == 0,
                "Deadline disabled the device before a dispatched note resolved.");
            fixture.Itl.Stored = 1;
            fixture.Itl.Enqueue("STORED");
            await fixture.Tick();
            await fixture.Tick();
            Check(fixture.Owner.State.Intake is { Closed: true } && !fixture.Owner.State.Locked
                && fixture.Owner.State.Intake.Notes.Single().Credited && fixture.Itl.AcceptCount == 1,
                "Late STORED for a previously authorized accept was not credited exactly once.");
        }
    }

    private sealed class FixtureDirectory : IDisposable
    {
        private readonly string root = Path.GetFullPath(Path.Combine("CashMachine", "CashMachineController.Tests",
            ".fixtures", Guid.NewGuid().ToString("N")));
        public FixtureDirectory() => Directory.CreateDirectory(root);
        public string File(string name) => Path.Combine(root, name);
        public void Dispose() => Directory.Delete(root, true);
    }

    private sealed class CashPolicyEnvironment : IDisposable
    {
        private readonly string? previous = Environment.GetEnvironmentVariable("KALASH_CASH_POLICY");

        public CashPolicyEnvironment(string? value) => Environment.SetEnvironmentVariable("KALASH_CASH_POLICY", value);

        public void Dispose() => Environment.SetEnvironmentVariable("KALASH_CASH_POLICY", previous);
    }

    private sealed class OwnerFixture : IAsyncDisposable
    {
        public readonly FixtureDirectory Files = new();
        public readonly SyntheticItl Itl = new();
        public readonly SyntheticCentral Central;
        public ProductCashJournal Journal = null!;
        public ProductCashExecutionOwner Owner = null!;
        private ItlControllerClient client = null!;
        private CentralCashCommandClient centralClient = null!;
        private ItlDeviceStatusPoller poller = null!;
        private readonly FixtureClock clock = new();
        private bool useSystemClock;

        private OwnerFixture(CashStartCommand? command) => Central = new(command ?? Command());

        public static async Task<OwnerFixture> Create(bool singleHundred = false, bool initialize = true, bool systemClock = false,
            CashStartCommand? command = null, string deviceId = "synthetic-device")
        {
            var fixture = new OwnerFixture(command);
            fixture.Itl.DeviceId = deviceId;
            fixture.useSystemClock = systemClock;
            fixture.client = new("synthetic-user", "synthetic-password", fixture.Itl);
            fixture.centralClient = fixture.Central.Client();
            fixture.Journal = new(fixture.Files.File("product"));
            await ProductCashHost.OpenDisabledAsync(true, fixture.client, fixture.Journal,
                "COM4", fixture.Files.File("ssp-logs"), None, singleHundred);
            await fixture.MakeOwner(initialize);
            return fixture;
        }

        private async Task MakeOwner(bool initialize = true)
        {
            poller = new(client, Itl.DeviceId, Files.File("raw.jsonl"))
            { OwnedTimeProvider = useSystemClock ? TimeProvider.System : clock };
            Owner = new("atm-test", centralClient, centralClient, new ItlProductCashDevice(client, poller, Itl.DeviceId),
                Journal, new(Files.File("commands")), true, useSystemClock ? TimeProvider.System : clock);
            if (initialize) await Owner.InitializeAsync(None);
        }

        public async Task Restart()
        {
            await poller.DisposeAsync();
            Journal.Dispose();
            Journal = new(Files.File("product"));
            await MakeOwner();
        }

        public async Task<ProductInitializationRecoveryReceipt> RecoverStartup()
        {
            await poller.DisposeAsync();
            poller = new(client, "synthetic-device", Files.File("raw.jsonl"));
            return await new ProductInitializationRecovery(Journal, new(Files.File("commands")),
                new ItlProductCashDevice(client, poller, "synthetic-device"), Files.File("raw.jsonl"),
                Files.File("evidence")).ReconcileAndDisconnectAsync(None);
        }

        public async Task<CashStartCommand> SeedFailedStart()
        {
            await Task.Delay(5);
            var command = Command();
            var state = Owner.State;
            state.Begin(command, Inventory(), [10_000L]);
            state.Intake!.EnableDispatchStarted = true;
            state.Intake.EnableDispatchedAt = command.CreatedAt + 1;
            await client.EnableAcceptorOnceAsync(Itl.DeviceId, None);
            state.RawSequence = (await poller.PollOwnedAsync(None)).Sequence;
            state.Reconcile("ready_not_observed", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            state.Intake.DisableDispatchStarted = true;
            await client.DisableAcceptorOnceAsync(Itl.DeviceId, None);
            state.RawSequence = (await poller.PollOwnedAsync(None)).Sequence;
            state.Intake.DisabledObserved = true;
            state.Reconcile("start_command_not_observed", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            state.Finish(Inventory(), true, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            while (state.Outbox.Count != 0)
                state.Acknowledge(new(true, state.StreamId, state.Outbox[0].Sequence));
            await Journal.SaveAsync(state, None);
            await new CashCommandJournal(Files.File("commands")).SaveAsync(new CashCommandJournalEntry
            {
                Command = command, ContentHash = command.ContentHash(), State = "unknown",
                Reason = "acceptance_state_not_observed", UpdatedAt = DateTimeOffset.UtcNow
            }, None);
            return command;
        }

        public async Task<ProductFailedStartRecoveryReceipt> RecoverFailedStart(string cashSessionId, bool confirmed = true)
        {
            await poller.DisposeAsync();
            poller = new(client, Itl.DeviceId, Files.File("raw.jsonl"));
            return await new ProductFailedStartRecovery(Journal, new(Files.File("commands")),
                new ItlProductCashDevice(client, poller, Itl.DeviceId), Files.File("raw.jsonl"),
                Files.File("failed-evidence"), "atm-test", cashSessionId, confirmed).ReconcileAndDisconnectAsync(None);
        }

        public async Task Start(bool expectClosed = false)
        {
            await Tick();
            Check(Itl.EnableCount == 1 && Owner.State.Intake!.Started, "Synthetic product failed to start.");
            if (!expectClosed) Check(!Owner.State.Locked && Central.Types.Contains("intake_started"), "Start event not acknowledged.");
        }

        public Task Tick()
        {
            clock.Advance();
            return Owner.TickAsync(None);
        }

        public void AdvanceHealthInterval()
        {
            for (var index = 0; index < 5; index++) clock.Advance();
        }

        public void AdvanceBy(long milliseconds) => clock.Advance(milliseconds);
        public long ClockNow => clock.GetUtcNow().ToUnixTimeMilliseconds();

        public async ValueTask DisposeAsync()
        {
            await poller.DisposeAsync();
            client.Dispose(); centralClient.Dispose(); Journal.Dispose(); Files.Dispose();
        }

        private sealed class FixtureClock : TimeProvider
        {
            private long offset;
            public void Advance(long milliseconds = 1_100) => offset += milliseconds;
            public override DateTimeOffset GetUtcNow() => DateTimeOffset.UtcNow.AddMilliseconds(offset);
        }
    }

    private sealed class SyntheticCentral : HttpMessageHandler
    {
        private readonly CashStartCommand command;
        public SyntheticCentral(CashStartCommand command)
        {
            this.command = command;
            Command = command;
        }

        public const string SensitiveErrorBody = "synthetic-sensitive-response-body-not-for-logs";
        public CashStartCommand Command { get; }
        public string ExpectedOrigin = "https://central.example";
        public HttpStatusCode? HealthFailureStatus;
        public HttpStatusCode? CashSessionFailureStatus;
        public bool Done, Offline, BadAck, LoseReceiptOnce, WrongBinding, NoSession, RejectHealth, BadCloseAck;
        public Action? AcceptingSessionRead, ClosePosted;
        public Action<string>? ResponseLatency;
        public List<string> Events { get; } = [];
        public List<string> Attempts { get; } = [];
        public List<string> Types { get; } = [];
        public List<string> RequestPaths { get; } = [];
        public List<JsonElement> CommandReportBodies { get; } = [];
        public List<JsonElement> CashSessionBodies { get; } = [];
        public List<JsonElement> HealthBodies { get; } = [];
        private bool observed;
        private readonly Dictionary<long, string> durable = [];
        public CentralCashCommandClient Client(Uri? centralUri = null) =>
            new(centralUri ?? new Uri("https://central.example"), "atm-test", new string('a', 64), this);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath;
            RequestPaths.Add($"{request.Method} {path}");
            Check(request.Headers.TryGetValues("Origin", out var origins) && origins.SequenceEqual([ExpectedOrigin]),
                "Every Central request must carry the single canonical configured Origin without a trailing slash.");
            Check(request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter == new string('a', 64),
                "Controller credential was not transported as Bearer.");
            if (Offline) throw new HttpRequestException("synthetic offline");
            if (path == "/api/controller/atm-test/health")
            {
                Check(request.Method == HttpMethod.Post, "Health method differs.");
                var body = JsonSerializer.Deserialize<JsonElement>(await request.Content!.ReadAsStringAsync(token));
                Fields(body, ["sequence", "reportedAt", "usbConnected", "connectionOpen", "deviceStarted", "routesVerified", "pollerOwned", "deviceId"]);
                Check(body.GetProperty("sequence").GetInt64() > 0 && body.GetProperty("reportedAt").GetInt64() > 0,
                    "Health timestamp/sequence omitted.");
                if (HealthBodies.Count > 0)
                    Check(body.GetProperty("sequence").GetInt64() > HealthBodies[^1].GetProperty("sequence").GetInt64(),
                        "Health sequence did not increase.");
                HealthBodies.Add(body);
                if (HealthFailureStatus is { } failure)
                    return new HttpResponseMessage(failure) { Content = new StringContent(SensitiveErrorBody) };
                ResponseLatency?.Invoke("health");
                return Json(new ControllerHealthReceipt(!RejectHealth, false, false, true));
            }
            if (path == "/api/controller/atm-test/cash-session")
            {
                Check(request.Method == HttpMethod.Get, "Cash-session method differs.");
                if (CashSessionFailureStatus is { } failure)
                    return new HttpResponseMessage(failure) { Content = new StringContent(SensitiveErrorBody) };
                if (NoSession) return Json(new CentralCashSessionResponse(null));
                if (observed && !Done) AcceptingSessionRead?.Invoke();
                var body = JsonSerializer.SerializeToElement(new CentralCashSessionResponse(new(command.VisitId, WrongBinding ? Guid.NewGuid().ToString() : command.CashSessionId,
                    Done ? "closing" : observed ? "accepting" : "awaiting_device",
                    observed ? CommandReportBodies.Single(report => report.GetProperty("state").GetString() == "observed")
                        .GetProperty("observedAt").GetInt64() + ProductTiming.HumanWindowMs : null,
                    Done, Done ? "done" : null)), ProductCashJson.Options);
                Fields(body, ["session"]);
                Fields(body.GetProperty("session"), ["visitId", "cashSessionId", "state", "deadline", "closeRequested", "closeReason"]);
                CashSessionBodies.Add(body);
                ResponseLatency?.Invoke("cash-session");
                return Json(body);
            }
            if (path == "/api/controller/atm-test/commands")
            {
                Check(request.Method == HttpMethod.Get, "Command discovery method differs.");
                return Json(new { command });
            }
            if (path == $"/api/controller/atm-test/commands/{command.CommandId}")
            {
                Check(request.Method == HttpMethod.Post, "Command report method differs.");
                using var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
                Check(body.RootElement.GetProperty("commandId").GetString() == command.CommandId, "Command report ID differs.");
                CommandReportBodies.Add(body.RootElement.Clone());
                if (body.RootElement.GetProperty("state").GetString() == "observed")
                {
                    if (body.RootElement.GetProperty("deviceState").GetString() == "IDLE")
                    {
                        var evidence = JsonSerializer.Deserialize<ProductCashReadinessEvidence>(
                            body.RootElement.GetProperty("readinessEvidence"), ProductCashJson.Options)!;
                        evidence.Validate(command, evidence.DeviceId, body.RootElement.GetProperty("observedAt").GetInt64());
                        Check(evidence.IdleObservedAt == body.RootElement.GetProperty("observedAt").GetInt64(),
                            "IDLE observation timestamp differs from immutable proof.");
                        Fields(body.RootElement.GetProperty("readinessEvidence"),
                            ["version", "commandId", "cashSessionId", "deviceId", "disabledObservedAt", "disabledRawSequence",
                                "enableDispatchedAt", "enableAcknowledgedAt", "idleObservedAt", "rawSequence", "deviceStateCode",
                                "manualEscrow", "routesVerified", "escrowEmpty", "deviceHealthy", "baseline", "inventory"]);
                    }
                    observed = true;
                }
                ResponseLatency?.Invoke(body.RootElement.GetProperty("state").GetString()!);
                return Json(new { accepted = true });
            }
            Check(path == "/api/controller/atm-test/cash-events" && request.Method == HttpMethod.Post, "Unexpected synthetic Central endpoint.");
            var text = await request.Content!.ReadAsStringAsync(token);
            var value = JsonSerializer.Deserialize<CashEventEnvelope>(text, ProductCashJson.Options)!;
            Attempts.Add(text);
            if (durable.TryGetValue(value.Sequence, out var previous)) Check(previous == text, "Event replay changed content.");
            else
            {
                Check(value.Sequence == durable.Count + 1, "Non-contiguous stream.");
                durable[value.Sequence] = text;
                Events.Add(text); Types.Add(value.Type);
            }
            if (LoseReceiptOnce) { LoseReceiptOnce = false; throw new HttpRequestException("synthetic lost committed receipt"); }
            var wrongAck = BadAck || BadCloseAck && value.Type == "intake_closed";
            if (value.Type == "intake_closed") ClosePosted?.Invoke();
            ResponseLatency?.Invoke(value.Type);
            return Json(new CashEventAck(true, value.StreamId, value.Sequence + (wrongAck ? 1 : 0)));
        }
    }

    private sealed class SyntheticItl : HttpMessageHandler
    {
        public int EnableCount, AcceptCount, ReturnCount, DisableCount, Stored, MaximumConcurrentStatus, StatusCount, DisconnectCount;
        public bool AcceptFails, IgnoreDisable, BadRoute, MissingCounter, UsbDisconnected, ForceEscrow, DisconnectFails;
        public bool SuppressEnableEvent;
        public string DeviceId = "synthetic-device";
        public string EnableState = "IDLE";
        public int? ReadbackState;
        public HashSet<long> EnabledValues { get; } = CashInventory.Denominations.ToHashSet();
        public Func<Task>? BeforeAccept, BeforeEnable;
        public Action? AfterEnable;
        public Action? ReadbackCompleted;
        public string State = "DISABLED";
        private bool escrow;
        private int statusRequests;
        private bool disconnected;
        private readonly Queue<object> events = new();

        public void Enqueue(string name)
        {
            events.Enqueue(new { type = "CashEventResponse", eventTypeAsString = name, value = 10_000, countryCode = "INR" });
            escrow = name == "ESCROW";
        }

        public void EnqueueState(string name) => events.Enqueue(new { type = "DeviceStatusResponse", stateAsString = name });
        public void EnqueueRouteResult(bool result) => events.Enqueue(new { type = "SetDenominationRouteFinishedEventResponse", result });

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath;
            var operation = path[(path.LastIndexOf('/') + 1)..];
            switch (operation)
            {
                case "Authenticate": return Json(new { token = "synthetic-itl-token", expires_seconds = 3600 });
                case "GetConnectedUSBDevices": return Json(UsbDisconnected ? Array.Empty<object>() : [new { Port = "COM4" }]);
                case "GetAllCashDevices": return Json(disconnected ? Array.Empty<string>() : [DeviceId]);
                case "OpenConnection":
                    using (var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)))
                    {
                        Check(!body.RootElement.GetProperty("EnableAcceptor").GetBoolean()
                            && !body.RootElement.GetProperty("EnableAutoAcceptEscrow").GetBoolean(), "Bootstrap enabled acceptance.");
                        EnabledValues.Clear();
                        foreach (var row in body.RootElement.GetProperty("SetInhibits").EnumerateArray())
                            if (!row.GetProperty("Inhibit").GetBoolean())
                                EnabledValues.Add(long.Parse(row.GetProperty("Denomination").GetString()!.Split(' ')[0]));
                    }
                    foreach (var status in new[] { "CONNECTING", "CONNECTED", "STARTING", "STARTED", "DISABLED" })
                        EnqueueState(status);
                    for (var index = 0; index < 6; index++)
                        events.Enqueue(new { type = "SetDenominationRouteFinishedEventResponse", result = true });
                    return Json(new { deviceID = DeviceId });
                case "GetDeviceStatus":
                    StatusCount++;
                    MaximumConcurrentStatus = Math.Max(MaximumConcurrentStatus, Interlocked.Increment(ref statusRequests));
                    try
                    {
                        await Task.Yield();
                        var batch = events.ToArray(); events.Clear();
                        return Json(new { deviceState = State, pollBuffer = batch });
                    }
                    finally { Interlocked.Decrement(ref statusRequests); }
                case "GetCompleteCashDevice": return Json(new
                {
                    deviceModel = 2, deviceType = 3, baseDeviceType = 0, firmware = "NVS2004321016000", dataset = "INR02006",
                    deviceState = ReadbackState ?? (State == "DISABLED" ? 4 : State == "IDLE" ? 5 : 6),
                    deviceError = 0, dispenseState = 0, isOpen = true, isStarted = true, noteInEscrow = escrow || ForceEscrow
                });
                case "GetAllLevels": return Json(CashInventory.Denominations.Select(value => new
                {
                    value, countryCode = "INR", storedInPayout = value == 10_000 ? Stored : 0, storedInCashbox = 0,
                    isInhibited = !EnabledValues.Contains(value), isRecyclable = true, acceptRoute = BadRoute ? 0 : 7
                }).ToArray());
                case "GetCounters":
                    ReadbackCompleted?.Invoke();
                    return MissingCounter
                        ? Json(new { stored = Stored, stacked = 0, dispensed = 0 })
                        : Json(new { stored = Stored, stacked = 0, dispensed = 0, transferredToStack = 0 });
                case "EnableAcceptor":
                    if (BeforeEnable is not null) await BeforeEnable();
                    EnableCount++;
                    State = EnableState;
                    if (!SuppressEnableEvent) EnqueueState(State);
                    AfterEnable?.Invoke();
                    return Json(new { });
                case "DisableAcceptor":
                    DisableCount++;
                    if (!IgnoreDisable) { State = "DISABLED"; EnqueueState(State); }
                    return Json(new { });
                case "AcceptFromEscrow":
                    if (BeforeAccept is not null) await BeforeAccept();
                    AcceptCount++;
                    if (AcceptFails) throw new HttpRequestException("synthetic unknown Accept result");
                    return Json(new { });
                case "ReturnFromEscrow": ReturnCount++; return Json(new { });
                case "DisconnectDevice":
                    DisconnectCount++;
                    if (DisconnectFails) throw new HttpRequestException("synthetic unknown disconnect");
                    disconnected = true;
                    return Json(new { });
                default: throw new InvalidOperationException("Unexpected synthetic ITL operation.");
            }
        }
    }

    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(value, ProductCashJson.Options), Encoding.UTF8, "application/json")
    };
}
