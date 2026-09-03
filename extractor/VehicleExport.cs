using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using RageLib.FileSystem;
using RageLib.Models.Resource;
using RageLib.Models.Resource.Models;
using RageLib.Textures;
using static RageGltf;
using ArchiveFile = RageLib.FileSystem.Common.File;
using FragResource = RageLib.Models.Resource.File<RageLib.Models.Resource.FragTypeModel>;
using ResourceSkeleton = RageLib.Models.Resource.Skeletons.Skeleton;

// Exports the traffic vehicles out of pc/models/cdimages/vehicles.img. Unlike
// the player, a car is not a skin: a .wft is a rage::fragType whose main
// Drawable is the body shell and whose Children are the separable pieces —
// wheels, doors, bonnet, boot, bumpers, glass — each attached to a skeleton
// bone that supplies its transform. So each vehicle exports as a rigid glTF
// node hierarchy, one node per piece, which is also exactly what the viewer
// needs to spin the wheels and swing the doors.
//
// Model metadata comes from the loose text files the game ships beside the
// archives: vehicles.ide (which models exist, and how common they are in
// traffic), handling.dat (mass, drive type, top speed) and carcols.dat (the
// paint sets each model is allowed to spawn in).
static class VehicleExport
{
    private const string VehicleImg = "pc/models/cdimages/vehicles.img";

    // Most of a car's surface is painted from the shared dictionaries, not from
    // its own .wtd: police.wtd holds three badge and light textures while the
    // bodywork, glass and interior all resolve out of vehshare. Lookup order is
    // model first, then these.
    private static readonly string[] SharedTextureDictionaries = { "vehshare", "vehshare_truck" };

    // gta_vehicle_paint* is the sprayable bodywork: the texture is a spec map
    // and the actual colour is per-instance, from the model's carcols sets. The
    // viewer needs to know which primitives to tint, so it is recorded on the
    // material.
    private static bool IsPaint(string shaderName) =>
        shaderName != null && shaderName.StartsWith("gta_vehicle_paint", StringComparison.OrdinalIgnoreCase);

    private static bool IsGlass(string shaderName) =>
        shaderName != null && shaderName.Contains("glass", StringComparison.OrdinalIgnoreCase);

    // Frag children whose bone name starts with one of these is a moving part
    // the viewer animates rather than a static body panel.
    private static string PartKind(string boneName)
    {
        if (string.IsNullOrEmpty(boneName)) return "body";
        var name = boneName.ToLowerInvariant();
        if (name.StartsWith("wheel_l") || name.StartsWith("wheel_r")) return "wheel";
        if (name.StartsWith("door_")) return "door";
        if (name.StartsWith("bonnet")) return "bonnet";
        if (name.StartsWith("boot")) return "boot";
        if (name.StartsWith("windscreen") || name.Contains("window") || name.Contains("glass")) return "glass";
        if (name.StartsWith("bumper_")) return "bumper";
        if (name.StartsWith("chassis")) return "chassis";
        return "body";
    }

    private static FragTypeModel ReadFragment(byte[] data, out FragResource resource)
    {
        resource = new FragResource();
        resource.Open(new MemoryStream(data, writable: false));
        return resource.Data;
    }

    private static Dictionary<string, ArchiveFile> OpenVehicleArchive(string gameDir, out IMGFileSystem archive)
    {
        archive = new IMGFileSystem();
        archive.Open(Path.Combine(gameDir, VehicleImg.Replace('/', Path.DirectorySeparatorChar)));
        var result = new Dictionary<string, ArchiveFile>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in archive.GetAllFiles()) result[file.Name] = file;
        return result;
    }

    // Diagnostic: the shape of one vehicle fragment, so the export can be
    // written against what the file actually holds rather than assumptions.
    public static int Probe(string gameDir, string[] models)
    {
        var files = OpenVehicleArchive(gameDir, out var archive);
        try
        {
            foreach (var model in models)
            {
                if (!files.TryGetValue(model + ".wft", out var source))
                {
                    Console.Error.WriteLine($"{model}: no such vehicle in {VehicleImg}");
                    continue;
                }
                var fragment = ReadFragment(source.GetData(), out var resource);
                var skeleton = fragment.Skeleton ?? fragment.Drawable?.Skeleton;
                Console.WriteLine($"=== {model} ===");
                Console.WriteLine($"  skeleton: {(skeleton == null ? "none" : skeleton.Bones.Count + " bones")}");
                if (skeleton != null)
                    foreach (var bone in skeleton.Bones)
                        Console.WriteLine($"    [{bone.BoneIndex,3}] id={bone.BoneID,-5} {bone.Name,-22} kind={PartKind(bone.Name),-8} pos=({bone.Position.X:0.###},{bone.Position.Y:0.###},{bone.Position.Z:0.###})");

                Console.WriteLine($"  body drawable: {DescribeDrawable(fragment.Drawable)}");
                DescribeSkinning(fragment.Drawable, skeleton);
                Console.WriteLine($"  children: {fragment.Children?.Length ?? 0}");
                for (var i = 0; i < (fragment.Children?.Length ?? 0); i++)
                {
                    var child = fragment.Children[i];
                    var boneName = skeleton != null && child.BoneIndex >= 0 && child.BoneIndex < skeleton.Bones.Count
                        ? skeleton.Bones[child.BoneIndex].Name : "?";
                    Console.WriteLine($"    [{i,3}] bone={child.BoneIndex,-4} ({boneName,-20}) flags=0x{child.Flags:X2} {DescribeDrawable(child.Drawable)}");
                }

                using var textures = OpenTextures(files, model);
                Console.WriteLine($"  textures: {(textures == null ? "none" : textures.Textures.Count + " -> " + string.Join(", ", textures.Textures.Take(8).Select(t => t.Name)))}");
                resource.Dispose();
            }
            return 0;
        }
        finally { archive.Close(); }
    }

    private static string DescribeDrawable(DrawableModel drawable)
    {
        if (drawable == null) return "none";
        if (drawable.ModelCollection == null || drawable.ModelCollection.Length == 0) return "no models";
        var lods = drawable.ModelCollection.Length;
        var geometries = 0;
        var vertices = 0;
        foreach (var model in drawable.ModelCollection[0])
        {
            geometries += model.Geometries.Count;
            foreach (var geometry in model.Geometries) vertices += geometry.VertexCount;
        }
        var shaders = drawable.ShaderGroup?.Shaders?.Count ?? 0;
        return $"{lods} lod(s), {geometries} geom, {vertices} verts, {shaders} shader(s)";
    }

    // Whether the body drawable is rigid-skinned to the fragment skeleton: if
    // its vertices carry blend indices into a matrix palette, the door and
    // wheel geometry lives in this one drawable and is separated by bone, not
    // by frag child.
    private static void DescribeSkinning(DrawableModel drawable, ResourceSkeleton skeleton)
    {
        if (drawable?.ModelCollection == null || drawable.ModelCollection.Length == 0) return;
        var modelIndex = 0;
        foreach (var model in drawable.ModelCollection[0])
        {
            for (var g = 0; g < model.Geometries.Count; g++)
            {
                var geometry = model.Geometries[g];
                if (geometry.VertexBuffer?.VertexDeclaration == null) continue;
                var usages = geometry.VertexBuffer.VertexDeclaration.DecodeAsVertexElements()
                    .Select(e => e.Usage.ToString()).Distinct();
                var palette = geometry.MtxPalette;
                var paletteText = palette == null ? "none" : $"{palette.Length} -> [{string.Join(",", palette.Take(24))}]";
                var shaderIndex = g < model.ShaderMappings.Count ? model.ShaderMappings[g] : (ushort)0;
                var shader = drawable.ShaderGroup != null && shaderIndex < drawable.ShaderGroup.Shaders.Count
                    ? drawable.ShaderGroup.Shaders[shaderIndex] : null;
                Console.WriteLine($"    model{modelIndex}.geom{g}: {geometry.VertexCount,6} verts  shader={shader?.ShaderName,-24} tex={TextureIo.TextureName(shader)}");
                Console.WriteLine($"      usages: {string.Join(" ", usages)}");
                Console.WriteLine($"      palette: {paletteText}");
                if (palette != null && skeleton != null)
                {
                    var names = palette.Take(24).Select(b => b < skeleton.Bones.Count ? skeleton.Bones[b].Name : "?");
                    Console.WriteLine($"      bones:   {string.Join(",", names)}");
                }
            }
            modelIndex++;
        }
    }

    // A vehicle's own textures live in a .wtd of the same name beside the .wft.
    private static TextureFile OpenTextures(Dictionary<string, ArchiveFile> files, string model)
    {
        if (!files.TryGetValue(model + ".wtd", out var source)) return null;
        var dictionary = new TextureFile();
        try { dictionary.Open(source.GetData()); }
        catch { dictionary.Dispose(); return null; }
        return dictionary;
    }

    // Model dictionary first, then the shared ones, then the drawable's own
    // embedded dictionary. Returns null when the shader names a texture no
    // dictionary in the chain carries.
    private static Texture Resolve(string name, TextureFile model, TextureFile[] shared, TextureFile embedded)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var found = TextureIo.FindTexture(model, name);
        if (found != null) return found;
        foreach (var dictionary in shared)
        {
            found = TextureIo.FindTexture(dictionary, name);
            if (found != null) return found;
        }
        return TextureIo.FindTexture(embedded, name);
    }

    // ---- export -----------------------------------------------------------

    public static int Run(string gameDir, string outputDir, string textureDir, string textureUriPrefix, string[] only)
    {
        System.IO.Directory.CreateDirectory(outputDir);
        System.IO.Directory.CreateDirectory(textureDir);

        var catalogue = VehicleData.Read(gameDir, out var palette);
        var files = OpenVehicleArchive(gameDir, out var archive);
        try
        {
            var shared = SharedTextureDictionaries
                .Select(name => OpenTextures(files, name))
                .Where(dictionary => dictionary != null)
                .ToArray();
            Console.WriteLine($"Palette: {palette.Length} colours. Shared dictionaries: {string.Join(", ", shared.Select(d => d.Textures.Count + " textures"))}");

            var wanted = only is { Length: > 0 }
                ? catalogue.Values.Where(v => only.Contains(v.Model, StringComparer.OrdinalIgnoreCase))
                : catalogue.Values;

            var exported = new List<Dictionary<string, object>>();
            var skipped = new List<string>();
            foreach (var vehicle in wanted.OrderBy(v => v.Model, StringComparer.OrdinalIgnoreCase))
            {
                if (!files.TryGetValue(vehicle.Model + ".wft", out var source)) { skipped.Add(vehicle.Model + " (no .wft)"); continue; }
                try
                {
                    var record = ExportOne(vehicle, source, files, shared, outputDir, textureDir, textureUriPrefix);
                    if (record == null) { skipped.Add(vehicle.Model + " (no geometry)"); continue; }
                    exported.Add(record);
                }
                catch (Exception error)
                {
                    skipped.Add($"{vehicle.Model} ({error.GetType().Name}: {error.Message})");
                }
            }
            foreach (var dictionary in shared) dictionary.Dispose();

            var manifest = new Dictionary<string, object>
            {
                ["source"] = VehicleImg,
                ["count"] = exported.Count,
                ["palette"] = palette.Select(colour => new Dictionary<string, object>
                {
                    ["rgb"] = new[] { colour.R, colour.G, colour.B },
                    ["family"] = colour.Family,
                }).ToArray(),
                ["vehicles"] = exported,
                ["skipped"] = skipped,
            };
            System.IO.File.WriteAllText(Path.Combine(outputDir, "vehicles.json"),
                System.Text.Json.JsonSerializer.Serialize(manifest, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));

            Console.WriteLine($"Exported {exported.Count} vehicle(s) to {outputDir}");
            foreach (var entry in skipped) Console.Error.WriteLine($"  skipped {entry}");
            return 0;
        }
        finally { archive.Close(); }
    }

    private static Dictionary<string, object> ExportOne(VehicleData.VehicleInfo vehicle, ArchiveFile source,
        Dictionary<string, ArchiveFile> files, TextureFile[] shared,
        string outputDir, string textureDir, string textureUriPrefix)
    {
        var fragment = ReadFragment(source.GetData(), out var resource);
        try
        {
            var skeleton = fragment.Skeleton ?? fragment.Drawable?.Skeleton;
            if (skeleton == null || fragment.Drawable == null) return null;

            var writer = new ModelGltfWriter("gta4-webmap-vehicle");
            using var modelTextures = OpenTextures(files, vehicle.Model);

            // Bone nodes, composed the way the player's are: the bind pose is
            // built from the local chain so it agrees with the hierarchy by
            // construction rather than trusting the file's own matrices.
            var boneCount = skeleton.Bones.Count;
            var boneNodes = new int[boneCount];
            var children = new List<int>[boneCount];
            var worldRotation = new Quat[boneCount];
            var worldPosition = new (float X, float Y, float Z)[boneCount];
            for (var i = 0; i < boneCount; i++) children[i] = new List<int>();

            for (var i = 0; i < boneCount; i++)
            {
                var bone = skeleton.Bones[i];
                var localPosition = ToGltf(bone.Position.X, bone.Position.Y, bone.Position.Z);
                var localRotation = ToGltf(new Quat(bone.RotationQuaternion.X, bone.RotationQuaternion.Y, bone.RotationQuaternion.Z, bone.RotationQuaternion.W).Normalized());
                boneNodes[i] = writer.AddNode(new Dictionary<string, object>
                {
                    ["name"] = string.IsNullOrEmpty(bone.Name) ? $"bone_{i}" : bone.Name,
                    ["translation"] = new[] { localPosition.X, localPosition.Y, localPosition.Z },
                    ["rotation"] = new[] { localRotation.X, localRotation.Y, localRotation.Z, localRotation.W },
                    ["extras"] = new Dictionary<string, object> { ["kind"] = PartKind(bone.Name) },
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
            }

            // Inverse bind matrices: model space -> joint space.
            var inverseBind = new float[boneCount * 16];
            for (var i = 0; i < boneCount; i++)
            {
                var inverseRotation = worldRotation[i].Conjugate();
                var t = inverseRotation.Rotate(worldPosition[i].X, worldPosition[i].Y, worldPosition[i].Z);
                WriteMatrix(inverseBind.AsSpan(i * 16, 16), inverseRotation, (-t.X, -t.Y, -t.Z));
            }
            var skin = writer.AddSkin(boneNodes, writer.AddFloatAccessor(inverseBind, 16, false, vertexData: false), boneNodes[0]);

            // Lowest point of everything authored in fragment space. The frag
            // children are not — see the wheel note below — so they are
            // measured separately and folded in afterwards.
            var lowestY = float.PositiveInfinity;
            var vertexTotal = 0;
            var missingTextures = new List<string>();
            var meshNodes = new List<int>();

            // The body: one rigid-skinned drawable whose per-geometry matrix
            // palettes bind each panel to its bone, so doors, sirens and lights
            // separate by joint without needing separate meshes.
            var bodyPrimitives = BuildDrawable(writer, fragment.Drawable, vehicle.Model, boneNodes,
                modelTextures, shared, textureDir, textureUriPrefix, missingTextures, ref lowestY, ref vertexTotal);
            if (bodyPrimitives.Count > 0)
                meshNodes.Add(writer.AddNode(new Dictionary<string, object>
                {
                    ["name"] = "body",
                    ["mesh"] = writer.AddMesh("body", bodyPrimitives),
                    ["skin"] = skin,
                }));

            // Frag children carrying real geometry. In practice this is the
            // wheel: the file stores one wheel drawable on wheel_lf and leaves
            // the other three wheel children empty, so it is instanced onto
            // every wheel bone rather than drawn once where it was authored.
            // Wheel drawables keyed by the bone they were authored on. There is
            // usually one, but bikes and six-wheelers ship a front *and* a rear
            // wheel that are genuinely different sizes, so they must not be
            // collapsed into a single mesh.
            var wheelMeshes = new Dictionary<string, (int Mesh, List<(float X, float Y, float Z)> Positions)>(StringComparer.OrdinalIgnoreCase);
            var partNodes = new List<Dictionary<string, object>>();
            for (var i = 0; i < (fragment.Children?.Length ?? 0); i++)
            {
                var child = fragment.Children[i];
                if (child?.Drawable?.ModelCollection == null || child.Drawable.ModelCollection.Length == 0) continue;
                var boneName = child.BoneIndex >= 0 && child.BoneIndex < boneCount ? skeleton.Bones[child.BoneIndex].Name : null;
                var childLowestY = float.PositiveInfinity;
                var isWheel = PartKind(boneName) == "wheel";
                var childPositions = isWheel ? new List<(float X, float Y, float Z)>() : null;
                var primitives = BuildDrawable(writer, child.Drawable, $"{vehicle.Model}_{boneName ?? i.ToString()}", boneNodes,
                    modelTextures, shared, textureDir, textureUriPrefix, missingTextures, ref childLowestY, ref vertexTotal, childPositions);
                if (primitives.Count == 0) continue;
                var mesh = writer.AddMesh(boneName ?? $"part_{i}", primitives);
                if (isWheel) wheelMeshes[boneName] = (mesh, childPositions);
                else
                {
                    // A non-wheel part drawn where it was authored, so its
                    // extent counts towards the body's own lowest point.
                    lowestY = Math.Min(lowestY, childLowestY);
                    partNodes.Add(new Dictionary<string, object> { ["name"] = boneName ?? $"part_{i}", ["mesh"] = mesh, ["skin"] = skin });
                }
            }
            foreach (var node in partNodes) meshNodes.Add(writer.AddNode(node));

            // One wheel instance parented to each wheel bone, with no transform
            // of its own. The wheel drawable is authored in bone-local space —
            // its vertices are centred on the origin, not out at the hub the
            // file stores it against — so parenting it to the bone puts it in
            // the right place, and rotating that bone rolls it.
            var wheels = new List<string>();
            if (wheelMeshes.Count > 0)
            {
                for (var i = 0; i < boneCount; i++)
                {
                    var boneName = skeleton.Bones[i].Name;
                    if (PartKind(boneName) != "wheel") continue;
                    var sourceKey = WheelSourceFor(boneName, wheelMeshes);
                    if (sourceKey == null) continue;
                    var (mesh, wheelPositions) = wheelMeshes[sourceKey];
                    children[i].Add(writer.AddNode(new Dictionary<string, object>
                    {
                        ["name"] = boneName + "_mesh",
                        ["mesh"] = mesh,
                    }));
                    wheels.Add(boneName);
                    // The contact patch. The tyre's own lowest vertex is not
                    // enough: the mesh is parented to the bone, so it is drawn
                    // under the bone's *rotation* too. A car's wheel bones sit
                    // more or less upright and the difference is nil, but a
                    // bike's front wheel hangs off a raked fork, and ignoring
                    // that rotation buries it 0.1 m into the road.
                    foreach (var position in wheelPositions)
                    {
                        var rotated = worldRotation[i].Rotate(position.X, position.Y, position.Z);
                        lowestY = Math.Min(lowestY, worldPosition[i].Y + rotated.Y);
                    }
                }
            }
            for (var i = 0; i < boneCount; i++)
                if (children[i].Count > 0) writer.SetNodeChildren(boneNodes[i], children[i]);

            if (vertexTotal == 0) return null;

            // Sit the car on the ground, as the player export does, so the
            // viewer places it by its contact point rather than its hull.
            var groundOffset = float.IsPositiveInfinity(lowestY) ? 0f : -lowestY;
            var root = writer.AddNode(new Dictionary<string, object>
            {
                ["name"] = vehicle.Model,
                ["translation"] = new[] { 0f, groundOffset, 0f },
                ["children"] = meshNodes.Concat(new[] { boneNodes[0] }).ToArray(),
            });

            // Seats and lights are bones with no geometry of their own; the
            // viewer wants their positions to seat peds and place coronas.
            var seats = Dummies(skeleton, worldPosition, groundOffset,
                name => name.StartsWith("seat_", StringComparison.OrdinalIgnoreCase));
            var lights = Dummies(skeleton, worldPosition, groundOffset,
                name => name.StartsWith("headlight_", StringComparison.OrdinalIgnoreCase)
                     || name.StartsWith("taillight_", StringComparison.OrdinalIgnoreCase));

            var record = new Dictionary<string, object>
            {
                ["model"] = vehicle.Model,
                ["name"] = vehicle.GameName,
                ["type"] = vehicle.Type,
                ["gltf"] = vehicle.Model + ".gltf",
                ["frequency"] = vehicle.Frequency,
                ["maxNumber"] = vehicle.MaxNumber,
                ["swankness"] = vehicle.Swankness,
                ["flags"] = vehicle.Flags,
                ["wheelRadius"] = new[] { vehicle.WheelRadiusFront, vehicle.WheelRadiusRear },
                ["bones"] = boneCount,
                ["vertices"] = vertexTotal,
                ["groundOffset"] = groundOffset,
                ["wheels"] = wheels,
                ["seats"] = seats,
                ["lights"] = lights,
                ["colourSets"] = vehicle.ColourSets,
                // Program.cs writes the world through a reflection; the viewer
                // mirrors vehicles into that space exactly as it does Niko.
                ["worldMirrorX"] = true,
            };
            if (vehicle.Handling != null)
                record["handling"] = new Dictionary<string, object>
                {
                    ["mass"] = vehicle.Handling.Mass,
                    ["drive"] = vehicle.Handling.DriveType,
                    ["gears"] = vehicle.Handling.Gears,
                    ["driveForce"] = vehicle.Handling.DriveForce,
                    ["topSpeed"] = vehicle.Handling.TopSpeed,
                    ["brakeForce"] = vehicle.Handling.BrakeForce,
                    ["steeringLock"] = vehicle.Handling.SteeringLock,
                    ["value"] = vehicle.Handling.MonetaryValue,
                };
            if (missingTextures.Count > 0) record["missingTextures"] = missingTextures.Distinct().ToArray();

            writer.Write(outputDir, vehicle.Model + ".gltf", vehicle.Model + ".bin", record, sceneRoot: root, manifestName: null);
            Console.WriteLine($"  {vehicle.Model,-14} {boneCount,3} bones {vertexTotal,7:n0} verts {bodyPrimitives.Count,3} prim {wheels.Count} wheel(s) {seats.Count} seat(s)");
            return record;
        }
        finally { resource.Dispose(); }
    }

    // Which stored wheel drawable a given wheel bone should use. Bone names end
    // in the axle: wheel_lf/wheel_rf front, wheel_lr/wheel_rr rear,
    // wheel_lm/wheel_rm the middle axle of a six-wheeler. The file authors one
    // drawable per axle — nearly always on the left-hand bone — so a bone takes
    // whichever side of its own axle exists, and a middle axle falls back to
    // the rear wheel it shares its size with.
    private static string WheelSourceFor(string boneName, Dictionary<string, (int Mesh, List<(float X, float Y, float Z)> Positions)> available)
    {
        if (string.IsNullOrEmpty(boneName)) return available.Keys.FirstOrDefault();
        var axle = char.ToLowerInvariant(boneName[^1]);
        foreach (var candidate in new[] { $"wheel_l{axle}", $"wheel_r{axle}" })
            if (available.ContainsKey(candidate)) return candidate;
        if (axle == 'm')
            foreach (var candidate in new[] { "wheel_lr", "wheel_rr" })
                if (available.ContainsKey(candidate)) return candidate;
        return available.Keys.FirstOrDefault();
    }

    private static List<Dictionary<string, object>> Dummies(ResourceSkeleton skeleton,
        (float X, float Y, float Z)[] worldPosition, float groundOffset, Func<string, bool> match)
    {
        var result = new List<Dictionary<string, object>>();
        for (var i = 0; i < skeleton.Bones.Count; i++)
        {
            var name = skeleton.Bones[i].Name;
            if (string.IsNullOrEmpty(name) || !match(name)) continue;
            result.Add(new Dictionary<string, object>
            {
                ["name"] = name,
                ["position"] = new[] { worldPosition[i].X, worldPosition[i].Y + groundOffset, worldPosition[i].Z },
            });
        }
        return result;
    }

    // ModelCollection[0] is the full-detail model; the rest are LODs the viewer
    // streams without.
    private static List<Dictionary<string, object>> BuildDrawable(ModelGltfWriter writer, DrawableModel drawable,
        string label, int[] boneNodes, TextureFile modelTextures, TextureFile[] shared,
        string textureDir, string textureUriPrefix, List<string> missingTextures,
        ref float lowestY, ref int vertexTotal, List<(float X, float Y, float Z)> collect = null)
    {
        var primitives = new List<Dictionary<string, object>>();
        if (drawable?.ModelCollection == null || drawable.ModelCollection.Length == 0) return primitives;
        var embedded = drawable.ShaderGroup?.TextureDictionary;

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
                var texture = Resolve(textureName, modelTextures, shared, embedded);
                var textureUri = TextureIo.Export(texture, textureDir, textureUriPrefix);
                if (textureUri == null && !string.IsNullOrWhiteSpace(textureName)) missingTextures.Add(textureName);

                var material = writer.AddMaterial($"{label}_{geometryIndex}", shaderName, textureName, textureUri, IsGlass(shaderName));
                writer.TagMaterial(material, "paint", IsPaint(shaderName));
                primitives.Add(BuildPrimitive(writer, geometry, material, boneNodes, ref lowestY, ref vertexTotal, collect));
            }
        }
        return primitives;
    }

    // The rigid-skinned equivalent of the player's primitive builder: same
    // vertex layout and the same matrix-palette indirection, but a vehicle
    // vertex belongs to exactly one panel, so the weights come out (255,0,0,0).
    private static Dictionary<string, object> BuildPrimitive(ModelGltfWriter writer, Geometry geometry, int material,
        int[] boneNodes, ref float lowestY, ref int vertexTotal, List<(float X, float Y, float Z)> collect = null)
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
        var hasWeights = offsets.TryGetValue((VertexElementUsage.BlendWeight, 0), out var weightOffset)
            & offsets.TryGetValue((VertexElementUsage.BlendIndices, 0), out var jointOffset);

        var positions = new float[count * 3];
        var normals = new float[count * 3];
        var uvs = new float[count * 2];
        var joints = new byte[count * 4];
        var weights = new byte[count * 4];
        var palette = geometry.MtxPalette;

        for (var i = 0; i < count; i++)
        {
            var start = i * stride;
            var position = ToGltf(ReadFloat(raw, start + positionOffset), ReadFloat(raw, start + positionOffset + 4), ReadFloat(raw, start + positionOffset + 8));
            positions[i * 3] = position.X; positions[i * 3 + 1] = position.Y; positions[i * 3 + 2] = position.Z;
            lowestY = Math.Min(lowestY, position.Y);
            collect?.Add(position);

            if (hasNormal)
            {
                var normal = ToGltf(ReadFloat(raw, start + normalOffset), ReadFloat(raw, start + normalOffset + 4), ReadFloat(raw, start + normalOffset + 8));
                normals[i * 3] = normal.X; normals[i * 3 + 1] = normal.Y; normals[i * 3 + 2] = normal.Z;
            }
            if (hasUv) { uvs[i * 2] = ReadFloat(raw, start + uvOffset); uvs[i * 2 + 1] = ReadFloat(raw, start + uvOffset + 4); }

            var total = 0;
            for (var slot = 0; slot < 4; slot++)
            {
                var weight = hasWeights ? raw[start + weightOffset + slot] : (byte)0;
                var local = hasWeights ? raw[start + jointOffset + slot] : (byte)0;
                var bone = palette != null && local < palette.Length ? palette[local] : (ushort)0;
                joints[i * 4 + slot] = (byte)Math.Min(bone, boneNodes.Length - 1);
                weights[i * 4 + slot] = weight;
                total += weight;
            }
            // A vertex with no weights would collapse to the origin; pin it to
            // its first bone instead.
            if (total == 0) weights[i * 4] = 255;
        }
        vertexTotal += count;

        var source = new ushort[geometry.IndexCount];
        Buffer.BlockCopy(geometry.IndexBuffer.RawData, 0, source, 0, source.Length * 2);
        var indices = new uint[geometry.FaceCount * 3];
        // The conversion above is a rotation, so the original winding survives.
        for (var i = 0; i < indices.Length; i++) indices[i] = source[i];

        return new Dictionary<string, object>
        {
            ["attributes"] = new Dictionary<string, int>
            {
                ["POSITION"] = writer.AddFloatAccessor(positions, 3, true),
                ["NORMAL"] = writer.AddFloatAccessor(normals, 3, false),
                ["TEXCOORD_0"] = writer.AddFloatAccessor(uvs, 2, false),
                ["JOINTS_0"] = writer.AddByteAccessor(joints, normalized: false),
                ["WEIGHTS_0"] = writer.AddByteAccessor(weights, normalized: true),
            },
            ["indices"] = writer.AddIndexAccessor(indices),
            ["material"] = material,
            ["mode"] = 4,
        };
    }

    // Bone 0 lists itself as its own parent; every other entry is a real index.
    private static int ParentOf(ResourceSkeleton skeleton, int index)
    {
        var parent = skeleton.ParentIndices[index];
        return index == 0 || parent == index ? -1 : parent;
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

    private static float ReadFloat(byte[] data, int offset) =>
        BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4)));
}
