using System.Text.Json;

namespace Kalash.CashMachineController;

public static class ProductCashHost
{
    public static Task RunSelectedAsync(bool enabled, Func<Task> product, Func<Task> noCash) =>
        enabled ? product() : noCash();

    public static async Task<string> OpenDisabledAsync(bool enabled, ItlControllerClient client,
        ProductCashJournal journal, string comPort, string logDirectory, CancellationToken token)
    {
        if (!enabled) throw new InvalidOperationException("Product connection is forbidden while the physical gate is off.");
        var state = await journal.LoadAsync(token);
        if (state.Locked || state.ConnectionDispatchPending || state.PollInFlight || state.Intake is { Closed: false })
            throw new InvalidOperationException("Unresolved product cash state forbids another OpenConnection.");
        state.ConnectionDispatchPending = true;
        state.ManualEscrowConfigured = false;
        state.RouteVerificationRequired = true;
        state.SuccessfulRouteResults = 0;
        await journal.SaveAsync(state, token);
        Directory.CreateDirectory(logDirectory);
        using var opened = await client.OpenConnectionAsync(comPort, logDirectory, token);
        var id = ProductCashReadback.Text(opened.RootElement, "deviceID");
        state.ConnectionDispatchPending = false;
        state.ManualEscrowConfigured = true;
        state.DeviceId = id;
        await journal.SaveAsync(state, token);
        return id;
    }
}
