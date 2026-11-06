using System.Text.Json;

namespace Kalash.CashMachineController;

public sealed record ProductDeviceReadback(CashInventory Inventory, long[] EnabledValues, bool EscrowEmpty, bool Healthy);
public sealed record ProductDeviceHealth(bool UsbConnected, bool ConnectionOpen, bool DeviceStarted, ProductDeviceReadback Readback);

public interface IProductCashDevice
{
    Task<IReadOnlyList<CashRawSnapshot>> RecoverAsync(CancellationToken token);
    Task<CashRawSnapshot> PollAsync(CancellationToken token);
    Task<ProductDeviceReadback> ReadAsync(CancellationToken token);
    Task<ProductDeviceHealth> ReadHealthAsync(CancellationToken token);
    Task EnableAsync(CancellationToken token);
    Task DisableAsync(CancellationToken token);
    Task AcceptAsync(CancellationToken token);
    Task ReturnAsync(CancellationToken token);
}

public sealed class ItlProductCashDevice(
    ItlControllerClient client, ItlDeviceStatusPoller poller, string deviceId) : IProductCashDevice
{
    public Task<IReadOnlyList<CashRawSnapshot>> RecoverAsync(CancellationToken token) => poller.RecoverOwnedAsync(token);
    public Task<CashRawSnapshot> PollAsync(CancellationToken token) => poller.PollOwnedAsync(token);
    public Task EnableAsync(CancellationToken token) => client.EnableAcceptorOnceAsync(deviceId, token);
    public Task DisableAsync(CancellationToken token) => client.DisableAcceptorOnceAsync(deviceId, token);
    public Task AcceptAsync(CancellationToken token) => client.AcceptFromEscrowOnceAsync(deviceId, token);
    public Task ReturnAsync(CancellationToken token) => client.ReturnFromEscrowOnceAsync(deviceId, token);

    public async Task<ProductDeviceHealth> ReadHealthAsync(CancellationToken token)
    {
        using var usb = await client.GetConnectedUsbDevicesAsync(token);
        using var devices = await client.GetAllCashDevicesAsync(token);
        if (usb.RootElement.ValueKind != JsonValueKind.Array || devices.RootElement.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("Product health requires explicit USB and connected-device lists.");
        var connected = devices.RootElement.GetArrayLength() == 1
            && (devices.RootElement[0].ValueKind == JsonValueKind.String
                ? devices.RootElement[0].GetString()
                : ProductCashReadback.Text(devices.RootElement[0], "deviceID")) == deviceId;
        var readback = await ReadAsync(token);
        // Healthy is true only after identity, IsOpen, IsStarted and error/dispense readbacks match.
        return new ProductDeviceHealth(usb.RootElement.GetArrayLength() == 1,
            connected && readback.Healthy, connected && readback.Healthy, readback);
    }

    public async Task<ProductDeviceReadback> ReadAsync(CancellationToken token)
    {
        using var complete = await client.GetCompleteCashDeviceAsync(deviceId, token);
        var identity = DeviceReadback.ParseCompleteCashDevice(complete.RootElement);
        using var levels = await client.GetAllLevelsAsync(deviceId, token);
        using var counters = await client.GetCountersAsync(deviceId, token);
        var inventory = ProductCashReadback.Inventory(levels.RootElement, counters.RootElement);
        var enabled = new List<long>();
        foreach (var row in levels.RootElement.EnumerateArray())
        {
            var inhibited = Boolean(row, "isInhibited");
            var recyclable = Boolean(row, "isRecyclable");
            var route = ProductCashReadback.Required(row, "acceptRoute");
            if (!IsPayout(route) || !recyclable)
                throw new InvalidDataException("Product INR denominations must be recyclable and routed to payout.");
            if (!inhibited) enabled.Add(ProductCashReadback.Integer(row, "value"));
        }
        return new ProductDeviceReadback(inventory, enabled.ToArray(), !identity.NoteInEscrow,
            identity.DeviceModel == 2 && identity.DeviceType == 3 && identity.BaseDeviceType == 0
            && identity.Firmware.Equals("NVS2004321016000", StringComparison.OrdinalIgnoreCase)
            && identity.Dataset.Equals("INR02006", StringComparison.OrdinalIgnoreCase)
            && identity.IsOpen && identity.IsStarted && identity.DeviceError == 0 && identity.DispenseState == 0);
    }

    public static bool IsPayout(JsonElement route) =>
        (route.ValueKind == JsonValueKind.String ? route.GetString() : route.GetRawText())?.ToUpperInvariant()
            is "1" or "7" or "PAYOUT" or "RECYCLER";

    private static bool Boolean(JsonElement row, string name)
    {
        var value = ProductCashReadback.Required(row, name);
        return value.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? value.GetBoolean() : throw new InvalidDataException("Product route flags must be explicit booleans.");
    }
}
