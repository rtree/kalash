using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Kalash.CashMachineController;

public sealed class ProductCashNote
{
    public required string Key { get; init; }
    public required long Value { get; init; }
    public required string Currency { get; init; }
    public required string Decision { get; set; }
    public bool DispatchStarted { get; set; }
    public bool Stored { get; set; }
    public bool Returned { get; set; }
    public bool Credited { get; set; }
    public string? AuditDisposition { get; set; }
}

public sealed class ProductCashIntake
{
    public required CashStartCommand Command { get; init; }
    public required CashInventory Baseline { get; init; }
    public required long[] EnabledValues { get; init; }
    public List<ProductCashNote> Notes { get; init; } = [];
    public List<string> Reasons { get; init; } = [];
    public bool EnableDispatchStarted { get; set; }
    public long? DisabledObservedAt { get; set; }
    public long? DisabledRawSequence { get; set; }
    public long? EnableDispatchedAt { get; set; }
    public long? EnableAcknowledgedAt { get; set; }
    public ProductCashReadinessEvidence? ReadinessEvidence { get; set; }
    public bool Started { get; set; }
    public long? Deadline { get; set; }
    public long? ReadyAt { get; set; }
    public long? ReadinessToFirstAcceptingMs { get; set; }
    public string? CloseReason { get; set; }
    public string? CloseDetail { get; set; }
    public long? ClosingAt { get; set; }
    public bool DisableDispatchStarted { get; set; }
    public bool DisabledObserved { get; set; }
    public bool Closed { get; set; }
    public long NoteSequence { get; set; }
    public bool SingleHundred { get; init; }
    public CashInventory? FinalInventory { get; set; }
    public long? AuditRetiredAt { get; set; }
    [JsonIgnore] public ProductCashNote? Pending => Notes.SingleOrDefault(note =>
        !note.Stored && !note.Returned && note.AuditDisposition is null);
    [JsonIgnore] public long CommittedPaise => Notes.Where(note => note.Decision == "accept" && !note.Returned).Sum(note => note.Value);
    [JsonIgnore] public long CommittedNotes => Notes.LongCount(note => note.Decision == "accept" && !note.Returned);
}

// This is a deterministic, I/O-free reducer. The owner commits every transition before dispatch.
public sealed class ProductCashState
{
    public required string StreamId { get; init; }
    public long NextSequence { get; set; } = 1;
    public long AcknowledgedSequence { get; set; }
    public long RawSequence { get; set; }
    public long HealthSequence { get; set; }
    public bool SingleHundred { get; set; }
    public bool PollInFlight { get; set; }
    public bool ConnectionDispatchPending { get; set; }
    public bool ManualEscrowConfigured { get; set; }
    public string? DeviceId { get; set; }
    public bool RouteVerificationRequired { get; set; }
    public int SuccessfulRouteResults { get; set; }
    public string? InitializationRecoveryPhase { get; set; }
    public ProductInitializationRecoveryReceipt? InitializationRecovery { get; set; }
    public string? FailedStartRecoveryPhase { get; set; }
    public ProductFailedStartRecoveryReceipt? FailedStartRecovery { get; set; }
    public bool Locked { get; set; }
    public bool HistoricalAuditRetired { get; set; }
    public List<string> LockReasons { get; init; } = [];
    public List<string> AuditWarnings { get; init; } = [];
    public List<string> CompletedSessions { get; init; } = [];
    public List<CashEventEnvelope> Outbox { get; init; } = [];
    public ProductCashIntake? Intake { get; set; }
    public List<ProductCashIntake> HistoricalIntakes { get; init; } = [];
    public List<ProductPayout> Payouts { get; init; } = [];

    public void Begin(CashStartCommand command, CashInventory baseline, long[] enabled)
    {
        baseline.Validate();
        if (Locked || Payouts.Any(payout => !payout.Reconciled && payout.State is not ("reported" or "precondition_failed"))
            || Intake is { Closed: false } || Outbox.Count != 0
            || CompletedSessions.Contains(command.CashSessionId)
            || baseline.Paise >= 100_000 || baseline.Notes >= 10
            || (SingleHundred && (baseline.Paise + 10_000 > 100_000 || !enabled.SequenceEqual([10_000L])))
            || enabled.Length == 0 || enabled.Any(value => !CashInventory.Denominations.Contains(value)))
            throw new InvalidOperationException("Product cash preconditions prevent a new intake.");
        if (Intake is { Closed: true, AuditRetiredAt: not null } retired)
            HistoricalIntakes.Add(retired);
        Intake = new ProductCashIntake { Command = command, Baseline = baseline, EnabledValues = enabled, SingleHundred = SingleHundred };
    }

    public void Ready(long now)
    {
        var intake = RequiredIntake();
        if (intake.Started || intake.Closed) return;
        intake.Started = true;
        intake.ReadyAt = now;
        intake.Deadline = checked(now + ProductTiming.HumanWindowMs);
        Emit("intake_started", new { inventory = intake.Baseline }, now);
    }

    public void Close(string reason, long now, string? detail = null)
    {
        var intake = RequiredIntake();
        var wireReason = reason is "deadline" or "done" or "capacity" or "fault" or "offline" ? reason : "fault";
        var wireDetail = string.IsNullOrWhiteSpace(detail) ? reason : detail;
        if (intake.CloseReason is not null && ClosePriority(intake.CloseReason) >= ClosePriority(wireReason))
        {
            intake.CloseDetail ??= wireDetail;
            return;
        }
        intake.CloseReason = wireReason;
        intake.CloseDetail = wireDetail;
        intake.ClosingAt ??= now;
    }

    public void Reconcile(string reason, long now)
    {
        Locked = true;
        if (!LockReasons.Contains(reason)) LockReasons.Add(reason);
        if (Intake is not { } intake) return;
        Close("fault", now, reason);
        if (intake.Reasons.Contains(reason)) return;
        intake.Reasons.Add(reason);
        Emit("needs_reconciliation", new { reason }, now);
    }

    public ProductCashNote? Escrow(long value, string currency, bool online, long now)
    {
        var intake = RequiredIntake();
        if (!intake.Started)
        {
            Reconcile("escrow_before_ready", now);
            return null;
        }
        if (intake.Closed || intake.Pending is not null)
        {
            Reconcile("ambiguous_escrow", now);
            return null;
        }
        if (currency != "INR" || !CashInventory.Denominations.Contains(value))
        {
            Reconcile("unsupported_note_identity", now);
            return null;
        }
        var accept = !Locked && intake.Started && intake.CloseReason is null && online
            && intake.Deadline > now && intake.EnabledValues.Contains(value)
            && intake.CommittedPaise + value <= 40_000
            && (!intake.SingleHundred || value == 10_000 && intake.CommittedNotes == 0)
            && intake.Baseline.Paise + intake.CommittedPaise + value <= 100_000
            && intake.Baseline.Notes + intake.CommittedNotes + 1 <= 10;
        var note = new ProductCashNote
        {
            Key = $"{intake.Command.CashSessionId}:{++intake.NoteSequence}",
            Value = value, Currency = currency, Decision = accept ? "accept" : "return"
        };
        intake.Notes.Add(note);
        Emit("note_escrow", new { noteKey = note.Key, valuePaise = Value(value), currency, decision = note.Decision }, now);
        if (!accept)
        {
            var reason = intake.Deadline <= now ? "deadline" : !online ? "offline" : "capacity";
            Close(reason, now, reason == "deadline" ? "permission_expired_or_deadline" : "note_not_accepted");
        }
        return note;
    }

    public void ObserveAccepting(long now)
    {
        var intake = RequiredIntake();
        if (!intake.Started || intake.ReadinessToFirstAcceptingMs is not null) return;
        if (intake.ReadyAt is not { } readyAt || now < readyAt)
        {
            Reconcile("accepting_before_readiness", now);
            return;
        }
        intake.ReadinessToFirstAcceptingMs = now - readyAt;
    }

    public void Resolve(string name, long value, string currency, bool payout, long now)
    {
        var intake = RequiredIntake();
        var note = intake.Pending;
        if (intake.Closed || note is null || note.Value != value || note.Currency != currency
            || !note.DispatchStarted || (name == "STORED" && (note.Decision != "accept" || !payout))
            || (name == "RETURNED" && note.Decision != "return"))
        {
            Reconcile("unmatched_note_outcome", now);
            return;
        }
        if (name == "STORED")
        {
            note.Stored = true;
            note.Credited = !Locked && intake.Reasons.Count == 0;
            if (note.Credited)
                Emit("note_stored", new { noteKey = note.Key, valuePaise = Value(value), currency, route = "payout" }, now);
        }
        else
        {
            note.Returned = true;
            Emit("note_returned", new { noteKey = note.Key, valuePaise = Value(value), currency }, now);
        }
        if (intake.SingleHundred && intake.CommittedNotes >= 1
            || intake.CommittedPaise >= 40_000 || intake.Baseline.Paise + intake.CommittedPaise >= 100_000
            || intake.Baseline.Notes + intake.CommittedNotes >= 10) Close("capacity", now);
    }

    public void Finish(CashInventory after, bool escrowEmpty, long now)
    {
        var intake = RequiredIntake();
        if (intake.Closed) return;
        after.Validate();
        if (!intake.DisabledObserved) Reconcile("acceptor_not_disabled", now);
        if (!escrowEmpty || intake.Pending is not null) Reconcile("unresolved_escrow", now);
        var stored = intake.Notes.Where(note => note.Stored).ToArray();
        var credited = stored.Where(note => note.Credited).ToArray();
        if (stored.Length != credited.Length) Reconcile("uncredited_notes", now);
        if (after.Counters.Stored - intake.Baseline.Counters.Stored != stored.Length
            || after.Counters.Stacked != intake.Baseline.Counters.Stacked
            || after.Counters.Dispensed != intake.Baseline.Counters.Dispensed
            || after.Counters.TransferredToStack != intake.Baseline.Counters.TransferredToStack)
            Reconcile("counter_mismatch", now);
        foreach (var before in intake.Baseline.Levels)
        {
            var level = after.Levels.Single(level => level.ValuePaise == before.ValuePaise);
            if (level.Payout - before.Payout != stored.Count(note => Value(note.Value) == before.ValuePaise)
                || level.Cashbox != before.Cashbox) Reconcile("inventory_mismatch", now);
        }
        Emit("intake_closed", new
        {
            reason = intake.CloseReason ?? "fault", inventory = after,
            creditedNotes = credited.Length, creditedPaise = Value(credited.Sum(note => note.Value)),
            uncreditedNotes = stored.Length - credited.Length, disabled = intake.DisabledObserved,
            escrowEmpty, reconciliationReasons = intake.Reasons.ToArray()
        }, now);
        intake.Closed = true;
        intake.FinalInventory = after;
        CompletedSessions.Add(intake.Command.CashSessionId);
    }

    internal bool RetireHistoricalIntakeAsAudit(long now)
    {
        var intake = Intake;
        if (!Locked || intake is not { Closed: true, FinalInventory: not null, AuditRetiredAt: null }
            || !CompletedSessions.Contains(intake.Command.CashSessionId) || LockReasons.Count == 0
            || intake.Reasons.Count == 0
            || LockReasons.Any(reason => !ProductCashPolicy.IsAuditableHistoricalReason(reason))
            || intake.Reasons.Any(reason => !ProductCashPolicy.IsAuditableHistoricalReason(reason))
            || intake.Notes.Any(note => note.Stored && note.Returned || note.Credited && !note.Stored))
            return false;

        var unresolved = intake.Notes.Where(note => !note.Stored && !note.Returned).ToArray();
        if (unresolved.Length > 1 || unresolved.Any(note => note.Credited
            || note.AuditDisposition is not null and not "unresolved_audit"))
            return false;

        foreach (var reason in LockReasons.Concat(intake.Reasons).Distinct(StringComparer.Ordinal))
            if (!AuditWarnings.Contains(reason, StringComparer.Ordinal))
                AuditWarnings.Add(reason);

        foreach (var note in unresolved)
        {
            note.AuditDisposition = "unresolved_audit";
            var warning = $"unresolved_note_audit:{note.Key}";
            if (!AuditWarnings.Contains(warning, StringComparer.Ordinal))
                AuditWarnings.Add(warning);
        }

        LockReasons.Clear();
        Locked = false;
        HistoricalAuditRetired = true;
        intake.AuditRetiredAt = now;
        return true;
    }

    public void Acknowledge(CashEventAck ack)
    {
        if (Outbox.Count == 0 || !ack.Accepted || ack.StreamId != StreamId
            || ack.Sequence != Outbox[0].Sequence || ack.Sequence != AcknowledgedSequence + 1)
            throw new InvalidDataException("Cash ACK does not match the durable outbox head.");
        Outbox.RemoveAt(0);
        AcknowledgedSequence = ack.Sequence;
    }

    private void Emit(string type, object data, long now)
    {
        var command = RequiredIntake().Command;
        var sequence = NextSequence++;
        Outbox.Add(new CashEventEnvelope(StreamId, sequence, $"{StreamId}:{sequence}", now,
            command.VisitId, command.CashSessionId, type, JsonSerializer.SerializeToElement(data, ProductCashJson.Options)));
    }

    private ProductCashIntake RequiredIntake() => Intake ?? throw new InvalidOperationException("No product cash intake is bound.");
    private static string Value(long value) => value.ToString(CultureInfo.InvariantCulture);

    private static int ClosePriority(string reason) => reason switch
    {
        "deadline" => 5,
        "done" => 4,
        "capacity" => 3,
        "fault" => 2,
        "offline" => 1,
        _ => 0
    };
}

public sealed class ProductCashJournal : IDisposable
{
    private readonly string path;
    private readonly FileStream ownership;
    public ProductCashJournal(string directory)
    {
        Directory.CreateDirectory(directory);
        path = Path.Combine(directory, "state.json");
        ownership = new FileStream(Path.Combine(directory, "owner.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
    }

    public async Task<ProductCashState> LoadAsync(CancellationToken token)
    {
        if (!File.Exists(path)) return new ProductCashState { StreamId = Guid.NewGuid().ToString("D") };
        await using var stream = File.OpenRead(path);
        var state = await JsonSerializer.DeserializeAsync<ProductCashState>(stream, ProductCashJson.Options, token)
            ?? throw new InvalidDataException("The product cash journal is empty.");
        if (!Guid.TryParseExact(state.StreamId, "D", out _) || state.AcknowledgedSequence < 0
            || state.NextSequence != state.AcknowledgedSequence + state.Outbox.Count + 1
            || state.Outbox.Where((item, index) => item.StreamId != state.StreamId
                || item.Sequence != state.AcknowledgedSequence + index + 1
                || item.DeviceEventId != $"{state.StreamId}:{item.Sequence}").Any())
            throw new InvalidDataException("The product cash journal ordering is corrupt.");
        state.Intake?.Baseline.Validate();
        state.Intake?.FinalInventory?.Validate();
        foreach (var historical in state.HistoricalIntakes)
        {
            if (!historical.Closed || historical.AuditRetiredAt is null || historical.FinalInventory is null)
                throw new InvalidDataException("Archived cash intakes must preserve their closed physical evidence.");
            historical.Baseline.Validate();
            historical.FinalInventory.Validate();
        }
        if (state.HistoricalIntakes.Select(intake => intake.Command.CashSessionId).Distinct(StringComparer.Ordinal).Count()
            != state.HistoricalIntakes.Count)
            throw new InvalidDataException("Historical cash session identities must be unique.");
        if (state.HistoricalAuditRetired
            && (state.AuditWarnings.Count == 0
                || state.Intake?.AuditRetiredAt is null
                    && !state.HistoricalIntakes.Any(intake => intake.AuditRetiredAt is not null)))
            throw new InvalidDataException("Retired historical audit evidence is missing its closed intake.");
        var historicalIntakes = state.HistoricalIntakes.AsEnumerable();
        if (state.Intake is { } currentIntake)
            historicalIntakes = historicalIntakes.Append(currentIntake);
        foreach (var historical in historicalIntakes)
            if (historical.Notes.Any(note =>
                note.AuditDisposition is not null && note.AuditDisposition != "unresolved_audit"
                || note.AuditDisposition == "unresolved_audit"
                    && (note.Stored || note.Returned || note.Credited
                        || !state.AuditWarnings.Contains($"unresolved_note_audit:{note.Key}", StringComparer.Ordinal))))
                throw new InvalidDataException("An audit-only note must remain explicitly unresolved and non-credited.");
        foreach (var payout in state.Payouts) payout.ValidatePersisted();
        if (state.Payouts.Select(payout => payout.Command.CommandId).Distinct().Count() != state.Payouts.Count
            || state.Payouts.Select(payout => payout.Command.PayoutId).Distinct().Count() != state.Payouts.Count
            || state.Payouts.Select(payout => payout.Command.ApprovalId).Distinct().Count() != state.Payouts.Count)
            throw new InvalidDataException("Payout identities must be unique in the durable journal.");
        return state;
    }

    public async Task SaveAsync(ProductCashState state, CancellationToken token)
    {
        var replacement = path + ".next";
        await using (var stream = new FileStream(replacement, FileMode.Create, FileAccess.Write, FileShare.None,
            4096, FileOptions.Asynchronous | FileOptions.WriteThrough))
        {
            await JsonSerializer.SerializeAsync(stream, state, ProductCashJson.Options, token);
            await stream.FlushAsync(token);
            stream.Flush(true);
        }
        File.Move(replacement, path, overwrite: true);
    }

    public Task<byte[]> ReadEvidenceAsync(CancellationToken token) => File.ReadAllBytesAsync(path, token);

    public void Dispose() => ownership.Dispose();
}
