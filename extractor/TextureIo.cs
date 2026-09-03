using System;
using System.Buffers.Binary;
using System.IO;
using System.IO.Compression;
using System.Linq;
using RageLib.Textures;
using RageLib.Textures.Resource;
using RageLib.Models.Resource.Shaders;

// Texture naming and DDS/PNG writing shared by the map exporter (Program.cs)
// and the player exporter (PlayerExport.cs).
static class TextureIo
{
    public static string TextureName(ShaderFx shader)
    {
        if (shader == null) return null;
        if (shader.ShaderParams.TryGetValue(ParamNameHash.Texture, out var value) && value is ShaderParamTexture main)
            return main.TextureName;
        foreach (var param in shader.ShaderParams.Values)
            if (param is ShaderParamTexture texture) return texture.TextureName;
        return null;
    }

    public static Texture FindTexture(TextureFile file, string name)
    {
        if (file == null || string.IsNullOrWhiteSpace(name)) return null;
        var exact = file.FindTextureByName(name);
        if (exact != null) return exact;

        // Shader references often use a bare name while WTD entries retain a
        // virtual "pack:/..." path (or the reverse). RAGE hashes those spellings
        // differently, so compare their canonical leaf names as a fallback.
        var canonical = CanonicalTextureName(name);
        return file.Textures.FirstOrDefault(texture =>
            string.Equals(CanonicalTextureName(texture.Name), canonical, StringComparison.OrdinalIgnoreCase));
    }

    public static string CanonicalTextureName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return string.Empty;
        var normalized = name.Replace('\\', '/');
        var slash = normalized.LastIndexOf('/');
        if (slash >= 0) normalized = normalized[(slash + 1)..];
        var dot = normalized.LastIndexOf('.');
        if (dot > 0) normalized = normalized[..dot];
        return new string(normalized.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }

    public static string SafeName(string name)
    {
        var result = new string(name.Select(ch => char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '_').ToArray());
        return result.Length == 0 ? "texture" : result;
    }

    // How many leading mips to drop so the top level fits inside maxEdge.
    // Trimming is a slice of the chain the game already stored, so it costs no
    // re-encode and no quality beyond the resolution deliberately given up.
    // Never trims away the last level.
    public static int LevelsToSkip(Texture texture, int maxEdge)
    {
        if (maxEdge <= 0 || texture == null) return 0;
        var skip = 0;
        while (skip < texture.Levels - 1 &&
               (Math.Max(1u, texture.Width >> skip) > maxEdge || Math.Max(1u, texture.Height >> skip) > maxEdge))
            skip++;
        return skip;
    }

    public static void WriteDds(string path, Texture texture, int skipLevels = 0)
    {
        skipLevels = Math.Clamp(skipLevels, 0, Math.Max(0, texture.Levels - 1));
        var width = Math.Max(1u, texture.Width >> skipLevels);
        var height = Math.Max(1u, texture.Height >> skipLevels);
        var levels = Math.Max(1, texture.Levels - skipLevels);

        using var stream = System.IO.File.Create(path);
        using var output = new BinaryWriter(stream);
        output.Write(0x20534444u); output.Write(124u);
        var mipmapped = levels > 1;
        output.Write(mipmapped ? 0x000A1007u : 0x00081007u);
        output.Write(height); output.Write(width); output.Write(texture.GetDataSize(skipLevels));
        output.Write(0u); output.Write((uint)levels);
        for (var i = 0; i < 11; i++) output.Write(0u);
        output.Write(32u); output.Write(0x4u);
        output.Write(texture.Format switch { D3DFormat.DXT1 => 0x31545844u, D3DFormat.DXT3 => 0x33545844u, D3DFormat.DXT5 => 0x35545844u, _ => 0u });
        for (var i = 0; i < 5; i++) output.Write(0u);
        output.Write(mipmapped ? 0x00401008u : 0x1000u);
        for (var i = 0; i < 4; i++) output.Write(0u);

        var all = texture.GetAllMipData();
        var offset = 0;
        for (var level = 0; level < skipLevels; level++) offset += checked((int)texture.GetDataSize(level));
        offset = Math.Min(offset, all.Length);
        output.Write(all, offset, all.Length - offset);
    }

    public static void WritePng(string path, Texture texture)
    {
        var width = checked((int)texture.Width);
        var height = checked((int)texture.Height);
        var source = texture.GetAllMipData();
        var scanlines = new byte[(width * 4 + 1) * height];
        for (var y = 0; y < height; y++)
        {
            var row = y * (width * 4 + 1);
            scanlines[row] = 0;
            for (var x = 0; x < width; x++)
            {
                var target = row + 1 + x * 4;
                if (texture.Format == D3DFormat.A8R8G8B8)
                {
                    var sourceOffset = (y * width + x) * 4;
                    scanlines[target] = source[sourceOffset + 2];
                    scanlines[target + 1] = source[sourceOffset + 1];
                    scanlines[target + 2] = source[sourceOffset];
                    scanlines[target + 3] = source[sourceOffset + 3];
                }
                else
                {
                    var value = source[y * width + x];
                    scanlines[target] = scanlines[target + 1] = scanlines[target + 2] = value;
                    scanlines[target + 3] = 255;
                }
            }
        }

        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.SmallestSize, true)) zlib.Write(scanlines);
        using var output = System.IO.File.Create(path);
        output.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        var header = new byte[13];
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(0, 4), (uint)width);
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(4, 4), (uint)height);
        header[8] = 8; header[9] = 6;
        WritePngChunk(output, "IHDR", header);
        WritePngChunk(output, "IDAT", compressed.ToArray());
        WritePngChunk(output, "IEND", Array.Empty<byte>());
    }

    private static void WritePngChunk(Stream output, string type, byte[] data)
    {
        Span<byte> value = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(value, (uint)data.Length);
        output.Write(value);
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        output.Write(typeBytes); output.Write(data);
        var crcData = new byte[typeBytes.Length + data.Length];
        typeBytes.CopyTo(crcData, 0); data.CopyTo(crcData, typeBytes.Length);
        BinaryPrimitives.WriteUInt32BigEndian(value, PngCrc32(crcData));
        output.Write(value);
    }

    private static uint PngCrc32(byte[] data)
    {
        var crc = 0xffffffffu;
        foreach (var item in data)
        {
            crc ^= item;
            for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ (0xedb88320u & (uint)-(int)(crc & 1));
        }
        return ~crc;
    }

    // Writes one RAGE texture next to the others and returns its relative URI,
    // or null when the format is not something a browser can decode.
    //
    // maxEdge caps the top mip level. It only applies to block-compressed
    // textures, whose stored chain can simply be sliced; an uncompressed one is
    // written whole. Callers that cap must write to their own directory, since
    // the name does not record the cap and a trimmed file must never be mistaken
    // for the full-resolution one in the shared cache.
    // namePrefix namespaces the written file. It exists because ped textures
    // are NOT uniquely named: every ped's own .wtd calls its shirt
    // "uppr_diff_000_a_uni", and those are different images. Deduplicating them
    // by name would silently dress the whole population in the first ped's
    // clothes. Callers with globally unique texture names leave it empty.
    public static string Export(Texture texture, string outputDir, string uriPrefix, int maxEdge = 0, string namePrefix = "")
    {
        if (texture == null) return null;
        if (texture.Format is not (D3DFormat.DXT1 or D3DFormat.DXT3 or D3DFormat.DXT5 or D3DFormat.A8R8G8B8 or D3DFormat.L8))
        {
            Console.Error.WriteLine($"  unsupported texture format 0x{(int)texture.Format:X}: {texture.Name}");
            return null;
        }
        var compressed = texture.Format is D3DFormat.DXT1 or D3DFormat.DXT3 or D3DFormat.DXT5;
        var safeName = (string.IsNullOrEmpty(namePrefix) ? "" : SafeName(namePrefix) + "__")
            + SafeName(texture.Name) + (compressed ? ".dds" : ".png");
        var target = Path.Combine(outputDir, safeName);
        if (!System.IO.File.Exists(target))
        {
            if (compressed) WriteDds(target, texture, LevelsToSkip(texture, maxEdge));
            else WritePng(target, texture);
        }
        return uriPrefix + safeName;
    }
}
