using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;

namespace Kalash.CashMachineController;

public interface IManagedChildProcess : IDisposable
{
    int Id { get; }
    bool HasExited { get; }
    Task<int> WaitForExitAsync(CancellationToken cancellationToken = default);
    void StopOwnedProcess();
}

public interface IChildProcessFactory
{
    IManagedChildProcess Start(ProcessStartInfo startInfo);
}

public interface IPortAvailabilityGuard
{
    void EnsureAvailable(int port);
}

public sealed class RestApiServerSupervisor(
    IChildProcessFactory processFactory,
    IPortAvailabilityGuard portAvailabilityGuard,
    TimeSpan? startupGracePeriod = null)
{
    private readonly TimeSpan startupGracePeriod = startupGracePeriod ?? TimeSpan.FromMilliseconds(500);
    private IManagedChildProcess? child;

    public async Task<IManagedChildProcess> StartAsync(
        RestApiServerConfiguration configuration,
        CancellationToken cancellationToken = default)
    {
        if (child is not null)
        {
            throw new InvalidOperationException("This controller already owns a REST API Server child.");
        }

        portAvailabilityGuard.EnsureAvailable(configuration.Port);
        child = processFactory.Start(configuration.CreateStartInfo());
        await Task.Delay(startupGracePeriod, cancellationToken);

        if (child.HasExited)
        {
            var exitCode = await child.WaitForExitAsync(cancellationToken);
            child.Dispose();
            child = null;
            throw new InvalidOperationException(
                $"The REST API Server child exited during startup with code {exitCode}.");
        }

        return child;
    }

    public async Task StopAsync(
        IManagedChildProcess ownedChild,
        bool noCashOperationCanBeInProgress,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        if (!ReferenceEquals(child, ownedChild))
        {
            throw new InvalidOperationException("Refusing to stop a process not started by this controller.");
        }

        if (!noCashOperationCanBeInProgress)
        {
            throw new InvalidOperationException(
                "Refusing to stop the REST API Server while device operation state is active or unknown.");
        }

        if (ownedChild.HasExited)
        {
            return;
        }

        ownedChild.StopOwnedProcess();
        try
        {
            await ownedChild.WaitForExitAsync(cancellationToken).WaitAsync(timeout, cancellationToken);
        }
        catch (TimeoutException exception)
        {
            throw new InvalidOperationException(
                $"Owned REST API Server process {ownedChild.Id} did not stop; no other process was terminated.",
                exception);
        }
    }
}

public sealed class SystemPortAvailabilityGuard : IPortAvailabilityGuard
{
    public void EnsureAvailable(int port)
    {
        if (IPGlobalProperties.GetIPGlobalProperties()
            .GetActiveTcpListeners()
            .Any(endpoint => endpoint.Port == port))
        {
            throw new InvalidOperationException(
                $"TCP port {port} is already in use. The controller will not attach to or stop its owner.");
        }
    }
}

public sealed class LoopbackListenerVerifier(Func<IPEndPoint[]>? listenerProvider = null)
{
    private readonly Func<IPEndPoint[]> listenerProvider = listenerProvider
        ?? IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners;

    public async Task<IReadOnlyList<IPAddress>> WaitForLoopbackOnlyAsync(
        IManagedChildProcess child,
        int port,
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var started = Stopwatch.GetTimestamp();
        while (Stopwatch.GetElapsedTime(started) < timeout)
        {
            if (child.HasExited)
            {
                var exitCode = await child.WaitForExitAsync(cancellationToken);
                throw new InvalidOperationException(
                    $"The REST API Server child exited before binding its port with code {exitCode}.");
            }

            var listeners = listenerProvider().Where(endpoint => endpoint.Port == port).ToArray();
            if (listeners.Length > 0)
            {
                if (listeners.Any(endpoint => !IPAddress.IsLoopback(endpoint.Address)))
                {
                    throw new InvalidOperationException(
                        $"The REST API Server port {port} is listening on a non-loopback address.");
                }

                return listeners.Select(endpoint => endpoint.Address).Distinct().ToArray();
            }

            await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken);
        }

        throw new TimeoutException(
            $"The REST API Server did not bind its loopback port {port} before the startup deadline.");
    }
}

public sealed class SystemChildProcessFactory : IChildProcessFactory
{
    public IManagedChildProcess Start(ProcessStartInfo startInfo)
    {
        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };

        // Vendor output may contain credentials or tokens; drain it without recording it.
        process.OutputDataReceived += static (_, _) => { };
        process.ErrorDataReceived += static (_, _) => { };

        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("The REST API Server child process did not start.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return new SystemManagedChildProcess(process);
    }
}

public sealed class SystemManagedChildProcess(Process process) : IManagedChildProcess
{
    public int Id => process.Id;
    public bool HasExited => process.HasExited;

    public async Task<int> WaitForExitAsync(CancellationToken cancellationToken = default)
    {
        await process.WaitForExitAsync(cancellationToken);
        return process.ExitCode;
    }

    public void StopOwnedProcess()
    {
        if (!process.HasExited)
        {
            process.Kill(entireProcessTree: false);
        }
    }

    public void Dispose()
    {
        process.Dispose();
    }
}
