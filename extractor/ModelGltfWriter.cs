using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

// RAGE is Z-up right-handed, glTF is Y-up right-handed. This is the proper
// (determinant +1) conversion, so bone rotations convert as real quaternions
// and triangle winding is preserved. Program.cs maps the world with (-x, z, -y)
// instead, which is a reflection; app.js mirrors characters and vehicles back
// into that space with a single scale.x = -1.
public static class RageGltf
{
    public static (float X, float Y, float Z) ToGltf(float x, float y, float z) => (x, z, -y);

    public static Quat ToGltf(Quat q) => new Quat(q.X, q.Z, -q.Y, q.W);
}

public struct Quat
{
    public float X, Y, Z, W;
    public Quat(float x, float y, float z, float w) { X = x; Y = y; Z = z; W = w; }
    public static Quat Identity => new Quat(0, 0, 0, 1);
    public Quat Conjugate() => new Quat(-X, -Y, -Z, W);

    public static Quat Multiply(Quat a, Quat b) => new Quat(
        a.W * b.X + a.X * b.W + a.Y * b.Z - a.Z * b.Y,
        a.W * b.Y - a.X * b.Z + a.Y * b.W + a.Z * b.X,
        a.W * b.Z + a.X * b.Y - a.Y * b.X + a.Z * b.W,
        a.W * b.W - a.X * b.X - a.Y * b.Y - a.Z * b.Z);

    public (float X, float Y, float Z) Rotate(float x, float y, float z)
    {
        var tx = 2 * (Y * z - Z * y);
        var ty = 2 * (Z * x - X * z);
        var tz = 2 * (X * y - Y * x);
        return (x + W * tx + (Y * tz - Z * ty), y + W * ty + (Z * tx - X * tz), z + W * tz + (X * ty - Y * tx));
    }

    public Quat Normalized()
    {
        var length = MathF.Sqrt(X * X + Y * Y + Z * Z + W * W);
        return length > 0 ? new Quat(X / length, Y / length, Z / length, W / length) : Identity;
    }
}

// A small glTF writer for one node-hierarchy model: the skinned, animated
// character in PlayerExport.cs and the rigid fragment hierarchy in
// VehicleExport.cs. Program.cs has its own GltfWriter for the instanced map
// scene; that one emits a flat scene and shares no structure with this.
public sealed class ModelGltfWriter
{
    private readonly MemoryStream binary = new();
    private readonly List<object> bufferViews = new(), accessors = new(), meshes = new(), materials = new(), skins = new(), animations = new();
    private readonly List<Dictionary<string, object>> nodes = new();
    private readonly string generator;

    public ModelGltfWriter(string generator) { this.generator = generator; }

    public int AddNode(Dictionary<string, object> node) { nodes.Add(node); return nodes.Count - 1; }

    public void SetNodeChildren(int node, List<int> children) => nodes[node]["children"] = children.ToArray();

    public int AddMaterial(string name, string shader, string textureName, string textureUri, bool cutout)
    {
        materials.Add(new Dictionary<string, object>
        {
            ["name"] = name,
            ["pbrMetallicRoughness"] = new Dictionary<string, object>
            {
                ["baseColorFactor"] = new[] { 1f, 1f, 1f, 1f },
                ["metallicFactor"] = 0f,
                ["roughnessFactor"] = .78f,
            },
            ["doubleSided"] = cutout,
            ["alphaMode"] = cutout ? "MASK" : "OPAQUE",
            ["alphaCutoff"] = .4f,
            ["extras"] = new Dictionary<string, object> { ["shader"] = shader, ["textureName"] = textureName, ["texture"] = textureUri },
        });
        return materials.Count - 1;
    }

    // Records an extra flag on a material's extras, for facts the viewer needs
    // that glTF has no field for — which vehicle primitives take the car's
    // per-instance paint colour, for one.
    public void TagMaterial(int material, string key, object value) =>
        ((Dictionary<string, object>)((Dictionary<string, object>)materials[material])["extras"])[key] = value;

    public int AddMesh(string name, List<Dictionary<string, object>> primitives)
    {
        meshes.Add(new Dictionary<string, object> { ["name"] = name, ["primitives"] = primitives.ToArray() });
        return meshes.Count - 1;
    }

    public int AddSkin(int[] joints, int inverseBindMatrices, int skeletonRoot)
    {
        skins.Add(new Dictionary<string, object>
        {
            ["joints"] = joints,
            ["inverseBindMatrices"] = inverseBindMatrices,
            ["skeleton"] = skeletonRoot,
        });
        return skins.Count - 1;
    }

    public void AddAnimation(string name, List<Dictionary<string, object>> channels, List<Dictionary<string, object>> samplers) =>
        animations.Add(new Dictionary<string, object> { ["name"] = name, ["channels"] = channels.ToArray(), ["samplers"] = samplers.ToArray() });

    // vertexData tags the buffer view as ARRAY_BUFFER. Animation samplers
    // and inverse-bind matrices are not vertex attributes, and glTF forbids
    // a target on those views.
    public int AddFloatAccessor(float[] values, int components, bool minMax, bool vertexData = true)
    {
        Align();
        var offset = binary.Position;
        using (var output = new BinaryWriter(binary, System.Text.Encoding.UTF8, true))
            foreach (var value in values) output.Write(value);
        var view = AddView(offset, values.Length * 4, vertexData ? 34962 : (int?)null);
        var count = values.Length / components;
        var accessor = new Dictionary<string, object>
        {
            ["bufferView"] = view,
            ["componentType"] = 5126,
            ["count"] = count,
            ["type"] = components switch { 1 => "SCALAR", 2 => "VEC2", 3 => "VEC3", 4 => "VEC4", 16 => "MAT4", _ => throw new ArgumentOutOfRangeException(nameof(components)) },
        };
        if (minMax)
        {
            accessor["min"] = Enumerable.Range(0, components).Select(c => Enumerable.Range(0, count).Min(i => values[i * components + c])).ToArray();
            accessor["max"] = Enumerable.Range(0, components).Select(c => Enumerable.Range(0, count).Max(i => values[i * components + c])).ToArray();
        }
        accessors.Add(accessor);
        return accessors.Count - 1;
    }

    public int AddByteAccessor(byte[] values, bool normalized)
    {
        Align();
        var offset = binary.Position;
        binary.Write(values, 0, values.Length);
        var view = AddView(offset, values.Length, 34962);
        var accessor = new Dictionary<string, object>
        {
            ["bufferView"] = view,
            ["componentType"] = 5121,
            ["count"] = values.Length / 4,
            ["type"] = "VEC4",
        };
        if (normalized) accessor["normalized"] = true;
        accessors.Add(accessor);
        return accessors.Count - 1;
    }

    public int AddIndexAccessor(uint[] values)
    {
        Align();
        var offset = binary.Position;
        using (var output = new BinaryWriter(binary, System.Text.Encoding.UTF8, true))
            foreach (var value in values) output.Write(value);
        var view = AddView(offset, values.Length * 4, 34963);
        accessors.Add(new Dictionary<string, object>
        {
            ["bufferView"] = view,
            ["componentType"] = 5125,
            ["count"] = values.Length,
            ["type"] = "SCALAR",
        });
        return accessors.Count - 1;
    }

    // sceneRoot defaults to the last node added, which is how both exporters
    // build their hierarchy: children first, root last. manifestName is null
    // for the vehicles, which write many glTFs into one directory and share a
    // single catalogue written by the caller instead.
    public void Write(string outputDir, string gltfName, string binName, Dictionary<string, object> extras,
        int? sceneRoot = null, string manifestName = "manifest.json")
    {
        System.IO.File.WriteAllBytes(Path.Combine(outputDir, binName), binary.ToArray());
        var root = new Dictionary<string, object>
        {
            ["asset"] = new Dictionary<string, object> { ["version"] = "2.0", ["generator"] = generator },
            ["scene"] = 0,
            ["scenes"] = new[] { new Dictionary<string, object> { ["nodes"] = new[] { sceneRoot ?? nodes.Count - 1 } } },
            ["nodes"] = nodes,
            ["meshes"] = meshes,
            ["materials"] = materials,
            ["accessors"] = accessors,
            ["bufferViews"] = bufferViews,
            ["buffers"] = new[] { new Dictionary<string, object> { ["uri"] = binName, ["byteLength"] = binary.Length } },
            ["extras"] = extras,
        };
        // glTF forbids an empty skins array; the vehicles are rigid and add none.
        if (skins.Count > 0) root["skins"] = skins;
        if (animations.Count > 0) root["animations"] = animations;
        System.IO.File.WriteAllText(Path.Combine(outputDir, gltfName), JsonSerializer.Serialize(root));
        if (manifestName != null)
            System.IO.File.WriteAllText(Path.Combine(outputDir, manifestName), JsonSerializer.Serialize(extras, new JsonSerializerOptions { WriteIndented = true }));
    }

    private int AddView(long offset, int length, int? target)
    {
        var view = new Dictionary<string, object> { ["buffer"] = 0, ["byteOffset"] = offset, ["byteLength"] = length };
        // Animation and inverse-bind data is not vertex data, and glTF
        // forbids tagging those buffer views with an array target.
        if (target.HasValue) view["target"] = target.Value;
        bufferViews.Add(view);
        return bufferViews.Count - 1;
    }

    private void Align() { while ((binary.Position & 3) != 0) binary.WriteByte(0); }
}
