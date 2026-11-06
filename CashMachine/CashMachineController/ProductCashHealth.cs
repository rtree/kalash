using System.Net.Http.Json;

namespace Kalash.CashMachineController;

public sealed record ControllerHealthReport(
    long Sequence, long ReportedAt, bool UsbConnected, bool ConnectionOpen,
    bool DeviceStarted, bool RoutesVerified, bool PollerOwned, string? DeviceId);
public sealed record ControllerHealthReceipt(
    bool Accepted, bool CashEnabled, bool CashAcceptanceEnabled, bool CryptoEnabled);

public interface IControllerHealthCentral
{
    Task ReportHealthAsync(ControllerHealthReport report, CancellationToken token);
}

public static class ProductCashHealth
{
    public static async Task<long> NextSequenceAsync(
        ProductCashState state, ProductCashJournal journal, long now, CancellationToken token)
    {
        state.HealthSequence = Math.Max(checked(state.HealthSequence + 1), now);
        await journal.SaveAsync(state, token);
        return state.HealthSequence;
    }

    public static async Task VerifyCentralBeforeStartupAsync(
        ProductCashJournal journal, IControllerHealthCentral central, CancellationToken token)
    {
        var state = await journal.LoadAsync(token);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var sequence = await NextSequenceAsync(state, journal, now, token);
        await central.ReportHealthAsync(new ControllerHealthReport(
            sequence, now, false, false, false, false, false, null), token);
    }
}

public sealed partial class CentralCashCommandClient : IControllerHealthCentral
{
    public async Task ReportHealthAsync(ControllerHealthReport report, CancellationToken token)
    {
        using var response = await client.PostAsJsonAsync(
            $"/api/controller/{Uri.EscapeDataString(atmId)}/health", report, ProductCashJson.Options, token);
        EnsureSuccess(response);
        var receipt = await response.Content.ReadFromJsonAsync<ControllerHealthReceipt>(ProductCashJson.Options, token);
        if (receipt?.Accepted != true)
            throw new InvalidDataException("Central did not accept the Controller health report.");
    }
}
