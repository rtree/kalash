using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kalash.CashMachineController;

public static class ProductCashJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        RespectRequiredConstructorParameters = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
}

public sealed record CashInventoryLevel(string ValuePaise, long Payout, long Cashbox);
public sealed record CashInventoryCounters(long Stored, long Stacked, long Dispensed, long TransferredToStack);
public sealed record CashInventory(CashInventoryLevel[] Levels, CashInventoryCounters Counters)
{
    public static readonly long[] Denominations = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000];

    public void Validate()
    {
        if (Levels is null || Counters is null || Levels.Length != 6
            || Levels.Any(level => level is null || level.Payout < 0 || level.Cashbox < 0)
            || !Levels.Select(level => ParseValue(level.ValuePaise)).Order().SequenceEqual(Denominations)
            || Counters.Stored < 0 || Counters.Stacked < 0 || Counters.Dispensed < 0
            || Counters.TransferredToStack < 0)
            throw new InvalidDataException("Cash inventory requires all six unique INR levels and four nonnegative counters.");
    }

    [JsonIgnore] public long Notes => Levels.Sum(level => checked(level.Payout + level.Cashbox));
    [JsonIgnore] public long Paise => Levels.Sum(level => checked(ParseValue(level.ValuePaise) * checked(level.Payout + level.Cashbox)));

    public static long ParseValue(string value) =>
        long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var result)
        && result > 0 && result.ToString(CultureInfo.InvariantCulture) == value
            ? result : throw new InvalidDataException("Cash values must be canonical positive paise strings.");
}

public sealed record CashEventEnvelope(
    string StreamId, long Sequence, string DeviceEventId, long OccurredAt,
    string VisitId, string CashSessionId, string Type, JsonElement Data);
public sealed record CashEventAck(bool Accepted, string StreamId, long Sequence);
public sealed record CentralCashSession(
    string VisitId, string CashSessionId, string State, long? Deadline,
    bool CloseRequested, string? CloseReason);
public sealed record CentralCashSessionResponse(CentralCashSession? Session);

public interface ICashEventCentral
{
    Task<CentralCashSession?> GetCashSessionAsync(CancellationToken cancellationToken);
    Task<CashEventAck> PostCashEventAsync(CashEventEnvelope value, CancellationToken cancellationToken);
}

public sealed partial class CentralCashCommandClient
{
    public async Task<CentralCashSession?> GetCashSessionAsync(CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/cash-session", cancellationToken);
        EnsureSuccess(response);
        var result = await response.Content.ReadFromJsonAsync<CentralCashSessionResponse>(
            ProductCashJson.Options, cancellationToken)
            ?? throw new InvalidDataException("Central cash-session response is missing.");
        if (result.Session is { } session
            && (string.IsNullOrWhiteSpace(session.VisitId)
                || !Guid.TryParseExact(session.CashSessionId, "D", out _)
                || session.State is not ("awaiting_device" or "accepting" or "closing" or "reconciling"
                    or "confirmed" or "closed" or "expired" or "needs_reconciliation")
                || session.Deadline is <= 0
                || session.CloseReason is not (null or "done" or "deadline" or "capacity" or "offline" or "fault")))
            throw new InvalidDataException("Central cash-session response is invalid.");
        return result.Session;
    }

    public async Task<CashEventAck> PostCashEventAsync(
        CashEventEnvelope value, CancellationToken cancellationToken)
    {
        using var response = await client.PostAsJsonAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/cash-events", value,
            ProductCashJson.Options, cancellationToken);
        EnsureSuccess(response);
        var ack = await response.Content.ReadFromJsonAsync<CashEventAck>(ProductCashJson.Options, cancellationToken);
        if (ack is null || !ack.Accepted || ack.StreamId != value.StreamId || ack.Sequence != value.Sequence)
            throw new InvalidDataException("Central did not acknowledge the exact durable cash event.");
        return ack;
    }
}

public static class ProductCashReadback
{
    public static JsonElement Required(JsonElement value, string name)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var matches = value.EnumerateObject().Where(property =>
                property.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (matches.Length == 1) return matches[0].Value;
        }
        throw new InvalidDataException($"Cash readback omitted or duplicated {name}.");
    }

    public static string Text(JsonElement value, string name)
    {
        var field = Required(value, name);
        return field.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(field.GetString())
            ? field.GetString()! : throw new InvalidDataException($"Cash readback {name} is not a string.");
    }

    public static long Integer(JsonElement value, string name)
    {
        var field = Required(value, name);
        var text = field.ValueKind == JsonValueKind.String ? field.GetString() : field.GetRawText();
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var number) || number < 0)
            throw new InvalidDataException($"Cash readback {name} is not a nonnegative integer.");
        return number;
    }

    public static CashInventory Inventory(JsonElement levels, JsonElement counters)
    {
        if (levels.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("ITL inventory levels are missing.");
        var rows = levels.EnumerateArray().Select(level =>
        {
            if (!Text(level, "countryCode").Equals("INR", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("ITL inventory currency is not INR.");
            return new CashInventoryLevel(Integer(level, "value").ToString(CultureInfo.InvariantCulture),
                Integer(level, "storedInPayout"), Integer(level, "storedInCashbox"));
        }).ToArray();
        var inventory = new CashInventory(rows, new CashInventoryCounters(
            Counter(counters, "stored"), Counter(counters, "stacked"),
            Counter(counters, "dispensed"), Counter(counters, "transferredToStack")));
        inventory.Validate();
        return inventory;
    }

    private static long Counter(JsonElement value, string name)
    {
        // Each returned module must supply every counter. An absent module counter is not zero.
        if (value.ValueKind == JsonValueKind.Array)
        {
            if (value.GetArrayLength() == 0) throw new InvalidDataException("ITL counters are empty.");
            return value.EnumerateArray().Aggregate(0L, (sum, row) => checked(sum + Counter(row, name)));
        }
        return Integer(value, name);
    }
}
