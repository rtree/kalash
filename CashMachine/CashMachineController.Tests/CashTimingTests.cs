using System.Text.Json;
using Kalash.CashMachineController;

namespace Kalash.CashMachineController.Tests;

internal static class CashTimingTests
{
    private const long CreatedAt = 1_000_000;

    public static Task RunAsync()
    {
        CommandTtlBoundaries();
        ClockSkewBoundaries();
        ObservationFreshnessBoundaries();
        ReadinessTimestampOrdering();
        HumanWindowAndLocalCloseDetail();
        TimingConstants();
        Console.WriteLine("6 cash timing boundary tests passed.");
        return Task.CompletedTask;
    }

    private static void CommandTtlBoundaries()
    {
        var command = Command();
        command.Validate("atm-test", CreatedAt);
        ExpectInvalid(() => (command with { ExpiresAt = CreatedAt + ProductTiming.HumanWindowMs + 1 })
            .Validate("atm-test", CreatedAt));

        (command with { CreatedAt = CreatedAt + ProductTiming.ClockSkewMs,
            ExpiresAt = CreatedAt + ProductTiming.ClockSkewMs + ProductTiming.HumanWindowMs })
            .Validate("atm-test", CreatedAt);
        ExpectInvalid(() => (command with { CreatedAt = CreatedAt + ProductTiming.ClockSkewMs + 1 })
            .Validate("atm-test", CreatedAt));
    }

    private static void ClockSkewBoundaries()
    {
        var command = Command();
        var disabled = CreatedAt - ProductTiming.ClockSkewMs;
        Readiness(command, disabled, CreatedAt, CreatedAt + 1, CreatedAt + 2)
            .Validate(command, "device", CreatedAt + 2);
        ExpectInvalid(() => Readiness(command, disabled - 1, CreatedAt, CreatedAt + 1,
            CreatedAt + 2).Validate(command, "device", CreatedAt + 2));

        var futureIdle = CreatedAt + ProductTiming.ClockSkewMs;
        Readiness(command, CreatedAt, CreatedAt + 1, CreatedAt + 2, futureIdle)
            .Validate(command, "device", CreatedAt);
        ExpectInvalid(() => Readiness(command, CreatedAt, CreatedAt + 1, CreatedAt + 2,
            futureIdle + 1).Validate(command, "device", CreatedAt));
    }

    private static void ObservationFreshnessBoundaries()
    {
        var command = Command();
        var idleAt = CreatedAt + 20_000;
        var now = idleAt + ProductTiming.StatusFreshnessMs;
        Readiness(command, CreatedAt, CreatedAt + 1, CreatedAt + 2, idleAt)
            .Validate(command, "device", now);
        ExpectInvalid(() => Readiness(command, CreatedAt, CreatedAt + 1, CreatedAt + 2,
            idleAt).Validate(command, "device", now + 1));
    }

    private static void ReadinessTimestampOrdering()
    {
        var command = Command();
        var valid = Readiness(command, CreatedAt, CreatedAt + 1, CreatedAt + 2, CreatedAt + 4);
        ExpectInvalid(() => (valid with { EnableAcknowledgedAt = valid.IdleObservedAt + 1 })
            .Validate(command, "device", CreatedAt + 4));
        ExpectInvalid(() => (valid with { RawSequence = valid.DisabledRawSequence })
            .Validate(command, "device", CreatedAt + 4));
    }

    private static void HumanWindowAndLocalCloseDetail()
    {
        var inventory = Inventory();
        var state = new ProductCashState { StreamId = "10000000-0000-4000-8000-000000000001" };
        state.Begin(Command(), inventory, [10_000]);
        state.Ready(CreatedAt + 10);
        var intake = state.Intake!;
        Check(intake.Deadline == CreatedAt + 10 + ProductTiming.HumanWindowMs,
            "Reception deadline does not use the 240-second human window.");

        state.Close("offline", CreatedAt + 11, "temporary_transport");
        state.Close("capacity", CreatedAt + 12, "capacity_reached");
        state.Close("done", CreatedAt + 13, "owner_done");
        state.Close("deadline", CreatedAt + 14, "permission_expired");
        state.Close("fault", CreatedAt + 15, "late_fault");
        Check(intake.CloseReason == "deadline" && intake.CloseDetail == "permission_expired",
            "Close reason priority or local detail persistence changed.");
        intake.DisabledObserved = true;
        state.Finish(inventory, true, CreatedAt + 16);
        using var wire = JsonDocument.Parse(state.Outbox.Single(item => item.Type == "intake_closed").Data.GetRawText());
        Check(!wire.RootElement.TryGetProperty("closeDetail", out _),
            "Local close detail leaked into the existing cash wire contract.");
    }

    private static void TimingConstants()
    {
        Check(ProductTiming.StatusFreshnessMs == 30_000
            && ProductTiming.ClockSkewMs == 30_000
            && ProductTiming.HumanWindowMs == 240_000
            && ProductTiming.DeviceTransitionMs == 20_000
            && ProductTiming.InitializationMs == 30_000
            && ProductTiming.HttpTimeoutMs == 10_000
            && ProductTiming.PollHttpTimeoutMs == 4_000
            && ProductTiming.EscrowDecisionMs == 2_000
            && ProductTiming.PayoutCompletionMs == 180_000,
            "Shared product timing constants differ from the approved values.");
    }

    private static ProductCashReadinessEvidence Readiness(CashStartCommand command,
        long disabled, long dispatched, long acknowledged, long idle) =>
        new("itl-idle-after-enable-v1", command.CommandId, command.CashSessionId, "device",
            disabled, 1, dispatched, acknowledged, idle, 2, 5, true, true, true, true,
            Inventory(), Inventory());

    private static CashStartCommand Command() => new(
        "cash-start-20000000-0000-4000-8000-000000000001", "start_cash", "pending", "atm-test",
        new string('a', 64), "temple-01", "20000000-0000-4000-8000-000000000001",
        CreatedAt + ProductTiming.HumanWindowMs, CreatedAt);

    private static CashInventory Inventory() => new(
        CashInventory.Denominations.Select(value => new CashInventoryLevel(value.ToString(), 0, 0)).ToArray(),
        new CashInventoryCounters(0, 0, 0, 0));

    private static void ExpectInvalid(Action action)
    {
        try { action(); }
        catch (InvalidDataException) { return; }
        throw new InvalidOperationException("Expected timing boundary rejection.");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
