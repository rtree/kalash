using System.ComponentModel;

namespace Kalash.CashMachineController;

internal static class Program
{
    private const string InstanceMutexName = @"Local\KALASH.CashMachineController";

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 1 && args[0] is "--help" or "-h")
        {
            Console.WriteLine("Usage: KALASH.CashMachineController.exe validate | run");
            Console.WriteLine(
                $"Requires {RestApiServerConfiguration.ServerDirectoryVariable}, an absolute {RestApiServerConfiguration.DotnetVariable}, and protected {RestApiServerConfiguration.SigningKeyVariable}.");
            Console.WriteLine("The validate command never starts a child process.");
            return 0;
        }

        if (args.Length == 1 && args[0] == "validate")
        {
            return ValidateConfiguration();
        }

        if (args.Length != 1 || args[0] != "run")
        {
            Console.Error.WriteLine("Specify 'validate' or the explicit 'run' command. No server starts by default.");
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
            var configuration = RestApiServerConfiguration.FromEnvironment();
            var supervisor = new RestApiServerSupervisor(
                new SystemChildProcessFactory(),
                new SystemPortAvailabilityGuard());
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

                // This host has no CashDevice command client; revisit this assertion before adding one.
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
        catch (ControllerConfigurationException exception)
        {
            Console.Error.WriteLine($"Configuration error: {exception.Message}");
            return 2;
        }
        catch (InvalidOperationException exception)
        {
            Console.Error.WriteLine($"Controller startup/shutdown failed: {exception.Message}");
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
}
