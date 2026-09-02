using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.Json;
using RageLib.Common;
using RageLib.FileSystem;
using RageLib.Models.Resource;
using RageLib.Models.Resource.Models;
using RageLib.Models.Resource.Shaders;
using RageLib.Textures;
using RageLib.Textures.Resource;
using static TextureIo;
using DrawableResource = RageLib.Models.Resource.File<RageLib.Models.Resource.DrawableModel>;
using DictionaryResource = RageLib.Models.Resource.File<RageLib.Models.Resource.DrawableModelDictionary>;

if (args.Length >= 3 && args[0].Equals("--extract-player", StringComparison.OrdinalIgnoreCase))
{
    // --extract-player <gameDir> <outputDir> [textureDir] [textureUriPrefix]
    var playerGame = Path.GetFullPath(args[1]);
    var playerOutput = Path.GetFullPath(args[2]);
    var playerKey = new KeyUtilGTAIV().FindKey(playerGame);
    if (playerKey == null) throw new InvalidOperationException("Could not locate GTA IV archive key in GTAIV.exe");
    KeyStore.SetKeyLoader(() => playerKey);
    var playerTextureDir = args.Length >= 4 ? Path.GetFullPath(args[3]) : Path.Combine(playerOutput, "textures");
    var playerTexturePrefix = args.Length >= 5 ? args[4].TrimEnd('/') + "/" : "textures/";
    return PlayerExport.Run(playerGame, playerOutput, playerTextureDir, playerTexturePrefix);
}

if (args.Length >= 2 && args[0].Equals("--probe-player", StringComparison.OrdinalIgnoreCase))
{
    var probePlayerGame = Path.GetFullPath(args[1]);
    var probePlayerKey = new KeyUtilGTAIV().FindKey(probePlayerGame);
    if (probePlayerKey == null) throw new InvalidOperationException("Could not locate GTA IV archive key in GTAIV.exe");
    KeyStore.SetKeyLoader(() => probePlayerKey);
    return PlayerExport.Probe(probePlayerGame);
}

if (args.Length >= 3 && args[0].Equals("--search-texture", StringComparison.OrdinalIgnoreCase))
{
    var searchGame = Path.GetFullPath(args[1]);
    var wantedTexture = CanonicalTextureName(args[2]);
    var searchKey = new KeyUtilGTAIV().FindKey(searchGame);
    if (searchKey == null) throw new InvalidOperationException("Could not locate GTA IV archive key in GTAIV.exe");
    KeyStore.SetKeyLoader(() => searchKey);
    var searchArchives = args.Length >= 4
        ? Directory.EnumerateFiles(Path.Combine(searchGame, args[3]), "*.img", SearchOption.AllDirectories)
        : new[] { Path.Combine(searchGame, "pc", "data", "cdimages", "gtxd.img") };
    foreach (var archivePath in searchArchives)
    {
        var searchImg = new IMGFileSystem();
        try
        {
            searchImg.Open(archivePath);
            foreach (var entry in searchImg.GetAllFiles().Where(file => file.Name.EndsWith(".wtd", StringComparison.OrdinalIgnoreCase)))
            {
                using var dictionary = new TextureFile();
                try { dictionary.Open(entry.GetData()); } catch { continue; }
                foreach (var texture in dictionary.Textures)
                    if (CanonicalTextureName(texture.Name) == wantedTexture)
                        Console.WriteLine($"{archivePath}|{entry.Name}|{texture.Name}");
            }
        }
        finally { searchImg.Close(); }
    }
    return 0;
}

if (args.Length >= 4 && args[0].Equals("--probe-txd", StringComparison.OrdinalIgnoreCase))
{
    // Diagnostic: validate parsed texture names against the dictionary's own
    // pgDictionary hash table. A name that does not re-hash to its stored key
    // was mis-read, so every by-name lookup against it is unreliable.
    var probeGame = Path.GetFullPath(args[1]);
    var probeImg = Path.Combine(probeGame, args[2].Replace('/', Path.DirectorySeparatorChar));
    var wanted = args.Skip(3).Select(value => Hasher.Hash(Path.GetFileNameWithoutExtension(value))).ToArray();
    var wantedNames = args.Skip(3).ToArray();
    var probeKey = new KeyUtilGTAIV().FindKey(probeGame);
    if (probeKey == null) throw new InvalidOperationException("Could not locate GTA IV archive key in GTAIV.exe");
    KeyStore.SetKeyLoader(() => probeKey);

    // Candidate spellings the pgDictionary hash table may have been built over.
    var variantNames = new[] { "full", "noPack", "noExt", "leaf", "leafNoExt" };
    var variants = new Func<string, string>[]
    {
        value => value,
        value => value.StartsWith("pack:/", StringComparison.OrdinalIgnoreCase) ? value[6..] : value,
        value => Path.ChangeExtension(value, null) ?? value,
        value => value[(value.LastIndexOf('/') + 1)..],
        value => Path.GetFileNameWithoutExtension(value),
    };
    var variantHits = new long[variantNames.Length];

    var archivePaths = Directory.Exists(probeImg)
        ? Directory.EnumerateFiles(probeImg, "*.img", SearchOption.AllDirectories).ToArray()
        : new[] { probeImg };

    long total = 0, bad = 0;
    var samples = new List<string>();
    // Loose .wtd files on disk are not inside any .img, so scan them too.
    if (Directory.Exists(probeImg))
    {
        foreach (var loosePath in Directory.EnumerateFiles(probeImg, "*.wtd", SearchOption.AllDirectories))
        {
            using var looseDict = new TextureFile();
            try { looseDict.Open(System.IO.File.ReadAllBytes(loosePath)); } catch { continue; }
            if (looseDict.Resource?.TexturesByHash == null) continue;
            foreach (var pair in looseDict.Resource.TexturesByHash)
            {
                total++;
                for (int w = 0; w < wanted.Length; w++)
                    if (pair.Key == wanted[w])
                        Console.WriteLine($"HIT {wantedNames[w]} -> (loose) {loosePath} parsedName='{pair.Value.Name}' {pair.Value.Width}x{pair.Value.Height} {pair.Value.Format}");
            }
        }
    }
    foreach (var currentArchive in archivePaths)
    {
    var probeFs = new IMGFileSystem();
    try { probeFs.Open(currentArchive); } catch { continue; }
    try
    {
        foreach (var entry in probeFs.GetAllFiles().Where(file => file.Name.EndsWith(".wtd", StringComparison.OrdinalIgnoreCase)))
        {
            using var dictionary = new TextureFile();
            try { dictionary.Open(entry.GetData()); } catch { continue; }
            var resource = dictionary.Resource;
            if (resource?.TexturesByHash == null) continue;
            foreach (var pair in resource.TexturesByHash)
            {
                total++;
                var name = pair.Value.Name ?? string.Empty;
                for (int v = 0; v < variantNames.Length; v++)
                {
                    var spelling = variants[v](name);
                    if (spelling.Length != 0 && Hasher.Hash(spelling) == pair.Key) variantHits[v]++;
                }
                if (name.Length == 0 || Hasher.Hash(name) != pair.Key)
                {
                    bad++;
                    if (samples.Count < 8) samples.Add($"    {entry.Name}: stored=0x{pair.Key:X8} name='{name}' rehash=0x{(name.Length == 0 ? 0 : Hasher.Hash(name)):X8}");
                }
                for (int w = 0; w < wanted.Length; w++)
                    if (pair.Key == wanted[w])
                        Console.WriteLine($"HIT {wantedNames[w]} -> {Path.GetFileName(currentArchive)}|{entry.Name} parsedName='{name}' {pair.Value.Width}x{pair.Value.Height} {pair.Value.Format}");
            }
        }
    }
    finally { probeFs.Close(); }
    }
    Console.WriteLine($"textures={total:n0} nameHashMismatch={bad:n0} ({(total == 0 ? 0 : bad * 100.0 / total):F1}%)");
    for (int v = 0; v < variantNames.Length; v++)
        Console.WriteLine($"    spelling '{variantNames[v]}' matches {variantHits[v]:n0}/{total:n0} ({(total == 0 ? 0 : variantHits[v] * 100.0 / total):F1}%)");
    foreach (var sample in samples) Console.WriteLine(sample);
    return 0;
}

if (args.Length < 4)
{
    Console.Error.WriteLine("Usage: Gta4MapExtractor <game-dir> <map-relative-dir> <sector> <output-dir> [texture-output-dir] [texture-uri-prefix]");
    return 2;
}

var gameDir = Path.GetFullPath(args[0]);
var mapRelativeDir = args[1];
var sector = args[2];
var outputDir = Path.GetFullPath(args[3]);
var textureOutputDir = args.Length >= 5 ? Path.GetFullPath(args[4]) : Path.Combine(outputDir, "textures");
var textureUriPrefix = args.Length >= 6 ? args[5].TrimEnd('/') + "/" : "textures/";
var mapDir = Path.Combine(gameDir, mapRelativeDir.Replace('/', Path.DirectorySeparatorChar));
var imgPath = Path.Combine(mapDir, sector + ".img");
var idePath = Path.Combine(mapDir, sector + ".ide");
var baseWplPath = Path.Combine(mapDir, sector + ".wpl");

var key = new KeyUtilGTAIV().FindKey(gameDir);
if (key == null) throw new InvalidOperationException("Could not locate GTA IV archive key in GTAIV.exe");
KeyStore.SetKeyLoader(() => key);

Directory.CreateDirectory(outputDir);
Directory.CreateDirectory(textureOutputDir);

var img = new IMGFileSystem();
img.Open(imgPath);
var archiveFiles = img.GetAllFiles();
var files = archiveFiles.GroupBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
    .ToDictionary(group => group.Key, group => group.Last(), StringComparer.OrdinalIgnoreCase);
Console.WriteLine($"Opened {Path.GetFileName(imgPath)}: {files.Count:n0} archive entries");

var definitions = ParseIde(idePath);
var textureParents = ParseTextureParents(idePath);
var requiredTextureDictionaries = definitions.Values.Select(value => value.TextureDictionary)
    .Concat(textureParents.Values);
var externalWtdData = LoadExternalTextureDictionaries(requiredTextureDictionaries);
foreach (var file in archiveFiles.Where(file => file.Name.EndsWith(".wdr", StringComparison.OrdinalIgnoreCase)))
{
    var name = Path.GetFileNameWithoutExtension(file.Name);
    var hash = Hasher.Hash(name);
    if (!definitions.ContainsKey(hash)) definitions[hash] = new Definition(name, name, null);
}

var instances = new List<Placement>();
instances.AddRange(ParseWpl(Path.GetFileName(baseWplPath), System.IO.File.ReadAllBytes(baseWplPath)));
foreach (var file in archiveFiles.Where(file => file.Name.EndsWith(".wpl", StringComparison.OrdinalIgnoreCase)))
    instances.AddRange(ParseWpl(file.Name, file.GetData()));
instances = instances.GroupBy(value => $"{value.Hash:X8}:{value.X:F2}:{value.Y:F2}:{value.Z:F2}")
    .Select(group => group.First()).ToList();
Console.WriteLine($"Parsed {instances.Count:n0} unique placements from base + streaming WPLs");

var writer = new GltfWriter(outputDir);
var modelMeshes = new Dictionary<uint, int>();
var failedModels = new HashSet<uint>();
var textureFiles = new Dictionary<string, TextureFile>(StringComparer.OrdinalIgnoreCase);
var materialCache = new Dictionary<string, int>(StringComparer.Ordinal);
var unresolvedTextures = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
var rendered = 0;

foreach (var placement in instances)
{
    if (!definitions.TryGetValue(placement.Hash, out var definition)) continue;
    if (!modelMeshes.TryGetValue(placement.Hash, out var meshIndex))
    {
        if (failedModels.Contains(placement.Hash)) continue;
        try
        {
            meshIndex = ExportModel(definition, placement.Hash);
            if (meshIndex < 0) { failedModels.Add(placement.Hash); continue; }
            modelMeshes[placement.Hash] = meshIndex;
            if (modelMeshes.Count % 25 == 0) Console.WriteLine($"  decoded {modelMeshes.Count:n0} models...");
        }
        catch (Exception ex)
        {
            failedModels.Add(placement.Hash);
            Console.Error.WriteLine($"  skip {definition.Name}: {ex.Message}");
            continue;
        }
    }

    writer.AddNode(definition.Name, meshIndex,
        new[] { -placement.X, placement.Z, -placement.Y },
        new[] { -placement.Qx, placement.Qz, -placement.Qy, placement.Qw });
    rendered++;
}

writer.Write("map.gltf", "map.bin", new Dictionary<string, object>
{
    ["sector"] = sector,
    ["region"] = Path.GetFileName(mapDir),
    ["placements"] = rendered,
    ["models"] = modelMeshes.Count,
    ["skippedModels"] = failedModels.Count,
    ["bounds"] = writer.GetPlacementBounds(180f),
});

foreach (var textureFile in textureFiles.Values) textureFile.Dispose();
img.Close();
Console.WriteLine($"Exported {rendered:n0} placements, {modelMeshes.Count:n0} models, {writer.MaterialCount:n0} materials");
if (unresolvedTextures.Count > 0)
{
    Console.WriteLine($"Unresolved textures: {unresolvedTextures.Count:n0} distinct across {unresolvedTextures.Values.Sum():n0} materials");
    foreach (var pair in unresolvedTextures.OrderByDescending(value => value.Value).Take(25))
        Console.WriteLine($"    {pair.Key} x{pair.Value}");
}
Console.WriteLine($"Output: {Path.Combine(outputDir, "map.gltf")}");
return 0;

int ExportModel(Definition definition, uint modelHash)
{
    RageLib.Models.Resource.DrawableModel drawable;
    IDisposable resource;
    var wddName = string.IsNullOrWhiteSpace(definition.Wdd) || definition.Wdd.Equals("null", StringComparison.OrdinalIgnoreCase)
        ? null : definition.Wdd + ".wdd";

    if (wddName != null && files.TryGetValue(wddName, out var wddFile))
    {
        var dict = new DictionaryResource();
        dict.Open(new MemoryStream(wddFile.GetData(), writable: false));
        var entryIndex = -1;
        for (var i = 0; i < dict.Data.NameHashes.Count; i++)
            if (dict.Data.NameHashes[i] == modelHash) { entryIndex = i; break; }
        if (entryIndex < 0) { dict.Dispose(); return -1; }
        drawable = dict.Data.Entries[entryIndex];
        resource = dict;
    }
    else
    {
        var modelName = definition.Name + ".wdr";
        if (!files.TryGetValue(modelName, out var modelFile)) return -1;
        var single = new DrawableResource();
        single.Open(new MemoryStream(modelFile.GetData(), writable: false));
        drawable = single.Data;
        resource = single;
    }

    using (resource)
    {
        var external = GetTextureFile(definition.TextureDictionary);
        var parent = textureParents.TryGetValue(definition.TextureDictionary ?? string.Empty, out var parentName)
            ? GetTextureFile(parentName) : null;
        var primitives = new List<GltfPrimitive>();
        foreach (var lod in drawable.ModelCollection)
        {
            foreach (var model in lod)
            {
                for (var geometryIndex = 0; geometryIndex < model.Geometries.Count; geometryIndex++)
                {
                    var geometry = model.Geometries[geometryIndex];
                    if (geometry.VertexBuffer?.RawData == null || geometry.IndexBuffer?.RawData == null) continue;
                    var shaderIndex = geometryIndex < model.ShaderMappings.Count ? model.ShaderMappings[geometryIndex] : (ushort)0;
                    var shader = drawable.ShaderGroup != null && shaderIndex < drawable.ShaderGroup.Shaders.Count
                        ? drawable.ShaderGroup.Shaders[shaderIndex] : null;
                    var materialIndex = ExportMaterial(shader, drawable.ShaderGroup?.TextureDictionary, external, parent);
                    primitives.Add(writer.AddGeometry(geometry, materialIndex));
                }
            }
        }
        return primitives.Count == 0 ? -1 : writer.AddMesh(definition.Name, primitives);
    }
}

TextureFile GetTextureFile(string dictionaryName)
{
    if (string.IsNullOrWhiteSpace(dictionaryName) || dictionaryName.Equals("null", StringComparison.OrdinalIgnoreCase)) return null;
    if (textureFiles.TryGetValue(dictionaryName, out var cached)) return cached;
    var parsed = new TextureFile();
    if (files.TryGetValue(dictionaryName + ".wtd", out var source)) parsed.Open(source.GetData());
    else if (externalWtdData.TryGetValue(dictionaryName + ".wtd", out var externalData)) parsed.Open(externalData);
    else { parsed.Dispose(); return null; }
    textureFiles[dictionaryName] = parsed;
    return parsed;
}

Dictionary<string, byte[]> LoadExternalTextureDictionaries(IEnumerable<string> dictionaryNames)
{
    var wanted = dictionaryNames
        .Where(value => !string.IsNullOrWhiteSpace(value) && !value.Equals("null", StringComparison.OrdinalIgnoreCase))
        .Select(value => value + ".wtd")
        .ToHashSet(StringComparer.OrdinalIgnoreCase);
    wanted.ExceptWith(files.Keys);

    var result = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
    var candidates = Directory.EnumerateFiles(mapDir, "*.img")
        .Concat(new[] { Path.Combine(gameDir, "pc", "data", "cdimages", "gtxd.img") })
        .Where(System.IO.File.Exists);
    foreach (var neighborPath in candidates)
    {
        if (Path.GetFullPath(neighborPath).Equals(imgPath, StringComparison.OrdinalIgnoreCase)) continue;
        var neighbor = new IMGFileSystem();
        try
        {
            neighbor.Open(neighborPath);
            foreach (var entry in neighbor.GetAllFiles())
            {
                if (wanted.Contains(entry.Name) && !result.ContainsKey(entry.Name))
                    result[entry.Name] = entry.GetData();
            }
        }
        finally { neighbor.Close(); }
    }
    Console.WriteLine($"Resolved {result.Count:n0} referenced texture dictionaries from shared archives");
    return result;
}

int ExportMaterial(ShaderFx shader, TextureFile attached, TextureFile external, TextureFile parent)
{
    var shaderName = shader?.ShaderName ?? "gta_default";
    var textureName = TextureName(shader);
    var keyName = shaderName + "|" + textureName;
    if (materialCache.TryGetValue(keyName, out var existing)) return existing;

    var texture = FindTexture(attached, textureName) ?? FindTexture(external, textureName) ?? FindTexture(parent, textureName);
    if (texture == null && !string.IsNullOrWhiteSpace(textureName))
        unresolvedTextures[textureName] = unresolvedTextures.GetValueOrDefault(textureName) + 1;
    string textureUri = null;
    if (texture != null && texture.Format is D3DFormat.DXT1 or D3DFormat.DXT3 or D3DFormat.DXT5 or D3DFormat.A8R8G8B8 or D3DFormat.L8)
    {
        var compressed = texture.Format is D3DFormat.DXT1 or D3DFormat.DXT3 or D3DFormat.DXT5;
        var safeName = SafeName(texture.Name) + (compressed ? ".dds" : ".png");
        var target = Path.Combine(textureOutputDir, safeName);
        if (!System.IO.File.Exists(target))
        {
            if (compressed) WriteDds(target, texture);
            else WritePng(target, texture);
        }
        textureUri = textureUriPrefix + safeName;
    }
    else if (texture != null) Console.Error.WriteLine($"  unsupported texture format 0x{(int)texture.Format:X}: {textureName}");
    var material = writer.AddMaterial(shaderName, textureName, textureUri);
    materialCache[keyName] = material;
    return material;
}

static Dictionary<string, string> ParseTextureParents(string path)
{
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    var section = string.Empty;
    foreach (var raw in System.IO.File.ReadLines(path))
    {
        var line = raw.Trim();
        if (line.Length == 0 || line.StartsWith('#')) continue;
        if (line.Equals("txdp", StringComparison.OrdinalIgnoreCase)) { section = "txdp"; continue; }
        if (line.Equals("end", StringComparison.OrdinalIgnoreCase)) { section = string.Empty; continue; }
        if (section != "txdp") continue;
        var fields = line.Split(',', StringSplitOptions.TrimEntries);
        if (fields.Length >= 2 && fields[0].Length > 0 && fields[1].Length > 0)
            result[fields[0]] = fields[1];
    }
    Console.WriteLine($"Parsed {result.Count:n0} texture dictionary parent links");
    return result;
}

static Dictionary<uint, Definition> ParseIde(string path)
{
    var result = new Dictionary<uint, Definition>();
    var section = "";
    foreach (var raw in System.IO.File.ReadLines(path))
    {
        var line = raw.Trim();
        if (line.Length == 0 || line.StartsWith('#')) continue;
        if (!line.Contains(',')) { section = line.Equals("end", StringComparison.OrdinalIgnoreCase) ? "" : line.ToLowerInvariant(); continue; }
        if (section is not ("objs" or "tobj" or "anim")) continue;
        var values = line.Split(',').Select(value => value.Trim()).ToArray();
        if (values.Length < 2) continue;
        var name = values[0]; var txd = values[1]; var wdd = values.Length >= 17 ? values[^1] : null;
        result[Hasher.Hash(name)] = new Definition(name, txd, wdd);
    }
    Console.WriteLine($"Parsed {result.Count:n0} model definitions from {Path.GetFileName(path)}");
    return result;
}

static List<Placement> ParseWpl(string name, byte[] data)
{
    using var reader = new BinaryReader(new MemoryStream(data, writable: false));
    if (reader.ReadInt32() != 3) return new();
    var count = reader.ReadInt32(); reader.BaseStream.Position = 68;
    var result = new List<Placement>(count);
    for (var i = 0; i < count && reader.BaseStream.Position + 48 <= reader.BaseStream.Length; i++)
    {
        var x = reader.ReadSingle(); var y = reader.ReadSingle(); var z = reader.ReadSingle();
        var qx = reader.ReadSingle(); var qy = reader.ReadSingle(); var qz = reader.ReadSingle(); var qw = reader.ReadSingle();
        var hash = reader.ReadUInt32(); var flags = reader.ReadInt32(); var lod = reader.ReadInt32();
        reader.ReadInt32(); reader.ReadSingle();
        result.Add(new Placement(name, hash, x, y, z, qx, qy, qz, qw, flags, lod));
    }
    return result;
}

record Definition(string Name, string TextureDictionary, string Wdd);
record Placement(string Source, uint Hash, float X, float Y, float Z, float Qx, float Qy, float Qz, float Qw, int Flags, int Lod);
record GltfPrimitive(int Position, int Normal, int Uv, int Color, int Indices, int Material);

sealed class GltfWriter
{
    private readonly string outputDir;
    private readonly MemoryStream binary = new();
    private readonly List<object> bufferViews = new(), accessors = new(), meshes = new(), nodes = new(), materials = new();
    private readonly float[] nodeMin = { float.PositiveInfinity, float.PositiveInfinity, float.PositiveInfinity };
    private readonly float[] nodeMax = { float.NegativeInfinity, float.NegativeInfinity, float.NegativeInfinity };
    public int MaterialCount => materials.Count;
    public GltfWriter(string outputDir) => this.outputDir = outputDir;

    public GltfPrimitive AddGeometry(Geometry geometry, int material)
    {
        var declaration = geometry.VertexBuffer.VertexDeclaration.DecodeAsVertexElements();
        var offsets = new Dictionary<(VertexElementUsage, int), int>(); var cursor = 0;
        foreach (var element in declaration) { offsets[(element.Usage, element.UsageIndex)] = cursor; cursor += element.Size; }
        var positionElement = declaration.FirstOrDefault(element => element.Usage == VertexElementUsage.Position && element.UsageIndex == 0);
        if (positionElement.Type != VertexElementType.Float3)
            throw new InvalidDataException($"Unsupported position encoding {positionElement.Type}");
        var stride = checked((int)geometry.VertexBuffer.StrideSize); var count = geometry.VertexCount; var raw = geometry.VertexBuffer.RawData;
        var positions = new float[count * 3]; var normals = new float[count * 3]; var uvs = new float[count * 2]; var colors = new byte[count * 4];
        var normalElement = declaration.FirstOrDefault(element => element.Usage == VertexElementUsage.Normal && element.UsageIndex == 0);
        var uvElement = declaration.FirstOrDefault(element => element.Usage == VertexElementUsage.TextureCoordinate && element.UsageIndex == 0);
        var no = 0; var uo = 0;
        var hasNormal = normalElement.Type == VertexElementType.Float3 && offsets.TryGetValue((VertexElementUsage.Normal, 0), out no);
        var hasUv = uvElement.Type == VertexElementType.Float2 && offsets.TryGetValue((VertexElementUsage.TextureCoordinate, 0), out uo);
        var hasColor = offsets.TryGetValue((VertexElementUsage.Color, 0), out var co);
        var po = offsets[(VertexElementUsage.Position, 0)];
        for (var i = 0; i < count; i++)
        {
            var start = i * stride; var px = ReadFloat(raw, start + po); var py = ReadFloat(raw, start + po + 4); var pz = ReadFloat(raw, start + po + 8);
            if (!float.IsFinite(px) || !float.IsFinite(py) || !float.IsFinite(pz)) throw new InvalidDataException("Non-finite vertex position");
            positions[i * 3] = -px; positions[i * 3 + 1] = pz; positions[i * 3 + 2] = -py;
            if (hasNormal) { var nx = ReadFloat(raw, start + no); var ny = ReadFloat(raw, start + no + 4); var nz = ReadFloat(raw, start + no + 8); normals[i * 3] = -nx; normals[i * 3 + 1] = nz; normals[i * 3 + 2] = -ny; }
            if (hasUv) { uvs[i * 2] = ReadFloat(raw, start + uo); uvs[i * 2 + 1] = ReadFloat(raw, start + uo + 4); }
            if (hasColor) { var packed = BinaryPrimitives.ReadUInt32LittleEndian(raw.AsSpan(start + co, 4)); colors[i * 4] = (byte)(packed >> 16); colors[i * 4 + 1] = (byte)(packed >> 8); colors[i * 4 + 2] = (byte)packed; colors[i * 4 + 3] = (byte)(packed >> 24); }
            else colors[i * 4] = colors[i * 4 + 1] = colors[i * 4 + 2] = colors[i * 4 + 3] = 255;
        }
        var source = new ushort[geometry.IndexCount]; Buffer.BlockCopy(geometry.IndexBuffer.RawData, 0, source, 0, source.Length * 2);
        var indices = new uint[geometry.FaceCount * 3];
        for (var face = 0; face < geometry.FaceCount; face++) { indices[face * 3] = source[face * 3]; indices[face * 3 + 1] = source[face * 3 + 2]; indices[face * 3 + 2] = source[face * 3 + 1]; }
        return new(AddFloatAccessor(positions, 3, true), AddFloatAccessor(normals, 3, false), AddFloatAccessor(uvs, 2, false), AddByteAccessor(colors), AddUIntAccessor(indices), material);
    }

    public int AddMaterial(string shader, string textureName, string textureUri)
    {
        var index = materials.Count; var alpha = shader.Contains("glass", StringComparison.OrdinalIgnoreCase);
        materials.Add(new Dictionary<string, object> {
            ["name"] = $"mat_{index}", ["pbrMetallicRoughness"] = new Dictionary<string, object> { ["baseColorFactor"] = new[] { 1f, 1f, 1f, 1f }, ["metallicFactor"] = 0f, ["roughnessFactor"] = .82f },
            ["doubleSided"] = true, ["alphaMode"] = alpha ? "BLEND" : shader.Contains("cutout", StringComparison.OrdinalIgnoreCase) || shader.Contains("trees", StringComparison.OrdinalIgnoreCase) ? "MASK" : "OPAQUE",
            ["alphaCutoff"] = .35f, ["extras"] = new Dictionary<string, object> { ["shader"] = shader, ["textureName"] = textureName, ["texture"] = textureUri },
        }); return index;
    }

    public int AddMesh(string name, List<GltfPrimitive> source)
    {
        var primitives = source.Select(value => new Dictionary<string, object> { ["attributes"] = new Dictionary<string, int> { ["POSITION"] = value.Position, ["NORMAL"] = value.Normal, ["TEXCOORD_0"] = value.Uv, ["COLOR_0"] = value.Color }, ["indices"] = value.Indices, ["material"] = value.Material, ["mode"] = 4 }).ToArray();
        meshes.Add(new Dictionary<string, object> { ["name"] = name, ["primitives"] = primitives }); return meshes.Count - 1;
    }

    public void AddNode(string name, int mesh, float[] position, float[] rotation)
    {
        nodes.Add(new Dictionary<string, object> { ["name"] = name, ["mesh"] = mesh, ["translation"] = position, ["rotation"] = rotation });
        for (var i = 0; i < 3; i++) { nodeMin[i] = Math.Min(nodeMin[i], position[i]); nodeMax[i] = Math.Max(nodeMax[i], position[i]); }
    }

    public Dictionary<string, float[]> GetPlacementBounds(float padding)
    {
        if (float.IsPositiveInfinity(nodeMin[0])) return new() { ["min"] = new[] { 0f, 0f, 0f }, ["max"] = new[] { 0f, 0f, 0f } };
        return new()
        {
            ["min"] = new[] { nodeMin[0] - padding, nodeMin[1] - 40f, nodeMin[2] - padding },
            ["max"] = new[] { nodeMax[0] + padding, nodeMax[1] + 120f, nodeMax[2] + padding },
        };
    }

    public void Write(string gltfName, string binName, Dictionary<string, object> extras)
    {
        System.IO.File.WriteAllBytes(Path.Combine(outputDir, binName), binary.ToArray());
        var root = new Dictionary<string, object> { ["asset"] = new Dictionary<string, object> { ["version"] = "2.0", ["generator"] = "gta4-webmap-headless" }, ["scene"] = 0, ["scenes"] = new[] { new Dictionary<string, object> { ["nodes"] = Enumerable.Range(0, nodes.Count).ToArray() } }, ["nodes"] = nodes, ["meshes"] = meshes, ["materials"] = materials, ["accessors"] = accessors, ["bufferViews"] = bufferViews, ["buffers"] = new[] { new Dictionary<string, object> { ["uri"] = binName, ["byteLength"] = binary.Length } }, ["extras"] = extras };
        System.IO.File.WriteAllText(Path.Combine(outputDir, gltfName), JsonSerializer.Serialize(root));
        System.IO.File.WriteAllText(Path.Combine(outputDir, "manifest.json"), JsonSerializer.Serialize(extras, new JsonSerializerOptions { WriteIndented = true }));
    }

    private int AddFloatAccessor(float[] values, int components, bool minMax)
    {
        Align(); var offset = binary.Position; using (var output = new BinaryWriter(binary, System.Text.Encoding.UTF8, true)) foreach (var value in values) output.Write(value);
        var view = AddView(offset, values.Length * 4, 34962); var accessor = new Dictionary<string, object> { ["bufferView"] = view, ["componentType"] = 5126, ["count"] = values.Length / components, ["type"] = components == 2 ? "VEC2" : "VEC3" };
        if (minMax) { accessor["min"] = Enumerable.Range(0, components).Select(c => Enumerable.Range(0, values.Length / components).Min(i => values[i * components + c])).ToArray(); accessor["max"] = Enumerable.Range(0, components).Select(c => Enumerable.Range(0, values.Length / components).Max(i => values[i * components + c])).ToArray(); }
        accessors.Add(accessor); return accessors.Count - 1;
    }
    private int AddByteAccessor(byte[] values) { Align(); var offset = binary.Position; binary.Write(values, 0, values.Length); var view = AddView(offset, values.Length, 34962); accessors.Add(new Dictionary<string, object> { ["bufferView"] = view, ["componentType"] = 5121, ["normalized"] = true, ["count"] = values.Length / 4, ["type"] = "VEC4" }); return accessors.Count - 1; }
    private int AddUIntAccessor(uint[] values) { Align(); var offset = binary.Position; using (var output = new BinaryWriter(binary, System.Text.Encoding.UTF8, true)) foreach (var value in values) output.Write(value); var view = AddView(offset, values.Length * 4, 34963); accessors.Add(new Dictionary<string, object> { ["bufferView"] = view, ["componentType"] = 5125, ["count"] = values.Length, ["type"] = "SCALAR" }); return accessors.Count - 1; }
    private int AddView(long offset, int length, int target) { bufferViews.Add(new Dictionary<string, object> { ["buffer"] = 0, ["byteOffset"] = offset, ["byteLength"] = length, ["target"] = target }); return bufferViews.Count - 1; }
    private void Align() { while ((binary.Position & 3) != 0) binary.WriteByte(0); }
    private static float ReadFloat(byte[] data, int offset) => BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4)));
}
