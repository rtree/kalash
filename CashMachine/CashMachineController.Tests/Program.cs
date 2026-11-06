using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Net.Sockets;
using Kalash.CashMachineController;

namespace Kalash.CashMachineController.Tests;

internal static class Program
{
    private const string TestSigningKey = "not-a-production-signing-key-for-controller-tests";

    private static async Task<int> Main()
    {
        await Run("valid vendor package configuration", ValidConfiguration);
        await Run("reject non-loopback server configuration", RejectNonLoopbackConfiguration);
        await Run("reject incompatible runtime configuration", RejectIncompatibleRuntime);
        await Run("reject ambient .NET host lookup", RejectAmbientDotnet);
        await Run("override host filtering and signing key in child environment", ChildEnvironmentOverrides);
        await Run("refuse an occupied port without starting a child", RefuseOccupiedPort);
        await Run("stop only the owned child after safe-state approval", StopOwnedChild);
        await Run("serialize authenticated read-only ITL requests", ReadOnlyItlRequests);
        await Run("do not expose failed-auth response bodies", HideAuthenticationResponseBody);
        await Run("verify allowed and rejected Host headers", VerifyHostFiltering);
        await Run("reject an unfiltered Host header", RejectUnfilteredHost);
        await Run("accept loopback listeners and reject wildcard binding", VerifyLoopbackBinding);
        await Run("fail when no local listener appears", RejectMissingLoopbackBinding);
        Console.WriteLine("13 CashMachineController tests passed.");
        return 0;
    }

    private static Task ValidConfiguration()
    {
        using var serverDirectory = TestServerDirectory.Create();
        var configuration = serverDirectory.CreateConfiguration();
        Check(configuration.Port == 5000, "Configured server port was not 5000.");
        Check(configuration.ServerDirectory == serverDirectory.Path, "Unexpected server directory.");
        return Task.CompletedTask;
    }

    private static Task RejectNonLoopbackConfiguration()
    {
        using var serverDirectory = TestServerDirectory.Create(host: "0.0.0.0");
        ExpectConfigurationFailure(() => serverDirectory.CreateConfiguration());
        return Task.CompletedTask;
    }

    private static Task RejectIncompatibleRuntime()
    {
        using var serverDirectory = TestServerDirectory.Create(runtimeVersion: "9.0.0");
        ExpectConfigurationFailure(() => serverDirectory.CreateConfiguration());
        return Task.CompletedTask;
    }

    private static Task RejectAmbientDotnet()
    {
        using var serverDirectory = TestServerDirectory.Create();
        var rejected = false;
        try
        {
            RestApiServerConfiguration.Create(
                serverDirectory.Path,
                "dotnet",
                TestSigningKey);
        }
        catch (ControllerConfigurationException)
        {
            rejected = true;
        }

        Check(rejected, "Ambient PATH lookup for dotnet.exe was accepted.");
        return Task.CompletedTask;
    }

    private static Task ChildEnvironmentOverrides()
    {
        using var serverDirectory = TestServerDirectory.Create();
        var startInfo = serverDirectory.CreateConfiguration().CreateStartInfo();

        Check(startInfo.FileName == serverDirectory.DotnetPath, "Unexpected .NET host executable.");
        Check(startInfo.WorkingDirectory == serverDirectory.Path, "Unexpected child working directory.");
        Check(startInfo.ArgumentList.Count == 1, "The child received unexpected command arguments.");
        Check(
            startInfo.ArgumentList[0] == Path.Combine(serverDirectory.Path, "CashDevice-RestAPI.dll"),
            "The child DLL path is not from the configured server directory.");
        Check(
            startInfo.Environment["AllowedHosts"] == RestApiServerConfiguration.AllowedHosts,
            "The child Host allowlist was not restricted.");
        Check(
            startInfo.Environment["Jwt__Key"] == TestSigningKey,
            "The protected signing-key override was not passed to the child.");
        Check(
            !startInfo.Environment.ContainsKey(RestApiServerConfiguration.SigningKeyVariable),
            "The input signing-key variable was inherited by the child.");
        Check(!startInfo.Environment.ContainsKey("PATH"), "The parent PATH was inherited by the child.");
        Check(
            startInfo.Environment["DOTNET_ROOT"] == System.IO.Path.GetDirectoryName(serverDirectory.DotnetPath),
            "The child runtime root did not come from the explicit .NET host.");
        Check(startInfo.RedirectStandardOutput && startInfo.RedirectStandardError, "Vendor output was not drained.");
        return Task.CompletedTask;
    }

    private static async Task RefuseOccupiedPort()
    {
        using var serverDirectory = TestServerDirectory.Create();
        var factory = new FakeChildProcessFactory();
        var guard = new FakePortAvailabilityGuard
        {
            Failure = new InvalidOperationException("Port is occupied.")
        };
        var supervisor = new RestApiServerSupervisor(factory, guard, TimeSpan.Zero);
        var rejected = false;

        try
        {
            await supervisor.StartAsync(serverDirectory.CreateConfiguration());
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }

        Check(rejected, "The occupied port was not rejected.");
        Check(factory.StartCount == 0, "A child was started while the port was occupied.");
    }

    private static async Task StopOwnedChild()
    {
        using var serverDirectory = TestServerDirectory.Create();
        var factory = new FakeChildProcessFactory();
        var supervisor = new RestApiServerSupervisor(
            factory,
            new FakePortAvailabilityGuard(),
            TimeSpan.Zero);
        var child = await supervisor.StartAsync(serverDirectory.CreateConfiguration());
        using (child)
        {
            var unsafeStopRejected = false;
            try
            {
                await supervisor.StopAsync(
                    child,
                    noCashOperationCanBeInProgress: false,
                    TimeSpan.FromSeconds(1));
            }
            catch (InvalidOperationException)
            {
                unsafeStopRejected = true;
            }

            Check(unsafeStopRejected, "The supervisor stopped without a safe-state assertion.");
            Check(factory.Process.StopCount == 0, "The child was stopped despite unknown device state.");

            using var foreignChild = new FakeManagedChildProcess(9999);
            var foreignStopRejected = false;
            try
            {
                await supervisor.StopAsync(
                    foreignChild,
                    noCashOperationCanBeInProgress: true,
                    TimeSpan.FromSeconds(1));
            }
            catch (InvalidOperationException)
            {
                foreignStopRejected = true;
            }

            Check(foreignStopRejected, "The supervisor accepted a foreign process handle.");
            Check(foreignChild.StopCount == 0, "The supervisor stopped a foreign process.");

            await supervisor.StopAsync(
                child,
                noCashOperationCanBeInProgress: true,
                TimeSpan.FromSeconds(1));
            Check(factory.Process.StopCount == 1, "The owned child was not stopped exactly once.");
            Check(child.HasExited, "The owned child did not exit after stop.");
        }
    }

    private static async Task ReadOnlyItlRequests()
    {
        var handler = new CapturingHttpHandler();
        using var client = new ItlReadOnlyClient("test-user", "test-password", handler);
        using var usbDevices = await client.GetConnectedUsbDevicesAsync();
        using var cashDevices = await client.GetAllCashDevicesAsync();
        using var completeDevice = await client.GetCompleteCashDeviceAsync("id/with space");
        using var levels = await client.GetAllLevelsAsync("device-01");
        using var counters = await client.GetCountersAsync("device-01");
        using var currency = await client.GetCurrencyAssignmentAsync("device-01");

        Check(handler.Requests.Count == 7, "Unexpected number of ITL HTTP requests.");
        Check(handler.Requests[0].Method == HttpMethod.Post, "Authentication was not a POST.");
        Check(
            handler.Requests[0].Path == "/api/v2/Users/Authenticate",
            "Authentication used an unexpected endpoint.");
        using var authenticationBody = JsonDocument.Parse(handler.Requests[0].Body);
        Check(
            authenticationBody.RootElement.GetProperty("Username").GetString() == "test-user"
                && authenticationBody.RootElement.GetProperty("Password").GetString() == "test-password",
            "Authentication payload did not use the documented field names.");

        var reads = handler.Requests.Skip(1).ToArray();
        Check(reads.All(request => request.Method == HttpMethod.Get), "A read-only operation used a non-GET method.");
        Check(
            reads.All(request => request.Authorization == "Bearer synthetic-test-token"),
            "A read request did not use the in-memory bearer token.");
        Check(
            reads[0].Path == "/api/v2/CashDevice/GetConnectedUSBDevices"
                && reads[1].Path == "/api/v2/CashDevice/GetAllCashDevices"
                && reads[2].Path.Contains("GetCompleteCashDevice?deviceID=id%2Fwith%20space", StringComparison.OrdinalIgnoreCase)
                && reads[3].Path == "/api/v2/CashDevice/GetAllLevels?deviceID=device-01"
                && reads[4].Path == "/api/v2/CashDevice/GetCounters?deviceID=device-01"
                && reads[5].Path == "/api/v2/CashDevice/GetCurrencyAssignment?deviceID=device-01",
            "A read request used an unexpected ITL endpoint.");
    }

    private static async Task HideAuthenticationResponseBody()
    {
        var handler = new CapturingHttpHandler(
            authenticationStatus: HttpStatusCode.Unauthorized,
            authenticationResponseBody: "synthetic-secret-response-body");
        using var client = new ItlReadOnlyClient("test-user", "test-password", handler);
        ItlApiException? observed = null;
        try
        {
            using var _ = await client.GetAllCashDevicesAsync();
        }
        catch (ItlApiException exception)
        {
            observed = exception;
        }

        var failure = observed
            ?? throw new InvalidOperationException("The authentication HTTP error was not surfaced.");
        Check(failure.StatusCode == HttpStatusCode.Unauthorized, "The HTTP error status was not surfaced.");
        Check(
            !failure.Message.Contains("synthetic-secret-response-body", StringComparison.Ordinal)
                && !failure.Message.Contains("test-password", StringComparison.Ordinal),
            "Authentication response data leaked into the exception message.");
    }

    private static async Task VerifyHostFiltering()
    {
        var handler = new CapturingHttpHandler();
        using var client = new ItlReadOnlyClient("test-user", "test-password", handler);
        await client.VerifyHostFilteringAsync();

        Check(handler.Requests.Count == 2, "Host filtering did not use both probe requests.");
        Check(
            handler.Requests[0].Host == "127.0.0.1:5000"
                && handler.Requests[1].Host == "not-allowed.invalid",
            "Host filtering probes used unexpected Host headers.");
        Check(
            handler.Requests.All(request => request.Method == HttpMethod.Get && request.Authorization is null),
            "Host filtering probes were not unauthenticated GET requests.");
    }

    private static async Task RejectUnfilteredHost()
    {
        var handler = new CapturingHttpHandler(rejectUnlistedHost: false);
        using var client = new ItlReadOnlyClient("test-user", "test-password", handler);
        var rejected = false;
        try
        {
            await client.VerifyHostFilteringAsync();
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }

        Check(rejected, "The client accepted a Host filter that allowed an unlisted hostname.");
    }

    private static async Task VerifyLoopbackBinding()
    {
        using var process = new FakeManagedChildProcess(102);
        var verifier = new LoopbackListenerVerifier(
            () => [new IPEndPoint(IPAddress.Loopback, 5000), new IPEndPoint(IPAddress.IPv6Loopback, 5000)]);
        var addresses = await verifier.WaitForLoopbackOnlyAsync(
            process,
            5000,
            TimeSpan.FromSeconds(1));
        Check(
            addresses.Count == 2 && addresses.All(IPAddress.IsLoopback),
            "The loopback-only listener set was not accepted.");

        var wildcard = new LoopbackListenerVerifier(
            () => [new IPEndPoint(IPAddress.Any, 5000)]);
        var rejected = false;
        try
        {
            await wildcard.WaitForLoopbackOnlyAsync(process, 5000, TimeSpan.FromSeconds(1));
        }
        catch (InvalidOperationException)
        {
            rejected = true;
        }

        Check(rejected, "A wildcard listener was accepted as loopback-only.");
    }

    private static async Task RejectMissingLoopbackBinding()
    {
        using var process = new FakeManagedChildProcess(103);
        var verifier = new LoopbackListenerVerifier(static () => []);
        var timedOut = false;
        try
        {
            await verifier.WaitForLoopbackOnlyAsync(
                process,
                5000,
                TimeSpan.FromMilliseconds(20));
        }
        catch (TimeoutException)
        {
            timedOut = true;
        }

        Check(timedOut, "The verifier accepted a server that did not bind a listener.");
    }

    private static async Task Run(string name, Func<Task> test)
    {
        await test();
        Console.WriteLine($"PASS {name}");
    }

    private static void ExpectConfigurationFailure(Action action)
    {
        var rejected = false;
        try
        {
            action();
        }
        catch (ControllerConfigurationException)
        {
            rejected = true;
        }

        Check(rejected, "Invalid vendor configuration was accepted.");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class TestServerDirectory(string path) : IDisposable
    {
        public string Path { get; } = path;
        public string DotnetPath { get; } = System.IO.Path.Combine(
            Directory.GetParent(path)?.FullName ?? throw new InvalidOperationException("Missing test parent."),
            "dotnet.exe");

        public static TestServerDirectory Create(
            string host = "localhost",
            string runtimeVersion = "8.0.0")
        {
            var parent = System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"kalash-controller-test-{Guid.NewGuid():N}");
            var directory = System.IO.Path.Combine(parent, "RESTAPIServer");
            Directory.CreateDirectory(directory);
            File.WriteAllBytes(System.IO.Path.Combine(parent, "dotnet.exe"), []);
            File.WriteAllBytes(System.IO.Path.Combine(directory, "CashDevice-RestAPI.dll"), []);
            File.WriteAllText(System.IO.Path.Combine(directory, "CashDevice-RestAPI.deps.json"), "{}");
            File.WriteAllText(
                System.IO.Path.Combine(directory, "serverconfig.json"),
                JsonSerializer.Serialize(new { ServerConfig = new { Host = host, Port = "5000" } }));
            File.WriteAllText(
                System.IO.Path.Combine(directory, "CashDevice-RestAPI.runtimeconfig.json"),
                JsonSerializer.Serialize(new
                {
                    runtimeOptions = new
                    {
                        tfm = "net8.0",
                        frameworks = new[]
                        {
                            new { name = "Microsoft.NETCore.App", version = runtimeVersion },
                            new { name = "Microsoft.AspNetCore.App", version = "8.0.0" }
                        }
                    }
                }));
            File.WriteAllText(
                System.IO.Path.Combine(directory, "appsettings.json"),
                """{"AllowedHosts":"*"}""");
            return new TestServerDirectory(directory);
        }

        public RestApiServerConfiguration CreateConfiguration()
        {
            return RestApiServerConfiguration.Create(Path, DotnetPath, TestSigningKey);
        }

        public void Dispose()
        {
            var parent = Directory.GetParent(Path)?.FullName;
            if (parent is not null && Directory.Exists(parent))
            {
                Directory.Delete(parent, recursive: true);
            }
        }
    }

    private sealed class FakePortAvailabilityGuard : IPortAvailabilityGuard
    {
        public Exception? Failure { get; init; }

        public void EnsureAvailable(int port)
        {
            Check(port == 5000, "The supervisor checked an unexpected port.");
            if (Failure is not null)
            {
                throw Failure;
            }
        }
    }

    private sealed class FakeChildProcessFactory : IChildProcessFactory
    {
        public FakeManagedChildProcess Process { get; } = new(101);
        public int StartCount { get; private set; }

        public IManagedChildProcess Start(ProcessStartInfo startInfo)
        {
            StartCount++;
            return Process;
        }
    }

    private sealed class FakeManagedChildProcess(int id) : IManagedChildProcess
    {
        private readonly TaskCompletionSource<int> exit = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public int Id { get; } = id;
        public bool HasExited => exit.Task.IsCompleted;
        public int StopCount { get; private set; }

        public Task<int> WaitForExitAsync(CancellationToken cancellationToken = default)
        {
            return exit.Task.WaitAsync(cancellationToken);
        }

        public void StopOwnedProcess()
        {
            StopCount++;
            exit.TrySetResult(0);
        }

        public void Dispose()
        {
        }
    }

    private sealed class CapturingHttpHandler(
        HttpStatusCode authenticationStatus = HttpStatusCode.OK,
        string authenticationResponseBody = """{"token":"synthetic-test-token","expires_seconds":3600}""",
        bool rejectUnlistedHost = true)
        : HttpMessageHandler
    {
        public List<CapturedRequest> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var body = request.Content is null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new CapturedRequest(
                request.Method,
                request.RequestUri?.PathAndQuery ?? string.Empty,
                request.Headers.Host,
                request.Headers.Authorization?.ToString(),
                body));

            if (request.RequestUri?.AbsolutePath == "/api/v2/Users/Authenticate")
            {
                return new HttpResponseMessage(authenticationStatus)
                {
                    Content = new StringContent(authenticationResponseBody, Encoding.UTF8, "application/json")
                };
            }

            if (request.Method == HttpMethod.Get
                && request.RequestUri?.AbsolutePath == "/api/v2/CashDevice/GetConnectedUSBDevices"
                && request.Headers.Authorization is null)
            {
                var status = request.Headers.Host == "not-allowed.invalid" && rejectUnlistedHost
                    ? HttpStatusCode.BadRequest
                    : HttpStatusCode.Unauthorized;
                return new HttpResponseMessage(status);
            }

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json")
            };
        }
    }

    private sealed record CapturedRequest(
        HttpMethod Method,
        string Path,
        string? Host,
        string? Authorization,
        string Body);
}
