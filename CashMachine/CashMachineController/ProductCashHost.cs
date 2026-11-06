using System.Text.Json;

namespace Kalash.CashMachineController;

public static class ProductCashHost
{
    public static Task RunSelectedAsync(bool enabled, Func<Task> product, Func<Task> noCash) =>
        enabled ? product() : noCash();

    public static async Task<string> OpenDisabledAsync(bool enabled, ItlControllerClient client,
        ProductCashJournal journal, string comPort, string logDirectory, CancellationToken token, bool singleHundred = false)
    {
        if (!enabled) throw new InvalidOperationException("Product connection is forbidden while the physical gate is off.");
        var state = await journal.LoadAsync(token);
        if (state.Locked || state.Payouts.Any(payout => !payout.Reconciled && payout.State is not ("reported" or "precondition_failed"))
            || state.ConnectionDispatchPending || state.PollInFlight || state.Intake is { Closed: false })
            throw new InvalidOperationException("Unresolved product cash state forbids another OpenConnection.");
        state.ConnectionDispatchPending = true;
        state.ManualEscrowConfigured = false;
        state.SingleHundred = singleHundred;
        state.RouteVerificationRequired = true;
        state.SuccessfulRouteResults = 0;
        await journal.SaveAsync(state, token);
        Directory.CreateDirectory(logDirectory);
        using var opened = await client.OpenConnectionAsync(comPort, logDirectory, token,
            enabledDenominations: singleHundred ? new HashSet<int> { 10_000 } : null);
        var id = ProductCashReadback.Text(opened.RootElement, "deviceID");
        state.ConnectionDispatchPending = false;
        state.ManualEscrowConfigured = true;
        state.DeviceId = id;
        await journal.SaveAsync(state, token);
        return id;
    }
}
