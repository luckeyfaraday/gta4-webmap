using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;

// The loose text files the game ships beside the archives, which say which
// vehicles exist, how they drive and what colours they are allowed to spawn
// in. Parsed straight off disk — none of this lives inside an .img.
//
// Column positions here were read off the shipped files rather than assumed;
// see the notes on each parser. Seat count is deliberately not taken from
// handling.dat, which does not carry one — the fragment skeleton's seat_* bones
// do, and they give seat positions as well as a count.
static class VehicleData
{
    public sealed class VehicleInfo
    {
        public string Model;
        public string TxdName;
        public string Type;              // car / bike / heli / boat / train
        public string HandlingId;
        public string GameName;          // the name shown on screen
        public int Frequency;            // relative spawn weight in traffic
        public int MaxNumber;            // cap on simultaneous instances
        public float WheelRadiusFront;
        public float WheelRadiusRear;
        public int Swankness;            // 0 (junk) .. 5 (exotic)
        public string[] Flags = Array.Empty<string>();
        public Handling Handling;
        public List<int[]> ColourSets = new();
    }

    public sealed class Handling
    {
        public float Mass;
        public float DriveBiasFront;     // 0 = RWD, 1 = FWD, between = AWD
        public int Gears;
        public float DriveForce;
        public float TopSpeed;           // fInitialDriveMaxFlatVel, km/h
        public float BrakeForce;
        public float SteeringLock;       // degrees
        public int MonetaryValue;

        public string DriveType => DriveBiasFront <= 0.01f ? "R" : DriveBiasFront >= 0.99f ? "F" : "4";
    }

    public sealed class Colour
    {
        public int R, G, B;
        public string Family;            // "black", "grey", "white", ...
    }

    // Strips a trailing "# comment" and trims. Returns null for a line carrying
    // no data, so callers can just skip nulls.
    private static string Clean(string line)
    {
        if (line == null) return null;
        var hash = line.IndexOf('#');
        if (hash >= 0) line = line[..hash];
        line = line.Trim();
        return line.Length == 0 ? null : line;
    }

    private static float Float(string value) =>
        float.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var result) ? result : 0f;

    private static int Int(string value) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var result) ? result : 0;

    private static string Field(string[] fields, int index) => index < fields.Length ? fields[index] : string.Empty;

    // vehicles.ide, between the "cars" and "end" markers, comma separated. The
    // header at the top of the file gives the order:
    //   0 model, 1 txd, 2 type, 3 handlingId, 4 game name, 5 anims, 6 anims2,
    //   7 frq, 8 maxNum, 9/10 wheel radius front/rear, 11 dirt, 12 swankness,
    //   13 lodMult, 14 (unused), 15 flags
    // Row width varies by vehicle type, so every read past column 4 is guarded.
    public static Dictionary<string, VehicleInfo> ReadIde(string path)
    {
        var result = new Dictionary<string, VehicleInfo>(StringComparer.OrdinalIgnoreCase);
        var inCars = false;
        foreach (var raw in System.IO.File.ReadLines(path))
        {
            var line = Clean(raw);
            if (line == null) continue;
            if (!inCars) { inCars = line.Equals("cars", StringComparison.OrdinalIgnoreCase); continue; }
            if (line.Equals("end", StringComparison.OrdinalIgnoreCase)) break;

            var fields = line.Split(',').Select(field => field.Trim()).ToArray();
            if (fields.Length < 5) continue;
            var flags = Field(fields, 15);
            result[fields[0]] = new VehicleInfo
            {
                Model = fields[0],
                TxdName = fields[1],
                Type = fields[2],
                HandlingId = fields[3],
                GameName = fields[4],
                Frequency = Int(Field(fields, 7)),
                MaxNumber = Int(Field(fields, 8)),
                WheelRadiusFront = Float(Field(fields, 9)),
                WheelRadiusRear = Float(Field(fields, 10)),
                Swankness = Int(Field(fields, 12)),
                Flags = flags is "" or "-" ? Array.Empty<string>() : flags.Split('+', StringSplitOptions.RemoveEmptyEntries),
            };
        }
        return result;
    }

    // handling.dat, whitespace separated, one row per handling id. Verified
    // against the shipped ADMIRAL/BANSHEE/POLICE rows:
    //   1 mass, 2 dragMult, 3 percentSubmerged, 4-6 centre of mass,
    //   7 driveBiasFront, 8 gears, 9 driveForce, 10 driveInertia,
    //   11 topSpeed, 12 brakeForce, 13 brakeBias, 14 handbrake, 15 steerLock,
    //   33 monetary value.
    // Note there is no drive-type letter anywhere in the row; RWD/FWD/AWD is
    // column 7 being 0 / 1 / in between. Rows prefixed % (boats) or #$ (planes)
    // use different layouts and are skipped.
    public static void ApplyHandling(string path, Dictionary<string, VehicleInfo> vehicles)
    {
        var byId = new Dictionary<string, Handling>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in System.IO.File.ReadLines(path))
        {
            var trimmed = raw?.TrimStart();
            if (trimmed == null || trimmed.StartsWith("%") || trimmed.StartsWith("$")) continue;
            var line = Clean(raw);
            if (line == null) continue;
            var fields = line.Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length < 16) continue;
            byId[fields[0]] = new Handling
            {
                Mass = Float(fields[1]),
                DriveBiasFront = Float(fields[7]),
                Gears = Int(fields[8]),
                DriveForce = Float(fields[9]),
                TopSpeed = Float(fields[11]),
                BrakeForce = Float(fields[12]),
                SteeringLock = Float(fields[15]),
                MonetaryValue = fields.Length > 33 ? Int(fields[33]) : 0,
            };
        }
        foreach (var vehicle in vehicles.Values)
            if (vehicle.HandlingId != null && byId.TryGetValue(vehicle.HandlingId, out var handling))
                vehicle.Handling = handling;
    }

    // carcols.dat is three sections. "col" is the shared palette: 134 rows of
    // "R,G,B,modifier,family". "car3" and "car4" then list, per model, the
    // colour combinations it may spawn in — three indices per combination in
    // car3 and four in car4, which is the only difference between them.
    //
    // Some shipped rows drop a comma between combinations ("85,2,88,85 89,0,89"),
    // so indices are split on whitespace as well as commas and then re-chunked
    // by the section's width rather than trusted to line up.
    public static (Colour[] Palette, Dictionary<string, List<int[]>> Sets) ReadCarCols(string path)
    {
        var palette = new List<Colour>();
        var sets = new Dictionary<string, List<int[]>>(StringComparer.OrdinalIgnoreCase);
        var section = "";
        foreach (var raw in System.IO.File.ReadLines(path))
        {
            var line = Clean(raw);
            if (line == null) continue;
            if (line is "col" or "car" or "car3" or "car4") { section = line; continue; }
            if (line == "end") { section = ""; continue; }

            if (section == "col")
            {
                var fields = line.Split(',').Select(field => field.Trim()).ToArray();
                if (fields.Length < 3) continue;
                palette.Add(new Colour { R = Int(fields[0]), G = Int(fields[1]), B = Int(fields[2]), Family = Field(fields, 4) });
                continue;
            }
            if (section is not ("car" or "car3" or "car4")) continue;

            var comma = line.IndexOf(',');
            if (comma < 0) continue;
            var model = line[..comma].Trim();
            var width = section == "car4" ? 4 : 3;
            var indices = line[(comma + 1)..]
                .Split(new[] { ',', ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(value => Int(value.Trim()))
                .ToArray();
            var combinations = new List<int[]>();
            for (var i = 0; i + width <= indices.Length; i += width)
                combinations.Add(indices.Skip(i).Take(width).ToArray());
            if (combinations.Count == 0) continue;
            if (!sets.TryGetValue(model, out var existing)) sets[model] = existing = new List<int[]>();
            existing.AddRange(combinations);
        }
        return (palette.ToArray(), sets);
    }

    public static Dictionary<string, VehicleInfo> Read(string gameDir, out Colour[] palette)
    {
        string Resolve(string relative) => Path.Combine(gameDir, relative.Replace('/', Path.DirectorySeparatorChar));

        var vehicles = ReadIde(Resolve("common/data/vehicles.ide"));

        var handlingPath = Resolve("common/data/handling.dat");
        if (System.IO.File.Exists(handlingPath)) ApplyHandling(handlingPath, vehicles);

        var carcolsPath = Resolve("common/data/carcols.dat");
        palette = Array.Empty<Colour>();
        if (System.IO.File.Exists(carcolsPath))
        {
            var (colours, sets) = ReadCarCols(carcolsPath);
            palette = colours;
            foreach (var pair in sets)
                if (vehicles.TryGetValue(pair.Key, out var vehicle))
                    vehicle.ColourSets = pair.Value;
        }
        return vehicles;
    }
}
