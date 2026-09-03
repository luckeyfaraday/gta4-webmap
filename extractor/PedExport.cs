using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RageLib.Common;
using RageLib.FileSystem;
using RageLib.Models.Resource;
using RageLib.Textures;
using ArchiveFile = RageLib.FileSystem.Common.File;
using DictionaryResource = RageLib.Models.Resource.File<RageLib.Models.Resource.DrawableModelDictionary>;
using FragResource = RageLib.Models.Resource.File<RageLib.Models.Resource.FragTypeModel>;
using ResourceSkeleton = RageLib.Models.Resource.Skeletons.Skeleton;

// Exports the ambient population out of pc/models/cdimages/componentpeds.img.
//
// The shape differs from Niko, whose components are loose .wdr files inside
// playerped.rpf. An ambient ped is a triple: <name>.wdd is a pgDictionary of
// component drawables, <name>.wft carries the skeleton, and <name>.wtd the
// textures. Every one of the 345 .wft files is between 25,982 and 27,196 bytes,
// which is the tell that they all share the standard ped skeleton — so one
// skinning path and one animation set covers the whole population.
static class PedExport
{
    private const string PedImg = "pc/models/cdimages/componentpeds.img";

    // Component slots a ped drawable dictionary may carry, in the order they
    // are drawn. Not every ped has all of them.
    private static readonly string[] ComponentSlots =
        { "head", "hair", "teef", "uppr", "lowr", "feet", "hand", "eyes", "accs", "task", "decl" };

    private static Dictionary<string, ArchiveFile> OpenPedArchive(string gameDir, out IMGFileSystem archive)
    {
        archive = new IMGFileSystem();
        archive.Open(Path.Combine(gameDir, PedImg.Replace('/', Path.DirectorySeparatorChar)));
        var result = new Dictionary<string, ArchiveFile>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in archive.GetAllFiles()) result[file.Name] = file;
        return result;
    }

    // The dictionary keys are name hashes, so recover the spelling by hashing
    // the candidate names the game uses and matching. Same hash and same
    // bare-leaf-name convention the texture dictionaries use.
    private static Dictionary<uint, string> BuildNameTable()
    {
        // Component names are "<slot>_<nnn>" optionally followed by a one- or
        // two-letter code ("_u" universal, "_r" race-varied, and a handful of
        // others). Enumerating all of those is a few hundred thousand hashes,
        // which costs nothing and resolves essentially every ped in the game.
        var suffixes = new List<string> { "" };
        for (var first = 'a'; first <= 'z'; first++)
        {
            suffixes.Add($"_{first}");
            for (var second = 'a'; second <= 'z'; second++) suffixes.Add($"_{first}{second}");
        }

        var table = new Dictionary<uint, string>();
        foreach (var slot in ComponentSlots)
            for (var variant = 0; variant < 32; variant++)
                foreach (var suffix in suffixes)
                {
                    var name = $"{slot}_{variant:000}{suffix}";
                    table.TryAdd(Hasher.Hash(name), name);
                }
        return table;
    }

    public static int Probe(string gameDir, string[] peds)
    {
        var files = OpenPedArchive(gameDir, out var archive);
        var names = BuildNameTable();
        try
        {
            foreach (var ped in peds)
            {
                Console.WriteLine($"=== {ped} ===");
                if (!files.TryGetValue(ped + ".wdd", out var wddFile))
                {
                    Console.Error.WriteLine($"  no {ped}.wdd in {PedImg}");
                    continue;
                }

                if (files.TryGetValue(ped + ".wft", out var wftFile))
                {
                    var frag = new FragResource();
                    frag.Open(new MemoryStream(wftFile.GetData(), writable: false));
                    var skeleton = frag.Data.Skeleton ?? frag.Data.Drawable?.Skeleton;
                    Console.WriteLine($"  skeleton: {(skeleton == null ? "none" : skeleton.Bones.Count + " bones")}");
                    if (skeleton != null)
                        Console.WriteLine($"    first 8: {string.Join(", ", skeleton.Bones.Take(8).Select(b => $"{b.Name}#{b.BoneID}"))}");
                    frag.Dispose();
                }

                var dictionary = new DictionaryResource();
                dictionary.Open(new MemoryStream(wddFile.GetData(), writable: false));
                var data = dictionary.Data;
                Console.WriteLine($"  components: {data.Entries.Count}");
                for (var i = 0; i < data.Entries.Count; i++)
                {
                    var hash = i < data.NameHashes.Count ? data.NameHashes[i] : 0u;
                    var name = names.TryGetValue(hash, out var resolved) ? resolved : $"0x{hash:X8}";
                    var drawable = data.Entries[i];
                    var geometries = 0;
                    var vertices = 0;
                    var shaders = new List<string>();
                    if (drawable?.ModelCollection is { Length: > 0 })
                        foreach (var model in drawable.ModelCollection[0])
                        {
                            geometries += model.Geometries.Count;
                            foreach (var geometry in model.Geometries) vertices += geometry.VertexCount;
                            for (var g = 0; g < model.Geometries.Count; g++)
                            {
                                var index = g < model.ShaderMappings.Count ? model.ShaderMappings[g] : (ushort)0;
                                if (drawable.ShaderGroup != null && index < drawable.ShaderGroup.Shaders.Count)
                                    shaders.Add(TextureIo.TextureName(drawable.ShaderGroup.Shaders[index]) ?? "?");
                            }
                        }
                    Console.WriteLine($"    [{i,2}] {name,-14} {geometries} geom {vertices,6} verts  tex: {string.Join(", ", shaders.Distinct().Take(3))}");
                }
                dictionary.Dispose();

                if (files.TryGetValue(ped + ".wtd", out var wtdFile))
                {
                    using var textures = new TextureFile();
                    textures.Open(wtdFile.GetData());
                    var bytes = textures.Textures.Sum(t => (long)t.GetAllMipData().Length);
                    Console.WriteLine($"  textures: {textures.Textures.Count}, {bytes / 1024} KB");
                    foreach (var texture in textures.Textures.Take(8))
                        Console.WriteLine($"    {texture.Name,-42} {texture.Width}x{texture.Height} {texture.Format} {texture.Levels} mip(s)");
                }
            }
            return 0;
        }
        finally { archive.Close(); }
    }

    // ---- export -----------------------------------------------------------

    private const string AnimImg = "pc/anim/anim.img";

    // The ambient locomotion sets. move_m@generic and move_f@generic are the
    // male and female walk cycles the crowd runs on; move_cop is what the
    // police use. All three are keyed by BoneID, so one export drives every ped.
    private static readonly string[] AnimationWads = { "move_m@generic.wad", "move_f@generic.wad", "move_cop.wad" };

    private sealed class Component
    {
        public string Slot;
        public string Name;
        public DrawableModel Drawable;
    }

    // Which slot and variant a component belongs to. The dictionary's own name
    // is the authority when the hash reverses, because a component may bundle
    // geometry that is not its own slot: m_y_bronx_01's "lowr_000_u" carries two
    // geometries and the *first* one is textured head_diff_000_a_bla. Reading
    // the slot off that texture labels the trousers a head, which then displaces
    // the real head and leaves the ped headless.
    //
    // The texture is only the fallback, for peds whose name hash does not
    // reverse — and even then the slot is taken from the geometry with the most
    // vertices rather than the first, so a small patch cannot outvote the
    // garment it is attached to.
    private static bool ClassifyComponent(DrawableModel drawable, string hashName, out string slot, out int variant)
    {
        slot = null;
        variant = int.MaxValue;

        if (hashName != null)
        {
            var underscore = hashName.IndexOf('_');
            if (underscore > 0)
            {
                var named = ComponentSlots.FirstOrDefault(s => s.Equals(hashName[..underscore], StringComparison.OrdinalIgnoreCase));
                var digits = new string(hashName.Skip(underscore + 1).TakeWhile(char.IsDigit).ToArray());
                if (named != null && int.TryParse(digits, out var fromName))
                {
                    slot = named;
                    variant = fromName;
                    return true;
                }
            }
        }

        if (drawable?.ModelCollection == null || drawable.ModelCollection.Length == 0) return false;
        var best = -1;
        foreach (var model in drawable.ModelCollection[0])
            for (var g = 0; g < model.Geometries.Count; g++)
            {
                var index = g < model.ShaderMappings.Count ? model.ShaderMappings[g] : (ushort)0;
                if (drawable.ShaderGroup == null || index >= drawable.ShaderGroup.Shaders.Count) continue;
                var texture = TextureIo.TextureName(drawable.ShaderGroup.Shaders[index]);
                if (string.IsNullOrWhiteSpace(texture)) continue;
                var parts = Path.GetFileNameWithoutExtension(texture).Split('_');
                if (parts.Length < 3) continue;
                var candidate = ComponentSlots.FirstOrDefault(s => s.Equals(parts[0], StringComparison.OrdinalIgnoreCase));
                if (candidate == null || !int.TryParse(parts[2], out var number)) continue;
                var weight = model.Geometries[g].VertexCount;
                if (weight <= best) continue;
                best = weight;
                slot = candidate;
                variant = number;
            }
        return slot != null;
    }

    // One entry per slot: the lowest-numbered variant present, which is the
    // ped's default outfit. The other variants are recorded in the catalogue
    // but not exported — 345 peds is already the variety, and shipping every
    // shirt would multiply the payload for very little visible gain.
    private static List<Component> DefaultOutfit(DrawableModelDictionary dictionary, Dictionary<uint, string> names,
        out List<string> otherVariants)
    {
        var bySlot = new Dictionary<string, (int Variant, Component Item)>(StringComparer.OrdinalIgnoreCase);
        otherVariants = new List<string>();
        for (var i = 0; i < dictionary.Entries.Count; i++)
        {
            var drawable = dictionary.Entries[i];
            var hash = i < dictionary.NameHashes.Count ? dictionary.NameHashes[i] : 0u;
            names.TryGetValue(hash, out var hashName);
            if (!ClassifyComponent(drawable, hashName, out var slot, out var variant)) continue;
            var name = hashName ?? $"{slot}_{variant:000}";
            var item = new Component { Slot = slot, Name = name, Drawable = drawable };
            if (bySlot.TryGetValue(slot, out var existing))
            {
                if (variant >= existing.Variant) { otherVariants.Add(name); continue; }
                otherVariants.Add(existing.Item.Name);
            }
            bySlot[slot] = (variant, item);
        }
        return ComponentSlots
            .Where(bySlot.ContainsKey)
            .Select(slot => bySlot[slot].Item)
            .ToList();
    }

    private static ResourceSkeleton ReadSkeleton(byte[] wftData, out FragResource resource)
    {
        resource = new FragResource();
        resource.Open(new MemoryStream(wftData, writable: false));
        return resource.Data.Skeleton ?? resource.Data.Drawable?.Skeleton;
    }

    public static int Run(string gameDir, string outputDir, string textureDir, string textureUriPrefix,
        int maxEdge, string[] only)
    {
        System.IO.Directory.CreateDirectory(outputDir);
        System.IO.Directory.CreateDirectory(textureDir);

        var files = OpenPedArchive(gameDir, out var archive);
        var names = BuildNameTable();
        try
        {
            var upfront = new List<string>();
            var candidates = files.Keys
                .Where(key => key.EndsWith(".wdd", StringComparison.OrdinalIgnoreCase))
                .Select(key => key[..^4])
                .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            var pedNames = new List<string>();
            foreach (var name in candidates)
            {
                // "superlod" is the game's 3-vertex stand-in for a ped too far
                // away to draw, not a member of the population.
                if (name.Equals("superlod", StringComparison.OrdinalIgnoreCase)) { upfront.Add(name + " (LOD placeholder, not a ped)"); continue; }
                if (!files.ContainsKey(name + ".wft")) { upfront.Add(name + " (no .wft)"); continue; }
                if (!files.ContainsKey(name + ".wtd")) { upfront.Add(name + " (no .wtd of its own)"); continue; }
                pedNames.Add(name);
            }
            // The reference skeleton is chosen BEFORE any filter is applied.
            // Bone names are taken from it and stamped on every ped and on the
            // clip library, so it must not depend on which peds this run
            // happens to export — re-exporting just the clips with a filter
            // would otherwise pick a different reference and emit tracks for
            // Char_L_Toe0 against a population whose bone is called Char_L_Toe.
            var referenceName = pedNames.FirstOrDefault();

            if (only is { Length: > 0 })
                pedNames = pedNames.Where(name => only.Contains(name, StringComparer.OrdinalIgnoreCase)).ToList();
            Console.WriteLine($"{pedNames.Count} ped(s) in {PedImg}"
                + (upfront.Count > 0 ? $" ({upfront.Count} excluded: {string.Join(", ", upfront)})" : ""));

            // Every ped carries its own copy of the same standard skeleton, and
            // the copies disagree on a couple of bone *names* (Char_L_Toe vs
            // Char_L_Toe0) while agreeing on every BoneID. Node names are
            // therefore taken from one reference ped and applied by ID to all
            // of them, so a single set of clips drives the whole population.
            var reference = referenceName;
            if (reference == null) { Console.Error.WriteLine("No peds found."); return 1; }
            var referenceSkeleton = ReadSkeleton(files[reference + ".wft"].GetData(), out var referenceResource);
            var canonicalName = new Dictionary<int, string>();
            foreach (var bone in referenceSkeleton.Bones)
                canonicalName.TryAdd(bone.BoneID, string.IsNullOrEmpty(bone.Name) ? $"bone_{bone.BoneID}" : bone.Name);
            Console.WriteLine($"Reference skeleton: {reference}, {referenceSkeleton.Bones.Count} bones");

            var clipInfo = WriteAnimations(gameDir, outputDir, referenceSkeleton, canonicalName);
            referenceResource.Dispose();

            var exported = new List<Dictionary<string, object>>();
            var skipped = new List<string>(upfront);
            foreach (var ped in pedNames)
            {
                try
                {
                    var record = ExportOne(ped, files, names, canonicalName, outputDir, textureDir, textureUriPrefix, maxEdge);
                    if (record == null) { skipped.Add(ped + " (no geometry)"); continue; }
                    exported.Add(record);
                }
                catch (Exception error) { skipped.Add($"{ped} ({error.GetType().Name}: {error.Message})"); }
            }

            var manifest = new Dictionary<string, object>
            {
                ["source"] = PedImg,
                ["count"] = exported.Count,
                ["skeleton"] = referenceSkeleton.Bones.Count,
                ["animations"] = "animations.gltf",
                ["clips"] = clipInfo,
                ["maxTextureEdge"] = maxEdge,
                ["peds"] = exported,
                ["skipped"] = skipped,
            };
            System.IO.File.WriteAllText(Path.Combine(outputDir, "peds.json"),
                System.Text.Json.JsonSerializer.Serialize(manifest, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));

            Console.WriteLine($"Exported {exported.Count} ped(s) and {clipInfo.Count} shared clip(s) to {outputDir}");
            foreach (var entry in skipped.Take(20)) Console.Error.WriteLine($"  skipped {entry}");
            return 0;
        }
        finally { archive.Close(); }
    }

    // The clip library, written once. It carries the skeleton and the
    // animations but no meshes: the viewer loads it a single time and plays its
    // clips on any ped, because every ped's bone nodes carry the same names.
    private static List<Dictionary<string, object>> WriteAnimations(string gameDir, string outputDir,
        ResourceSkeleton skeleton, Dictionary<int, string> canonicalName)
    {
        var writer = new ModelGltfWriter("gta4-webmap-ped-anim");
        var (boneNodes, boneIdToNode, _, _) = BuildSkeletonNodes(writer, skeleton, canonicalName);

        var rootBone = skeleton.Bones[0];
        var rootRest = (rootBone.Position.X, rootBone.Position.Y, rootBone.Position.Z);
        var restByBoneId = new Dictionary<int, Quat>();
        foreach (var bone in skeleton.Bones)
            restByBoneId.TryAdd(bone.BoneID, new Quat(bone.RotationQuaternion.X, bone.RotationQuaternion.Y, bone.RotationQuaternion.Z, bone.RotationQuaternion.W).Normalized());

        var clipInfo = new List<Dictionary<string, object>>();
        var animationImg = new IMGFileSystem();
        animationImg.Open(Path.Combine(gameDir, AnimImg.Replace('/', Path.DirectorySeparatorChar)));
        try
        {
            var entries = animationImg.GetAllFiles().ToDictionary(file => file.Name, StringComparer.OrdinalIgnoreCase);
            foreach (var wadName in AnimationWads)
            {
                if (!entries.TryGetValue(wadName, out var wad)) { Console.Error.WriteLine($"  missing {wadName}"); continue; }
                using var dictionary = new RageLib.Animation.AnimationDictionaryFile();
                dictionary.Open(new MemoryStream(wad.GetData(), writable: false));
                var added = 0;
                // "move_m@generic.wad" -> "m@generic/", so a clip is asked for as
                // "m@generic/walk". The three sets share 50 names.
                var set = Path.GetFileNameWithoutExtension(wadName);
                var prefix = (set.StartsWith("move_", StringComparison.OrdinalIgnoreCase) ? set[5..] : set) + "/";
                foreach (var clip in dictionary.File.Data.Entries)
                {
                    var info = PlayerExport.AddAnimation(writer, clip, boneIdToNode, boneNodes[0], rootRest, restByBoneId, prefix);
                    if (info == null) continue;
                    info["wad"] = set;
                    info["set"] = prefix.TrimEnd('/');
                    clipInfo.Add(info);
                    added++;
                }
                Console.WriteLine($"  {wadName}: {added} clip(s)");
            }
        }
        finally { animationImg.Close(); }

        var root = writer.AddNode(new Dictionary<string, object>
        {
            ["name"] = "ped_rig",
            ["children"] = new[] { boneNodes[0] },
        });
        writer.Write(outputDir, "animations.gltf", "animations.bin",
            new Dictionary<string, object> { ["bones"] = boneNodes.Length, ["clips"] = clipInfo },
            sceneRoot: root, manifestName: null);
        return clipInfo;
    }

    // Bone nodes in glTF space, composed from the local chain so the bind pose
    // agrees with the hierarchy by construction. Returns the node indices, the
    // BoneID lookup the clips need, and the composed world transforms the
    // inverse bind matrices are built from.
    private static (int[] BoneNodes, Dictionary<int, int> BoneIdToNode, Quat[] WorldRotation, (float X, float Y, float Z)[] WorldPosition)
        BuildSkeletonNodes(ModelGltfWriter writer, ResourceSkeleton skeleton, Dictionary<int, string> canonicalName)
    {
        var boneCount = skeleton.Bones.Count;
        var boneNodes = new int[boneCount];
        var children = new List<int>[boneCount];
        var worldRotation = new Quat[boneCount];
        var worldPosition = new (float X, float Y, float Z)[boneCount];
        var boneIdToNode = new Dictionary<int, int>();
        for (var i = 0; i < boneCount; i++) children[i] = new List<int>();

        for (var i = 0; i < boneCount; i++)
        {
            var bone = skeleton.Bones[i];
            var localPosition = RageGltf.ToGltf(bone.Position.X, bone.Position.Y, bone.Position.Z);
            var localRotation = RageGltf.ToGltf(new Quat(bone.RotationQuaternion.X, bone.RotationQuaternion.Y, bone.RotationQuaternion.Z, bone.RotationQuaternion.W).Normalized());
            boneNodes[i] = writer.AddNode(new Dictionary<string, object>
            {
                // Canonical, by BoneID, so one clip library fits every ped.
                ["name"] = canonicalName.TryGetValue(bone.BoneID, out var canonical) ? canonical
                    : string.IsNullOrEmpty(bone.Name) ? $"bone_{i}" : bone.Name,
                ["translation"] = new[] { localPosition.X, localPosition.Y, localPosition.Z },
                ["rotation"] = new[] { localRotation.X, localRotation.Y, localRotation.Z, localRotation.W },
            });

            var parent = ParentOf(skeleton, i);
            if (parent >= 0)
            {
                children[parent].Add(boneNodes[i]);
                var offset = worldRotation[parent].Rotate(localPosition.X, localPosition.Y, localPosition.Z);
                worldPosition[i] = (worldPosition[parent].X + offset.X, worldPosition[parent].Y + offset.Y, worldPosition[parent].Z + offset.Z);
                worldRotation[i] = Quat.Multiply(worldRotation[parent], localRotation);
            }
            else
            {
                worldPosition[i] = localPosition;
                worldRotation[i] = localRotation;
            }
            boneIdToNode.TryAdd(bone.BoneID, boneNodes[i]);
        }
        for (var i = 0; i < boneCount; i++)
            if (children[i].Count > 0) writer.SetNodeChildren(boneNodes[i], children[i]);

        return (boneNodes, boneIdToNode, worldRotation, worldPosition);
    }

    private static int ParentOf(ResourceSkeleton skeleton, int index)
    {
        var parent = skeleton.ParentIndices[index];
        return index == 0 || parent == index ? -1 : parent;
    }

    private static Dictionary<string, object> ExportOne(string ped, Dictionary<string, ArchiveFile> files,
        Dictionary<uint, string> names, Dictionary<int, string> canonicalName,
        string outputDir, string textureDir, string textureUriPrefix, int maxEdge)
    {
        var skeleton = ReadSkeleton(files[ped + ".wft"].GetData(), out var skeletonResource);
        try
        {
            if (skeleton == null) return null;

            var writer = new ModelGltfWriter("gta4-webmap-ped");
            var (boneNodes, _, worldRotation, worldPosition) = BuildSkeletonNodes(writer, skeleton, canonicalName);
            var boneCount = boneNodes.Length;

            var inverseBind = new float[boneCount * 16];
            for (var i = 0; i < boneCount; i++)
            {
                var inverseRotation = worldRotation[i].Conjugate();
                var t = inverseRotation.Rotate(worldPosition[i].X, worldPosition[i].Y, worldPosition[i].Z);
                WriteMatrix(inverseBind.AsSpan(i * 16, 16), inverseRotation, (-t.X, -t.Y, -t.Z));
            }
            var skin = writer.AddSkin(boneNodes, writer.AddFloatAccessor(inverseBind, 16, false, vertexData: false), boneNodes[0]);

            using var textures = new TextureFile();
            textures.Open(files[ped + ".wtd"].GetData());

            var dictionary = new DictionaryResource();
            dictionary.Open(new MemoryStream(files[ped + ".wdd"].GetData(), writable: false));
            var outfit = DefaultOutfit(dictionary.Data, names, out var otherVariants);

            var lowestY = float.PositiveInfinity;
            var vertexTotal = 0;
            var missingTextures = new List<string>();
            var meshNodes = new List<int>();
            var textureBytes = 0L;
            var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            foreach (var component in outfit)
            {
                var drawable = component.Drawable;
                if (drawable?.ModelCollection == null || drawable.ModelCollection.Length == 0) continue;
                var primitives = new List<Dictionary<string, object>>();

                // ModelCollection[0] is the full-detail model; the rest are LODs.
                foreach (var model in drawable.ModelCollection[0])
                {
                    for (var geometryIndex = 0; geometryIndex < model.Geometries.Count; geometryIndex++)
                    {
                        var geometry = model.Geometries[geometryIndex];
                        if (geometry.VertexBuffer?.RawData == null || geometry.IndexBuffer?.RawData == null) continue;
                        var shaderIndex = geometryIndex < model.ShaderMappings.Count ? model.ShaderMappings[geometryIndex] : (ushort)0;
                        var shader = drawable.ShaderGroup != null && shaderIndex < drawable.ShaderGroup.Shaders.Count
                            ? drawable.ShaderGroup.Shaders[shaderIndex] : null;
                        var shaderName = shader?.ShaderName ?? string.Empty;
                        var textureName = TextureIo.TextureName(shader);
                        var texture = TextureIo.FindTexture(textures, textureName);
                        // Namespaced by ped: see the note on TextureIo.Export.
                        // These names collide across peds and the images differ.
                        var target = texture == null ? null
                            : Path.Combine(textureDir, TextureIo.SafeName(ped) + "__" + TextureIo.SafeName(texture.Name) + ".dds");
                        var isNew = target != null && !System.IO.File.Exists(target);
                        var textureUri = TextureIo.Export(texture, textureDir, textureUriPrefix, maxEdge, ped);
                        if (textureUri == null && !string.IsNullOrWhiteSpace(textureName)) missingTextures.Add(textureName);
                        else if (isNew && written.Add(textureUri)) textureBytes += new FileInfo(target).Length;

                        // Hair is the one component that needs alpha testing;
                        // the rest of a ped is opaque.
                        var material = writer.AddMaterial($"{component.Name}_{geometryIndex}", shaderName, textureName, textureUri,
                            component.Slot.Equals("hair", StringComparison.OrdinalIgnoreCase));
                        primitives.Add(PlayerExport.BuildSkinnedPrimitive(writer, geometry, material, boneNodes, ref lowestY, ref vertexTotal));
                    }
                }
                if (primitives.Count == 0) continue;
                meshNodes.Add(writer.AddNode(new Dictionary<string, object>
                {
                    ["name"] = component.Name,
                    ["mesh"] = writer.AddMesh(component.Name, primitives),
                    ["skin"] = skin,
                }));
            }
            dictionary.Dispose();

            if (vertexTotal == 0) return null;

            // Stand the ped on the ground rather than on the pelvis, which is
            // where the RAGE skeleton is centred — the same lift the player
            // export applies.
            var footOffset = float.IsPositiveInfinity(lowestY) ? 0f : -lowestY;
            var root = writer.AddNode(new Dictionary<string, object>
            {
                ["name"] = ped,
                ["translation"] = new[] { 0f, footOffset, 0f },
                ["children"] = meshNodes.Concat(new[] { boneNodes[0] }).ToArray(),
            });

            var record = new Dictionary<string, object>
            {
                ["ped"] = ped,
                ["gltf"] = ped + ".gltf",
                ["sex"] = ped.StartsWith("f_", StringComparison.OrdinalIgnoreCase) ? "f" : "m",
                ["bones"] = boneCount,
                ["vertices"] = vertexTotal,
                ["components"] = outfit.Select(item => item.Name).ToArray(),
                ["otherVariants"] = otherVariants.ToArray(),
                ["footOffset"] = footOffset,
                // Program.cs writes the world through a reflection; the viewer
                // mirrors peds into that space exactly as it does Niko.
                ["worldMirrorX"] = true,
            };
            if (missingTextures.Count > 0) record["missingTextures"] = missingTextures.Distinct().ToArray();

            writer.Write(outputDir, ped + ".gltf", ped + ".bin", record, sceneRoot: root, manifestName: null);
            Console.WriteLine($"  {ped,-22} {vertexTotal,6:n0} verts  {outfit.Count} component(s)  +{textureBytes / 1024,4} KB tex");
            return record;
        }
        finally { skeletonResource.Dispose(); }
    }

    private static void WriteMatrix(Span<float> target, Quat rotation, (float X, float Y, float Z) translation)
    {
        float x = rotation.X, y = rotation.Y, z = rotation.Z, w = rotation.W;
        // Column-major, as glTF stores matrices.
        target[0] = 1 - 2 * (y * y + z * z); target[1] = 2 * (x * y + z * w); target[2] = 2 * (x * z - y * w); target[3] = 0;
        target[4] = 2 * (x * y - z * w); target[5] = 1 - 2 * (x * x + z * z); target[6] = 2 * (y * z + x * w); target[7] = 0;
        target[8] = 2 * (x * z + y * w); target[9] = 2 * (y * z - x * w); target[10] = 1 - 2 * (x * x + y * y); target[11] = 0;
        target[12] = translation.X; target[13] = translation.Y; target[14] = translation.Z; target[15] = 1;
    }
}
