using System.Net;
using System.Text;
using System.Text.Json;
using Kalash.CashMachineController;

namespace Kalash.CashMachineController.Tests;

internal static class ProductCashTests
{
    private static readonly CancellationToken None = CancellationToken.None;
    private static int passed;

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

    public static async Task RunAsync()
    {
        passed = 0;
        await Run("same denomination has distinct note keys and session cap", SameDenomination);
        await Run("in-flight note prevents a second physical decision", InFlight);
        await Run("INR value, session, demo value and demo note caps", Limits);
        await Run("STORED requires pending dispatched identity and payout", StoredIdentity);
        await Run("fault latches and late STORED never resurrects credit", NoResurrection);
        await Run("close reconciles all counters and denomination levels", CloseMismatch);
        await Run("inventory wire fields and mandatory counters", InventoryContract);
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
        return new($"cash-start-{Guid.NewGuid():D}", "start_cash", "pending", "atm-test",
            new string('b', 64), "temple-01", Guid.NewGuid().ToString("D"), now + 120_000, now);
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
        await fixture.Start();
        fixture.Itl.BeforeAccept = async () =>
        {
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
            Fields(report, observed ? ["commandId", "state", "observedAt", "deviceState"] : ["commandId", "state"]);
            if (observed) Check(report.GetProperty("deviceState").GetString() == "ACCEPTING"
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
        await fixture.Tick();
        Check(fixture.Itl.DisableCount == 1 && fixture.Owner.State.Intake!.Notes.Single().Stored, "Offline abandoned device events.");
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
        fixture.Owner.State.Intake!.ClosingAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 11_000;
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

    private sealed class FixtureDirectory : IDisposable
    {
        private readonly string root = Path.GetFullPath(Path.Combine("CashMachine", "CashMachineController.Tests",
            ".fixtures", Guid.NewGuid().ToString("N")));
        public FixtureDirectory() => Directory.CreateDirectory(root);
        public string File(string name) => Path.Combine(root, name);
        public void Dispose() => Directory.Delete(root, true);
    }

    private sealed class OwnerFixture : IAsyncDisposable
    {
        public readonly FixtureDirectory Files = new();
        public readonly SyntheticItl Itl = new();
        public readonly SyntheticCentral Central = new(Command());
        public ProductCashJournal Journal = null!;
        public ProductCashExecutionOwner Owner = null!;
        private ItlControllerClient client = null!;
        private CentralCashCommandClient centralClient = null!;
        private ItlDeviceStatusPoller poller = null!;
        private readonly FixtureClock clock = new();

        public static async Task<OwnerFixture> Create()
        {
            var fixture = new OwnerFixture();
            fixture.client = new("synthetic-user", "synthetic-password", fixture.Itl);
            fixture.centralClient = fixture.Central.Client();
            fixture.Journal = new(fixture.Files.File("product"));
            await ProductCashHost.OpenDisabledAsync(true, fixture.client, fixture.Journal,
                "COM4", fixture.Files.File("ssp-logs"), None);
            await fixture.MakeOwner();
            return fixture;
        }

        private async Task MakeOwner()
        {
            poller = new(client, "synthetic-device", Files.File("raw.jsonl"));
            Owner = new("atm-test", centralClient, centralClient, new ItlProductCashDevice(client, poller, "synthetic-device"),
                Journal, new(Files.File("commands")), true, clock);
            await Owner.InitializeAsync(None);
        }

        public async Task Restart()
        {
            await poller.DisposeAsync();
            Journal.Dispose();
            Journal = new(Files.File("product"));
            await MakeOwner();
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

        public async ValueTask DisposeAsync()
        {
            await poller.DisposeAsync();
            client.Dispose(); centralClient.Dispose(); Journal.Dispose(); Files.Dispose();
        }

        private sealed class FixtureClock : TimeProvider
        {
            private DateTimeOffset now = DateTimeOffset.UtcNow;
            public void Advance() => now = now.AddMilliseconds(1_100);
            public override DateTimeOffset GetUtcNow() => now;
        }
    }

    private sealed class SyntheticCentral(CashStartCommand command) : HttpMessageHandler
    {
        public bool Done, Offline, BadAck, LoseReceiptOnce, WrongBinding;
        public List<string> Events { get; } = [];
        public List<string> Attempts { get; } = [];
        public List<string> Types { get; } = [];
        public List<string> RequestPaths { get; } = [];
        public List<JsonElement> CommandReportBodies { get; } = [];
        public List<JsonElement> CashSessionBodies { get; } = [];
        private bool observed;
        private readonly Dictionary<long, string> durable = [];
        public CentralCashCommandClient Client() => new(new Uri("https://central.example"), "atm-test", new string('a', 64), this);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (Offline) throw new HttpRequestException("synthetic offline");
            var path = request.RequestUri!.AbsolutePath;
            RequestPaths.Add($"{request.Method} {path}");
            Check(request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter == new string('a', 64),
                "Controller credential was not transported as Bearer.");
            if (path == "/api/controller/atm-test/cash-session")
            {
                Check(request.Method == HttpMethod.Get, "Cash-session method differs.");
                var body = JsonSerializer.SerializeToElement(new CentralCashSessionResponse(new(command.VisitId, WrongBinding ? Guid.NewGuid().ToString() : command.CashSessionId,
                    Done ? "closing" : observed ? "accepting" : "awaiting_device",
                    observed ? command.CreatedAt + 120_000 : null, Done, Done ? "done" : null)), ProductCashJson.Options);
                Fields(body, ["session"]);
                Fields(body.GetProperty("session"), ["visitId", "cashSessionId", "state", "deadline", "closeRequested", "closeReason"]);
                CashSessionBodies.Add(body);
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
                if (body.RootElement.GetProperty("state").GetString() == "observed") observed = true;
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
            return Json(new CashEventAck(true, value.StreamId, value.Sequence + (BadAck ? 1 : 0)));
        }
    }

    private sealed class SyntheticItl : HttpMessageHandler
    {
        public int EnableCount, AcceptCount, ReturnCount, DisableCount, Stored, MaximumConcurrentStatus;
        public bool AcceptFails, IgnoreDisable, BadRoute, MissingCounter;
        public Func<Task>? BeforeAccept;
        private string state = "DISABLED";
        private bool escrow;
        private int statusRequests;
        private readonly Queue<object> events = new();

        public void Enqueue(string name)
        {
            events.Enqueue(new { type = "CashEventResponse", eventTypeAsString = name, value = 10_000, countryCode = "INR" });
            escrow = name == "ESCROW";
        }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            var path = request.RequestUri!.AbsolutePath;
            var operation = path[(path.LastIndexOf('/') + 1)..];
            switch (operation)
            {
                case "Authenticate": return Json(new { token = "synthetic-itl-token", expires_seconds = 3600 });
                case "OpenConnection":
                    using (var body = JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token)))
                    {
                        Check(!body.RootElement.GetProperty("EnableAcceptor").GetBoolean()
                            && !body.RootElement.GetProperty("EnableAutoAcceptEscrow").GetBoolean(), "Bootstrap enabled acceptance.");
                    }
                    for (var index = 0; index < 6; index++)
                        events.Enqueue(new { type = "SetDenominationRouteFinishedEventResponse", result = true });
                    return Json(new { deviceID = "synthetic-device" });
                case "GetDeviceStatus":
                    MaximumConcurrentStatus = Math.Max(MaximumConcurrentStatus, Interlocked.Increment(ref statusRequests));
                    try
                    {
                        await Task.Yield();
                        var batch = events.ToArray(); events.Clear();
                        return Json(new { deviceState = state, pollBuffer = batch });
                    }
                    finally { Interlocked.Decrement(ref statusRequests); }
                case "GetCompleteCashDevice": return Json(new
                {
                    deviceModel = 2, deviceType = 3, baseDeviceType = 0, firmware = "NVS2004321016000", dataset = "INR02006",
                    deviceState = 0, deviceError = 0, dispenseState = 0, isOpen = true, isStarted = true, noteInEscrow = escrow
                });
                case "GetAllLevels": return Json(CashInventory.Denominations.Select(value => new
                {
                    value, countryCode = "INR", storedInPayout = value == 10_000 ? Stored : 0, storedInCashbox = 0,
                    isInhibited = false, isRecyclable = true, acceptRoute = BadRoute ? 0 : 7
                }).ToArray());
                case "GetCounters": return MissingCounter
                    ? Json(new { stored = Stored, stacked = 0, dispensed = 0 })
                    : Json(new { stored = Stored, stacked = 0, dispensed = 0, transferredToStack = 0 });
                case "EnableAcceptor": EnableCount++; state = "ACCEPTING"; return Json(new { });
                case "DisableAcceptor": DisableCount++; if (!IgnoreDisable) state = "DISABLED"; return Json(new { });
                case "AcceptFromEscrow":
                    if (BeforeAccept is not null) await BeforeAccept();
                    AcceptCount++;
                    if (AcceptFails) throw new HttpRequestException("synthetic unknown Accept result");
                    return Json(new { });
                case "ReturnFromEscrow": ReturnCount++; return Json(new { });
                default: throw new InvalidOperationException("Unexpected synthetic ITL operation.");
            }
        }
    }

    private static HttpResponseMessage Json(object value) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(JsonSerializer.Serialize(value, ProductCashJson.Options), Encoding.UTF8, "application/json")
    };
}
