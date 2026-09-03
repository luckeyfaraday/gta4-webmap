#!/usr/bin/env bash
# Resumes the ped meshopt pass over whatever .gltf files are still uncompressed,
# then points the catalogue at the .glb files the viewer fetches.
#
# extract-peds.ps1 does this inline, but re-running that script re-extracts every
# ped first, which makes all 343 .gltf files newer than their .glb and forces a
# full recompress. This picks up where an interrupted run left off.
set -u
cd "$(dirname "$0")/.."

total=$(ls web/assets/peds/*.gltf 2>/dev/null | wc -l)
index=0
for source in web/assets/peds/*.gltf; do
  [ -e "$source" ] || break
  index=$((index + 1))
  name=$(basename "$source" .gltf)
  echo "[$index/$total] $name"
  npx --yes '@gltf-transform/cli@4.4.2' optimize \
    "web/assets/peds/$name.gltf" "web/assets/peds/$name.glb" \
    --compress meshopt --flatten false --join false --instance false \
    --palette false --simplify false --texture-compress false >/dev/null 2>&1
  if [ -s "web/assets/peds/$name.glb" ]; then
    rm -f "web/assets/peds/$name.gltf" "web/assets/peds/$name.bin"
  else
    echo "  FAILED: $name" >&2
  fi
done

node -e '
const fs = require("fs");
const path = "web/assets/peds/peds.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8").replace(/^﻿/, ""));
let missing = 0;
for (const ped of manifest.peds) {
  ped.gltf = ped.ped + ".glb";
  if (!fs.existsSync("web/assets/peds/" + ped.gltf)) missing++;
}
manifest.animations = "animations.glb";
fs.writeFileSync(path, JSON.stringify(manifest, null, 2));
console.log("catalogue updated:", manifest.count, "peds,", missing, "missing .glb");
'
