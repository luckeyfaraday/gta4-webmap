using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using RageLib.Common;
using RageLib.FileSystem;
using ArchiveFile = RageLib.FileSystem.Common.File;

// Exports GTA IV's pedestrian navmesh — where a person may legally stand — out
// of pc/data/cdimages/navmeshes.img.
//
// This is the only source for that. GTA IV's paths*.ipl carry a vehicle graph
// and nothing for peds; the crowd navigates a navmesh instead, and RageLib has
// no reader for it. The format below was worked out by inspection and checked
// against independent data — see the notes on each field.
//
// Layout, per tile:
//
//   container   RSC5 header, then a zlib stream at offset 12 (~131 KB inflated)
//   0x40 float  tile size X            always 100
//   0x44 float  tile size Y            always 100
//   0x48 float  tile Z extent          varies per tile, 0 to ~215 m
//   0x58 ptr    vertex array           count at 0x78
//   0x60 ptr    vertex index array     count at 0x68
//   0x6c ptr    polygon array          count at 0x7c
//
//   vertex   6 bytes, 3 x uint16, quantised across the tile's own box
//   index    2 bytes, uint16 into the vertex array
//   polygon  40 bytes; uint16 at +4 is its first index, and the next polygon's
//            first index ends it, so vertex count is the difference (3 to 10)
//
// RAGE pointers carry a 0x50000000 segment tag; masking it off gives the offset
// into the inflated buffer.
//
// Evidence the reading is right, rather than merely self-consistent:
//   * Decoded vertices land 0.07-0.72 m from road-graph nodes in the same tile.
//   * The index array holds exactly `vertexCount` distinct values with a
//     maximum of vertexCount-1 — it addresses every vertex and nothing else.
//   * Across 18 tiles spanning 67 to 7,121 vertices: no out-of-range index, no
//     degenerate polygon, and a median height spread WITHIN a polygon of
//     0.00-0.48 m. Navmesh polygons are flat, and wrong indexing could not
//     produce that.
//
// Not decoded, and not needed: the per-tile Z minimum. The Z extent is stored
// but the base is not, and no float in the header matches the offset measured
// against real road heights. Heights come from the viewer's own ground raycast,
// which is exact; what the navmesh uniquely provides is the walkable footprint.
static class NavmeshExport
{
    private const string NavmeshImg = "pc/data/cdimages/navmeshes.img";

    // nav.dat: SECTORS_PER_NAVMESH=2 over 50 m game sectors, so each tile spans
    // 100 m. Tile indices in the filenames are sector numbers, hence all even.
    // The tiles form a dense 60x60 grid, which at 100 m covers 6,000 m per axis
    // and places the world origin at -3000.
    private const float TileSize = 100f;
    private const float WorldOrigin = -3000f;

    private sealed class Tile
    {
        public int SectorX, SectorY;
        public List<(float X, float Y)> Points = new();
    }

    private static byte[] Inflate(byte[] resource)
    {
        // RSC5: 4-byte magic, type, flags, then a raw zlib stream.
        using var input = new MemoryStream(resource, 12, resource.Length - 12, writable: false);
        using var zlib = new ZLibStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        zlib.CopyTo(output);
        return output.ToArray();
    }

    private static uint Offset(byte[] data, int at) => BitConverter.ToUInt32(data, at) & 0x0FFFFFFF;

    // Walkable points for one tile, thinned onto a grid. Every polygon
    // contributes its centroid; a cell keeps the first centroid that lands in
    // it. Full detail would be about 4.7 million polygons city-wide, which is
    // far more than a crowd needs — one standable point every couple of metres
    // is plenty, and it keeps the whole city in a few megabytes.
    private static Tile ReadTile(string name, byte[] resource, float cell, out int polygons)
    {
        polygons = 0;
        var data = Inflate(resource);
        if (data.Length < 0x90) return null;

        var vertexCount = BitConverter.ToUInt32(data, 0x78);
        var polygonCount = BitConverter.ToUInt32(data, 0x7c);
        var indexCount = BitConverter.ToUInt32(data, 0x68);
        var vertexBase = Offset(data, 0x58);
        var indexBase = Offset(data, 0x60);
        var polygonBase = Offset(data, 0x6c);
        var sizeX = BitConverter.ToSingle(data, 0x40);
        var sizeY = BitConverter.ToSingle(data, 0x44);

        if (vertexCount == 0 || polygonCount == 0 || indexCount == 0) return null;
        if (vertexBase + vertexCount * 6 > data.Length) return null;
        if (indexBase + indexCount * 2 > data.Length) return null;
        if (polygonBase + polygonCount * 40 > data.Length) return null;
        if (sizeX <= 0 || sizeY <= 0) return null;

        var parts = name[..^4].Split('_');
        if (parts.Length < 3 || !int.TryParse(parts[1], out var sectorX) || !int.TryParse(parts[2], out var sectorY))
            return null;

        var tile = new Tile { SectorX = sectorX, SectorY = sectorY };
        var columns = Math.Max(1, (int)MathF.Ceiling(sizeX / cell));
        var rows = Math.Max(1, (int)MathF.Ceiling(sizeY / cell));
        var taken = new bool[columns * rows];

        uint FirstIndex(uint polygon) => BitConverter.ToUInt16(data, (int)(polygonBase + polygon * 40 + 4));

        for (uint p = 0; p < polygonCount; p++)
        {
            var start = FirstIndex(p);
            var end = p + 1 < polygonCount ? FirstIndex(p + 1) : indexCount;
            if (end <= start || end > indexCount) continue;

            float sumX = 0, sumY = 0;
            var used = 0;
            for (var i = start; i < end; i++)
            {
                var vertex = BitConverter.ToUInt16(data, (int)(indexBase + i * 2));
                if (vertex >= vertexCount) { used = 0; break; }
                sumX += BitConverter.ToUInt16(data, (int)(vertexBase + vertex * 6)) / 65535f * sizeX;
                sumY += BitConverter.ToUInt16(data, (int)(vertexBase + vertex * 6 + 2)) / 65535f * sizeY;
                used++;
            }
            if (used < 3) continue;
            polygons++;

            var x = sumX / used;
            var y = sumY / used;
            var column = Math.Clamp((int)(x / cell), 0, columns - 1);
            var row = Math.Clamp((int)(y / cell), 0, rows - 1);
            var slot = row * columns + column;
            if (taken[slot]) continue;
            taken[slot] = true;
            tile.Points.Add((x, y));
        }
        return tile.Points.Count > 0 ? tile : null;
    }

    public static int Run(string gameDir, string outputPath, float cell)
    {
        var archive = new IMGFileSystem();
        archive.Open(Path.Combine(gameDir, NavmeshImg.Replace('/', Path.DirectorySeparatorChar)));
        try
        {
            var tiles = new List<Tile>();
            long totalPolygons = 0;
            var skipped = 0;
            foreach (var file in archive.GetAllFiles())
            {
                if (!file.Name.StartsWith("sectors2x2_", StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    var tile = ReadTile(file.Name, file.GetData(), cell, out var polygons);
                    totalPolygons += polygons;
                    if (tile == null) { skipped++; continue; }
                    tiles.Add(tile);
                }
                catch { skipped++; }
            }

            // Packed as one binary blob plus an index, the same shape the map's
            // own assets use: a flat array beats 3,600 little files.
            var points = tiles.Sum(tile => tile.Points.Count);
            var blob = new byte[points * 4];
            var index = new List<Dictionary<string, object>>();
            var cursor = 0;
            foreach (var tile in tiles.OrderBy(t => t.SectorY).ThenBy(t => t.SectorX))
            {
                var start = cursor / 4;
                foreach (var (x, y) in tile.Points)
                {
                    // Local to the tile, quantised — 100 m over 65,535 steps is
                    // 1.5 mm, far finer than anything a crowd needs.
                    BitConverter.GetBytes((ushort)Math.Clamp(x / TileSize * 65535f, 0, 65535)).CopyTo(blob, cursor);
                    BitConverter.GetBytes((ushort)Math.Clamp(y / TileSize * 65535f, 0, 65535)).CopyTo(blob, cursor + 2);
                    cursor += 4;
                }
                index.Add(new Dictionary<string, object>
                {
                    ["sx"] = tile.SectorX,
                    ["sy"] = tile.SectorY,
                    // World corner of the tile, in RAGE coordinates.
                    ["x"] = tile.SectorX * 50f + WorldOrigin,
                    ["y"] = tile.SectorY * 50f + WorldOrigin,
                    ["start"] = start,
                    ["count"] = tile.Points.Count,
                });
            }

            var binName = Path.GetFileNameWithoutExtension(outputPath) + ".bin";
            System.IO.File.WriteAllBytes(Path.Combine(Path.GetDirectoryName(outputPath) ?? ".", binName), blob);

            var manifest = new Dictionary<string, object>
            {
                ["source"] = NavmeshImg,
                ["note"] = "Walkable points from the ped navmesh. Heights are NOT included — the tile Z base is not stored in the file; use a ground raycast.",
                ["binary"] = binName,
                ["tileSize"] = TileSize,
                ["worldOrigin"] = WorldOrigin,
                ["metresPerSector"] = 50f,
                ["gridCell"] = cell,
                ["tiles"] = index,
                ["stats"] = new Dictionary<string, object>
                {
                    ["tiles"] = tiles.Count,
                    ["skipped"] = skipped,
                    ["polygons"] = totalPolygons,
                    ["points"] = points,
                    ["bytes"] = blob.Length,
                },
            };
            System.IO.File.WriteAllText(outputPath,
                System.Text.Json.JsonSerializer.Serialize(manifest));

            Console.WriteLine($"Navmesh: {tiles.Count} tiles, {totalPolygons:n0} polygons -> {points:n0} walkable points ({blob.Length / 1024:n0} KB), {skipped} skipped");
            Console.WriteLine($"Wrote {outputPath} and {binName}");
            return 0;
        }
        finally { archive.Close(); }
    }
}
