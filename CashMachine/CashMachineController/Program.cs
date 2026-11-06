using System.ComponentModel;
using System.Diagnostics;
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
            Console.WriteLine("Usage: KALASH.CashMachineController.exe validate | inspect | initialize | run");
            Console.WriteLine(
                $"Inspect uses the unchanged vendor default credentials from the local Fresh package at {VendorBootstrapCredentials.PackageDirectoryVariable}; no password changes or persistence are performed.");
            Console.WriteLine("validate never starts a child; inspect performs read-only checks and stops its child.");
            return 0;
        }

        if (args.Length == 1 && args[0] == "validate")
        {
            EnsureRuntimeSigningKey();
            return ValidateConfiguration();
        }

        if (args.Length != 1 || args[0] is not ("inspect" or "initialize" or "run"))
        {
            Console.Error.WriteLine("Specify 'validate', 'inspect', 'initialize', or the explicit 'run' command.");
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
            return args[0] switch
            {
                "inspect" => await InspectReadinessAsync(),
                "initialize" => await InitializeDeviceAsync(),
                _ => await RunServerAsync()
            };
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
        var configuration = RestApiServerConfiguration.FromEnvironment();
        var freshPackageDirectory = Environment.GetEnvironmentVariable(
            VendorBootstrapCredentials.PackageDirectoryVariable);
        if (string.IsNullOrWhiteSpace(freshPackageDirectory))
        {
            throw new ControllerConfigurationException(
                $"Set {VendorBootstrapCredentials.PackageDirectoryVariable} to the local Fresh ITL package.");
        }

        VendorBootstrapCredentials.VerifyTargetMatchesFreshPackage(
            configuration.ServerDirectory,
            freshPackageDirectory);
        var bootstrapCredentials = VendorBootstrapCredentials.Load(freshPackageDirectory);
        using var api = new ItlControllerClient(bootstrapCredentials.Username, bootstrapCredentials.Password);
        var supervisor = CreateSupervisor();
        using var child = await supervisor.StartAsync(configuration);
        var noCashOperationCanBeInProgress = true;
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

    private static async Task<int> InitializeDeviceAsync()
    {
        var configuration = RestApiServerConfiguration.FromEnvironment();
        var freshPackageDirectory = Environment.GetEnvironmentVariable(
            VendorBootstrapCredentials.PackageDirectoryVariable);
        if (string.IsNullOrWhiteSpace(freshPackageDirectory))
        {
            throw new ControllerConfigurationException(
                $"Set {VendorBootstrapCredentials.PackageDirectoryVariable} to the local Fresh ITL package.");
        }

        VendorBootstrapCredentials.VerifyTargetMatchesFreshPackage(
            configuration.ServerDirectory,
            freshPackageDirectory);
        var bootstrapCredentials = VendorBootstrapCredentials.Load(freshPackageDirectory);
        using var api = new ItlControllerClient(bootstrapCredentials.Username, bootstrapCredentials.Password);
        var supervisor = CreateSupervisor();
        using var child = await supervisor.StartAsync(configuration);
        var stopAttempted = false;
        var safeToStopChild = true;

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
            var comPorts = GetComPorts(usbDevices.RootElement);
            if (comPorts.Length != 1)
            {
                throw new InvalidOperationException(
                    $"Expected one detected COM port for this controlled initialization; found {comPorts.Length}. No device command was sent.");
            }

            using var connectedDevices = await api.GetAllCashDevicesAsync();
            if (connectedDevices.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("GetAllCashDevices did not return an array.");
            }

            if (connectedDevices.RootElement.GetArrayLength() != 0)
            {
                throw new InvalidOperationException(
                    "The REST API already reports a connected device; refusing to send OpenConnection again.");
            }

            safeToStopChild = false;
            var logDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "KALASH",
                "ssp-logs");
            Directory.CreateDirectory(logDirectory);
            using var openResponse = await api.OpenConnectionAsync(comPorts[0], logDirectory);
            var deviceId = RequiredString(openResponse.RootElement, "deviceID");
            Console.WriteLine("OpenConnection returned a device ID; its value is withheld.");

            var routePoll = await WaitForRouteConfigurationAsync(api, deviceId);
            if (!string.Equals(routePoll.FinalDeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"The device did not reach DISABLED after initialization (state {routePoll.FinalDeviceState}). No acceptor command was sent; the owned server remains running for safe follow-up.");
            }

            Console.WriteLine(
                $"Single poller observed {routePoll.SuccessfulRoutes} successful denomination-route results and DISABLED state.");

            using var complete = await api.GetCompleteCashDeviceAsync(deviceId);
            var model = RequiredString(complete.RootElement, "deviceModel");
            var firmware = RequiredString(complete.RootElement, "firmware");
            var dataset = RequiredString(complete.RootElement, "dataset");
            if (!string.Equals(model, "SPECTRAL_PAYOUT", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(firmware, "NVS2004321016000", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(dataset, "INR02006", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "The connected device identity differs from the authorized Spectral Payout / firmware / dataset. Acceptor remains disabled.");
            }

            if (!TryGetBooleanProperty(complete.RootElement, "noteInEscrow", out var noteInEscrow)
                || noteInEscrow)
            {
                throw new InvalidOperationException(
                    "The device's escrow state is not confirmed empty. The owned server remains running; no cash command was sent.");
            }

            using var levels = await api.GetAllLevelsAsync(deviceId);
            if (levels.RootElement.ValueKind != JsonValueKind.Array
                || levels.RootElement.GetArrayLength() != 6)
            {
                throw new InvalidDataException(
                    "GetAllLevels did not return the six expected INR denominations.");
            }

            var levelSummary = SummarizeLevels(levels.RootElement);
            using var counters = await api.GetCountersAsync(deviceId);
            using var currency = await api.GetCurrencyAssignmentAsync(deviceId);
            if (currency.RootElement.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object))
            {
                throw new InvalidDataException("GetCurrencyAssignment returned an unsupported response shape.");
            }
            if (counters.RootElement.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object))
            {
                throw new InvalidDataException("GetCounters returned an unsupported response shape.");
            }

            Console.WriteLine($"Device: {model}; firmware: {firmware}; dataset: {dataset}.");
            Console.WriteLine($"INR level rows: {levelSummary.RowCount}; readback route codes: {levelSummary.RouteCodes}.");
            Console.WriteLine("Counters and currency assignment were read successfully.");
            Console.WriteLine("Acceptor and automatic escrow acceptance were configured disabled; no cash command was sent.");

            await api.DisconnectDeviceAsync(deviceId);
            using var afterDisconnect = await api.GetAllCashDevicesAsync();
            if (afterDisconnect.RootElement.ValueKind != JsonValueKind.Array
                || afterDisconnect.RootElement.GetArrayLength() != 0)
            {
                throw new InvalidOperationException(
                    "DisconnectDevice returned but the device remains listed. The owned server remains running for safe follow-up.");
            }

            safeToStopChild = true;
            stopAttempted = true;
            await supervisor.StopAsync(
                child,
                noCashOperationCanBeInProgress: true,
                timeout: TimeSpan.FromSeconds(5));
        }
        finally
        {
            if (!stopAttempted && !child.HasExited && safeToStopChild)
            {
                await supervisor.StopAsync(
                    child,
                    noCashOperationCanBeInProgress: true,
                    timeout: TimeSpan.FromSeconds(5));
            }
            else if (!stopAttempted && !child.HasExited && !safeToStopChild)
            {
                Console.Error.WriteLine(
                    $"Device state is unresolved; leaving only this owned REST API child (PID {child.Id}) running. Do not retry OpenConnection or stop this process until the device is reconciled.");
            }
        }

        Console.WriteLine("The device was disconnected with the acceptor disabled; the owned REST API Server child stopped normally.");
        return 0;
    }

    private static async Task<(int SuccessfulRoutes, string FinalDeviceState)> WaitForRouteConfigurationAsync(
        ItlControllerClient api,
        string deviceId)
    {
        const int expectedRoutes = 6;
        var started = Stopwatch.GetTimestamp();
        var successfulRoutes = 0;
        var finalDeviceState = string.Empty;

        while (Stopwatch.GetElapsedTime(started) < TimeSpan.FromSeconds(15))
        {
            using var status = await api.GetDeviceStatusAsync(deviceId);
            var root = status.RootElement;
            if (TryGetStringProperty(root, "deviceState", out var deviceState))
            {
                finalDeviceState = deviceState!;
            }

            if (!root.TryGetProperty("pollBuffer", out var pollBuffer)
                || pollBuffer.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("GetDeviceStatus omitted its pollBuffer array.");
            }

            foreach (var item in pollBuffer.EnumerateArray())
            {
                if (!TryGetStringProperty(item, "type", out var type)
                    || !string.Equals(
                        type,
                        "SetDenominationRouteFinishedEventResponse",
                        StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if (!TryGetBooleanProperty(item, "result", out var succeeded))
                {
                    throw new InvalidDataException(
                        "A denomination-route event omitted its result; hardware configuration is unverified.");
                }

                if (!succeeded)
                {
                    throw new InvalidOperationException(
                        "The device reported a failed denomination route; acceptor remains disabled.");
                }

                successfulRoutes++;
            }

            if (successfulRoutes >= expectedRoutes
                && string.Equals(finalDeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
            {
                return (successfulRoutes, finalDeviceState);
            }

            await Task.Delay(TimeSpan.FromMilliseconds(200));
        }

        throw new TimeoutException(
            $"Only {successfulRoutes} of {expectedRoutes} successful denomination-route results were observed; final device state was {finalDeviceState}. No cash command was sent.");
    }

    private static (int RowCount, string RouteCodes) SummarizeLevels(JsonElement levels)
    {
        var routeCodes = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var level in levels.EnumerateArray())
        {
            if (!TryGetStringProperty(level, "countryCode", out var countryCode)
                || !string.Equals(countryCode, "INR", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("A denomination level did not report the expected INR country code.");
            }

            if (!TryGetBooleanProperty(level, "isInhibited", out var isInhibited)
                || isInhibited)
            {
                throw new InvalidOperationException(
                    "A configured INR denomination is inhibited or its readback is missing. Acceptor remains disabled.");
            }

            if (TryGetStringProperty(level, "acceptRoute", out var route))
            {
                routeCodes.Add(route!);
            }
            else if (TryGetNumberProperty(level, "acceptRoute", out var numericRoute))
            {
                routeCodes.Add(numericRoute);
            }
        }

        return (levels.GetArrayLength(), routeCodes.Count == 0 ? "not provided" : string.Join(", ", routeCodes));
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
        var ports = GetComPorts(response);

        if (response.GetArrayLength() == 0)
        {
            return "GetConnectedUSBDevices returned 0 devices.";
        }

        return ports.Length > 0
            ? $"GetConnectedUSBDevices returned {response.GetArrayLength()} device(s); COM port(s): {string.Join(", ", ports)}."
            : $"GetConnectedUSBDevices returned {response.GetArrayLength()} device(s); no COM port value was available.";
    }

    private static string[] GetComPorts(JsonElement response)
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

        return ports.ToArray();
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

    private static string RequiredString(JsonElement element, string propertyName)
    {
        return TryGetStringProperty(element, propertyName, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidDataException($"The ITL response omitted {propertyName}.");
    }

    private static bool TryGetBooleanProperty(JsonElement value, string propertyName, out bool result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    result = property.Value.GetBoolean();
                    return true;
                }
            }
        }

        result = false;
        return false;
    }

    private static bool TryGetNumberProperty(JsonElement value, string propertyName, out string result)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (string.Equals(property.Name, propertyName, StringComparison.OrdinalIgnoreCase)
                    && property.Value.ValueKind == JsonValueKind.Number)
                {
                    result = property.Value.GetRawText();
                    return true;
                }
            }
        }

        result = string.Empty;
        return false;
    }

    private static bool IsComPort(string? value)
    {
        return value is { Length: > 3 }
            && value.StartsWith("COM", StringComparison.OrdinalIgnoreCase)
            && Regex.IsMatch(value[3..], "^[0-9]+$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
    }
}
