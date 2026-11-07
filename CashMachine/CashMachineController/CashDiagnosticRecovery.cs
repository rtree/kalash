using System.Globalization;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed class CashDiagnosticRecovery(
    ILocalCashRecoveryDevice device,
    CashDiagnosticJournal journal)
{
    private const long RecoveryAmountPaise = 10_000;

    public async Task<CashDiagnosticRecord> RecoverOneNoteAsync(
        Func<long, CancellationToken, Task> confirmRecoveryAsync,
        CancellationToken cancellationToken)
    {
        var record = await journal.GetRecoveryCandidateAsync(cancellationToken);
        ValidateStoredDiagnosticRecord(record);

        var preflight = await device.CheckPreconditionsAsync(cancellationToken);
        if (!preflight.Ready)
        {
            throw new InvalidOperationException(
                $"Local diagnostic recovery preflight failed: {preflight.Reason}.");
        }

        var before = await device.ReadInventoryAsync(cancellationToken);
        if (await device.ReadNoteInEscrowAsync(cancellationToken)
            || !MatchesRecordedFinalInventory(record, before)
            || before.PayoutNotes != 1
            || before.PayoutPaise != RecoveryAmountPaise)
        {
            throw new InvalidOperationException(
                "Recovery requires the exact reconciled single-note Payout balance and empty escrow.");
        }

        await confirmRecoveryAsync(RecoveryAmountPaise, cancellationToken);

        var finalPreflight = await device.CheckPreconditionsAsync(cancellationToken);
        var immediatelyBefore = await device.ReadInventoryAsync(cancellationToken);
        if (!finalPreflight.Ready
            || await device.ReadNoteInEscrowAsync(cancellationToken)
            || !MatchesRecordedFinalInventory(record, immediatelyBefore)
            || immediatelyBefore.PayoutNotes != 1
            || immediatelyBefore.PayoutPaise != RecoveryAmountPaise)
        {
            throw new InvalidOperationException(
                "Recovery state changed after operator confirmation; no payout command was sent.");
        }

        record.RecoveryState = "dispatching";
        record.RecoveryAmountPaise = RecoveryAmountPaise;
        record.RecoveryDispensedCounterBefore = immediatelyBefore.DispensedCounter;
        await journal.SaveAsync(record, cancellationToken);

        var dispatchStartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        try
        {
            await device.DispenseValueOnceAsync(RecoveryAmountPaise, cancellationToken);
            await WaitForDispenseCompletionAsync(dispatchStartedAt, cancellationToken);

            var after = await device.ReadInventoryAsync(cancellationToken);
            if (await device.ReadNoteInEscrowAsync(cancellationToken)
                || !MatchesRecoveredInventory(record, immediatelyBefore, after))
            {
                throw new InvalidOperationException(
                    "Payout result does not reconcile with the local diagnostic note.");
            }

            record.RecoveryState = "recovered";
            record.RecoveryDispensedCounterAfter = after.DispensedCounter;
            record.Outcome = "local_diagnostic_recovered";
            await journal.SaveAsync(record, cancellationToken);
            return record;
        }
        catch (Exception failure)
        {
            record.RecoveryState = "needs_reconciliation";
            var journalFailure = await TrySaveAsync(record);
            if (journalFailure is not null)
            {
                throw new AggregateException(
                    "Payout outcome and its diagnostic journal both require reconciliation.",
                    failure,
                    journalFailure);
            }

            throw;
        }
    }

    private async Task WaitForDispenseCompletionAsync(
        long notBefore,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(60);
        var dispensedSeen = false;
        var transactionCompleted = false;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var status = await device.ReadNextStatusAsync(deadline - DateTimeOffset.UtcNow, cancellationToken);
            if (status is null) break;
            if (status.ObservedAt < notBefore) continue;

            foreach (var item in status.Events)
            {
                if (!TryGetString(item, "type", out var type)) continue;
                if (string.Equals(type, "CashEventResponse", StringComparison.OrdinalIgnoreCase))
                {
                    if (!string.Equals(EventName(item), "DISPENSED", StringComparison.OrdinalIgnoreCase)
                        || RequiredInteger(item, "value") != RecoveryAmountPaise
                        || !string.Equals(
                            RequiredString(item, "countryCode"),
                            "INR",
                            StringComparison.OrdinalIgnoreCase)
                        || dispensedSeen)
                    {
                        throw new InvalidDataException(
                            "Unexpected or duplicate cash event during diagnostic recovery.");
                    }

                    dispensedSeen = true;
                }
                else if (string.Equals(type, "DispenserTransactionEventResponse", StringComparison.OrdinalIgnoreCase))
                {
                    if (!TryGetString(item, "stateAsString", out var transactionState)
                        || !string.Equals(transactionState, "COMPLETED", StringComparison.OrdinalIgnoreCase)
                        || transactionCompleted)
                    {
                        throw new InvalidDataException(
                            "Unexpected or duplicate payout transaction result during diagnostic recovery.");
                    }

                    transactionCompleted = true;
                }
            }

            if (dispensedSeen && transactionCompleted
                && (string.Equals(status.DeviceState, "IDLE", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(status.DeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase)))
            {
                return;
            }
        }

        throw new TimeoutException(
            "The exact DISPENSED event, COMPLETED transaction, and idle state were not all observed.");
    }

    private static void ValidateStoredDiagnosticRecord(CashDiagnosticRecord record)
    {
        if (record.State != "reconciled"
            || record.RecoveryState != "none"
            || record.AcceptedPaise != RecoveryAmountPaise
            || record.AcceptedNotes != 1
            || record.BaselineLevels.Count != 6
            || record.FinalLevels.Count != 6
            || record.BaselineLevels.Any(level => level.StoredInPayout != 0)
            || record.BaselineLevels.Any(level =>
                record.FinalLevels.SingleOrDefault(final => final.Value == level.Value) is not { } final
                || level.StoredInCashbox != final.StoredInCashbox)
            || record.FinalLevels.Sum(level => level.Value * level.StoredInPayout) != RecoveryAmountPaise
            || record.FinalLevels.Sum(level => level.StoredInPayout) != 1
            || record.FinalStoredCounter != record.BaselineStoredCounter + 1
            || record.FinalStackedCounter != record.BaselineStackedCounter
            || record.FinalDispensedCounter != record.BaselineDispensedCounter)
        {
            throw new InvalidDataException(
                "The local diagnostic journal does not prove one unrecovered ₹100 Payout note.");
        }
    }

    private static bool MatchesRecordedFinalInventory(
        CashDiagnosticRecord record,
        CashDiagnosticInventory current)
    {
        if (current.Levels.Count != record.FinalLevels.Count
            || current.StoredCounter != record.FinalStoredCounter
            || current.StackedCounter != record.FinalStackedCounter
            || current.DispensedCounter != record.FinalDispensedCounter)
        {
            return false;
        }

        return record.FinalLevels.All(level =>
            current.Levels.TryGetValue(level.Value, out var currentLevel)
            && currentLevel == level);
    }

    private static bool MatchesRecoveredInventory(
        CashDiagnosticRecord record,
        CashDiagnosticInventory before,
        CashDiagnosticInventory after)
    {
        if (after.Levels.Count != before.Levels.Count
            || after.StoredCounter != record.FinalStoredCounter
            || after.StackedCounter != before.StackedCounter
            || after.DispensedCounter != before.DispensedCounter + 1)
        {
            return false;
        }

        foreach (var (value, beforeLevel) in before.Levels)
        {
            if (!after.Levels.TryGetValue(value, out var afterLevel)
                || afterLevel.StoredInPayout != beforeLevel.StoredInPayout - (value == RecoveryAmountPaise ? 1 : 0)
                || afterLevel.StoredInCashbox != beforeLevel.StoredInCashbox)
            {
                return false;
            }
        }

        return after.PayoutPaise == 0 && after.PayoutNotes == 0;
    }

    private async Task<Exception?> TrySaveAsync(CashDiagnosticRecord record)
    {
        try
        {
            await journal.SaveAsync(record, CancellationToken.None);
            return null;
        }
        catch (Exception exception)
        {
            return exception;
        }
    }

    private static string? EventName(JsonElement value) =>
        TryGetString(value, "eventTypeAsString", out var name) ? name : null;

    private static long RequiredInteger(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var property))
        {
            throw new InvalidDataException($"The ITL event omitted {name}.");
        }

        var text = property.ValueKind switch
        {
            JsonValueKind.Number => property.GetRawText(),
            JsonValueKind.String => property.GetString(),
            _ => null
        };
        if (!long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var result)
            || result <= 0)
        {
            throw new InvalidDataException($"The ITL event {name} is not a positive integer.");
        }

        return result;
    }

    private static string RequiredString(JsonElement value, string name) =>
        TryGetString(value, name, out var result) && !string.IsNullOrWhiteSpace(result)
            ? result
            : throw new InvalidDataException($"The ITL event omitted {name}.");

    private static bool TryGetString(JsonElement value, string name, out string? result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.String)
                {
                    result = property.Value.GetString();
                    return true;
                }
            }
        }

        result = null;
        return false;
    }
}
