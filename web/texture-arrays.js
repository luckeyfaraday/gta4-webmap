import * as THREE from 'three';

// GTA IV ships every texture as a DXT1/DXT5 mip chain. A WebGL2 sampler2DArray
// needs every layer to share one size and format, so textures are bucketed by
// (width, height, format) after trimming leading mips down to `maxEdge`.
// Trimming is free — it just slices the chain the game already stored — and it
// both shrinks VRAM and merges buckets (a trimmed 512x512 lands exactly on the
// native 256x256 bucket).

const DXT1_RGB = THREE.RGB_S3TC_DXT1_Format;
const DXT1_RGBA = THREE.RGBA_S3TC_DXT1_Format;
const DXT5 = THREE.RGBA_S3TC_DXT5_Format;

// Must match DDSLoader's choices exactly, or bundled sectors would shade
// differently from ones falling back to per-file loading.
const FOURCC_FORMAT = {
  DXT1: THREE.RGB_S3TC_DXT1_Format,
  DXT3: THREE.RGBA_S3TC_DXT3_Format,
  DXT5: THREE.RGBA_S3TC_DXT5_Format,
};
const FOURCC_BLOCK_BYTES = { DXT1: 8, DXT3: 16, DXT5: 16 };

function configure(texture, anisotropy, levels) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// Arrays prebuilt by tools/pack-textures.mjs: the binary is already laid out
// mip-major per array, so each level is one contiguous view with no copying.
export class BundledArrays {
  constructor(manifest, binary, anisotropy = 8) {
    this.textures = new Map();
    this.placement = new Map();
    this.bytes = 0;

    for (const spec of manifest.arrays) {
      const format = FOURCC_FORMAT[spec.fourCC];
      if (!format) throw new Error(`unsupported bundled format ${spec.fourCC}`);
      const mipmaps = [];
      let offset = spec.offset;
      for (let level = 0; level < spec.levels; level++) {
        const width = Math.max(1, spec.width >> level);
        const height = Math.max(1, spec.height >> level);
        const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
        const stride = blocks * FOURCC_BLOCK_BYTES[spec.fourCC] * spec.layers;
        mipmaps.push({ data: new Uint8Array(binary, offset, stride), width, height });
        offset += stride;
        this.bytes += stride;
      }
      const array = new THREE.CompressedArrayTexture(mipmaps, spec.width, spec.height, spec.layers, format);
      this.textures.set(spec.key, configure(array, anisotropy, spec.levels));
    }

    for (const [name, [arrayIndex, layer]] of Object.entries(manifest.layers)) {
      this.placement.set(name, { key: manifest.arrays[arrayIndex].key, layer });
    }
  }

  locate(name) { return this.placement.get(name) ?? null; }
  get(key) { return this.textures.get(key); }
  stats() { return { arrays: this.textures.size, bytes: this.bytes }; }

  dispose() {
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.placement.clear();
  }
}

function bytesPerBlockRow(width, height, format) {
  const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
  return blocks * (format === DXT1_RGB || format === DXT1_RGBA ? 8 : 16);
}

// Number of leading mips to skip so the base level fits inside maxEdge. Never
// trims past the last level, so tiny textures are left alone.
function trimLevels(mipmaps, maxEdge) {
  let drop = 0;
  while (drop < mipmaps.length - 1 && (mipmaps[drop].width > maxEdge || mipmaps[drop].height > maxEdge)) drop++;
  return drop;
}

export function classify(texture, maxEdge) {
  const drop = trimLevels(texture.mipmaps, maxEdge);
  const base = texture.mipmaps[drop];
  return { key: `${base.width}x${base.height}|${texture.format}`, drop, width: base.width, height: base.height, format: texture.format };
}

export class TextureArraySet {
  constructor(maxEdge = 256) {
    this.maxEdge = maxEdge;
    this.buckets = new Map();   // key -> { width, height, format, sources: [], layerOf: Map<id, layer> }
    this.textures = new Map();  // key -> CompressedArrayTexture
  }

  // Returns { key, layer } so callers can record where a texture landed before
  // the arrays are actually built.
  add(id, texture) {
    const info = classify(texture, this.maxEdge);
    let bucket = this.buckets.get(info.key);
    if (!bucket) {
      bucket = { ...info, sources: [], layerOf: new Map() };
      this.buckets.set(info.key, bucket);
    }
    if (!bucket.layerOf.has(id)) {
      bucket.layerOf.set(id, bucket.sources.length);
      bucket.sources.push({ id, texture, drop: info.drop });
    }
    return { key: info.key, layer: bucket.layerOf.get(id) };
  }

  build(anisotropy = 8) {
    for (const [key, bucket] of this.buckets) {
      const { width, height, format, sources } = bucket;
      // Layers must agree on level count, so clamp to the shortest chain.
      const levels = Math.min(...sources.map(s => s.texture.mipmaps.length - s.drop));
      const mipmaps = [];
      for (let level = 0; level < levels; level++) {
        const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
        const stride = bytesPerBlockRow(w, h, format);
        const data = new Uint8Array(stride * sources.length);
        sources.forEach((source, layer) => {
          const mip = source.texture.mipmaps[source.drop + level];
          // A malformed chain would silently corrupt neighbouring layers.
          if (mip.data.byteLength !== stride) {
            throw new Error(`mip ${level} of ${source.id} is ${mip.data.byteLength}B, expected ${stride}B for ${w}x${h}`);
          }
          data.set(mip.data, layer * stride);
        });
        mipmaps.push({ data, width: w, height: h });
      }

      const array = new THREE.CompressedArrayTexture(mipmaps, width, height, sources.length, format);
      array.colorSpace = THREE.SRGBColorSpace;
      array.wrapS = array.wrapT = THREE.RepeatWrapping;
      array.minFilter = levels > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      array.magFilter = THREE.LinearFilter;
      array.anisotropy = anisotropy;
      array.generateMipmaps = false;
      array.needsUpdate = true;
      this.textures.set(key, array);

      // The per-texture CompressedTextures were only staging for the copy above.
      for (const source of sources) source.texture.dispose();
      bucket.sources = [];
    }
    return this.textures;
  }

  get(key) { return this.textures.get(key); }

  dispose() {
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
    this.buckets.clear();
  }

  stats() {
    let bytes = 0;
    for (const texture of this.textures.values()) {
      for (const mip of texture.mipmaps) bytes += mip.data.byteLength;
    }
    return { arrays: this.textures.size, bytes };
  }
}
