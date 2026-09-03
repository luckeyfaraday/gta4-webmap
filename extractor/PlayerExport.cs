using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using RageLib.Animation;
using RageLib.Common;
using RageLib.FileSystem;
using RageLib.Models.Resource;
using RageLib.Models.Resource.Models;
using RageLib.Textures;
using static RageGltf;
using ArchiveFile = RageLib.FileSystem.Common.File;
using DrawableResource = RageLib.Models.Resource.File<RageLib.Models.Resource.DrawableModel>;
using ResourceSkeleton = RageLib.Models.Resource.Skeletons.Skeleton;

// Exports the player character (Niko) out of playerped.rpf: the 90-bone
// skeleton from player.wft, the skinned component meshes from the *.wdr
// drawables, and the movement/jump clips from pc/anim/anim.img, as one
// skinned+animated glTF the Three.js viewer can play with an AnimationMixer.
static class PlayerExport
{
    private const string PlayerRpf = "pc/models/cdimages/playerped.rpf";
    private const string AnimImg = "pc/anim/anim.img";

    // Niko's default outfit: the first drawable of each component slot.
    private static readonly string[] DefaultOutfit =
    {
        "head_000_r", "hair_000_u", "teef_000_u", "uppr_000_u", "lowr_000_u", "feet_000_u", "hand_000_r",
    };

    // move_player is Niko's locomotion set (idle/walk/run/sprint/strafes/turns);
    // jump_std holds the takeoff/in-air/landing chain.
    private static readonly string[] AnimationWads = { "move_player.wad", "jump_std.wad" };

    // Armed animation, written to its own clip library beside the character so
    // player.gltf stays the size it is. Every gun@ set names its clips the same
    // - fire, reload, holster, unholster - so they are namespaced by set, the
    // same lesson the ped library taught. move_rifle and move_rpg are the armed
    // walk cycles; the pistol keeps the ordinary one, as it does in game.
    private static readonly (string Wad, string Set)[] WeaponWads =
    {
        ("gun@handgun.wad", "handgun"),
        ("gun@rifle.wad", "rifle"),
        ("gun@rocket.wad", "rocket"),
        ("gun@aim_idles.wad", "aim"),
        ("move_rifle.wad", "move_rifle"),
        ("move_rpg.wad", "move_rpg"),
    };

    // No clip drives the arm roll bones — GTA IV solves them at runtime, and
    // leaving them at the bind pose shears the skin around the elbow and
    // shoulder as the arm turns. Each roll bone takes a share of the twist its
    // driver picked up, about the driver's own length axis, exactly as
    // PedTwistSolver does. Since it is a function of the animated pose, it can
    // be solved once here rather than every frame in the browser.
    private static readonly (int Twist, int Driver, float X, float Y, float Z)[] TwistBones =
    {
        (14497, 1218, 0, 0, 1),  // Char_L_ForeTwist   <- Char_L_Forearm
        (14496, 1217, 1, 0, 0),  // L_UpperArmRoll     <- Char_L_UpperArm
        (14753, 1225, 0, 0, 1),  // Char_R_ForeTwist   <- Char_R_Forearm
        (14752, 1224, 1, 0, 0),  // R_UpperArmRoll     <- Char_R_UpperArm
    };



    // Bone 0 ("Char") lists itself as its own parent; every other entry is a
    // real index into the bone array.
    private static int ParentOf(ResourceSkeleton skeleton, int index)
    {
        var parent = skeleton.ParentIndices[index];
        return index == 0 || parent == index ? -1 : parent;
    }

    private static ResourceSkeleton ReadSkeleton(byte[] wftData)
    {
        var frag = new RageLib.Models.Resource.File<FragTypeModel>();
        frag.Open(new MemoryStream(wftData, writable: false));
        return frag.Data.Skeleton ?? frag.Data.Drawable?.Skeleton;
    }

    private static Dictionary<string, ArchiveFile> OpenPlayerArchive(string gameDir, out RPFFileSystem archive)
    {
        archive = new RPFFileSystem();
        archive.Open(Path.Combine(gameDir, PlayerRpf.Replace('/', Path.DirectorySeparatorChar)));
        var result = new Dictionary<string, ArchiveFile>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in archive.GetAllFiles()) result[file.Name] = file;
        return result;
    }

    // The stored bone quaternion's handedness is not obvious from the format
    // and getting it wrong silently scrambles the bind pose, so compose the
    // local chain both ways and keep whichever reproduces the absolute
    // positions the file also stores. (Measured: as-stored is exact.)
    private static bool StoredRotationIsConjugated(ResourceSkeleton skeleton, out double asStored, out double conjugated)
    {
        asStored = ChainError(skeleton, conjugate: false);
        conjugated = ChainError(skeleton, conjugate: true);
        return conjugated < asStored;
    }

    private static double ChainError(ResourceSkeleton skeleton, bool conjugate)
    {
        var count = skeleton.Bones.Count;
        var position = new (float X, float Y, float Z)[count];
        var rotation = new Quat[count];
        double worst = 0;
        for (var i = 0; i < count; i++)
        {
            var bone = skeleton.Bones[i];
            var local = new Quat(bone.RotationQuaternion.X, bone.RotationQuaternion.Y, bone.RotationQuaternion.Z, bone.RotationQuaternion.W).Normalized();
            if (conjugate) local = local.Conjugate();
            var parent = ParentOf(skeleton, i);
            if (parent >= 0)
            {
                var offset = rotation[parent].Rotate(bone.Position.X, bone.Position.Y, bone.Position.Z);
                position[i] = (position[parent].X + offset.X, position[parent].Y + offset.Y, position[parent].Z + offset.Z);
                rotation[i] = Quat.Multiply(rotation[parent], local);
            }
            else
            {
                position[i] = (bone.Position.X, bone.Position.Y, bone.Position.Z);
                rotation[i] = local;
            }
            var expected = bone.AbsolutePosition;
            worst = Math.Max(worst, Math.Sqrt(
                Math.Pow(position[i].X - expected.X, 2) +
                Math.Pow(position[i].Y - expected.Y, 2) +
                Math.Pow(position[i].Z - expected.Z, 2)));
        }
        return worst;
    }

    // Reports how one clip's tracks are encoded. AnimChannel only decodes the
    // static/raw/quantised float channel types and yields zeros for anything
    // else, so this is the way to tell a genuinely still track from one that
    // simply did not decode.
    private static void ProbeClip(string gameDir, string wadName, string clipName)
    {
        var img = new IMGFileSystem();
        img.Open(Path.Combine(gameDir, AnimImg.Replace('/', Path.DirectorySeparatorChar)));
        try
        {
            var entry = img.GetAllFiles().FirstOrDefault(file => string.Equals(file.Name, wadName, StringComparison.OrdinalIgnoreCase));
            if (entry == null) { Console.Error.WriteLine($"{wadName} not found"); return; }
            using var dictionary = new AnimationDictionaryFile();
            dictionary.Open(new MemoryStream(entry.GetData(), writable: false));
            foreach (var clip in dictionary.File.Data.Entries)
            {
                if (clip == null || CleanClipName(clip.Name) != clipName) continue;
                Console.WriteLine($"{wadName}/{clipName}: {clip.NumFrames} frames, {clip.Duration:F2}s");
                foreach (var track in clip.Tracks.Where(track => track != null))
                {
                    var types = track.Chunk?.Channels == null
                        ? "no chunk"
                        : string.Join(",", track.Chunk.Channels.Select(channel => channel == null ? "null" : channel.Type.ToString()));
                    var range = string.Empty;
                    if (track.TrackType == 0 && track.Chunk?.Channels != null)
                    {
                        range = " values=" + string.Join(" ", track.Chunk.Channels.Where(channel => channel != null).Select(channel =>
                        {
                            var values = channel.GetValues(clip.NumFrames);
                            return $"[{values.Min():F3}..{values.Max():F3}]";
                        }));
                    }
                    if (track.TrackType != 1)
                        Console.WriteLine($"  trackType={track.TrackType} channelType={track.ChannelType} boneId={track.BoneId} channels={types}{range}");
                }
                return;
            }
            Console.Error.WriteLine($"clip {clipName} not found in {wadName}");
        }
        finally { img.Close(); }
    }

    // Which skeleton bones a clip leaves at the bind pose. GTA IV solves some of
    // them procedurally at runtime rather than storing tracks for them.
    private static void ProbeUndriven(string gameDir, string wadName, string clipName, ResourceSkeleton skeleton)
    {
        var img = new IMGFileSystem();
        img.Open(Path.Combine(gameDir, AnimImg.Replace('/', Path.DirectorySeparatorChar)));
        try
        {
            var entry = img.GetAllFiles().FirstOrDefault(file => string.Equals(file.Name, wadName, StringComparison.OrdinalIgnoreCase));
            if (entry == null) return;
            using var dictionary = new AnimationDictionaryFile();
            dictionary.Open(new MemoryStream(entry.GetData(), writable: false));
            foreach (var clip in dictionary.File.Data.Entries)
            {
                if (clip == null || CleanClipName(clip.Name) != clipName) continue;
                var driven = clip.Tracks.Where(track => track != null && track.TrackType == 1).Select(track => (int)track.BoneId).ToHashSet();
                var missing = new List<string>();
                for (var i = 0; i < skeleton.Bones.Count; i++)
                    if (!driven.Contains(skeleton.Bones[i].BoneID)) missing.Add($"{skeleton.Bones[i].Name}({skeleton.Bones[i].BoneID})");
                Console.WriteLine($"{clipName}: {driven.Count} bones driven, {missing.Count} left at bind pose");
                Console.WriteLine("  " + string.Join(", ", missing));
                return;
            }
        }
        finally { img.Close(); }
    }

    public static int Probe(string gameDir)
    {
        ProbeClip(gameDir, "move_player.wad", "walk");
        ProbeClip(gameDir, "move_player.wad", "sprint");
        var files = OpenPlayerArchive(gameDir, out var archive);
        try
        {
            ProbeUndriven(gameDir, "move_player.wad", "walk", ReadSkeleton(files["player.wft"].GetData()));
            var skeleton = ReadSkeleton(files["player.wft"].GetData());
            Console.WriteLine($"player.wft: {skeleton.Bones.Count} bones");
            var conjugated = StoredRotationIsConjugated(skeleton, out var asStored, out var asConjugated);
            Console.WriteLine($"bind-pose chain error vs AbsolutePosition: as-stored={asStored:F6}m conjugated={asConjugated:F6}m -> use {(conjugated ? "CONJUGATED" : "AS-STORED")}");
            for (var i = 0; i < skeleton.Bones.Count; i++)
            {
                var bone = skeleton.Bones[i];
                if (bone.Name is not ("Char" or "Char_Pelvis" or "Char_Spine" or "Char_Head" or "Char_L_Foot" or "Char_R_Hand")) continue;
                var gltf = ToGltf(bone.AbsolutePosition.X, bone.AbsolutePosition.Y, bone.AbsolutePosition.Z);
                Console.WriteLine($"  [{i,2}] {bone.Name,-14} id={bone.BoneID,6} parent={ParentOf(skeleton, i),3} gltf=({gltf.X,7:F3},{gltf.Y,7:F3},{gltf.Z,7:F3})");
            }
            return 0;
        }
        finally { archive.Close(); }
    }

    public static int Run(string gameDir, string outputDir, string textureDir, string textureUriPrefix)
    {
        Directory.CreateDirectory(outputDir);
        Directory.CreateDirectory(textureDir);
        var files = OpenPlayerArchive(gameDir, out var archive);
        try
        {
            var skeleton = ReadSkeleton(files["player.wft"].GetData());
            if (skeleton == null) throw new InvalidDataException("player.wft carries no skeleton");
            if (StoredRotationIsConjugated(skeleton, out var asStored, out _))
                throw new InvalidDataException($"Unexpected bone rotation handedness (chain error {asStored:F4}m); the export would be scrambled.");

            var writer = new ModelGltfWriter("gta4-webmap-player");
            var boneCount = skeleton.Bones.Count;

            // Bone nodes, in glTF space. The bind pose is composed here rather
            // than taken from the file's own matrices so that it is consistent
            // with the node hierarchy by construction.
            var boneNodes = new int[boneCount];
            var children = new List<int>[boneCount];
            var worldRotation = new Quat[boneCount];
            var worldPosition = new (float X, float Y, float Z)[boneCount];
            var boneIdToNode = new Dictionary<int, int>();
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

            // Inverse bind matrices: model space -> joint space.
            var inverseBind = new float[boneCount * 16];
            for (var i = 0; i < boneCount; i++)
            {
                var inverseRotation = worldRotation[i].Conjugate();
                var t = inverseRotation.Rotate(worldPosition[i].X, worldPosition[i].Y, worldPosition[i].Z);
                WriteMatrix(inverseBind.AsSpan(i * 16, 16), inverseRotation, (-t.X, -t.Y, -t.Z));
            }
            var skin = writer.AddSkin(boneNodes, writer.AddFloatAccessor(inverseBind, 16, false, vertexData: false), boneNodes[0]);

            // Component meshes.
            var meshNodes = new List<int>();
            var lowestY = float.PositiveInfinity;
            var vertexTotal = 0;
            foreach (var component in DefaultOutfit)
            {
                if (!files.TryGetValue(component + ".wdr", out var source))
                {
                    Console.Error.WriteLine($"  missing component {component}.wdr");
                    continue;
                }
                var drawable = new DrawableResource();
                drawable.Open(new MemoryStream(source.GetData(), writable: false));
                using var textures = OpenComponentTextures(files, component);
                var primitives = new List<Dictionary<string, object>>();

                // ModelCollection[0] is the full-detail model; the rest are LODs
                // the viewer does not need.
                foreach (var model in drawable.Data.ModelCollection[0])
                {
                    for (var geometryIndex = 0; geometryIndex < model.Geometries.Count; geometryIndex++)
                    {
                        var geometry = model.Geometries[geometryIndex];
                        if (geometry.VertexBuffer?.RawData == null || geometry.IndexBuffer?.RawData == null) continue;
                        var shaderIndex = geometryIndex < model.ShaderMappings.Count ? model.ShaderMappings[geometryIndex] : (ushort)0;
                        var shader = drawable.Data.ShaderGroup != null && shaderIndex < drawable.Data.ShaderGroup.Shaders.Count
                            ? drawable.Data.ShaderGroup.Shaders[shaderIndex] : null;
                        var shaderName = shader?.ShaderName ?? string.Empty;
                        var textureName = TextureIo.TextureName(shader);
                        var texture = TextureIo.FindTexture(textures, textureName) ?? textures?.Textures.FirstOrDefault();
                        var textureUri = TextureIo.Export(texture, textureDir, textureUriPrefix);
                        if (textureUri == null)
                            Console.Error.WriteLine($"  {component}: no texture for shader '{shaderName}' (wanted '{textureName}')");
                        var material = writer.AddMaterial($"{component}_{geometryIndex}", shaderName, textureName, textureUri, component.StartsWith("hair"));
                        primitives.Add(BuildSkinnedPrimitive(writer, geometry, material, boneNodes, ref lowestY, ref vertexTotal));
                    }
                }
                drawable.Dispose();
                if (primitives.Count == 0) continue;
                var mesh = writer.AddMesh(component, primitives);
                meshNodes.Add(writer.AddNode(new Dictionary<string, object> { ["name"] = component, ["mesh"] = mesh, ["skin"] = skin }));
                Console.WriteLine($"  {component}: {primitives.Count} primitive(s)");
            }

            // Lift the whole character so its origin sits on the ground rather
            // than at the pelvis, which is where the RAGE skeleton is centred.
            var footOffset = float.IsPositiveInfinity(lowestY) ? 0f : -lowestY;
            var root = writer.AddNode(new Dictionary<string, object>
            {
                ["name"] = "Niko",
                ["translation"] = new[] { 0f, footOffset, 0f },
                ["children"] = meshNodes.Concat(new[] { boneNodes[0] }).ToArray(),
            });

            // Animations. The mover track is expressed relative to bone 0's rest
            // position, in RAGE coordinates.
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
                    using var dictionary = new AnimationDictionaryFile();
                    dictionary.Open(new MemoryStream(wad.GetData(), writable: false));
                    var clips = dictionary.File.Data;
                    var added = 0;
                    for (var i = 0; i < clips.Entries.Count; i++)
                    {
                        var info = AddAnimation(writer, clips.Entries[i], boneIdToNode, boneNodes[0], rootRest, restByBoneId);
                        if (info == null) continue;
                        info["wad"] = Path.GetFileNameWithoutExtension(wadName);
                        clipInfo.Add(info);
                        added++;
                    }
                    Console.WriteLine($"  {wadName}: {added} clip(s)");
                }

                // The armed set, into its own file against the same skeleton, so
                // the viewer fetches it only when a weapon is drawn.
                var weaponWriter = new ModelGltfWriter("gta4-webmap-weapon-clips");
                var weaponBones = new int[boneCount];
                var weaponChildren = new List<int>[boneCount];
                var weaponIdToNode = new Dictionary<int, int>();
                for (var i = 0; i < boneCount; i++) weaponChildren[i] = new List<int>();
                for (var i = 0; i < boneCount; i++)
                {
                    var bone = skeleton.Bones[i];
                    var localPosition = ToGltf(bone.Position.X, bone.Position.Y, bone.Position.Z);
                    var localRotation = ToGltf(new Quat(bone.RotationQuaternion.X, bone.RotationQuaternion.Y, bone.RotationQuaternion.Z, bone.RotationQuaternion.W).Normalized());
                    weaponBones[i] = weaponWriter.AddNode(new Dictionary<string, object>
                    {
                        ["name"] = string.IsNullOrEmpty(bone.Name) ? $"bone_{i}" : bone.Name,
                        ["translation"] = new[] { localPosition.X, localPosition.Y, localPosition.Z },
                        ["rotation"] = new[] { localRotation.X, localRotation.Y, localRotation.Z, localRotation.W },
                    });
                    var weaponParent = ParentOf(skeleton, i);
                    if (weaponParent >= 0) weaponChildren[weaponParent].Add(weaponBones[i]);
                    weaponIdToNode.TryAdd(bone.BoneID, weaponBones[i]);
                }
                for (var i = 0; i < boneCount; i++)
                    if (weaponChildren[i].Count > 0) weaponWriter.SetNodeChildren(weaponBones[i], weaponChildren[i]);

                var weaponClips = new List<Dictionary<string, object>>();
                foreach (var weapon in WeaponWads)
                {
                    if (!entries.TryGetValue(weapon.Wad, out var weaponWad)) { Console.Error.WriteLine($"  missing {weapon.Wad}"); continue; }
                    using var weaponDictionary = new AnimationDictionaryFile();
                    weaponDictionary.Open(new MemoryStream(weaponWad.GetData(), writable: false));
                    var weaponAdded = 0;
                    foreach (var clip in weaponDictionary.File.Data.Entries)
                    {
                        var info = AddAnimation(weaponWriter, clip, weaponIdToNode, weaponBones[0], rootRest, restByBoneId, weapon.Set + "/");
                        if (info == null) continue;
                        info["set"] = weapon.Set;
                        info["wad"] = Path.GetFileNameWithoutExtension(weapon.Wad);
                        weaponClips.Add(info);
                        weaponAdded++;
                    }
                    Console.WriteLine($"  {weapon.Wad}: {weaponAdded} clip(s) -> {weapon.Set}/");
                }
                var weaponRoot = weaponWriter.AddNode(new Dictionary<string, object>
                {
                    ["name"] = "player_rig",
                    ["children"] = new[] { weaponBones[0] },
                });
                weaponWriter.Write(outputDir, "weaponclips.gltf", "weaponclips.bin",
                    new Dictionary<string, object> { ["bones"] = boneCount, ["clips"] = weaponClips },
                    sceneRoot: weaponRoot, manifestName: null);
                Console.WriteLine($"  weapon clip library: {weaponClips.Count} clip(s)");
            }
            finally { animationImg.Close(); }

            writer.Write(outputDir, "player.gltf", "player.bin", new Dictionary<string, object>
            {
                ["source"] = "playerped.rpf",
                ["components"] = DefaultOutfit,
                ["bones"] = boneCount,
                ["vertices"] = vertexTotal,
                ["footOffset"] = footOffset,
                // Program.cs writes the world through a reflection; the viewer
                // has to mirror the character to match. See app.js.
                ["worldMirrorX"] = true,
                ["clips"] = clipInfo,
            });
            Console.WriteLine($"Output: {Path.Combine(outputDir, "player.gltf")} ({boneCount} bones, {vertexTotal:n0} vertices, {clipInfo.Count} clips)");
            return 0;
        }
        finally { archive.Close(); }
    }

    // Ped component textures live in a sibling dictionary named after the
    // drawable: uppr_000_u.wdr -> uppr_diff_000_<variant>_<race>.wtd. Variant
    // "a" is the default outfit's colourway.
    private static TextureFile OpenComponentTextures(Dictionary<string, ArchiveFile> files, string component)
    {
        var parts = component.Split('_');
        if (parts.Length < 2) return null;
        var prefix = $"{parts[0]}_diff_{parts[1]}_";
        var name = files.Keys
            .Where(key => key.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && key.EndsWith(".wtd", StringComparison.OrdinalIgnoreCase))
            .OrderBy(key => key, StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (name == null) return null;
        var parsed = new TextureFile();
        parsed.Open(files[name].GetData());
        return parsed;
    }

    // internal, and skeleton-free: PedExport builds the identical primitive for
    // the ambient peds, which share this vertex layout and matrix-palette
    // indirection. (The skeleton parameter this used to take was never read.)
    internal static Dictionary<string, object> BuildSkinnedPrimitive(ModelGltfWriter writer, Geometry geometry, int material,
        int[] boneNodes, ref float lowestY, ref int vertexTotal)
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

            if (hasNormal)
            {
                var normal = ToGltf(ReadFloat(raw, start + normalOffset), ReadFloat(raw, start + normalOffset + 4), ReadFloat(raw, start + normalOffset + 8));
                normals[i * 3] = normal.X; normals[i * 3 + 1] = normal.Y; normals[i * 3 + 2] = normal.Z;
            }
            if (hasUv) { uvs[i * 2] = ReadFloat(raw, start + uvOffset); uvs[i * 2 + 1] = ReadFloat(raw, start + uvOffset + 4); }

            // Blend indices address the geometry's own matrix palette, which in
            // turn indexes the skeleton. Weights and indices share a byte
            // order, so any permutation applies to both and pairs up correctly.
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

        var attributes = new Dictionary<string, int>
        {
            ["POSITION"] = writer.AddFloatAccessor(positions, 3, true),
            ["NORMAL"] = writer.AddFloatAccessor(normals, 3, false),
            ["TEXCOORD_0"] = writer.AddFloatAccessor(uvs, 2, false),
            ["JOINTS_0"] = writer.AddByteAccessor(joints, normalized: false),
            ["WEIGHTS_0"] = writer.AddByteAccessor(weights, normalized: true),
        };
        return new Dictionary<string, object>
        {
            ["attributes"] = attributes,
            ["indices"] = writer.AddIndexAccessor(indices),
            ["material"] = material,
            ["mode"] = 4,
        };
    }

    // One glTF animation per RAGE clip. Rotation tracks are absolute local bone
    // rotations that replace the bind pose. The mover track on bone 0 is not
    // root motion — GTA IV locomotion clips run in place and the game drives
    // travel from its move-blend data — it is a ±0.1m body sway, applied here
    // the same way PedAnimationSystem applies it: x/y absolute over the rest
    // position, z relative to the clip's first frame.
    // internal so PedExport can share it: the ambient peds use the same clip
    // format and the same BoneID-keyed tracks, on a skeleton that differs from
    // Niko's only in size.
    // namePrefix namespaces the clip. Niko's two wads have no name in common so
    // he passes none, but the ped library merges three: move_m@generic,
    // move_f@generic and move_cop share 50 names between them — "walk", "run"
    // and "idle" among them — and without a prefix the female and police sets
    // are silently shadowed by whichever loaded first.
    internal static Dictionary<string, object> AddAnimation(ModelGltfWriter writer, AnimationData clip,
        Dictionary<int, int> boneIdToNode, int rootNode, (float X, float Y, float Z) rootRest,
        Dictionary<int, Quat> restByBoneId, string namePrefix = "")
    {
        if (clip?.Tracks == null || clip.NumFrames < 2 || clip.Duration <= 0) return null;
        var frames = clip.NumFrames;
        var times = new float[frames];
        var step = clip.Duration / (frames - 1);
        for (var i = 0; i < frames; i++) times[i] = i * step;
        var timeAccessor = writer.AddFloatAccessor(times, 1, true, vertexData: false);

        var channels = new List<Dictionary<string, object>>();
        var samplers = new List<Dictionary<string, object>>();
        var hasMover = false;
        // Clips do not agree on which way the character faces: idle and walk
        // start a quarter-turn apart. Reporting each clip's opening root yaw
        // lets the viewer cancel that instead of snapping on every crossfade.
        double? rootYaw = null;
        // Kept in RAGE space so the twist solver below can work in the same
        // frame the twist axes are expressed in.
        var rageRotations = new Dictionary<int, Quat[]>();

        foreach (var track in clip.Tracks)
        {
            if (track?.Chunk?.Channels == null) continue;
            var sources = track.Chunk.Channels;

            if (track.TrackType == 1 && sources.Length >= 4 && sources.Take(4).All(channel => channel != null))
            {
                if (!boneIdToNode.TryGetValue(track.BoneId, out var node)) continue;
                var x = sources[0].GetValues(frames);
                var y = sources[1].GetValues(frames);
                var z = sources[2].GetValues(frames);
                var w = sources[3].GetValues(frames);
                var rotations = new Quat[frames];
                var rage = new Quat[frames];
                for (var frame = 0; frame < frames; frame++)
                {
                    rage[frame] = new Quat(x[frame], y[frame], z[frame], w[frame]).Normalized();
                    rotations[frame] = ToGltf(rage[frame]);
                }
                rageRotations[track.BoneId] = rage;

                // The clips do not agree on which way the body starts facing:
                // idle opens square while every locomotion clip opens about
                // 85 degrees round. Blending two of those against each other
                // would swing the character through the difference, so cancel
                // each clip's opening yaw here and let the viewer own facing
                // entirely. Turning clips keep their turn: only the starting
                // orientation moves.
                if (track.BoneId == 0)
                {
                    rootYaw = Yaw(rotations[0]);
                    var correction = YawQuaternion(-rootYaw.Value);
                    for (var frame = 0; frame < frames; frame++)
                        rotations[frame] = Quat.Multiply(correction, rotations[frame]).Normalized();
                }

                var values = new float[frames * 4];
                var previous = Quat.Identity;
                for (var frame = 0; frame < frames; frame++)
                {
                    var rotation = rotations[frame];
                    // Keep the sampler on one hemisphere so the viewer's linear
                    // quaternion interpolation takes the short way round.
                    if (frame > 0 && previous.X * rotation.X + previous.Y * rotation.Y + previous.Z * rotation.Z + previous.W * rotation.W < 0)
                        rotation = new Quat(-rotation.X, -rotation.Y, -rotation.Z, -rotation.W);
                    previous = rotation;
                    values[frame * 4] = rotation.X; values[frame * 4 + 1] = rotation.Y;
                    values[frame * 4 + 2] = rotation.Z; values[frame * 4 + 3] = rotation.W;
                }
                samplers.Add(new Dictionary<string, object>
                {
                    ["input"] = timeAccessor,
                    ["output"] = writer.AddFloatAccessor(values, 4, false, vertexData: false),
                    ["interpolation"] = "LINEAR",
                });
                channels.Add(new Dictionary<string, object>
                {
                    ["sampler"] = samplers.Count - 1,
                    ["target"] = new Dictionary<string, object> { ["node"] = node, ["path"] = "rotation" },
                });
            }
            else if (track.TrackType == 0 && track.BoneId == 0 && sources.Length >= 3 && sources.Take(3).All(channel => channel != null))
            {
                var x = sources[0].GetValues(frames);
                var y = sources[1].GetValues(frames);
                var z = sources[2].GetValues(frames);
                var values = new float[frames * 3];
                for (var frame = 0; frame < frames; frame++)
                {
                    var position = ToGltf(rootRest.X + x[frame], rootRest.Y + y[frame], rootRest.Z + z[frame] - z[0]);
                    values[frame * 3] = position.X; values[frame * 3 + 1] = position.Y; values[frame * 3 + 2] = position.Z;
                }
                samplers.Add(new Dictionary<string, object>
                {
                    ["input"] = timeAccessor,
                    ["output"] = writer.AddFloatAccessor(values, 3, false, vertexData: false),
                    ["interpolation"] = "LINEAR",
                });
                channels.Add(new Dictionary<string, object>
                {
                    ["sampler"] = samplers.Count - 1,
                    ["target"] = new Dictionary<string, object> { ["node"] = rootNode, ["path"] = "translation" },
                });
                hasMover = true;
            }
        }

        // Fill in the roll bones the clip does not drive.
        var solved = 0;
        foreach (var (twistId, driverId, axisX, axisY, axisZ) in TwistBones)
        {
            if (rageRotations.ContainsKey(twistId)) continue;
            if (!rageRotations.TryGetValue(driverId, out var driver)) continue;
            if (!boneIdToNode.TryGetValue(twistId, out var node)) continue;
            if (!restByBoneId.TryGetValue(driverId, out var driverRest)) continue;
            if (!restByBoneId.TryGetValue(twistId, out var twistRest)) continue;

            var values = new float[frames * 4];
            var previous = Quat.Identity;
            for (var frame = 0; frame < frames; frame++)
            {
                var delta = Quat.Multiply(driver[frame], driverRest.Conjugate());
                var twist = TwistAbout(delta, axisX, axisY, axisZ);
                var rotation = ToGltf(Quat.Multiply(twistRest, twist).Normalized());
                if (frame > 0 && previous.X * rotation.X + previous.Y * rotation.Y + previous.Z * rotation.Z + previous.W * rotation.W < 0)
                    rotation = new Quat(-rotation.X, -rotation.Y, -rotation.Z, -rotation.W);
                previous = rotation;
                values[frame * 4] = rotation.X; values[frame * 4 + 1] = rotation.Y;
                values[frame * 4 + 2] = rotation.Z; values[frame * 4 + 3] = rotation.W;
            }
            samplers.Add(new Dictionary<string, object>
            {
                ["input"] = timeAccessor,
                ["output"] = writer.AddFloatAccessor(values, 4, false, vertexData: false),
                ["interpolation"] = "LINEAR",
            });
            channels.Add(new Dictionary<string, object>
            {
                ["sampler"] = samplers.Count - 1,
                ["target"] = new Dictionary<string, object> { ["node"] = node, ["path"] = "rotation" },
            });
            solved++;
        }

        if (channels.Count == 0) return null;
        var name = namePrefix + CleanClipName(clip.Name);
        writer.AddAnimation(name, channels, samplers);
        return new Dictionary<string, object>
        {
            ["name"] = name,
            ["duration"] = clip.Duration,
            ["frames"] = (int)frames,
            ["mover"] = hasMover,
            ["solvedTwistBones"] = solved,
            // The opening yaw that was cancelled out of the root track, kept for
            // reference. null when the clip has no root rotation track at all,
            // which is not the same as one that already opened square.
            ["rootYawRemoved"] = rootYaw,
        };
    }

    // Clip names are stored as virtual paths: "pack:/walk.anim" -> "walk".
    private static string CleanClipName(string name)
    {
        if (string.IsNullOrEmpty(name)) return "clip";
        var slash = name.LastIndexOf('/');
        if (slash >= 0) name = name[(slash + 1)..];
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name[..dot] : name;
    }

    // The part of a rotation that spins about the given axis, with the swing
    // discarded — the swing-twist decomposition PedTwistSolver uses.
    private static Quat TwistAbout(Quat q, float axisX, float axisY, float axisZ)
    {
        var projection = q.X * axisX + q.Y * axisY + q.Z * axisZ;
        var twist = new Quat(axisX * projection, axisY * projection, axisZ * projection, q.W);
        var length = MathF.Sqrt(twist.X * twist.X + twist.Y * twist.Y + twist.Z * twist.Z + twist.W * twist.W);
        if (length < 1e-4f) return Quat.Identity;
        twist = new Quat(twist.X / length, twist.Y / length, twist.Z / length, twist.W / length);
        return twist.W < 0 ? new Quat(-twist.X, -twist.Y, -twist.Z, -twist.W) : twist;
    }

    // Rotation about glTF's up axis, and the quaternion that undoes it.
    private static double Yaw(Quat q) => Math.Atan2(2 * (q.W * q.Y + q.X * q.Z), 1 - 2 * (q.Y * q.Y + q.Z * q.Z));

    private static Quat YawQuaternion(double yaw) => new Quat(0, (float)Math.Sin(yaw / 2), 0, (float)Math.Cos(yaw / 2));

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
