using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;

namespace Kalash.CashMachineController;

internal static partial class Program
{
    private static async Task<int> ReconcileProductFailedStartAsync(string cashSessionId)
    {
        if (!Guid.TryParseExact(cashSessionId, "D", out _))
            throw new ControllerConfigurationException("An exact failed cash-session UUID and explicit no-notes confirmation are required.");
        var configuration = RestApiServerConfiguration.FromEnvironment();
        if (!int.TryParse(Environment.GetEnvironmentVariable("KALASH_ITL_EXPECTED_SERVER_PID"), out var pid) || pid <= 0)
            throw new ControllerConfigurationException("Failed-start recovery requires the explicitly verified existing server PID.");
        using var process = Process.GetProcessById(pid);
        if (process.HasExited || !process.ProcessName.Equals("dotnet", StringComparison.OrdinalIgnoreCase)
            || process.MainModule?.FileName is not { } image
            || !Path.GetFullPath(image).Equals(Path.GetFullPath(configuration.DotnetExecutable), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The failed-start recovery PID does not match the expected .NET host.");
        var listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
            .Where(endpoint => endpoint.Port == configuration.Port).ToArray();
        if (listeners.Length == 0 || listeners.Any(endpoint => !IPAddress.IsLoopback(endpoint.Address)))
            throw new InvalidOperationException("Failed-start recovery requires the existing loopback-only server.");

        var registration = CashControllerConfiguration.Load();
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KALASH", "cash-product", registration.AtmId);
        using var journal = new ProductCashJournal(directory);
        var state = await journal.LoadAsync(CancellationToken.None);
        if (string.IsNullOrWhiteSpace(state.DeviceId) || state.Intake?.Command.CashSessionId != cashSessionId)
            throw new InvalidDataException("Failed-start recovery requires the exact durable device and session binding.");
        var fresh = Environment.GetEnvironmentVariable(VendorBootstrapCredentials.PackageDirectoryVariable);
        if (string.IsNullOrWhiteSpace(fresh))
            throw new ControllerConfigurationException("The verified local Fresh package configuration is required.");
        VendorBootstrapCredentials.VerifyTargetMatchesFreshPackage(configuration.ServerDirectory, fresh);
        var credentials = VendorBootstrapCredentials.Load(fresh);
        using var api = new ItlControllerClient(credentials.Username, credentials.Password);
        await api.VerifyHostFilteringAsync();
        await api.AuthenticateAsync();
        var rawPath = Path.Combine(directory, "raw.jsonl");
        await using var poller = new ItlDeviceStatusPoller(api, state.DeviceId, rawPath);
        var recovery = new ProductFailedStartRecovery(journal, CashCommandJournal.FromLocalApplicationData(),
            new ItlProductCashDevice(api, poller, state.DeviceId), rawPath,
            Path.Combine(directory, "failed-start-recovery-evidence"), registration.AtmId, cashSessionId, true);
        var receipt = await recovery.ReconcileAndDisconnectAsync(CancellationToken.None);
        Console.WriteLine("Zero-note failed start verified DISABLED/empty with unchanged six levels/four counters, then disconnected.");
        Console.WriteLine($"Preserved evidence directory: {receipt.ArchiveDirectory}");
        Console.WriteLine("Files: proof.json, state.json, raw.jsonl, command.json, readback.json.");
        Console.WriteLine("Original command remains terminal unknown; stream and sequence unchanged. No Enable/Accept/Return/Open/Payout or automatic restart.");
        Console.WriteLine("Central remains locked until the operator applies its separate verified archive reconciliation; proof freshness is 120 seconds.");
        return 0;
    }
}
