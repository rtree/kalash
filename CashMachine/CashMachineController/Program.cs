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
            Console.WriteLine("Usage: KALASH.CashMachineController.exe validate | inspect | initialize | reconcile | finish-initialization | diagnose-cash | run");
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

        if (args.Length != 1 || args[0] is not ("inspect" or "initialize" or "reconcile" or "finish-initialization" or "diagnose-cash" or "run"))
        {
            Console.Error.WriteLine("Specify 'validate', 'inspect', 'initialize', 'reconcile', 'finish-initialization', 'diagnose-cash', or the explicit 'run' command.");
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
                "reconcile" => await ReconcileExistingDeviceAsync(),
                "finish-initialization" => await FinishInitializationAsync(),
                "diagnose-cash" => await DiagnoseCashAsync(),
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
        catch (HttpRequestException exception) when (exception.StatusCode is not null)
        {
            Console.Error.WriteLine(
                $"Central command API returned HTTP {(int)exception.StatusCode.Value}; response body withheld and no cash command was retried.");
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
        var itlCredentials = VendorBootstrapCredentials.Load(freshPackageDirectory);
        var centralConfiguration = CashControllerConfiguration.Load();
        var productDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "KALASH", "cash-product", centralConfiguration.AtmId);
        using var productJournal = centralConfiguration.ProductCashEnabled ? new ProductCashJournal(productDirectory) : null;
        using var central = new CentralCashCommandClient(
            centralConfiguration.CentralUri,
            centralConfiguration.AtmId,
            centralConfiguration.Credential);
        _ = await central.GetCommandAsync(CancellationToken.None);
        var supervisor = CreateSupervisor();
        using var child = await supervisor.StartAsync(configuration);
        var stopRequested = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            stopRequested.TrySetResult();
        };
        Console.CancelKeyPress += cancelHandler;
        using var cancellation = new CancellationTokenSource();
        using var itl = new ItlControllerClient(itlCredentials.Username, itlCredentials.Password);
        ItlDeviceStatusPoller? deviceStatusPoller = null;
        Task? deviceEventDrain = null;
        ProductCashExecutionOwner? productOwner = null;
        var statusPollerDisposed = false;

        try
        {
            await new LoopbackListenerVerifier().WaitForLoopbackOnlyAsync(
                child,
                configuration.Port,
                TimeSpan.FromSeconds(15));
            await itl.VerifyHostFilteringAsync(cancellation.Token);
            await itl.AuthenticateAsync(cancellation.Token);
            using var connectedDevices = await itl.GetAllCashDevicesAsync(cancellation.Token);
            if (connectedDevices.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("GetAllCashDevices did not return an array.");
            }

            string? selectedDeviceId = connectedDevices.RootElement.GetArrayLength() == 1
                ? GetConnectedDeviceId(connectedDevices.RootElement[0]) : null;
            if (centralConfiguration.ProductCashEnabled && selectedDeviceId is not null
                && (await productJournal!.LoadAsync(cancellation.Token)).DeviceId != selectedDeviceId)
                throw new InvalidOperationException("The connected device is not bound to this durable product owner.");
            if (centralConfiguration.ProductCashEnabled && connectedDevices.RootElement.GetArrayLength() == 0)
            {
                using var usb = await itl.GetConnectedUsbDevicesAsync(cancellation.Token);
                var ports = GetComPorts(usb.RootElement);
                if (ports.Length != 1) throw new InvalidOperationException("Product cash requires exactly one USB device.");
                selectedDeviceId = await ProductCashHost.OpenDisabledAsync(
                    true, itl, productJournal!, ports[0], Path.Combine(productDirectory, "ssp-logs"), cancellation.Token);
            }
            if (centralConfiguration.ProductCashEnabled && selectedDeviceId is null)
                throw new InvalidOperationException("Product cash requires one exclusively owned device.");
            ICashStartDevice device;
            if (selectedDeviceId is not null)
            {
                var deviceId = selectedDeviceId;
                var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                var eventJournal = Path.Combine(
                    localData,
                    "KALASH",
                    "cash-device-events",
                    $"{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.jsonl");
                deviceStatusPoller = new ItlDeviceStatusPoller(itl, deviceId,
                    centralConfiguration.ProductCashEnabled ? Path.Combine(productDirectory, "raw.jsonl") : eventJournal);
                if (centralConfiguration.ProductCashEnabled)
                {
                    productOwner = new ProductCashExecutionOwner(centralConfiguration.AtmId, central, central,
                        new ItlProductCashDevice(itl, deviceStatusPoller, deviceId), productJournal!,
                        CashCommandJournal.FromLocalApplicationData(), physicalAcceptanceAuthorized: true);
                    device = productOwner;
                }
                else
                {
                    deviceStatusPoller.Start();
                    await WaitForStatusSnapshotAsync(deviceStatusPoller, TimeSpan.FromSeconds(5), cancellation.Token);
                    device = new ItlCashStartDevice(itl, deviceStatusPoller, deviceId);
                    deviceEventDrain = DrainDeviceEventsAsync(deviceStatusPoller, cancellation.Token);
                }
                Console.WriteLine($"ITL device {deviceId} attached with one durable status/event poller.");
            }
            else
            {
                device = new UnavailableCashStartDevice(
                    connectedDevices.RootElement.GetArrayLength() == 0
                        ? "no_connected_device"
                        : "multiple_connected_devices");
                Console.Error.WriteLine(
                    $"ITL status is unavailable: {connectedDevices.RootElement.GetArrayLength()} connected devices; cash commands will fail preflight.");
            }

            var journal = CashCommandJournal.FromLocalApplicationData();
            var processor = new CashStartCommandProcessor(
                centralConfiguration.AtmId,
                central,
                device,
                journal,
                physicalAcceptanceAuthorized: false);
            var commandPoller = new CashCommandPoller(central, journal, processor);
            Console.WriteLine(
                $"Controller ready for Central {centralConfiguration.CentralUri} / ATM {centralConfiguration.AtmId}. " +
                (centralConfiguration.ProductCashEnabled
                    ? "Owner-attended product cash gate is enabled; signed Central permission and all device preconditions remain mandatory."
                    : "Physical acceptance remains disabled."));

            var exitTask = child.WaitForExitAsync();
            var commandTask = ProductCashHost.RunSelectedAsync(centralConfiguration.ProductCashEnabled,
                () => productOwner!.RunAsync(cancellation.Token), () => commandPoller.RunAsync(cancellation.Token));
            if (await Task.WhenAny(exitTask, stopRequested.Task, commandTask) == exitTask)
            {
                var exitCode = await exitTask;
                Console.Error.WriteLine($"REST API Server child exited unexpectedly with code {exitCode}.");
                return 1;
            }

            if (commandTask.IsCompleted)
            {
                await commandTask;
                throw new InvalidOperationException("The Central cash command worker stopped unexpectedly.");
            }

            cancellation.Cancel();
            try
            {
                await commandTask;
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
            }
            if (deviceEventDrain is not null)
            {
                try
                {
                    await deviceEventDrain;
                }
                catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
                {
                }
            }

            if (deviceStatusPoller is not null)
            {
                await deviceStatusPoller.DisposeAsync();
                statusPollerDisposed = true;
            }

            var safeToStopChild = deviceStatusPoller is null;
            if ((productOwner is null || !productOwner.State.Locked && productOwner.State.Intake is not { Closed: false })
                && deviceStatusPoller?.Latest is { } finalStatus
                && string.Equals(finalStatus.DeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
            {
                using var connected = await itl.GetAllCashDevicesAsync(CancellationToken.None);
                if (connected.RootElement.ValueKind == JsonValueKind.Array
                    && connected.RootElement.GetArrayLength() == 1)
                {
                    var deviceId = GetConnectedDeviceId(connected.RootElement[0]);
                    using var complete = await itl.GetCompleteCashDeviceAsync(deviceId, CancellationToken.None);
                    var readback = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
                    if (!readback.NoteInEscrow && readback.DeviceError == 0 && readback.DispenseState == 0)
                    {
                        await itl.DisconnectDeviceAsync(deviceId, CancellationToken.None);
                        using var afterDisconnect = await itl.GetAllCashDevicesAsync(CancellationToken.None);
                        safeToStopChild = afterDisconnect.RootElement.ValueKind == JsonValueKind.Array
                            && afterDisconnect.RootElement.GetArrayLength() == 0;
                    }
                }
            }

            if (!safeToStopChild)
            {
                Console.Error.WriteLine(
                    $"Device state is not verified safe for shutdown; REST API child {child.Id} remains running for reconciliation.");
                return 1;
            }

            await supervisor.StopAsync(
                child,
                noCashOperationCanBeInProgress: true,
                timeout: TimeSpan.FromSeconds(5));
            Console.WriteLine("The owned REST API Server child stopped.");
            return 0;
        }
        finally
        {
            cancellation.Cancel();
            Console.CancelKeyPress -= cancelHandler;
            if (deviceStatusPoller is not null && !statusPollerDisposed)
            {
                await deviceStatusPoller.DisposeAsync();
            }
        }
    }

    private static async Task<int> DiagnoseCashAsync()
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
        var credentials = VendorBootstrapCredentials.Load(freshPackageDirectory);
        using var api = new ItlControllerClient(credentials.Username, credentials.Password);
        var supervisor = CreateSupervisor();
        using var child = await supervisor.StartAsync(configuration);
        ItlDeviceStatusPoller? statusPoller = null;
        var deviceId = (string?)null;
        var deviceMayBeConnected = false;
        var connectionOpenedByThisProcess = false;
        var diagnosticStarted = false;
        var diagnosticSucceeded = false;
        var safeToStopChild = false;
        try
        {
            await new LoopbackListenerVerifier().WaitForLoopbackOnlyAsync(
                child,
                configuration.Port,
                TimeSpan.FromSeconds(15));
            await api.VerifyHostFilteringAsync();
            await api.AuthenticateAsync();

            using var connected = await api.GetAllCashDevicesAsync();
            if (connected.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("GetAllCashDevices did not return an array.");
            }

            deviceMayBeConnected = connected.RootElement.GetArrayLength() > 0;
            if (connected.RootElement.GetArrayLength() > 1)
            {
                throw new InvalidOperationException(
                    "Cash diagnostic requires exactly one ITL device; no device command was sent.");
            }

            if (connected.RootElement.GetArrayLength() == 1)
            {
                deviceId = GetConnectedDeviceId(connected.RootElement[0]);
            }
            else
            {
                using var usbDevices = await api.GetConnectedUsbDevicesAsync();
                var ports = GetComPorts(usbDevices.RootElement);
                if (ports.Length != 1)
                {
                    throw new InvalidOperationException(
                        $"Cash diagnostic requires exactly one detected COM port; found {ports.Length}.");
                }

                var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrWhiteSpace(localData))
                {
                    throw new IOException("Windows Local Application Data is unavailable for SSP diagnostics.");
                }

                var logDirectory = Path.Combine(localData, "KALASH", "itl-ssp-logs");
                Directory.CreateDirectory(logDirectory);
                deviceMayBeConnected = true;
                using var opened = await api.OpenConnectionAsync(
                    ports[0],
                    logDirectory,
                    CancellationToken.None,
                    new HashSet<int> { 10_000 });
                connectionOpenedByThisProcess = true;
                deviceId = RequiredString(opened.RootElement, "deviceID");
                var routePoll = await WaitForRouteConfigurationAsync(api, deviceId);
                if (routePoll.SuccessfulRoutes != 6
                    || !string.Equals(routePoll.FinalDeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException(
                        "The diagnostic device did not verify six routes and DISABLED; no notes may be inserted.");
                }
            }

            var eventDirectory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "KALASH",
                "cash-device-events");
            var eventJournal = Path.Combine(
                eventDirectory,
                $"diagnostic-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.jsonl");
            statusPoller = new ItlDeviceStatusPoller(api, deviceId!, eventJournal);
            statusPoller.Start();
            await WaitForStatusSnapshotAsync(statusPoller, TimeSpan.FromSeconds(5), CancellationToken.None);
            var device = new ItlCashStartDevice(api, statusPoller, deviceId!);
            var preflight = await device.CheckPreconditionsAsync(CancellationToken.None);
            if (!preflight.Ready)
            {
                throw new InvalidOperationException(
                    $"Cash diagnostic preflight failed: {preflight.Reason}. No note was requested.");
            }

            Console.WriteLine("Local cash diagnostic only; it creates no donation, mint, or Central record.");
            Console.WriteLine("Owner/operator must be present and approve one owner-provided ₹100 INR note.");
            Console.WriteLine("Do not insert a note until the controller explicitly reports acceptance.");
            Console.Write("Type exactly OWNER PRESENT - ONE INR 100 NOTE to continue: ");
            if (!string.Equals(
                    Console.ReadLine(),
                    "OWNER PRESENT - ONE INR 100 NOTE",
                    StringComparison.Ordinal))
            {
                Console.WriteLine("Diagnostic cancelled before enabling the acceptor.");
                safeToStopChild = false;
                return 2;
            }

            var workflow = new CashReceptionDiagnostic(
                device,
                CashDiagnosticJournal.FromLocalApplicationData());
            diagnosticStarted = true;
            var result = await workflow.RunFirstNoteAsync(cancellationToken =>
            {
                Console.Write("One matching STORED event is durable. Inspect the machine and type DONE to close: ");
                if (!string.Equals(Console.ReadLine(), "DONE", StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("The operator did not confirm Done.");
                }

                return Task.CompletedTask;
            }, CancellationToken.None, () =>
            {
                Console.WriteLine("The device reported ACCEPTING for this diagnostic. Insert exactly one ₹100 INR note.");
            });
            Console.WriteLine(
                $"Local diagnostic reconciled {result.AcceptedNotes} note / {result.AcceptedPaise} paise. No donation or mint was created.");
            diagnosticSucceeded = true;
        }
        finally
        {
            if (statusPoller is not null)
            {
                await statusPoller.DisposeAsync();
            }

            if (!deviceMayBeConnected)
            {
                safeToStopChild = true;
            }
            else if (connectionOpenedByThisProcess
                && (!diagnosticStarted || diagnosticSucceeded)
                && deviceId is not null
                && statusPoller?.Latest is { } finalStatus
                && string.Equals(finalStatus.DeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
            {
                using var complete = await api.GetCompleteCashDeviceAsync(deviceId);
                var readback = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
                if (!readback.NoteInEscrow && readback.DeviceError == 0 && readback.DispenseState == 0)
                {
                    await api.DisconnectDeviceAsync(deviceId);
                    using var afterDisconnect = await api.GetAllCashDevicesAsync();
                    safeToStopChild = afterDisconnect.RootElement.ValueKind == JsonValueKind.Array
                        && afterDisconnect.RootElement.GetArrayLength() == 0;
                }
            }

            if (safeToStopChild)
            {
                await supervisor.StopAsync(child, noCashOperationCanBeInProgress: true, TimeSpan.FromSeconds(5));
            }
            else
            {
                Console.Error.WriteLine(
                    $"Cash/device result is unresolved. The owned REST API child {child.Id} remains running; do not retry cash commands.");
            }
        }

        return 0;
    }

    private static async Task WaitForStatusSnapshotAsync(
        ItlDeviceStatusPoller poller,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (poller.Latest is null && DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(50), cancellationToken);
        }

        if (poller.Latest is null)
        {
            throw new TimeoutException("The single ITL status poller produced no initial observation.");
        }
    }

    private static async Task DrainDeviceEventsAsync(
        ItlDeviceStatusPoller poller,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            _ = await poller.ReadNextAsync(cancellationToken);
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
            var readback = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
            if (readback.DeviceModel != 2
                || readback.DeviceType != 3
                || readback.BaseDeviceType != 0
                || !string.Equals(readback.Firmware, "NVS2004321016000", StringComparison.OrdinalIgnoreCase)
                || !string.Equals(readback.Dataset, "INR02006", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "The connected device identity differs from the authorized Spectral Payout / firmware / dataset. Acceptor remains disabled.");
            }

            if (!readback.IsOpen
                || !readback.IsStarted
                || readback.DeviceError != 0
                || readback.DispenseState != 0
                || readback.NoteInEscrow)
            {
                throw new InvalidOperationException(
                    "Device readiness, error, dispense, or escrow readback is not safe. The owned server remains running; no cash command was sent.");
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

            Console.WriteLine(
                $"Device model/type/base codes: {readback.DeviceModel}/{readback.DeviceType}/{readback.BaseDeviceType}; firmware: {readback.Firmware}; dataset: {readback.Dataset}; state code: {readback.DeviceState}.");
            Console.WriteLine(
                $"Device open/started: {readback.IsOpen}/{readback.IsStarted}; error={readback.DeviceError}; dispenseState={readback.DispenseState}; noteInEscrow={readback.NoteInEscrow}.");
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

    private static async Task<int> ReconcileExistingDeviceAsync()
    {
        var configuration = RestApiServerConfiguration.FromEnvironment();
        var expectedPidText = Environment.GetEnvironmentVariable("KALASH_ITL_EXPECTED_SERVER_PID");
        if (!int.TryParse(expectedPidText, out var expectedPid) || expectedPid <= 0)
        {
            throw new ControllerConfigurationException(
                "The local reconciliation runner did not provide a verified server PID.");
        }

        using var process = Process.GetProcessById(expectedPid);
        var expectedDotnet = Path.GetFullPath(configuration.DotnetExecutable);
        var imagePath = process.MainModule?.FileName;
        if (process.HasExited
            || !string.Equals(process.ProcessName, "dotnet", StringComparison.OrdinalIgnoreCase)
            || imagePath is null
            || !string.Equals(Path.GetFullPath(imagePath), expectedDotnet, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "The specified server PID is no longer the expected local .NET host; refusing to attach.");
        }

        var listeners = IPGlobalProperties.GetIPGlobalProperties()
            .GetActiveTcpListeners()
            .Where(endpoint => endpoint.Port == configuration.Port)
            .ToArray();
        if (listeners.Length == 0 || listeners.Any(endpoint => !IPAddress.IsLoopback(endpoint.Address)))
        {
            throw new InvalidOperationException(
                "The existing REST API does not have a loopback-only listener; refusing to attach.");
        }

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

        Console.WriteLine($"Verified existing loopback listener ownership for PID {expectedPid}.");
        await api.VerifyHostFilteringAsync();
        await api.AuthenticateAsync();
        Console.WriteLine("ITL API authentication succeeded; bearer token withheld.");

        using var connectedDevices = await api.GetAllCashDevicesAsync();
        if (connectedDevices.RootElement.ValueKind != JsonValueKind.Array
            || connectedDevices.RootElement.GetArrayLength() != 1)
        {
            throw new InvalidDataException(
                "Expected one connected device for reconciliation; no write command was sent.");
        }

        var connectedEntry = connectedDevices.RootElement[0];
        var deviceId = GetConnectedDeviceId(connectedEntry);
        using var complete = await api.GetCompleteCashDeviceAsync(deviceId);
        using var levels = await api.GetAllLevelsAsync(deviceId);
        using var counters = await api.GetCountersAsync(deviceId);
        using var currency = await api.GetCurrencyAssignmentAsync(deviceId);
        using var status = await api.GetDeviceStatusAsync(deviceId);

        var readback = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
        var deviceState = FindStringProperty(status.RootElement, "deviceState", "state") ?? "unknown";
        var eventTypes = DescribeEventTypes(status.RootElement);
        var routeCodes = levels.RootElement.ValueKind == JsonValueKind.Array
            ? SummarizeLevels(levels.RootElement).RouteCodes
            : "unavailable";

        Console.WriteLine(
            $"Device model/type/base codes: {readback.DeviceModel}/{readback.DeviceType}/{readback.BaseDeviceType}; firmware={readback.Firmware}; dataset={readback.Dataset}.");
        Console.WriteLine(
            $"Identity field names: connected=[{DescribeIdentityFieldNames(connectedEntry)}]; complete=[{DescribeIdentityFieldNames(complete.RootElement)}].");
        Console.WriteLine($"Complete response shape: {DescribeJsonShape(complete.RootElement)}.");
        Console.WriteLine(
            $"Complete state code={readback.DeviceState}; status state={deviceState}; open/started={readback.IsOpen}/{readback.IsStarted}; error={readback.DeviceError}; dispenseState={readback.DispenseState}; noteInEscrow={readback.NoteInEscrow}; readback route codes={routeCodes}.");
        Console.WriteLine(
            $"Levels={DescribeJsonCollection(levels.RootElement)}; counters={DescribeJsonCollection(counters.RootElement)}; currency={DescribeJsonCollection(currency.RootElement)}.");
        Console.WriteLine($"Single poller consumed {eventTypes}.");
        Console.WriteLine(
            $"No device-changing command was sent. The existing REST API child PID {expectedPid} remains running for follow-up.");
        return 0;
    }

    private static async Task<int> FinishInitializationAsync()
    {
        var configuration = RestApiServerConfiguration.FromEnvironment();
        var expectedPidText = Environment.GetEnvironmentVariable("KALASH_ITL_EXPECTED_SERVER_PID");
        if (!int.TryParse(expectedPidText, out var expectedPid) || expectedPid <= 0)
        {
            throw new ControllerConfigurationException(
                "The local completion runner did not provide a verified server PID.");
        }

        using var process = Process.GetProcessById(expectedPid);
        var expectedDotnet = Path.GetFullPath(configuration.DotnetExecutable);
        var imagePath = process.MainModule?.FileName;
        if (process.HasExited
            || !string.Equals(process.ProcessName, "dotnet", StringComparison.OrdinalIgnoreCase)
            || imagePath is null
            || !string.Equals(Path.GetFullPath(imagePath), expectedDotnet, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "The specified server PID is no longer the expected local .NET host; refusing to attach.");
        }

        var listeners = IPGlobalProperties.GetIPGlobalProperties()
            .GetActiveTcpListeners()
            .Where(endpoint => endpoint.Port == configuration.Port)
            .ToArray();
        if (listeners.Length == 0 || listeners.Any(endpoint => !IPAddress.IsLoopback(endpoint.Address)))
        {
            throw new InvalidOperationException(
                "The existing REST API does not have a loopback-only listener; refusing to attach.");
        }

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
        await api.VerifyHostFilteringAsync();
        await api.AuthenticateAsync();

        using var connectedDevices = await api.GetAllCashDevicesAsync();
        if (connectedDevices.RootElement.ValueKind != JsonValueKind.Array
            || connectedDevices.RootElement.GetArrayLength() != 1)
        {
            throw new InvalidDataException(
                "Expected one connected device before completing initialization; no write command was sent.");
        }

        var deviceId = GetConnectedDeviceId(connectedDevices.RootElement[0]);
        using var status = await api.GetDeviceStatusAsync(deviceId);
        var currentDeviceState = FindStringProperty(status.RootElement, "deviceState", "state");
        if (!string.Equals(currentDeviceState, "DISABLED", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "Current device state is not DISABLED; DisconnectDevice was not sent.");
        }

        using var complete = await api.GetCompleteCashDeviceAsync(deviceId);
        var readback = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
        if (readback.DeviceModel != 2
            || readback.DeviceType != 3
            || readback.BaseDeviceType != 0
            || !string.Equals(readback.Firmware, "NVS2004321016000", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(readback.Dataset, "INR02006", StringComparison.OrdinalIgnoreCase)
            || !readback.IsOpen
            || !readback.IsStarted
            || readback.DeviceError != 0
            || readback.DispenseState != 0
            || readback.NoteInEscrow)
        {
            throw new InvalidOperationException(
                "Current numeric identity/state readback does not meet the authorized Spectral Payout safe-shutdown criteria.");
        }

        using var levels = await api.GetAllLevelsAsync(deviceId);
        var levelSummary = SummarizeLevels(levels.RootElement);
        using var counters = await api.GetCountersAsync(deviceId);
        using var currency = await api.GetCurrencyAssignmentAsync(deviceId);
        if (currency.RootElement.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object)
            || counters.RootElement.ValueKind is not (JsonValueKind.Array or JsonValueKind.Object))
        {
            throw new InvalidDataException(
                "Inventory or counter readback is incomplete; DisconnectDevice was not sent.");
        }

        Console.WriteLine(
            $"Verified numeric device codes {readback.DeviceModel}/{readback.DeviceType}/{readback.BaseDeviceType}, firmware/dataset, DISABLED, empty escrow, and {levelSummary.RowCount} INR levels; route readback codes={levelSummary.RouteCodes}.");

        await api.DisconnectDeviceAsync(deviceId);
        using var afterDisconnect = await api.GetAllCashDevicesAsync();
        if (afterDisconnect.RootElement.ValueKind != JsonValueKind.Array
            || afterDisconnect.RootElement.GetArrayLength() != 0)
        {
            throw new InvalidOperationException(
                "DisconnectDevice returned but the device remains listed; keep the server running and reconcile without retrying.");
        }

        Console.WriteLine("DisconnectDevice succeeded; GetAllCashDevices is empty. No note was accepted or dispensed.");
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

    private static string? FindStringProperty(JsonElement value, params string[] propertyNames)
    {
        foreach (var name in propertyNames)
        {
            if (TryGetStringProperty(value, name, out var result) && !string.IsNullOrWhiteSpace(result))
            {
                return result;
            }
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                var nested = FindStringProperty(property.Value, propertyNames);
                if (nested is not null)
                {
                    return nested;
                }
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                var nested = FindStringProperty(item, propertyNames);
                if (nested is not null)
                {
                    return nested;
                }
            }
        }

        return null;
    }

    private static string DescribeEventTypes(JsonElement status)
    {
        if (!status.TryGetProperty("pollBuffer", out var pollBuffer)
            || pollBuffer.ValueKind != JsonValueKind.Array)
        {
            return "no event-type list";
        }

        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in pollBuffer.EnumerateArray())
        {
            if (TryGetStringProperty(item, "type", out var type))
            {
                names.Add(type!);
            }
            else if (TryGetStringProperty(item, "eventTypeAsString", out var eventType))
            {
                names.Add(eventType!);
            }
        }

        return names.Count == 0 ? "no pending events" : string.Join(", ", names);
    }

    private static string DescribeIdentityFieldNames(JsonElement value)
    {
        var names = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        CollectIdentityFieldNames(value, names, 0);
        return names.Count == 0 ? "none" : string.Join(", ", names);
    }

    private static void CollectIdentityFieldNames(
        JsonElement value,
        ISet<string> names,
        int depth)
    {
        if (depth > 4)
        {
            return;
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name.Contains("model", StringComparison.OrdinalIgnoreCase)
                    || property.Name.Contains("device", StringComparison.OrdinalIgnoreCase)
                    || property.Name.Equals("firmware", StringComparison.OrdinalIgnoreCase)
                    || property.Name.Equals("dataset", StringComparison.OrdinalIgnoreCase))
                {
                    names.Add(property.Name);
                }

                CollectIdentityFieldNames(property.Value, names, depth + 1);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray())
            {
                CollectIdentityFieldNames(item, names, depth + 1);
            }
        }
    }

    private static string DescribeJsonShape(JsonElement value)
    {
        var fields = new List<string>();
        CollectJsonShape(value, string.Empty, fields, 0);
        return fields.Count == 0 ? value.ValueKind.ToString() : string.Join(", ", fields);
    }

    private static void CollectJsonShape(
        JsonElement value,
        string prefix,
        ICollection<string> fields,
        int depth)
    {
        if (depth > 4 || fields.Count >= 80)
        {
            return;
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in value.EnumerateObject())
            {
                var path = string.IsNullOrEmpty(prefix) ? property.Name : $"{prefix}.{property.Name}";
                fields.Add($"{path}:{property.Value.ValueKind}");
                CollectJsonShape(property.Value, path, fields, depth + 1);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
        {
            fields.Add($"{prefix}[]:{value.GetArrayLength()}");
            if (value.GetArrayLength() > 0)
            {
                CollectJsonShape(value[0], $"{prefix}[]", fields, depth + 1);
            }
        }
    }

    private static string DescribeJsonCollection(JsonElement value)
    {
        return value.ValueKind switch
        {
            JsonValueKind.Array => $"{value.GetArrayLength()} row(s)",
            JsonValueKind.Object => $"{value.EnumerateObject().Count()} field(s)",
            _ => "invalid response"
        };
    }

    private static string RequiredString(JsonElement element, string propertyName)
    {
        return TryGetStringProperty(element, propertyName, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new InvalidDataException($"The ITL response omitted {propertyName}.");
    }

    private static string GetConnectedDeviceId(JsonElement device)
    {
        if (device.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(device.GetString()))
        {
            return device.GetString()!;
        }

        foreach (var name in new[] { "deviceID", "id" })
        {
            if (TryGetStringProperty(device, name, out var value) && !string.IsNullOrWhiteSpace(value))
            {
                return value!;
            }
        }

        var shape = device.ValueKind == JsonValueKind.Object
            ? string.Join(",", device.EnumerateObject().Select(property => property.Name))
            : device.ValueKind.ToString();
        throw new InvalidDataException(
            $"The connected-device entry has an unrecognized shape ({shape}); no command was sent.");
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
