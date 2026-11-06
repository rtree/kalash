using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;

namespace Kalash.CashMachineController;

internal static partial class Program
{
    private static async Task<int> ReconcileProductInitializationAsync()
    {
        var configuration = RestApiServerConfiguration.FromEnvironment();
        if (!int.TryParse(Environment.GetEnvironmentVariable("KALASH_ITL_EXPECTED_SERVER_PID"), out var pid) || pid <= 0)
            throw new ControllerConfigurationException("Startup reconciliation requires the explicitly verified existing server PID.");
        using var process = Process.GetProcessById(pid);
        if (process.HasExited || !process.ProcessName.Equals("dotnet", StringComparison.OrdinalIgnoreCase)
            || process.MainModule?.FileName is not { } image
            || !Path.GetFullPath(image).Equals(Path.GetFullPath(configuration.DotnetExecutable), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The startup reconciliation server PID does not match the expected .NET host.");
        var listeners = IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()
            .Where(endpoint => endpoint.Port == configuration.Port).ToArray();
        if (listeners.Length == 0 || listeners.Any(endpoint => !IPAddress.IsLoopback(endpoint.Address)))
            throw new InvalidOperationException("Startup reconciliation requires the existing loopback-only server.");

        var registration = CashControllerConfiguration.Load();
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KALASH", "cash-product", registration.AtmId);
        using var journal = new ProductCashJournal(directory);
        var state = await journal.LoadAsync(CancellationToken.None);
        if (string.IsNullOrWhiteSpace(state.DeviceId))
            throw new InvalidDataException("Startup reconciliation requires the durable device binding.");
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
        var recovery = new ProductInitializationRecovery(journal, CashCommandJournal.FromLocalApplicationData(),
            new ItlProductCashDevice(api, poller, state.DeviceId), rawPath, Path.Combine(directory, "initialization-recovery-evidence"));
        await recovery.ReconcileAndDisconnectAsync(CancellationToken.None);
        Console.WriteLine("Startup-only parser lock reconciled against retained raw evidence and current one-100 readbacks.");
        Console.WriteLine("DISABLED, empty escrow, identity, six levels, four counters and disconnected list verified; archive retained.");
        Console.WriteLine("No acceptor enable, Accept, Return, OpenConnection or Payout command was sent. No automatic restart.");
        return 0;
    }
}
