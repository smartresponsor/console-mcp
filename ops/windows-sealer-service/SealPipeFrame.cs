using System.Buffers.Binary;

namespace ConsoleMcp.Sealer.Service;

// A bounded binary frame: uint32 little-endian byte length plus one JSON
// request. Does not create a pipe, authenticate a peer or authorize sealing.
public static class SealPipeFrame
{
    private const int HeaderBytes = 4;
    public static readonly TimeSpan MaxReadDuration = TimeSpan.FromSeconds(3);

    public static async Task<byte[]?> ReadAsync(Stream source, CancellationToken stop = default)
    {
        ArgumentNullException.ThrowIfNull(source);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
        deadline.CancelAfter(MaxReadDuration);
        byte[] header = new byte[HeaderBytes];
        if (!await ReadExactlyAsync(source, header, deadline.Token).ConfigureAwait(false))
            return null;
        uint length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > SealRequestAdmission.MaxFrameBytes)
            return null;
        byte[] payload = new byte[(int)length];
        if (!await ReadExactlyAsync(source, payload, deadline.Token).ConfigureAwait(false))
            return null;
        return payload;
    }

    // Denial-only response. No success ACK is permitted until replay journal,
    // source verification, privileged key custody and authorization exist.
    public static async Task WriteDeniedAsync(Stream destination, CancellationToken stop = default)
    {
        ArgumentNullException.ThrowIfNull(destination);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stop);
        deadline.CancelAfter(MaxReadDuration);
        await destination.WriteAsync(new byte[] { 0x01 }, deadline.Token).ConfigureAwait(false);
        await destination.FlushAsync(deadline.Token).ConfigureAwait(false);
    }

    private static async Task<bool> ReadExactlyAsync(Stream source, byte[] destination, CancellationToken stop)
    {
        int offset = 0;
        try
        {
            while (offset < destination.Length)
            {
                int read = await source.ReadAsync(destination.AsMemory(offset), stop).ConfigureAwait(false);
                if (read == 0)
                    return false;
                offset += read;
            }
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }
}
