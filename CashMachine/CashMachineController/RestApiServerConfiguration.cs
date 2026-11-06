using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed class ControllerConfigurationException(string message, Exception? inner = null)
    : Exception(message, inner);

public sealed class RestApiServerConfiguration
{
    public const string ServerDirectoryVariable = "KALASH_ITL_REST_SERVER_DIR";
    public const string SigningKeyVariable = "KALASH_ITL_JWT_KEY";
    public const string DotnetVariable = "KALASH_ITL_DOTNET";
    public const string AllowedHosts = "localhost;127.0.0.1;[::1]";

    private static readonly string[] InheritedEnvironmentVariables =
    [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "DOTNET_ROOT",
        "DOTNET_ROOT_ARM64"
    ];

    private readonly string signingKey;

    private RestApiServerConfiguration(string serverDirectory, string dotnetExecutable, string signingKey)
    {
        ServerDirectory = serverDirectory;
        DotnetExecutable = dotnetExecutable;
        this.signingKey = signingKey;
    }

    public string ServerDirectory { get; }
    public string DotnetExecutable { get; }
    public int Port => 5000;

    public static RestApiServerConfiguration FromEnvironment()
    {
        return Create(
            Environment.GetEnvironmentVariable(ServerDirectoryVariable),
            Environment.GetEnvironmentVariable(DotnetVariable),
            Environment.GetEnvironmentVariable(SigningKeyVariable));
    }

    public static RestApiServerConfiguration Create(
        string? serverDirectory,
        string? dotnetExecutable,
        string? signingKey)
    {
        if (string.IsNullOrWhiteSpace(serverDirectory) || !Path.IsPathFullyQualified(serverDirectory))
        {
            throw new ControllerConfigurationException(
                $"{ServerDirectoryVariable} must point to the dedicated local RESTAPIServer directory.");
        }

        var fullServerDirectory = Path.GetFullPath(serverDirectory);
        var directory = new DirectoryInfo(fullServerDirectory);
        if (!directory.Exists
            || !string.Equals(directory.Name, "RESTAPIServer", StringComparison.OrdinalIgnoreCase)
            || (directory.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new ControllerConfigurationException(
                "The configured server directory must be a real, existing RESTAPIServer directory.");
        }

        RequireFile(fullServerDirectory, "CashDevice-RestAPI.dll");
        RequireFile(fullServerDirectory, "CashDevice-RestAPI.deps.json");
        RequireFile(fullServerDirectory, "CashDevice-RestAPI.runtimeconfig.json");
        RequireFile(fullServerDirectory, "serverconfig.json");
        RequireFile(fullServerDirectory, "appsettings.json");
        RequireFile(fullServerDirectory, "users.json");
        ValidateServerConfiguration(Path.Combine(fullServerDirectory, "serverconfig.json"));
        ValidateRuntimeConfiguration(Path.Combine(fullServerDirectory, "CashDevice-RestAPI.runtimeconfig.json"));

        if (string.IsNullOrWhiteSpace(signingKey) || signingKey.Length < 32)
        {
            throw new ControllerConfigurationException(
                $"{SigningKeyVariable} must be supplied from protected local configuration with at least 32 characters.");
        }

        return new RestApiServerConfiguration(
            fullServerDirectory,
            ResolveDotnetExecutable(dotnetExecutable),
            signingKey);
    }

    public ProcessStartInfo CreateStartInfo()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = DotnetExecutable,
            WorkingDirectory = ServerDirectory,
            UseShellExecute = false,
            CreateNoWindow = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add(Path.Combine(ServerDirectory, "CashDevice-RestAPI.dll"));
        startInfo.Environment.Clear();

        foreach (var name in InheritedEnvironmentVariables)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (value is not null)
            {
                startInfo.Environment[name] = value;
            }
        }

        var dotnetRoot = Path.GetDirectoryName(DotnetExecutable)
            ?? throw new ControllerConfigurationException($"{DotnetVariable} has no installation directory.");
        startInfo.Environment["DOTNET_ROOT"] = dotnetRoot;
        if (RuntimeInformation.ProcessArchitecture == Architecture.Arm64)
        {
            startInfo.Environment["DOTNET_ROOT_ARM64"] = dotnetRoot;
        }

        startInfo.Environment["AllowedHosts"] = AllowedHosts;
        startInfo.Environment["Jwt__Key"] = signingKey;
        startInfo.Environment["Logging__LogLevel__Default"] = "Warning";
        startInfo.Environment["Serilog__MinimumLevel__Default"] = "Warning";
        return startInfo;
    }

    private static string ResolveDotnetExecutable(string? dotnetExecutable)
    {
        if (string.IsNullOrWhiteSpace(dotnetExecutable)
            || !Path.IsPathFullyQualified(dotnetExecutable)
            || !string.Equals(Path.GetFileName(dotnetExecutable), "dotnet.exe", StringComparison.OrdinalIgnoreCase)
            || !File.Exists(dotnetExecutable))
        {
            throw new ControllerConfigurationException(
                $"{DotnetVariable} must point to an existing absolute dotnet.exe path; PATH lookup is disabled.");
        }

        return Path.GetFullPath(dotnetExecutable);
    }

    private static void RequireFile(string directory, string fileName)
    {
        if (!File.Exists(Path.Combine(directory, fileName)))
        {
            throw new ControllerConfigurationException(
                $"The configured RESTAPIServer directory is missing {fileName}.");
        }
    }

    private static void ValidateServerConfiguration(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            if (!root.TryGetProperty("ServerConfig", out var server)
                || !server.TryGetProperty("Host", out var hostElement)
                || !server.TryGetProperty("Port", out var portElement))
            {
                throw new ControllerConfigurationException(
                    "The vendor server configuration must define ServerConfig.Host and ServerConfig.Port.");
            }

            var host = hostElement.ValueKind == JsonValueKind.String ? hostElement.GetString() : null;
            var portText = portElement.ValueKind switch
            {
                JsonValueKind.String => portElement.GetString(),
                JsonValueKind.Number => portElement.GetRawText(),
                _ => null
            };

            if (!string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
                || !int.TryParse(portText, NumberStyles.None, CultureInfo.InvariantCulture, out var port)
                || port != 5000)
            {
                throw new ControllerConfigurationException(
                    "The vendor REST API must be configured for localhost:5000.");
            }
        }
        catch (JsonException exception)
        {
            throw new ControllerConfigurationException("The vendor serverconfig.json is invalid.", exception);
        }
        catch (IOException exception)
        {
            throw new ControllerConfigurationException("The vendor serverconfig.json could not be read.", exception);
        }
    }

    private static void ValidateRuntimeConfiguration(string path)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            if (!root.TryGetProperty("runtimeOptions", out var runtimeOptions)
                || !runtimeOptions.TryGetProperty("tfm", out var tfm)
                || !string.Equals(tfm.GetString(), "net8.0", StringComparison.Ordinal)
                || !runtimeOptions.TryGetProperty("frameworks", out var frameworks)
                || frameworks.ValueKind != JsonValueKind.Array
                || !HasFramework(frameworks, "Microsoft.NETCore.App")
                || !HasFramework(frameworks, "Microsoft.AspNetCore.App"))
            {
                throw new ControllerConfigurationException(
                    "The REST API server must be the .NET 8.0 package with Core and ASP.NET runtimes.");
            }
        }
        catch (JsonException exception)
        {
            throw new ControllerConfigurationException(
                "The vendor runtime configuration is invalid.",
                exception);
        }
        catch (IOException exception)
        {
            throw new ControllerConfigurationException(
                "The vendor runtime configuration could not be read.",
                exception);
        }
    }

    private static bool HasFramework(JsonElement frameworks, string name)
    {
        foreach (var framework in frameworks.EnumerateArray())
        {
            if (framework.TryGetProperty("name", out var frameworkName)
                && frameworkName.GetString() == name
                && framework.TryGetProperty("version", out var version)
                && version.GetString()?.StartsWith("8.", StringComparison.Ordinal) == true)
            {
                return true;
            }
        }

        return false;
    }
}
