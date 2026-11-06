using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record DeviceReadback(
    int DeviceModel,
    int DeviceType,
    int BaseDeviceType,
    string Firmware,
    string Dataset,
    int DeviceState,
    int DeviceError,
    int DispenseState,
    bool IsOpen,
    bool IsStarted,
    bool NoteInEscrow)
{
    public static DeviceReadback ParseCompleteCashDevice(JsonElement value)
    {
        return new DeviceReadback(
            RequiredInt32(value, "deviceModel"),
            RequiredInt32(value, "deviceType"),
            RequiredInt32(value, "baseDeviceType"),
            RequiredString(value, "firmware"),
            RequiredString(value, "dataset"),
            RequiredInt32(value, "deviceState"),
            RequiredInt32(value, "deviceError"),
            RequiredInt32(value, "dispenseState"),
            RequiredBoolean(value, "isOpen"),
            RequiredBoolean(value, "isStarted"),
            RequiredBoolean(value, "noteInEscrow"));
    }

    private static int RequiredInt32(JsonElement value, string name)
    {
        var property = RequiredProperty(value, name);
        if (property.ValueKind != JsonValueKind.Number || !property.TryGetInt32(out var result))
        {
            throw new InvalidDataException(
                $"GetCompleteCashDevice field {name} has type {property.ValueKind}; expected integer.");
        }

        return result;
    }

    private static string RequiredString(JsonElement value, string name)
    {
        var property = RequiredProperty(value, name);
        if (property.ValueKind != JsonValueKind.String
            || string.IsNullOrWhiteSpace(property.GetString()))
        {
            throw new InvalidDataException(
                $"GetCompleteCashDevice field {name} has type {property.ValueKind}; expected non-empty string.");
        }

        return property.GetString()!;
    }

    private static bool RequiredBoolean(JsonElement value, string name)
    {
        var property = RequiredProperty(value, name);
        if (property.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            throw new InvalidDataException(
                $"GetCompleteCashDevice field {name} has type {property.ValueKind}; expected boolean.");
        }

        return property.GetBoolean();
    }

    private static JsonElement RequiredProperty(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty(name, out var property))
        {
            throw new InvalidDataException($"GetCompleteCashDevice omitted field {name}.");
        }

        return property;
    }
}
