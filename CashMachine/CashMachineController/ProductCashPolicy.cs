namespace Kalash.CashMachineController;

public static class ProductCashPolicy
{
    private static readonly HashSet<string> AuditableHistoricalReasons = new(StringComparer.Ordinal)
    {
        "close_observation_timeout",
        "close_unresolved_note_outcome",
        "counter_mismatch",
        "inventory_mismatch",
        "unexpected_device_state",
        "unexpected_device_state_event",
        "uncredited_notes",
        "unresolved_escrow"
    };

    public static bool InterimEnabled =>
        Environment.GetEnvironmentVariable("KALASH_CASH_POLICY") == "interim-ledger";

    public static bool BlocksOperations(ProductCashState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        return state.Locked || state.PollInFlight || state.ConnectionDispatchPending
            || state.Outbox.Count != 0
            || state.Payouts.Any(payout => !payout.Reconciled && payout.State == "unknown");
    }

    public static bool IsAuditableHistoricalReason(string reason) =>
        AuditableHistoricalReasons.Contains(reason);

    public static bool CanReobserveClosedIntake(ProductCashState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        var intake = state.Intake;
        if (!InterimEnabled || !state.Locked || state.PollInFlight || state.ConnectionDispatchPending
            || state.Outbox.Count != 0
            || state.Payouts.Any(payout => !payout.Reconciled
                && payout.State is not ("reported" or "precondition_failed")))
            return false;
        if (intake is not { Closed: true, FinalInventory: not null, AuditRetiredAt: null })
            return false;
        return state.CompletedSessions.Contains(intake.Command.CashSessionId)
            && state.LockReasons.Count != 0 && intake.Reasons.Count != 0
            && state.LockReasons.All(IsAuditableHistoricalReason)
            && intake.Reasons.All(IsAuditableHistoricalReason);
    }
}
