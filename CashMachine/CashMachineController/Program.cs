using System.ComponentModel;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Kalash.CashMachineController;

internal static class Program
{
    private const string InstanceMutexName = @"Local\KALASH.CashMachineController";

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && args[0] is "--help" or "-h")
        {
            Console.WriteLine("Usage: KALASH.CashMachineController.exe validate | inspect | run");
            Console.WriteLine(
                $"Requires {RestApiServerConfiguration.ServerDirectoryVariable} and an absolute {RestApiServerConfiguration.DotnetVariable}; inspect also requires protected {ItlReadOnlyClient.UsernameEnvironmentVariable}/{ItlReadOnlyClient.PasswordEnvironmentVariable}.");
            Console.WriteLine("validate never starts a child; inspect performs read-only checks and stops its child.");
            return 0;
        }

        if (args.Length == 1 && args[0] == "validate")
        {
            EnsureRuntimeSigningKey();
            return ValidateConfiguration();
        }

        if (args.Length != 1 || args[0] is not ("inspect" or "run"))
        {
            Console.Error.WriteLine("Specify 'validate', 'inspect', or the explicit 'run' command.");
            return 2;
        }

        using var instanceMutex = new Mutex(initiallyOwned: true, InstanceMutexName, out var createdNew);
        if (!createdNew)
        {
            Console.Error.WriteLine("Another KALASH CashMachineController instance is already running.");
            return 3;
        }

        try
        {
            EnsureRuntimeSigningKey();
            return args[0] == "inspect"
                ? await InspectReadinessAsync()
                : await RunServerAsync();
        }
        catch (ControllerConfigurationException exception)
        {
            Console.Error.WriteLine($"Configuration error: {exception.Message}");
            return 2;
        }
        catch (ItlApiException exception)
        {
            Console.Error.WriteLine($"ITL REST API returned HTTP {(int)exception.StatusCode}; response body withheld.");
            return 1;
        }
        catch (HttpRequestException)
        {
            Console.Error.WriteLine("The local ITL REST API request failed.");
            return 1;
        }
        catch (TimeoutException exception)
        {
            Console.Error.WriteLine($"Controller readiness check timed out: {exception.Message}");
            return 1;
        }
        catch (InvalidDataException exception)
        {
            Console.Error.WriteLine($"Controller readiness data is invalid: {exception.Message}");
            return 1;
        }
        catch (NetworkInformationException)
        {
            Console.Error.WriteLine("Windows could not verify the REST API listener addresses.");
            return 1;
        }
        catch (InvalidOperationException exception)
        {
            Console.Error.WriteLine($"Controller readiness check failed: {exception.Message}");
            return 1;
        }
        catch (Win32Exception exception)
        {
            Console.Error.WriteLine($"Windows process operation failed with error {exception.NativeErrorCode}.");
            return 1;
        }
        catch (IOException)
        {
            Console.Error.WriteLine("Local REST API Server files could not be read.");
            return 1;
        }
        catch (UnauthorizedAccessException)
        {
            Console.Error.WriteLine("Access to the local REST API Server files was denied.");
            return 1;
        }
    }

    private static async Task<int> RunServerAsync()
    {
        var configuration = RestApiServerConfiguration.FromEnvironment();
        var supervisor = CreateSupervisor();
        using var child = await supervisor.StartAsync(configuration);
        Console.WriteLine(
            $"REST API Server child process {child.Id} is running. API authentication and device readiness are unverified.");

        var stopRequested = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stopRequested.TrySetResult();
        };
        Console.CancelKeyPress += cancelHandler;

        try
        {
            var exitTask = child.WaitForExitAsync();
            if (await Task.WhenAny(exitTask, stopRequested.Task) == exitTask)
            {
                var exitCode = await exitTask;
                Console.Error.WriteLine($"REST API Server child exited unexpectedly with code {exitCode}.");
                return 1;
            }

            const bool noCashOperationCanBeInProgress = true;
            await supervisor.StopAsync(
                child,
                noCashOperationCanBeInProgress,
                timeout: TimeSpan.FromSeconds(5));
            Console.WriteLine("The owned REST API Server child stopped.");
            return 0;
        }
        finally
        {
            Console.CancelKeyPress -= cancelHandler;
        }
    }

    private static async Task<int> InspectReadinessAsync()
    {
        var username = Environment.GetEnvironmentVariable(ItlReadOnlyClient.UsernameEnvironmentVariable);
        var password = Environment.GetEnvironmentVariable(ItlReadOnlyClient.PasswordEnvironmentVariable);
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(password))
        {
            throw new ControllerConfigurationException(
                $"Set {ItlReadOnlyClient.UsernameEnvironmentVariable} and {ItlReadOnlyClient.PasswordEnvironmentVariable} in protected local configuration before inspect; values are never printed.");
        }

        var configuration = RestApiServerConfiguration.FromEnvironment();
        var supervisor = CreateSupervisor();
        using var child = await supervisor.StartAsync(configuration);
        var noCashOperationCanBeInProgress = true;
        using var api = new ItlReadOnlyClient(username, password);
        var stopAttempted = false;

        try
        {
            var listeners = await new LoopbackListenerVerifier().WaitForLoopbackOnlyAsync(
                child,
                configuration.Port,
                TimeSpan.FromSeconds(15));
            Console.WriteLine($"REST API Server is bound to {listeners.Count} loopback listener(s) only.");

            await api.VerifyHostFilteringAsync();
            Console.WriteLine("Allowed loopback Host challenge and unlisted Host rejection verified.");

            await api.AuthenticateAsync();
            Console.WriteLine("ITL API authentication succeeded; bearer token withheld.");

            using var usbDevices = await api.GetConnectedUsbDevicesAsync();
            Console.WriteLine(DescribeUsbDevices(usbDevices.RootElement));

            using var cashDevices = await api.GetAllCashDevicesAsync();
            Console.WriteLine(DescribeCashDevices(cashDevices.RootElement));

            if (child.HasExited)
            {
                throw new InvalidOperationException("The REST API Server child exited before normal shutdown.");
            }

            stopAttempted = true;
            await supervisor.StopAsync(
                child,
                noCashOperationCanBeInProgress,
                timeout: TimeSpan.FromSeconds(5));
        }
        finally
        {
            if (!stopAttempted && !child.HasExited)
            {
                await supervisor.StopAsync(
                    child,
                    noCashOperationCanBeInProgress,
                    timeout: TimeSpan.FromSeconds(5));
            }
        }

        Console.WriteLine("The owned REST API Server child stopped normally.");
        return 0;
    }

    private static RestApiServerSupervisor CreateSupervisor()
    {
        return new RestApiServerSupervisor(
            new SystemChildProcessFactory(),
            new SystemPortAvailabilityGuard());
    }

    private static int ValidateConfiguration()
    {
        try
        {
            var configuration = RestApiServerConfiguration.FromEnvironment();
            _ = configuration.CreateStartInfo();
            Console.WriteLine(
                "Local REST API Server configuration is valid. No vendor server child was started; API and device readiness are unverified.");
            return 0;
        }
        catch (ControllerConfigurationException exception)
        {
            Console.Error.WriteLine($"Configuration error: {exception.Message}");
            return 2;
        }
        catch (IOException)
        {
            Console.Error.WriteLine("Local REST API Server files could not be read.");
            return 1;
        }
        catch (UnauthorizedAccessException)
        {
            Console.Error.WriteLine("Access to the local REST API Server files was denied.");
            return 1;
        }
    }

    private static void EnsureRuntimeSigningKey()
    {
        if (!string.IsNullOrWhiteSpace(
                Environment.GetEnvironmentVariable(RestApiServerConfiguration.SigningKeyVariable)))
        {
            return;
        }

        var keyBytes = RandomNumberGenerator.GetBytes(48);
        try
        {
            Environment.SetEnvironmentVariable(
                RestApiServerConfiguration.SigningKeyVariable,
                Convert.ToBase64String(keyBytes));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(keyBytes);
        }
    }

    private static string DescribeUsbDevices(JsonElement response)
    {
        if (response.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("GetConnectedUSBDevices did not return an array.");
        }

        var ports = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in response.EnumerateArray())
        {
            if (TryGetStringProperty(item, "Port", out var port) && IsComPort(port))
            {
                ports.Add(port!.ToUpperInvariant());
            }
        }

        if (response.GetArrayLength() == 0)
        {
            return "GetConnectedUSBDevices returned 0 devices.";
        }

        return ports.Count > 0
            ? $"GetConnectedUSBDevices returned {response.GetArrayLength()} device(s); COM port(s): {string.Join(", ", ports)}."
            : $"GetConnectedUSBDevices returned {response.GetArrayLength()} device(s); no COM port value was available.";
    }

    private static string DescribeCashDevices(JsonElement response)
    {
        if (response.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("GetAllCashDevices did not return an array.");
        }

        return $"GetAllCashDevices returned {response.GetArrayLength()} connected device(s).";
    }

    private static bool TryGetStringProperty(JsonElement value, string propertyName, out string? result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase)
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

    private static bool IsComPort(string? value)
    {
        return value is { Length: > 3 }
            && value.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(value[3..], "^[0-9]+$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    }
}
