namespace UnityEngine;

public struct Vector2
{
    public float x, y;
    public Vector2(float x, float y) { this.x = x; this.y = y; }
}

public struct Vector3
{
    public float x, y, z;
    public Vector3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
    public static Vector3 zero => new(0, 0, 0);
}

public struct Quaternion
{
    public float x, y, z, w;
    public Quaternion(float x, float y, float z, float w)
    { this.x = x; this.y = y; this.z = z; this.w = w; }
}

public struct Matrix4x4
{
    private float[] values;
    public Matrix4x4(float[] values) { this.values = values; }
    public static Matrix4x4 identity => new(new float[] {
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    });
    public float this[int row, int col]
    {
        get => values?[row * 4 + col] ?? 0;
        set
        {
            values ??= new float[16];
            values[row * 4 + col] = value;
        }
    }
}

public static class Debug
{
    public static void Log(object value) => System.Console.WriteLine(value);
    public static void LogWarning(object value) => System.Console.Error.WriteLine(value);
}

// RPFFileSystem looks for an optional KnownFilenames.txt beside the binary to
// name entries that are stored as hashes only. playerped.rpf keeps its real
// names, so an empty lookup table is fine.
public static class Application
{
    public static string streamingAssetsPath => System.IO.Path.Combine(System.AppContext.BaseDirectory, "StreamingAssets");
}
