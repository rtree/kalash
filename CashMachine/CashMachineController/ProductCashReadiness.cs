namespace Kalash.CashMachineController;

public sealed record ProductCashReadinessEvidence(
    string Version, string CommandId, string CashSessionId, string DeviceId,
    long DisabledObservedAt, long DisabledRawSequence, long EnableDispatchedAt,
    long EnableAcknowledgedAt, long IdleObservedAt, long RawSequence, int? DeviceStateCode,
    bool ManualEscrow, bool RoutesVerified, bool EscrowEmpty, bool DeviceHealthy,
    CashInventory Baseline, CashInventory Inventory)
{
    public void Validate(CashStartCommand command, string deviceId, long now)
    {
        if (Version != "itl-idle-after-enable-v1" || CommandId != command.CommandId
            || CashSessionId != command.CashSessionId || DeviceId != deviceId
            || DisabledObservedAt <= 0 || DisabledObservedAt > EnableDispatchedAt
            || DisabledObservedAt < command.CreatedAt - 5_000 || EnableDispatchedAt >= command.ExpiresAt
            || EnableDispatchedAt > EnableAcknowledgedAt || EnableAcknowledgedAt > IdleObservedAt
            || EnableDispatchedAt >= IdleObservedAt || IdleObservedAt > now || now - IdleObservedAt > 2_000
            || DisabledRawSequence < 0 || RawSequence <= DisabledRawSequence
            || DeviceStateCode != 5 || !ManualEscrow || !RoutesVerified || !EscrowEmpty || !DeviceHealthy
            || !SameInventory(Baseline, Inventory))
            throw new InvalidDataException("Causally bound IDLE readiness evidence is incomplete or inconsistent.");
    }

    public static bool SameInventory(CashInventory left, CashInventory right)
    {
        left.Validate();
        right.Validate();
        return left.Counters == right.Counters
            && left.Levels.OrderBy(level => level.ValuePaise).SequenceEqual(right.Levels.OrderBy(level => level.ValuePaise));
    }
}
