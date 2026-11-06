using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kalash.CashMachineController;

public sealed record ProductPayoutCommand(string CommandId, string Type, string PayoutId, string AtmId,
    string TempleId, long CreatedAt, long ExpiresAt, string AmountPaise, CashInventory Baseline, string ApprovalId)
{
    public void Validate(string atmId, long now)
    {
        if (!CommandId.StartsWith("payout-", StringComparison.Ordinal)
            || !Guid.TryParseExact(CommandId[7..], "D", out _)
            || !Guid.TryParseExact(PayoutId, "D", out _) || !Guid.TryParseExact(ApprovalId, "D", out _)
            || Type != "payout_cash" || AtmId != atmId
            || !System.Text.RegularExpressions.Regex.IsMatch(TempleId, "^temple-[0-9]{2}$")
            || CreatedAt <= 0 || CreatedAt > now + ProductTiming.ClockSkewMs || ExpiresAt <= now
            || ExpiresAt <= CreatedAt || ExpiresAt - CreatedAt > ProductTiming.HumanWindowMs)
            throw new InvalidDataException("Invalid payout authorization.");
        Baseline.Validate();
        // Central binds the administrator approval to actual Payout inventory, not the cash ledger or Cashbox.
        if (CashInventory.ParseValue(AmountPaise) != ProductPayoutInventory.Value(Baseline))
            throw new InvalidDataException("Payout must equal the full approved recycler value.");
    }

    public string Fingerprint() => JsonSerializer.Serialize(this, ProductCashJson.Options);
}

public sealed record ProductPayoutInventoryReport(long ObservedAt, string DeviceId, string DeviceState,
    bool EscrowEmpty, CashInventory Inventory, long RawSequence);
public sealed record ProductPayoutEvidence(CashInventory Before, CashInventory After, string DeviceId,
    string StreamId, long DispatchRawSequence, long DispensedRawSequence, long DispensedObservedAt,
    long CompletedRawSequence, long CompletedObservedAt, long IdleRawSequence, long IdleObservedAt,
    string DeviceState, bool EscrowEmpty);
public sealed record ProductPayoutReport(string CommandId, string State,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ObservedAt = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Reason = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProductPayoutEvidence? Evidence = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ProductPayoutEndState? EndState = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ReconciliationApprovalId = null);
public sealed record ProductPayoutEndState(CashInventory Before, CashInventory After, string DeviceId, string StreamId,
    long RawSequence, long ObservedAt, string DeviceState, bool EscrowEmpty,
    string DispensedPaise, string RemainingPaise);
public sealed record ProductPayoutReconciliationAuthorization(string CommandId, string PayoutId, string ApprovalId,
    CashInventory Baseline, CashInventory Current, long CreatedAt, long ExpiresAt);
public interface IProductPayoutReconciliationCentral
{
    Task<ProductPayoutReconciliationAuthorization?> GetPayoutReconciliationAsync(CancellationToken token);
}
public sealed record ProductPayoutCommandResponse(ProductPayoutCommand? Command);
public sealed record ProductPayoutAck(bool Accepted, string CommandId, string State);
public sealed record ProductPayoutInventoryAck(bool Accepted);

public interface IProductPayoutCentral
{
    Task<ProductPayoutCommand?> GetPayoutCommandAsync(CancellationToken token);
    Task ReportPayoutAsync(ProductPayoutReport report, CancellationToken token);
    Task ReportPayoutInventoryAsync(ProductPayoutInventoryReport report, CancellationToken token);
}

// Implementations must dispatch once only; no retry after an ambiguous response.
public interface IProductPayoutDevice : IProductCashDevice
{
    Task DispenseOnceAsync(long amountPaise, CancellationToken token);
}

public sealed partial class CentralCashCommandClient : IProductPayoutCentral, IProductPayoutReconciliationCentral
{
    public async Task<ProductPayoutReconciliationAuthorization?> GetPayoutReconciliationAsync(CancellationToken token)
    {
        using var response = await client.GetAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/payout-reconciliation-command", token);
        EnsureSuccess(response);
        var result = await response.Content.ReadFromJsonAsync<ProductPayoutReconciliationResponse>(ProductCashJson.Options, token)
            ?? throw new InvalidDataException("Payout reconciliation response missing.");
        return result.Command;
    }

    public async Task<ProductPayoutCommand?> GetPayoutCommandAsync(CancellationToken token)
    {
        using var response = await client.GetAsync($"/api/controller/{Uri.EscapeDataString(atmId)}/payout-command", token);
        EnsureSuccess(response);
        var result = await response.Content.ReadFromJsonAsync<ProductPayoutCommandResponse>(ProductCashJson.Options, token)
            ?? throw new InvalidDataException("Payout command response missing.");
        result.Command?.Validate(atmId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        return result.Command;
    }
    public sealed record ProductPayoutReconciliationResponse(ProductPayoutReconciliationAuthorization? Command);

    public async Task ReportPayoutAsync(ProductPayoutReport report, CancellationToken token)
    {
        using var response = await client.PostAsJsonAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/payout-command-reports", report, ProductCashJson.Options, token);
        EnsureSuccess(response);
        var ack = await response.Content.ReadFromJsonAsync<ProductPayoutAck>(ProductCashJson.Options, token);
        if (ack is null || !ack.Accepted || ack.CommandId != report.CommandId || ack.State != report.State)
            throw new InvalidDataException("Exact payout report acknowledgement missing.");
    }

    public async Task ReportPayoutInventoryAsync(ProductPayoutInventoryReport report, CancellationToken token)
    {
        using var response = await client.PostAsJsonAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/payout-inventory", report, ProductCashJson.Options, token);
        EnsureSuccess(response);
        var ack = await response.Content.ReadFromJsonAsync<ProductPayoutInventoryAck>(ProductCashJson.Options, token);
        if (ack is null || !ack.Accepted) throw new InvalidDataException("Payout inventory acknowledgement missing.");
    }
}

public static class ProductPayoutInventory
{
    public static long Value(CashInventory inventory) =>
        inventory.Levels.Sum(level => checked(CashInventory.ParseValue(level.ValuePaise) * level.Payout));
    public static long Notes(CashInventory inventory) => inventory.Levels.Sum(level => level.Payout);
    public static bool Same(CashInventory left, CashInventory right) => left.Counters == right.Counters
        && left.Levels.OrderBy(level => level.ValuePaise).SequenceEqual(right.Levels.OrderBy(level => level.ValuePaise));

    public static bool Completed(CashInventory before, CashInventory after)
    {
        before.Validate();
        after.Validate();
        return after.Levels.All(level => level.Payout == 0
                && level.Cashbox == before.Levels.Single(old => old.ValuePaise == level.ValuePaise).Cashbox)
            && after.Counters.Stored == before.Counters.Stored && after.Counters.Stacked == before.Counters.Stacked
            && after.Counters.TransferredToStack == before.Counters.TransferredToStack
            && after.Counters.Dispensed - before.Counters.Dispensed == Notes(before);
    }

    public static bool PartialEnd(CashInventory before, CashInventory after)
    {
        before.Validate();
        after.Validate();
        return after.Levels.All(level =>
        {
            var old = before.Levels.Single(row => row.ValuePaise == level.ValuePaise);
            return level.Payout <= old.Payout && level.Cashbox == old.Cashbox;
        })
            && after.Counters.Stored == before.Counters.Stored && after.Counters.Stacked == before.Counters.Stacked
            && after.Counters.TransferredToStack == before.Counters.TransferredToStack
            && after.Counters.Dispensed - before.Counters.Dispensed == Notes(before) - Notes(after);
    }
}
