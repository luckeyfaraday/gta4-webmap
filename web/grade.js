// GTA IV's colour grade, from the same timecyc.dat keyframes as the lighting.
//
// This is the pass that makes IV look like IV. The keyframe carries
// ColourCorrectRGB, ColourAddRGB, and Desaturation/Contrast/Gamma in two
// flavours - one for near geometry, one for far - blended between DepthFxNear
// and DepthFxFar, plus bloom from BPThreshold/MidGreyValue/IntensityBloom.
//
// Pipeline order matters here. three.js applies tone mapping only when a
// material renders to the canvas (WebGLPrograms.js: toneMapping stays
// NoToneMapping whenever currentRenderTarget is set), so everything the
// composer sees is raw HDR radiance. That is exactly what bloom wants, and it
// means this pass owns exposure, tone mapping and the sRGB encode as well as
// the grade. web/lighting.js therefore leaves the sky dome in raw radiance too,
// so the sky and the scene get tone mapped by the same code.
//
// How each grade column is meant to be applied is not documented anywhere, so
// the readings below are inferred from the data and each one records its
// evidence. Every inference sits behind a gain so it can be dialled or
// switched off without editing the shader.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const GRADE_FRAGMENT = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec3 uCorrect, uAdd;
uniform vec3 uNear, uFar;        // (desaturation, contrast, gamma)
uniform vec2 uDepthRange;        // (DepthFxNear, DepthFxFar)
uniform float uMidGrey, uCameraNear, uCameraFar, uExposure;
uniform float uSaturationGain, uContrastGain, uGammaGain, uCorrectGain, uAddGain;
uniform float uStrength;
varying vec2 vUv;

// three.js ACESFilmicToneMapping, reproduced exactly including its
// exposure / 0.6 scaling, so switching the composer off changes nothing but
// the grade.
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outputMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= uExposure / 0.6;
  color = inputMat * color;
  color = RRTAndODTFit(color);
  color = outputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

float viewDistance(float depth) {
  float clip = depth * 2.0 - 1.0;
  return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - clip * (uCameraFar - uCameraNear));
}

void main() {
  // The engine grades the display-referred image, not scene radiance, so tone
  // map and encode first and do the arithmetic in that space - contrast and
  // gamma behave completely differently either side of the transfer function.
  vec3 original = linearToSRGB(acesFilmic(texture2D(tDiffuse, vUv).rgb));
  vec3 c = original;

  float distance = viewDistance(texture2D(tDepth, vUv).x);
  float t = smoothstep(uDepthRange.x, uDepthRange.y, distance);
  float desaturation = mix(uNear.x, uFar.x, t);
  float contrast = mix(uNear.y, uFar.y, t);
  float gamma = mix(uNear.z, uFar.z, t);

  // Despite the name, this column reads as the saturation that survives, used
  // directly: it spans 0.16 to 1.00, and 1.0 meaning "untouched" is far more
  // plausible than 1.0 meaning "fully grey". A median of 0.49 then gives the
  // muted look IV actually has, and DesaturationFar reaching 0.0 becomes
  // complete haze at distance, which is exactly what it should be.
  float saturation = clamp(desaturation * uSaturationGain, 0.0, 2.0);
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, saturation);

  // Contrast pivots on MidGreyValue and is 1.0 (neutral) in most keyframes,
  // but tops out at 10.0, which as a straight multiplier would be a hard clip.
  // uContrastGain softens the excursion rather than clamping it.
  float amount = 1.0 + (contrast - 1.0) * uContrastGain;
  c = (c - uMidGrey) * amount + uMidGrey;

  // Gamma is a direct exponent: the column straddles 1.0 (0.60 to 1.25), which
  // only makes sense if 1.0 is the neutral.
  c = pow(max(c, 0.0), vec3(mix(1.0, gamma, uGammaGain)));

  // ColourCorrectRGB is a tint about a 0.5 neutral, hence the doubling. The
  // values cluster tightly around 0.5 and doubling them reproduces IV's actual
  // signature: (0.541, 0.423, 0.271) at 7PM becomes a 1.08/0.85/0.54 warm
  // push, and (0.420, 0.522, 0.541) at midnight becomes a cool blue one.
  c *= mix(vec3(1.0), uCorrect * 2.0, uCorrectGain);

  // ColourAddRGB is zero in 96 of the 99 keyframes, so 0 is clearly neutral,
  // but CLOUDY 8PM and 9PM carry (0.678, 0.871, 1.000), which taken literally
  // would wash the frame out completely. Scaled rather than trusted.
  c += uAdd * uAddGain;

  gl_FragColor = vec4(mix(original, clamp(c, 0.0, 1.0), uStrength), 1.0);
}
`;

const GRADE_VERTEX = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export class GradePipeline {
  constructor(renderer, scene, camera, options = {}) {
    this.renderer = renderer;
    this.camera = camera;
    this.enabled = options.enabled ?? true;
    this.bloomGain = options.bloomGain ?? 0.05;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    // The near/far split needs scene depth, which RenderPass only writes if the
    // target carries a DepthTexture. EffectComposer ping-pongs between two
    // targets and clone() gives the second one its own depth attachment, so
    // point both at this instance - otherwise the depth read here is a frame
    // stale every other frame.
    this.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.depthTexture.type = THREE.UnsignedIntType;
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthTexture: this.depthTexture,
      samples: options.samples ?? 4,
    });

    this.composer = new EffectComposer(renderer, target);
    this.composer.renderTarget2.depthTexture?.dispose();
    this.composer.renderTarget2.depthTexture = this.depthTexture;

    this.composer.addPass(new RenderPass(scene, camera));

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.4, 1);
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: this.depthTexture },
        uCorrect: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
        uAdd: { value: new THREE.Vector3() },
        uNear: { value: new THREE.Vector3(1, 1, 1) },
        uFar: { value: new THREE.Vector3(1, 1, 1) },
        uDepthRange: { value: new THREE.Vector2(16, 128) },
        uMidGrey: { value: 0.61 },
        uCameraNear: { value: camera.near },
        uCameraFar: { value: camera.far },
        uExposure: { value: 0.3 },
        uSaturationGain: { value: options.saturationGain ?? 1 },
        uContrastGain: { value: options.contrastGain ?? 0.35 },
        uGammaGain: { value: options.gammaGain ?? 1 },
        uCorrectGain: { value: options.correctGain ?? 1 },
        uAddGain: { value: options.addGain ?? 0.25 },
        uStrength: { value: 1 },
      },
      vertexShader: GRADE_VERTEX,
      fragmentShader: GRADE_FRAGMENT,
    });
    // ShaderPass deep-clones the uniforms it is handed (UniformsUtils.clone
    // copies anything with isTexture), so the pass would sample a detached copy
    // of the depth texture that nothing ever renders into - a flat buffer that
    // reads as "everything is at the far plane". Point it back at the real one.
    this.grade.uniforms.tDepth.value = this.depthTexture;
    this.grade.renderToScreen = true;
    this.composer.addPass(this.grade);
  }

  update(frame, exposure) {
    const u = this.grade.uniforms;
    u.uExposure.value = exposure;
    u.uCorrect.value.set(...frame.colourCorrect);
    u.uAdd.value.set(...frame.colourAdd);
    u.uNear.value.set(frame.desaturation, frame.contrast, frame.gamma);
    u.uFar.value.set(frame.desaturationFar, frame.contrastFar, frame.gammaFar);
    u.uDepthRange.value.set(frame.depthFxNear, frame.depthFxFar);
    u.uMidGrey.value = frame.midGrey;
    u.uCameraNear.value = this.camera.near;
    u.uCameraFar.value = this.camera.far;
    u.uStrength.value = this.enabled ? 1 : 0;

    // Bloom runs on radiance, before this pass tone maps, so its threshold has
    // to be in the same units: take the display-space threshold back through
    // exposure. BPThreshold alone is 0.0 in a lot of keyframes, which would
    // bloom the entire frame, so MidGreyValue is used as its floor - the two
    // columns sit together in the file and "BP" reads as bright-pass.
    this.bloom.threshold = Math.max(frame.bloomThreshold, frame.midGrey) / Math.max(exposure, 1e-4);
    this.bloom.strength = this.enabled ? frame.bloomIntensity * this.bloomGain : 0;
  }

  setSize(width, height) {
    this.composer.setSize(width, height);
    this.bloom.setSize(width, height);
  }

  render() { this.composer.render(); }
}
