using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record VendorBootstrapCredentials(string Username, string Password)
{
    public const string PackageDirectoryVariable = "KALASH_ITL_FRESH_PACKAGE_DIR";

    public static VendorBootstrapCredentials Load(string freshPackageDirectory)
    {
        if (string.IsNullOrWhiteSpace(freshPackageDirectory)
            || !Path.IsPathFullyQualified(freshPackageDirectory))
        {
            throw new ControllerConfigurationException(
                "KALASH_ITL_FRESH_PACKAGE_DIR must point to the local, freshly downloaded ITL SDK package.");
        }

        var root = Path.GetFullPath(freshPackageDirectory);
        var runtime = GetRuntimeDirectory(root);
        var collectionPath = Path.Combine(root, "Postman", "Cash-Device-REST-API.postman_collection.json");
        _ = ReadSingleUser(runtime);

        try
        {
            using var collection = JsonDocument.Parse(File.ReadAllText(collectionPath));
            var versionFolder = FindNamedItem(collection.RootElement.GetProperty("item"), "v2");
            if (versionFolder is null)
            {
                throw new ControllerConfigurationException("The vendor API collection has no v2 request group.");
            }

            var authenticate = ReadRawRequestBody(versionFolder.Value, "Authenticate");
            using var authBody = JsonDocument.Parse(authenticate);
            var username = RequiredString(authBody.RootElement, "Username");
            var password = RequiredString(authBody.RootElement, "Password");
            VerifyConfiguredUser(runtime, username);
            return new VendorBootstrapCredentials(username, password);
        }
        catch (JsonException exception)
        {
            throw new ControllerConfigurationException(
                "The local Fresh ITL package credentials collection is invalid.",
                exception);
        }
        catch (IOException exception)
        {
            throw new ControllerConfigurationException(
                "The local Fresh ITL package credentials collection could not be read.",
                exception);
        }
    }

    public static void VerifyTargetMatchesFreshPackage(
        string targetServerDirectory,
        string freshPackageDirectory)
    {
        var source = GetRuntimeDirectory(Path.GetFullPath(freshPackageDirectory));
        var sourceUsers = ReadSingleUser(source);
        var targetUsers = ReadSingleUser(targetServerDirectory);
        var usernameMatches = string.Equals(
            RequiredString(sourceUsers, "Username"),
            RequiredString(targetUsers, "Username"),
            StringComparison.Ordinal);
        var hashMatches = FixedTimeStringEquals(
            RequiredString(sourceUsers, "PasswordHash"),
            RequiredString(targetUsers, "PasswordHash"));
        var saltMatches = FixedTimeStringEquals(
            RequiredString(sourceUsers, "PasswordSalt"),
            RequiredString(targetUsers, "PasswordSalt"));
        if (!usernameMatches || !hashMatches || !saltMatches)
        {
            throw new ControllerConfigurationException(
                "The configured server users.json does not match the freshly downloaded package; refusing to assume default credentials.");
        }

        foreach (var fileName in new[]
        {
            "CashDevice-RestAPI.dll",
            "CashDevice-RestAPI.runtimeconfig.json",
            "serverconfig.json",
            "appsettings.json"
        })
        {
            var sourceFile = Path.Combine(source, fileName);
            var targetFile = Path.Combine(targetServerDirectory, fileName);
            if (!File.Exists(sourceFile)
                || !File.Exists(targetFile)
                || !FixedTimeStringEquals(
                    Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourceFile))),
                    Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(targetFile)))))
            {
                throw new ControllerConfigurationException(
                    "The configured local REST API runtime differs from the fresh package; refusing bootstrap authentication.");
            }
        }
    }

    private static string GetRuntimeDirectory(string packageDirectory)
    {
        return Path.Combine(
            packageDirectory,
            "CashDevice-REST-API-Version-2.0.0",
            "dotNET_8.0");
    }

    private static JsonElement ReadSingleUser(string runtimeDirectory)
    {
        var path = Path.Combine(runtimeDirectory, "users.json");
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            if (document.RootElement.ValueKind != JsonValueKind.Array
                || document.RootElement.GetArrayLength() != 1)
            {
                throw new ControllerConfigurationException(
                    "The Fresh package users.json must contain exactly one initial user.");
            }

            return document.RootElement[0].Clone();
        }
        catch (JsonException exception)
        {
            throw new ControllerConfigurationException("The Fresh package users.json is invalid.", exception);
        }
        catch (IOException exception)
        {
            throw new ControllerConfigurationException("The Fresh package users.json could not be read.", exception);
        }
    }

    private static void VerifyConfiguredUser(string runtimeDirectory, string username)
    {
        var user = ReadSingleUser(runtimeDirectory);
        if (!string.Equals(RequiredString(user, "Username"), username, StringComparison.Ordinal))
        {
            throw new ControllerConfigurationException(
                "The v2 Postman sample username does not match the Fresh package users.json.");
        }
    }

    private static JsonElement? FindNamedItem(JsonElement items, string name)
    {
        if (items.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var item in items.EnumerateArray())
        {
            if (item.TryGetProperty("name", out var itemName)
                && string.Equals(itemName.GetString(), name, StringComparison.OrdinalIgnoreCase))
            {
                return item;
            }
        }

        return null;
    }

    private static string ReadRawRequestBody(JsonElement group, string itemName)
    {
        var item = FindNamedItem(group.GetProperty("item"), itemName)
            ?? throw new ControllerConfigurationException(
                $"The Fresh API collection is missing the {itemName} request.");
        var request = item.GetProperty("request");
        if (!request.TryGetProperty("body", out var body)
            || !body.TryGetProperty("raw", out var raw)
            || raw.ValueKind != JsonValueKind.String)
        {
            throw new ControllerConfigurationException(
                $"The Fresh API {itemName} request body is missing.");
        }

        var url = request.GetProperty("url").GetProperty("raw").GetString();
        if (url is null || !url.Contains("/api/v2/Users/Authenticate", StringComparison.OrdinalIgnoreCase))
        {
            throw new ControllerConfigurationException("The Fresh API Authenticate request path is unexpected.");
        }

        return raw.GetString()!;
    }

    private static string RequiredString(JsonElement element, string propertyName)
    {
        if (element.ValueKind != JsonValueKind.Object
            || !element.TryGetProperty(propertyName, out var property)
            || property.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(property.GetString()))
        {
            throw new ControllerConfigurationException(
                $"The Fresh vendor material omits the required {propertyName} field.");
        }

        return property.GetString()!;
    }

    private static bool FixedTimeStringEquals(string left, string right)
    {
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        try
        {
            return leftBytes.Length == rightBytes.Length
                && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(leftBytes);
            CryptographicOperations.ZeroMemory(rightBytes);
        }
    }
}
