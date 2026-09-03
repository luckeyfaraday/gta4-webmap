using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using RageLib.Common;
using RageLib.FileSystem;
using RageLib.Models.Resource;
using RageLib.Models.Resource.Models;
using RageLib.Textures;
using static RageGltf;
using ArchiveFile = RageLib.FileSystem.Common.File;
using DrawableResource = RageLib.Models.Resource.File<RageLib.Models.Resource.DrawableModel>;

// Exports the weapons: their models out of pc/models/cdimages/weapons.img and
// their behaviour out of common/data/WeaponInfo.xml.
//
// A weapon model is the simplest thing in the game — an unskinned .wdr with a
// texture dictionary beside it — so this is a plain rigid mesh export. What
// makes a weapon feel like itself is the XML: damage, clip size, the gap
// between shots, range and reload time all come from the file rather than from
// anything invented here.
//
// The firing animations are NOT here. They belong to the character, are keyed
// by BoneID against his skeleton, and are exported by PlayerExport into its own
// clip library alongside his movement.
static class WeaponExport
{
    private const string WeaponImg = "pc/models/cdimages/weapons.img";
    private const string WeaponInfo = "common/data/WeaponInfo.xml";

    // The weapons to export, and the model and animation set each uses. The
    // names on the left are WeaponInfo.xml's own type names.
    private static readonly (string Type, string Model, string Anim, string Slot)[] Wanted =
    {
        ("PISTOL", "w_glock", "handgun", "handgun"),
        ("M4", "w_m4", "rifle", "rifle"),
        ("RLAUNCHER", "rpg", "rocket", "rocket"),
    };

    // The rocket a launcher fires. It is a weapon type in the XML and a model in
    // the archive, but it is ordnance rather than something carried.
    private const string ProjectileModel = "cj_rpg_rocket";

    private static float Float(string value, float fallback = 0) =>
        float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result) ? result : fallback;

    private static int Int(string value, int fallback = 0) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result) ? result : fallback;

    private static Dictionary<string, object> ReadWeaponInfo(string gameDir, string type)
    {
        var path = Path.Combine(gameDir, WeaponInfo.Replace('/', Path.DirectorySeparatorChar));
        if (!System.IO.File.Exists(path)) return null;
        var document = XDocument.Load(path);
        var weapon = document.Root?.Elements("weapon")
            .FirstOrDefault(element => string.Equals((string)element.Attribute("type"), type, StringComparison.OrdinalIgnoreCase));
        var data = weapon?.Element("data");
        if (data == null) return null;

        var damage = data.Element("damage");
        var reload = data.Element("reload");
        return new Dictionary<string, object>
        {
            ["type"] = type,
            ["slot"] = (string)data.Attribute("slot"),
            ["fireType"] = (string)data.Attribute("firetype"),
            ["damageType"] = (string)data.Attribute("damagetype"),
            ["group"] = (string)data.Attribute("group"),
            ["damage"] = Int((string)damage?.Attribute("base")),
            ["clipSize"] = Int((string)data.Attribute("clipsize"), 1),
            ["ammoMax"] = Int((string)data.Attribute("ammomax")),
            // Milliseconds between shots, straight out of the file: 333 for the
            // pistol, 120 for the M4, 800 for the launcher.
            ["timeBetweenShots"] = Int((string)data.Attribute("timebetweenshots"), 500),
            ["weaponRange"] = Float((string)data.Attribute("weaponrange"), 50),
            ["targetRange"] = Float((string)data.Attribute("targetrange"), 45),
            ["reloadTime"] = Int((string)reload?.Attribute("time"), 2000),
            ["flags"] = data.Element("flags")?.Elements("flag").Select(flag => flag.Value.Trim()).ToArray()
                ?? Array.Empty<string>(),
        };
    }

    public static int Run(string gameDir, string outputDir, string textureDir, string textureUriPrefix)
    {
        System.IO.Directory.CreateDirectory(outputDir);
        System.IO.Directory.CreateDirectory(textureDir);

        var archive = new IMGFileSystem();
        archive.Open(Path.Combine(gameDir, WeaponImg.Replace('/', Path.DirectorySeparatorChar)));
        try
        {
            var files = new Dictionary<string, ArchiveFile>(StringComparer.OrdinalIgnoreCase);
            foreach (var file in archive.GetAllFiles()) files[file.Name] = file;

            var exported = new List<Dictionary<string, object>>();
            var skipped = new List<string>();

            foreach (var (type, model, anim, slot) in Wanted)
            {
                var info = ReadWeaponInfo(gameDir, type);
                if (info == null) { skipped.Add($"{type} (not in WeaponInfo.xml)"); continue; }
                var record = ExportModel(model, files, outputDir, textureDir, textureUriPrefix);
                if (record == null) { skipped.Add($"{type} ({model}.wdr missing or empty)"); continue; }
                foreach (var pair in info) record[pair.Key] = pair.Value;
                record["animSet"] = anim;
                record["slot"] = slot;
                exported.Add(record);
                Console.WriteLine($"  {type,-10} {model,-10} {record["vertices"],6} verts  dmg {info["damage"]}  clip {info["clipSize"]}  {info["timeBetweenShots"]}ms");
            }

            var projectile = ExportModel(ProjectileModel, files, outputDir, textureDir, textureUriPrefix);
            if (projectile != null) projectile["type"] = "ROCKET";

            var manifest = new Dictionary<string, object>
            {
                ["source"] = WeaponImg + " + " + WeaponInfo,
                ["count"] = exported.Count,
                ["weapons"] = exported,
                ["projectile"] = projectile,
                ["skipped"] = skipped,
            };
            System.IO.File.WriteAllText(Path.Combine(outputDir, "weapons.json"),
                System.Text.Json.JsonSerializer.Serialize(manifest, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            Console.WriteLine($"Exported {exported.Count} weapon(s) to {outputDir}");
            foreach (var entry in skipped) Console.Error.WriteLine($"  skipped {entry}");
            return 0;
        }
        finally { archive.Close(); }
    }

    private static Dictionary<string, object> ExportModel(string model, Dictionary<string, ArchiveFile> files,
        string outputDir, string textureDir, string textureUriPrefix)
    {
        if (!files.TryGetValue(model + ".wdr", out var source)) return null;

        var drawable = new DrawableResource();
        drawable.Open(new MemoryStream(source.GetData(), writable: false));
        using var textures = OpenTextures(files, model);
        var embedded = drawable.Data.ShaderGroup?.TextureDictionary;

        var writer = new ModelGltfWriter("gta4-webmap-weapon");
        var primitives = new List<Dictionary<string, object>>();
        var vertexTotal = 0;
        var missing = new List<string>();

        // ModelCollection[0] is the full-detail model; the rest are LODs.
        if (drawable.Data.ModelCollection is { Length: > 0 })
        {
            foreach (var mesh in drawable.Data.ModelCollection[0])
            {
                for (var g = 0; g < mesh.Geometries.Count; g++)
                {
                    var geometry = mesh.Geometries[g];
                    if (geometry.VertexBuffer?.RawData == null || geometry.IndexBuffer?.RawData == null) continue;
                    var shaderIndex = g < mesh.ShaderMappings.Count ? mesh.ShaderMappings[g] : (ushort)0;
                    var shader = drawable.Data.ShaderGroup != null && shaderIndex < drawable.Data.ShaderGroup.Shaders.Count
                        ? drawable.Data.ShaderGroup.Shaders[shaderIndex] : null;
                    var shaderName = shader?.ShaderName ?? string.Empty;
                    var textureName = TextureIo.TextureName(shader);
                    var texture = TextureIo.FindTexture(textures, textureName) ?? TextureIo.FindTexture(embedded, textureName);
                    var textureUri = TextureIo.Export(texture, textureDir, textureUriPrefix);
                    if (textureUri == null && !string.IsNullOrWhiteSpace(textureName)) missing.Add(textureName);
                    var material = writer.AddMaterial($"{model}_{g}", shaderName, textureName, textureUri,
                        shaderName.Contains("alpha", StringComparison.OrdinalIgnoreCase));
                    primitives.Add(BuildRigidPrimitive(writer, geometry, material, ref vertexTotal));
                }
            }
        }
        drawable.Dispose();
        if (primitives.Count == 0) return null;

        var meshIndex = writer.AddMesh(model, primitives);
        var root = writer.AddNode(new Dictionary<string, object> { ["name"] = model, ["mesh"] = meshIndex });

        var record = new Dictionary<string, object>
        {
            ["model"] = model,
            ["gltf"] = model + ".gltf",
            ["vertices"] = vertexTotal,
            // A weapon is held, so the viewer parents it to a hand bone and the
            // world mirror is inherited from the character rather than applied
            // here.
            ["parentedToHand"] = true,
        };
        if (missing.Count > 0) record["missingTextures"] = missing.Distinct().ToArray();

        writer.Write(outputDir, model + ".gltf", model + ".bin", record, sceneRoot: root, manifestName: null);
        return record;
    }

    private static TextureFile OpenTextures(Dictionary<string, ArchiveFile> files, string model)
    {
        if (!files.TryGetValue(model + ".wtd", out var source)) return null;
        var dictionary = new TextureFile();
        try { dictionary.Open(source.GetData()); }
        catch { dictionary.Dispose(); return null; }
        return dictionary;
    }

    // Weapons are unskinned, so this is the plain version of the primitive
    // builder the character and vehicles use: no blend indices, no matrix
    // palette, just position, normal and UV through the same RAGE-to-glTF
    // rotation.
    private static Dictionary<string, object> BuildRigidPrimitive(ModelGltfWriter writer, Geometry geometry,
        int material, ref int vertexTotal)
    {
        var declaration = geometry.VertexBuffer.VertexDeclaration.DecodeAsVertexElements();
        var offsets = new Dictionary<(VertexElementUsage, int), int>();
        var cursor = 0;
        foreach (var element in declaration) { offsets[(element.Usage, element.UsageIndex)] = cursor; cursor += element.Size; }

        var stride = checked((int)geometry.VertexBuffer.StrideSize);
        var count = geometry.VertexCount;
        var raw = geometry.VertexBuffer.RawData;
        var positionOffset = offsets[(VertexElementUsage.Position, 0)];
        var hasNormal = offsets.TryGetValue((VertexElementUsage.Normal, 0), out var normalOffset);
        var hasUv = offsets.TryGetValue((VertexElementUsage.TextureCoordinate, 0), out var uvOffset);

        var positions = new float[count * 3];
        var normals = new float[count * 3];
        var uvs = new float[count * 2];

        for (var i = 0; i < count; i++)
        {
            var start = i * stride;
            var position = ToGltf(ReadFloat(raw, start + positionOffset), ReadFloat(raw, start + positionOffset + 4), ReadFloat(raw, start + positionOffset + 8));
            positions[i * 3] = position.X; positions[i * 3 + 1] = position.Y; positions[i * 3 + 2] = position.Z;
            if (hasNormal)
            {
                var normal = ToGltf(ReadFloat(raw, start + normalOffset), ReadFloat(raw, start + normalOffset + 4), ReadFloat(raw, start + normalOffset + 8));
                normals[i * 3] = normal.X; normals[i * 3 + 1] = normal.Y; normals[i * 3 + 2] = normal.Z;
            }
            if (hasUv) { uvs[i * 2] = ReadFloat(raw, start + uvOffset); uvs[i * 2 + 1] = ReadFloat(raw, start + uvOffset + 4); }
        }
        vertexTotal += count;

        var source = new ushort[geometry.IndexCount];
        Buffer.BlockCopy(geometry.IndexBuffer.RawData, 0, source, 0, source.Length * 2);
        var indices = new uint[geometry.FaceCount * 3];
        for (var i = 0; i < indices.Length; i++) indices[i] = source[i];

        return new Dictionary<string, object>
        {
            ["attributes"] = new Dictionary<string, int>
            {
                ["POSITION"] = writer.AddFloatAccessor(positions, 3, true),
                ["NORMAL"] = writer.AddFloatAccessor(normals, 3, false),
                ["TEXCOORD_0"] = writer.AddFloatAccessor(uvs, 2, false),
            },
            ["indices"] = writer.AddIndexAccessor(indices),
            ["material"] = material,
            ["mode"] = 4,
        };
    }

    private static float ReadFloat(byte[] data, int offset) =>
        BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4)));
}
