using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System;
using RageLib.Common;
using RageLib.Textures.Resource;

namespace RageLib.Textures;

public sealed class Texture : IDisposable
{
    internal Texture(TextureInfo info)
    {
        Info = info;
        Name = info.Name;
        Width = info.Width;
        Height = info.Height;
        Levels = info.Levels;
        Format = info.Format;
    }

    internal TextureInfo Info { get; private set; }
    public string Name { get; }
    public uint Width { get; }
    public uint Height { get; }
    public int Levels { get; }
    public D3DFormat Format { get; }
    public byte[] TextureData => Info.TextureData;
    public int DataOffset => Info.TextureDataOffset;
    public int DataLength => Info.TextureDataLength;

    public uint GetDataSize(int level)
    {
        var width = Math.Max(1u, Width >> level);
        var height = Math.Max(1u, Height >> level);
        return Format switch
        {
            D3DFormat.DXT1 => Math.Max(8u, ((width + 3) / 4) * ((height + 3) / 4) * 8),
            D3DFormat.DXT3 or D3DFormat.DXT5 => Math.Max(16u, ((width + 3) / 4) * ((height + 3) / 4) * 16),
            D3DFormat.A8R8G8B8 => width * height * 4,
            D3DFormat.L8 => width * height,
            _ => 0,
        };
    }

    public byte[] GetAllMipData()
    {
        var total = 0;
        for (var level = 0; level < Levels; level++) total += checked((int)GetDataSize(level));
        total = Math.Min(total, DataLength);
        var result = new byte[total];
        Buffer.BlockCopy(TextureData, DataOffset, result, 0, total);
        return result;
    }

    public void Dispose() => Info = null;
}

public sealed class TextureFile : IEnumerable<Texture>, IDisposable
{
    private Resource.File file;
    public List<Texture> Textures { get; private set; } = new();

    // Diagnostics: exposes the parsed pgDictionary (name-hash table + raw TextureInfos).
    public Resource.File Resource => file;

    public void Open(byte[] data)
    {
        using var stream = new MemoryStream(data, writable: false);
        Open(stream);
    }

    public void Open(Stream stream)
    {
        file = new Resource.File();
        file.Open(stream);
        Textures = file.Textures.Select(info => new Texture(info)).ToList();
    }

    public void Open(Stream systemMemory, Stream graphicsMemory)
    {
        file = new Resource.File();
        file.Open(systemMemory, graphicsMemory);
        Textures = file.Textures.Select(info => new Texture(info)).ToList();
    }

    // The pgDictionary hash table is keyed on the bare leaf name with no
    // extension ("road4cobble"), not on the stored "pack:/road4cobble.dds"
    // spelling. Verified against every .wtd under pc/: 49,323/49,323 entries
    // re-hash to their stored key under that spelling and no other.
    public Texture FindTextureByName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var byHash = FindTextureByHash(Hasher.Hash(Path.GetFileNameWithoutExtension(name)));
        if (byHash != null) return byHash;

        return Textures.FirstOrDefault(texture =>
            string.Equals(texture.Name, name, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(Path.GetFileNameWithoutExtension(texture.Name), name, StringComparison.OrdinalIgnoreCase));
    }

    public Texture FindTextureByHash(uint hash)
    {
        if (file?.TexturesByHash == null) return null;
        if (!file.TexturesByHash.TryGetValue(hash, out var info)) return null;
        var index = file.Textures.IndexOf(info);
        return index >= 0 && index < Textures.Count ? Textures[index] : null;
    }

    public IEnumerator<Texture> GetEnumerator() => Textures.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

    public void Dispose()
    {
        foreach (var texture in Textures) texture.Dispose();
        Textures.Clear();
        file?.Dispose();
    }
}
