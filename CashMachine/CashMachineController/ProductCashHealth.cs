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
