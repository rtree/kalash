using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Kalash.CashMachineController;

public sealed class CashControllerConfiguration(Uri centralUri, string atmId, string credential, bool productCashEnabled = false)
{
    private const string DefaultAtmId = "atm-01";
    private const int MaximumConfigurationBytes = 16 * 1024;
    public Uri CentralUri { get; } = centralUri;
    public string AtmId { get; } = atmId;
    public string Credential { get; } = credential;
    public bool ProductCashEnabled { get; } = productCashEnabled;
    public const string ProductCashEnableVariable = "KALASH_PRODUCT_CASH_ENABLE";
    public const string ProductCashEnableValue = "OWNER_ATTENDED_PRODUCT_CASH";

    public static bool ParseProductCashGate(string? value) => value switch
    {
        null or "" or "false" => false,
        ProductCashEnableValue => true,
        _ => throw new ControllerConfigurationException("The product physical cash gate is invalid; acceptance remains disabled.")
    };

    public override string ToString() =>
        $"CashControllerConfiguration {{ CentralUri = {CentralUri}, AtmId = {AtmId}, Credential = [redacted] }}";

    public static CashControllerConfiguration Load(
        string? localAppData = null,
        IReadOnlyDictionary<string, string?>? overrides = null)
    {
        var root = localAppData ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new ControllerConfigurationException(
                "The registered ATM configuration directory is unavailable for this Windows user.");
        }

        var path = Path.Combine(root, "KALASH", "secrets", $"{DefaultAtmId}.json");
        if (!File.Exists(path))
        {
            throw new ControllerConfigurationException(
                "The registered ATM configuration file is missing for this Windows user.");
        }

        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
        {
            throw new ControllerConfigurationException(
                "The registered ATM configuration file must not be a reparse point.");
        }

        var info = new FileInfo(path);
        if (info.Length is <= 0 or > MaximumConfigurationBytes)
        {
            throw new ControllerConfigurationException(
                "The registered ATM configuration file has an invalid size.");
        }

        RegisteredAtmConfiguration? registered;
        try
        {
            registered = JsonSerializer.Deserialize<RegisteredAtmConfiguration>(
                File.ReadAllBytes(path),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = false });
        }
        catch (JsonException)
        {
            throw new ControllerConfigurationException(
                "The registered ATM configuration file is not valid JSON.");
        }

        if (registered is null
            || registered.AtmId != DefaultAtmId
            || !Uri.TryCreate(registered.Origin, UriKind.Absolute, out var registeredUri)
            || !string.IsNullOrEmpty(registeredUri.UserInfo)
            || !string.IsNullOrEmpty(registeredUri.Query)
            || !string.IsNullOrEmpty(registeredUri.Fragment)
            || registeredUri.AbsolutePath != "/"
            || registeredUri.Scheme != Uri.UriSchemeHttps
            || !Regex.IsMatch(registered.Token ?? string.Empty, "^[a-f0-9]{64}$"))
        {
            throw new ControllerConfigurationException(
                "The registered ATM configuration does not match the expected HTTPS registration.");
        }

        var settings = overrides ?? ReadEnvironmentOverrides();
        var origin = GetOverride(settings, "KALASH_CENTRAL_URL") ?? registered.Origin;
        var atmId = GetOverride(settings, "KALASH_ATM_ID") ?? registered.AtmId;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var centralUri)
            || centralUri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(centralUri.UserInfo)
            || !string.IsNullOrEmpty(centralUri.Query)
            || !string.IsNullOrEmpty(centralUri.Fragment)
            || centralUri.AbsolutePath != "/"
            || !Regex.IsMatch(atmId, "^[a-z0-9][a-z0-9-]{2,63}$"))
        {
            throw new ControllerConfigurationException(
                "The Central URL or ATM ID override is invalid.");
        }

        settings.TryGetValue(ProductCashEnableVariable, out var gate);
        return new CashControllerConfiguration(centralUri, atmId, registered.Token!, ParseProductCashGate(gate));
    }

    private static IReadOnlyDictionary<string, string?> ReadEnvironmentOverrides()
    {
        return new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["KALASH_CENTRAL_URL"] = Environment.GetEnvironmentVariable("KALASH_CENTRAL_URL"),
            ["KALASH_ATM_ID"] = Environment.GetEnvironmentVariable("KALASH_ATM_ID"),
            [ProductCashEnableVariable] = Environment.GetEnvironmentVariable(ProductCashEnableVariable)
        };
    }

    private static string? GetOverride(IReadOnlyDictionary<string, string?> overrides, string name)
    {
        return overrides.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : null;
    }

    private sealed record RegisteredAtmConfiguration(
        [property: JsonPropertyName("atmId")] string? AtmId,
        [property: JsonPropertyName("origin")] string? Origin,
        [property: JsonPropertyName("token")] string? Token);
}
