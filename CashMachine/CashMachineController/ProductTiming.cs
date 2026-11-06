namespace Kalash.CashMachineController;

public static class ProductTiming
{
    public const int StatusFreshnessMs = 30_000;
    public const int ClockSkewMs = 30_000;
    public const int HumanWindowMs = 240_000;
    public const int DeviceTransitionMs = 20_000;
    public const int InitializationMs = 30_000;
    public const int HttpTimeoutMs = 10_000;
    public const int PollHttpTimeoutMs = 4_000;
    public const int EscrowDecisionMs = 2_000;
    public const int PayoutCompletionMs = 180_000;
}
