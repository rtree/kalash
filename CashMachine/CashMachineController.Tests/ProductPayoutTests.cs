using System.Text.Json;
using System.Net;
using System.Text;
using Kalash.CashMachineController;

namespace Kalash.CashMachineController.Tests;

internal static class ProductPayoutTests
{
    public static async Task RunAsync()
    {
        var count = 0;
        foreach (var mode in new[] { "success", "gate", "baseline", "timeout", "missing_dispensed",
            "missing_completed", "cashbox", "counter", "duplicate", "changed", "dispatch_timeout", "restart",
            "lost_ack", "intake", "escrow", "missing_bezel" })
        {
            using var fixture = await Fixture.Create(mode);
            await fixture.Owner.InitializeAsync(CancellationToken.None);
            await fixture.Owner.TickAsync(CancellationToken.None);
            if (mode is "gate" or "baseline" or "escrow")
            {
                Check(fixture.Device.Dispatches == 0, mode);
                Check(fixture.Owner.State.Payouts.Single().State == "precondition_failed", mode);
            }
            else if (mode == "intake")
            {
                Check(fixture.Device.Dispatches == 0 && fixture.Owner.State.Payouts.Count == 0, mode);
            }
            else if (mode == "lost_ack")
            {
                Check(fixture.Owner.State.Locked && fixture.Device.Dispatches == 0, mode);
                fixture.Central.FailDispatchAck = false;
                await fixture.Owner.TickAsync(CancellationToken.None);
                Check(fixture.Device.Dispatches == 0 && fixture.Central.Reports.Last().State == "unknown", mode);
            }
            else if (mode == "dispatch_timeout")
            {
                Check(fixture.Device.Dispatches == 1 && fixture.Owner.State.Locked, mode);
                await fixture.Owner.TickAsync(CancellationToken.None);
                Check(fixture.Device.Dispatches == 1, mode);
            }
            else if (mode == "restart")
            {
                Check(fixture.Device.Dispatches == 1, mode);
                fixture.Journal.Dispose();
                using var reopened = new ProductCashJournal(fixture.Directory);
                var restarted = fixture.NewOwner(reopened);
                await restarted.InitializeAsync(CancellationToken.None);
                await restarted.TickAsync(CancellationToken.None);
                Check(restarted.State.Locked && fixture.Device.Dispatches == 1, mode);
            }
            else if (mode == "timeout")
            {
                fixture.Clock.Advance(ProductTiming.HumanWindowMs / 2);
                await fixture.Owner.TickAsync(CancellationToken.None);
                Check(!fixture.Owner.State.Locked && fixture.Device.Dispatches == 1
                    && fixture.Owner.State.Payouts.Single().State == "dispatching",
                    "expired start authorization does not stop active payout completion");
                fixture.Clock.Advance(ProductTiming.PayoutCompletionMs - ProductTiming.HumanWindowMs / 2 + 1);
                await fixture.Owner.TickAsync(CancellationToken.None);
                Check(fixture.Owner.State.Locked && fixture.Device.Dispatches == 1, mode);
            }
            else
            {
                fixture.Device.Events.Enqueue(mode == "missing_dispensed"
                    ? [Event("DispenserTransactionEventResponse", "COMPLETED")]
                    : mode == "missing_completed" ? [Event("CashEventResponse", "DISPENSED")]
                    : [Event("CashEventResponse", "DISPENSED"), Event("DispenserTransactionEventResponse", "COMPLETED")]);
                fixture.Device.Inventory = After(mode);
                fixture.Clock.Advance(200);
                await fixture.Owner.TickAsync(CancellationToken.None);
                Check(fixture.Owner.State.Payouts.Single().State != "reported", "same batch cannot complete");
                fixture.Clock.Advance(200);
                await fixture.Owner.TickAsync(CancellationToken.None);
                if (mode is "cashbox" or "counter" or "missing_dispensed")
                    Check(fixture.Owner.State.Locked, mode);
                else if (mode == "missing_completed")
                {
                    fixture.Clock.Advance(ProductTiming.PayoutCompletionMs + 1);
                    await fixture.Owner.TickAsync(CancellationToken.None);
                    Check(fixture.Owner.State.Locked, mode);
                }
                else
                {
                    Check(fixture.Owner.State.Payouts.Single().State == "reported", mode);
                    Check(fixture.Central.Reports.Select(report => report.State).SequenceEqual(
                        ["received", "validated", "dispatching", "observed", "reported"]), mode);
                    var evidence = fixture.Central.Reports.Last().Evidence!;
                    Check(evidence.IdleObservedAt > evidence.CompletedObservedAt, mode);
                    if (mode == "success" && Environment.GetEnvironmentVariable("KALASH_PAYOUT_WIRE_OUTPUT") is { } output)
                    {
                        var partial = new ProductPayoutEndState(evidence.Before, evidence.After, evidence.DeviceId,
                            evidence.StreamId, evidence.IdleRawSequence, evidence.IdleObservedAt, "DISABLED", true,
                            fixture.Central.Command.AmountPaise, "0");
                        var report = new ProductPayoutInventoryReport(evidence.IdleObservedAt, evidence.DeviceId,
                            "DISABLED", true, evidence.Before, evidence.DispatchRawSequence);
                        File.WriteAllText(output, JsonSerializer.Serialize(new
                        { command = fixture.Central.Command, inventory = report, completion = evidence, partial },
                            ProductCashJson.Options));
                    }
                    fixture.Clock.Advance(5_000);
                    if (mode == "changed") fixture.Central.Command = fixture.Central.Command with
                    { ApprovalId = Guid.NewGuid().ToString("D") };
                    await fixture.Owner.TickAsync(CancellationToken.None);
                    Check(fixture.Device.Dispatches == 1, mode);
                    if (mode == "changed") Check(fixture.Owner.State.Locked, mode);
                }
            }
            Console.WriteLine($"PASS synthetic durable payout {mode}");
            count++;
        }
        var command = Command();
        var json = JsonSerializer.Serialize(command, ProductCashJson.Options);
        try
        {
            JsonSerializer.Deserialize<ProductPayoutCommand>(json[..^1] + ",\"extra\":true}", ProductCashJson.Options);
            throw new Exception("Unknown command fields accepted.");
        }
        catch (JsonException) { count++; }
        await WireAsync();
        count++;
        await AdapterAsync();
        await BezelWaitingAsync();
        await PartialReconciliationAsync();
        count += 3;
        Console.WriteLine($"{count} payout tests passed (synthetic; hardware off).");
    }

    private static async Task BezelWaitingAsync()
    {
        foreach (var held in new[] { "NOTE_HELD_IN_BEZEL", "NOTE_IN_BEZEL_HOLD" })
        {
            using var fixture = await Fixture.Create("success");
            await fixture.Owner.InitializeAsync(CancellationToken.None);
            await fixture.Owner.TickAsync(CancellationToken.None);
            fixture.Device.Summary = "DISPENSING";
            fixture.Device.Events.Enqueue([Event("DeviceStatusResponse", "DISPENSING"),
                Event("CashEventResponse", held), Event("DeviceStatusResponse", "DISABLED")]);
            fixture.Clock.Advance(200);
            await fixture.Owner.TickAsync(CancellationToken.None);
            Check(fixture.Owner.State.Payouts.Single().BezelHoldObserved
                && fixture.Owner.State.Payouts.Single().State == "dispatching" && !fixture.Owner.State.Locked,
                "held cash waits despite payout summary/event mismatch");
            fixture.Device.Summary = "DISABLED";
            fixture.Clock.Advance(200);
            await fixture.Owner.TickAsync(CancellationToken.None);
            Check(fixture.Owner.State.Payouts.Single().State == "dispatching", "idle summary never resolves held cash");
            fixture.Device.Events.Enqueue([Event("CashEventResponse", "DISPENSED"),
                Event("DispenserTransactionEventResponse", "COMPLETED"), Event("CashEventResponse", held)]);
            fixture.Device.Inventory = After("success");
            fixture.Clock.Advance(200);
            await fixture.Owner.TickAsync(CancellationToken.None);
            fixture.Clock.Advance(200);
            await fixture.Owner.TickAsync(CancellationToken.None);
            Check(fixture.Owner.State.Payouts.Single().State == "dispatching", "post-completion hold still waits");
            fixture.Device.Events.Enqueue([Event("DeviceStatusResponse", "DISABLED")]);
            fixture.Clock.Advance(200);
            await fixture.Owner.TickAsync(CancellationToken.None);
            Check(fixture.Owner.State.Payouts.Single().State == "reported", "actual later named disabled resolves hold");
            var wire = JsonSerializer.Serialize(fixture.Central.Reports.Last(), ProductCashJson.Options);
            Check(!wire.Contains("bezelEmpty", StringComparison.Ordinal), "completion has no bezel proof field");
        }
    }

    private static async Task AdapterAsync()
    {
        Check(!CashControllerConfiguration.ParseProductPayoutGate(null), "payout default off");
        Check(CashControllerConfiguration.ParseProductPayoutGate("OWNER_ATTENDED_PRODUCT_PAYOUT"), "payout exact gate");
        try
        {
            CashControllerConfiguration.ParseProductPayoutGate("true");
            throw new Exception("Loose payout gate accepted.");
        }
        catch (ControllerConfigurationException) { }
        using var handler = new ItlWireHandler();
        using var client = new ItlControllerClient("synthetic", "synthetic", handler);
        await using var poller = new ItlDeviceStatusPoller(client, "synthetic", Path.Combine(
            "CashMachine", "CashMachineController.Tests", ".fixtures", "unused-payout-raw.jsonl"));
        var off = new ItlProductCashDevice(client, poller, "synthetic");
        try
        {
            await off.DispenseOnceAsync(30_000, CancellationToken.None);
            throw new Exception("Adapter dispatched with gate off.");
        }
        catch (InvalidOperationException) { }
        Check(handler.Dispatches == 0, "off adapter makes no request");
        var on = new ItlProductCashDevice(client, poller, "synthetic", true);
        await on.DispenseOnceAsync(30_000, CancellationToken.None);
        Check(handler.Dispatches == 1 && handler.Payload == "{\"Value\":30000,\"CountryCode\":\"INR\"}",
            "actual product adapter exact ITL payload");
        handler.Fail = true;
        try
        {
            await on.DispenseOnceAsync(30_000, CancellationToken.None);
            throw new Exception("Adapter masked HTTP failure.");
        }
        catch (ItlApiException) { }
        Check(handler.Dispatches == 2, "one failed HTTP dispatch never retries");
        try
        {
            await client.GetConnectedUsbDevicesAsync();
            throw new Exception("503 readback became success.");
        }
        catch (ItlApiException exception)
        {
            Check(exception.Operation == "GetConnectedUSBDevices", "safe 503 GET operation diagnostic");
        }
    }

    private sealed class ItlWireHandler : HttpMessageHandler
    {
        public int Dispatches;
        public string? Payload;
        public bool Fail;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            if (request.RequestUri!.AbsolutePath.EndsWith("Authenticate"))
                return new(HttpStatusCode.OK) { Content = new StringContent("{\"token\":\"synthetic\",\"expires_seconds\":3600}") };
            if (request.RequestUri.AbsolutePath.EndsWith("DispenseValue"))
            {
                Check(request.Method == HttpMethod.Post && request.RequestUri.Query == "?deviceID=synthetic",
                    "ITL product route");
                Dispatches++;
                Payload = await request.Content!.ReadAsStringAsync(token);
            }
            return new(Fail ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
                { Content = new StringContent("{}") };
        }
    }

    private static async Task PartialReconciliationAsync()
    {
        using var fixture = await Fixture.Create("partial");
        var before = Before() with { Levels = Before().Levels.Select(level =>
            level with { Payout = level.ValuePaise == "10000" ? 2 : 0 }).ToArray() };
        fixture.Device.Inventory = before;
        fixture.Central.Command = fixture.Central.Command with { Baseline = before, AmountPaise = "20000" };
        await fixture.Owner.InitializeAsync(CancellationToken.None);
        await fixture.Owner.TickAsync(CancellationToken.None);
        fixture.Device.Inventory = Before() with { Counters = new(5, 2, 4, 0) };
        fixture.Clock.Advance(ProductTiming.PayoutCompletionMs + 1);
        await fixture.Owner.TickAsync(CancellationToken.None);
        await fixture.Owner.TickAsync(CancellationToken.None);
        var payout = fixture.Owner.State.Payouts.Single();
        Check(payout.State == "unknown" && fixture.Owner.State.Locked && payout.EndState?.RemainingPaise == "10000"
            && payout.EndState.DispensedPaise == "10000", "partial outcome stays unknown with actual remainder");
        Check(fixture.Owner.State.Outbox.Count == 0, "payout unknown never creates donation events");
        var authorization = new ProductPayoutReconciliationAuthorization(payout.Command.CommandId, payout.Command.PayoutId,
            Guid.NewGuid().ToString("D"), before, fixture.Device.Inventory,
            fixture.Clock.GetUtcNow().ToUnixTimeMilliseconds(), fixture.Clock.GetUtcNow().ToUnixTimeMilliseconds() + 120_000);
        fixture.Central.Reconciliation = authorization with { Current = before };
        try
        {
            await fixture.Owner.ReconcilePayoutAsync(fixture.Central.Reconciliation, CancellationToken.None);
            throw new Exception("Wrong partial inventory authorized recovery.");
        }
        catch (InvalidOperationException) { }
        fixture.Central.Reconciliation = authorization;
        await fixture.Owner.ReconcilePayoutAsync(authorization, CancellationToken.None);
        Check(payout.Reconciled && !fixture.Owner.State.Locked && fixture.Device.Dispatches == 1,
            "explicit operator reconciliation never resends");
        fixture.Central.Reconciliation = null;
        fixture.Clock.Advance(5_000);
        await fixture.Owner.TickAsync(CancellationToken.None);
        Check(fixture.Device.Dispatches == 1, "old command still not replayed after operator unlock");
        fixture.Central.Command = Command() with { Baseline = fixture.Device.Inventory,
            CreatedAt = fixture.Clock.GetUtcNow().ToUnixTimeMilliseconds(),
            ExpiresAt = fixture.Clock.GetUtcNow().ToUnixTimeMilliseconds() + ProductTiming.HumanWindowMs };
        fixture.Clock.Advance(5_000);
        await fixture.Owner.TickAsync(CancellationToken.None);
        Check(fixture.Device.Dispatches == 2 && fixture.Owner.State.Payouts.Count == 2,
            "new approval dispenses only settled remainder");
    }

    private static async Task WireAsync()
    {
        using var handler = new WireHandler();
        using var client = new CentralCashCommandClient(new Uri("https://synthetic.invalid"), "atm-01",
            new string('a', 64), handler);
        var command = await client.GetPayoutCommandAsync(CancellationToken.None);
        Check(command?.AmountPaise == "10000", "wire command");
        await client.ReportPayoutAsync(new(command!.CommandId, "received"), CancellationToken.None);
        await client.ReportPayoutInventoryAsync(new(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), "synthetic",
            "DISABLED", true, Before(), 1), CancellationToken.None);
        handler.BadAck = true;
        try
        {
            await client.ReportPayoutAsync(new(command.CommandId, "dispatching"), CancellationToken.None);
            throw new Exception("HTTP success retired a mismatched payout receipt.");
        }
        catch (InvalidDataException) { }
        Check(handler.Paths.SequenceEqual(["/api/controller/atm-01/payout-command",
            "/api/controller/atm-01/payout-command-reports", "/api/controller/atm-01/payout-inventory",
            "/api/controller/atm-01/payout-command-reports"]), "wire paths");
    }

    private sealed class WireHandler : HttpMessageHandler
    {
        public bool BadAck;
        public List<string> Paths = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
        {
            Paths.Add(request.RequestUri!.AbsolutePath);
            object body;
            if (request.Method == HttpMethod.Get)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                body = new { command = Command() with { CreatedAt = now, ExpiresAt = now + 120_000 } };
            }
            else if (request.RequestUri.AbsolutePath.EndsWith("payout-inventory"))
                body = new { accepted = true };
            else
            {
                var report = JsonSerializer.Deserialize<ProductPayoutReport>(
                    await request.Content!.ReadAsStringAsync(token), ProductCashJson.Options)!;
                body = new { accepted = true, commandId = BadAck ? "wrong" : report.CommandId, state = report.State };
            }
            return new(HttpStatusCode.OK) { Content = new StringContent(
                JsonSerializer.Serialize(body, ProductCashJson.Options), Encoding.UTF8, "application/json") };
        }
    }

    private static void Check(bool condition, string mode)
    {
        if (!condition) throw new Exception($"Payout assertion failed: {mode}");
    }
    private static JsonElement Event(string type, string name) => JsonSerializer.SerializeToElement(
        type == "CashEventResponse" ? (object)new { type, eventTypeAsString = name, value = 10_000, countryCode = "INR" }
            : new { type, stateAsString = name });
    private static CashInventory Before() => new(CashInventory.Denominations.Select(value =>
        new CashInventoryLevel(value.ToString(), value == 10_000 ? 1 : 0, value == 1_000 ? 2 : 0)).ToArray(),
        new(5, 2, 3, 0));
    private static CashInventory After(string mode) => new(Before().Levels.Select(level =>
        level with { Payout = 0, Cashbox = level.Cashbox + (mode == "cashbox" ? 1 : 0) }).ToArray(),
        new(5, 2, mode == "counter" ? 3 : 4, 0));
    private static ProductPayoutCommand Command() => new("payout-" + Guid.NewGuid().ToString("D"), "payout_cash",
        Guid.NewGuid().ToString("D"), "atm-01", "temple-01", 1_800_000_000_000,
        1_800_000_120_000, "10000", Before(), Guid.NewGuid().ToString("D"));

    private sealed class Clock : TimeProvider
    {
        private long now = 1_800_000_001_000;
        public void Advance(long value) => now += value;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.FromUnixTimeMilliseconds(now);
    }
    private sealed class Device(Clock clock, string mode) : IProductPayoutDevice
    {
        public int Dispatches;
        public long Sequence;
        public string Summary = "DISABLED";
        public CashInventory Inventory = Before();
        public Queue<JsonElement[]> Events = [];
        public Task<IReadOnlyList<CashRawSnapshot>> RecoverAsync(CancellationToken token) =>
            Task.FromResult<IReadOnlyList<CashRawSnapshot>>(Sequence == 0 ? [] :
                [new(Sequence, new("DISABLED", [], clock.GetUtcNow().ToUnixTimeMilliseconds()))]);
        public Task<CashRawSnapshot> PollAsync(CancellationToken token) => Task.FromResult(new CashRawSnapshot(++Sequence,
            new(Summary, Events.Count > 0 ? Events.Dequeue() : [], clock.GetUtcNow().ToUnixTimeMilliseconds())));
        public Task<ProductDeviceReadback> ReadAsync(CancellationToken token) => Task.FromResult(
            new ProductDeviceReadback(mode == "baseline" ? After("success") : Inventory,
                CashInventory.Denominations, mode != "escrow", true, 4));
        public async Task<ProductDeviceHealth> ReadHealthAsync(CancellationToken token) => new(true, true, true, await ReadAsync(token));
        public Task DispenseOnceAsync(long amountPaise, CancellationToken token)
        {
            Check(amountPaise == ProductPayoutInventory.Value(Inventory), "full recycler only, cashbox excluded");
            Dispatches++;
            return mode == "dispatch_timeout" ? Task.FromException(new TimeoutException()) : Task.CompletedTask;
        }
        public Task EnableAsync(CancellationToken token) => throw new Exception("Payout enabled intake.");
        public Task DisableAsync(CancellationToken token) => throw new Exception("Already disabled payout sent disable.");
        public Task AcceptAsync(CancellationToken token) => throw new Exception("Payout accepted cash.");
        public Task ReturnAsync(CancellationToken token) => throw new Exception("Payout returned escrow.");
    }
    private sealed class Central : ICashCommandCentral, ICashEventCentral, IControllerHealthCentral, IProductPayoutCentral,
        IProductPayoutReconciliationCentral
    {
        public ProductPayoutCommand Command = ProductPayoutTests.Command();
        public List<ProductPayoutReport> Reports = [];
        public bool FailDispatchAck;
        public CentralCashSession? Session;
        public ProductPayoutReconciliationAuthorization? Reconciliation;
        public Task<ProductPayoutReconciliationAuthorization?> GetPayoutReconciliationAsync(CancellationToken token) =>
            Task.FromResult(Reconciliation);
        public Task<CashStartCommand?> GetCommandAsync(CancellationToken token) => Task.FromResult<CashStartCommand?>(null);
        public Task ReportAsync(string commandId, string state, string? reason, CashCommandObservation? observation,
            CancellationToken token) => throw new Exception("Payout attempted cash command.");
        public Task<CentralCashSession?> GetCashSessionAsync(CancellationToken token) => Task.FromResult(Session);
        public Task<CashEventAck> PostCashEventAsync(CashEventEnvelope value, CancellationToken token) =>
            throw new Exception("Payout attempted donation event.");
        public Task ReportHealthAsync(ControllerHealthReport report, CancellationToken token) => Task.CompletedTask;
        public Task<ProductPayoutCommand?> GetPayoutCommandAsync(CancellationToken token) => Task.FromResult<ProductPayoutCommand?>(Command);
        public Task ReportPayoutAsync(ProductPayoutReport report, CancellationToken token)
        {
            if (FailDispatchAck && report.State == "dispatching") return Task.FromException(new TimeoutException());
            Reports.Add(report); return Task.CompletedTask;
        }
        public Task ReportPayoutInventoryAsync(ProductPayoutInventoryReport report, CancellationToken token) => Task.CompletedTask;
    }
    private sealed class Fixture : IDisposable
    {
        public string Directory = Path.GetFullPath(Path.Combine("CashMachine", "CashMachineController.Tests", ".fixtures",
            "payout-" + Guid.NewGuid().ToString("N")));
        public Clock Clock = new();
        public Device Device;
        public Central Central = new();
        public ProductCashJournal Journal;
        public ProductCashExecutionOwner Owner = null!;
        private readonly string mode;
        public Fixture(string mode)
        {
            this.mode = mode;
            Journal = new(Directory);
            Device = new(Clock, mode);
        }
        public ProductCashExecutionOwner NewOwner(ProductCashJournal journal) => new("atm-01", Central, Central,
            Device, journal, new(Path.Combine(Directory, "commands")), true, Clock, mode != "gate");
        public static async Task<Fixture> Create(string mode)
        {
            var fixture = new Fixture(mode);
            fixture.Central.FailDispatchAck = mode == "lost_ack";
            if (mode == "intake") fixture.Central.Session = new("visit", Guid.NewGuid().ToString("D"),
                "accepting", 1_800_000_120_000, false, null);
            await fixture.Journal.SaveAsync(new ProductCashState
            { StreamId = Guid.NewGuid().ToString("D"), DeviceId = "synthetic", ManualEscrowConfigured = true }, CancellationToken.None);
            fixture.Owner = fixture.NewOwner(fixture.Journal);
            return fixture;
        }
        public void Dispose()
        {
            Journal.Dispose();
            System.IO.Directory.Delete(Directory, true);
        }
    }
}
