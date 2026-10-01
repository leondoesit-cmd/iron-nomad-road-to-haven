import * as THREE from 'three';
import { DEG, lerp } from '../core/math';
import type { LightState } from '../sim/dayclock';

export type QualityPreset = 'low' | 'medium' | 'high';
export const QUALITY: Record<QualityPreset, { scale: number; shadow: number; zombies: number; draw: number; particles: number }> = {
  low: { scale: 0.7, shadow: 1024, zombies: 40, draw: 220, particles: 0.5 },
  medium: { scale: 0.85, shadow: 2048, zombies: 60, draw: 320, particles: 1 },
  high: { scale: 1.0, shadow: 2048, zombies: 80, draw: 420, particles: 1 },
};

export type SplitLayout = 'horizontal' | 'vertical';

export interface PlayerView {
  camera: THREE.PerspectiveCamera;
  /** Pixels in CSS space, origin top-left. */
  rect: { x: number; y: number; w: number; h: number };
  /** Point the shadow frustum and sky follow. */
  focus: THREE.Vector3;
  active: boolean;
}

/** Horizontal FOV is fixed at 100 degrees; vertical is derived with a floor of 32 degrees. */
export function fovFor(aspect: number, hfovDeg = 100, vfovMinDeg = 32) {
  const v = 2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / aspect) / DEG;
  return Math.max(vfovMinDeg, v);
}

const skyVert = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w * 0.9999;
}`;
const skyFrag = `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform float uNight; uniform float uTime;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  float t = pow(max(h, 0.0), 0.55);
  vec3 col = mix(uHorizon, uTop, t);
  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * (pow(sd, 400.0) * 2.5 + pow(sd, 12.0) * 0.28);
  // dust haze band hugging the horizon
  col = mix(col, uHorizon, smoothstep(0.18, 0.0, h) * 0.65);
  // stars
  vec3 sp = floor(d * 180.0);
  float s = step(0.9975, hash(sp)) * smoothstep(0.1, 0.5, d.y);
  col += vec3(0.9, 0.95, 1.0) * s * uNight;
  gl_FragColor = vec4(col, 1.0);
}`;

/** Vertical FOV used in the left/right layout, where a fixed 100 degree horizontal FOV would be a fisheye on a tall half. */
export const VERTICAL_SPLIT_VFOV = 66;

/** FOV for a view: fixed horizontal FOV for the wide strips, a fixed vertical FOV for the left/right halves. */
export function viewFov(aspect: number, layout: SplitLayout) {
  const strip = fovFor(aspect);
  return layout === 'vertical' ? Math.min(VERTICAL_SPLIT_VFOV, strip) : strip;
}

export class GameRenderer {
  gl: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  views: [PlayerView, PlayerView];
  sun = new THREE.DirectionalLight(0xffffff, 2);
  hemi = new THREE.HemisphereLight(0xffffff, 0x886644, 0.9);
  fog = new THREE.Fog(0xcfc4aa, 60, 340);
  sky: THREE.Mesh;
  skyUniforms: Record<string, THREE.IUniform>;
  /** Left/right is the default; top/bottom (the blueprint's strips) is a setting. */
  layout: SplitLayout = 'vertical';
  quality: QualityPreset = 'medium';
  renderScale = 1;
  private baseDpr = 1;
  private frameEma = 16;
  night = 0;
  width = 1;
  height = 1;
  sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  /** Overlay hook: extra callbacks called with each view before it renders (particles, billboards). */
  onBeforeView: ((i: number, cam: THREE.PerspectiveCamera) => void)[] = [];
  contextLost = false;
  onContextRestored: () => void = () => {};

  constructor(public canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.baseDpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.gl.setPixelRatio(this.baseDpr * QUALITY[this.quality].scale);
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.autoClear = true;
    this.scene.fog = this.fog;
    this.scene.add(this.hemi);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.sun.castShadow = true;
    this.setShadowSize(QUALITY[this.quality].shadow);
    const sc = this.sun.shadow.camera;
    sc.left = -64;
    sc.right = 64;
    sc.top = 64;
    sc.bottom = -64;
    sc.near = 1;
    sc.far = 260;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;

    this.skyUniforms = {
      uTop: { value: new THREE.Color(0.35, 0.45, 0.7) },
      uHorizon: { value: new THREE.Color(0.8, 0.75, 0.65) },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Color(1, 0.8, 0.5) },
      uNight: { value: 0 },
      uTime: { value: 0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 24, 16),
      new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    const mkView = (): PlayerView => ({ camera: new THREE.PerspectiveCamera(37, 3.56, 0.15, 900), rect: { x: 0, y: 0, w: 1, h: 1 }, focus: new THREE.Vector3(), active: true });
    this.views = [mkView(), mkView()];

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContextRestored();
    });
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setShadowSize(n: number) {
    this.sun.shadow.mapSize.set(n, n);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  setQuality(q: QualityPreset) {
    this.quality = q;
    this.renderScale = 1;
    this.gl.setPixelRatio(this.baseDpr * QUALITY[q].scale);
    this.setShadowSize(QUALITY[q].shadow);
    this.resize();
  }

  setLayout(l: SplitLayout) {
    this.layout = l;
    this.resize();
  }

  /** Per the blueprint: 4 px divider between halves. */
  static DIVIDER = 4;

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.gl.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const d = GameRenderer.DIVIDER;
    const [a, b] = this.views;
    if (this.layout === 'horizontal') {
      const hh = Math.floor((h - d) / 2);
      a.rect = { x: 0, y: 0, w, h: hh };
      b.rect = { x: 0, y: hh + d, w, h: h - hh - d };
    } else {
      const ww = Math.floor((w - d) / 2);
      a.rect = { x: 0, y: 0, w: ww, h };
      b.rect = { x: ww + d, y: 0, w: w - ww - d, h };
    }
    for (const v of this.views) {
      v.camera.aspect = v.rect.w / v.rect.h;
      v.camera.fov = viewFov(v.camera.aspect, this.layout);
      v.camera.updateProjectionMatrix();
    }
  }

  /** Apply time-of-day lighting. */
  setLight(l: LightState, biome: 'wasteland' | 'city') {
    this.night = l.night;
    const e = l.elevation;
    const az = l.azimuth;
    this.sunDir.set(Math.cos(az) * Math.sqrt(Math.max(0.05, 1 - e * e)), e, Math.sin(az) * Math.sqrt(Math.max(0.05, 1 - e * e))).normalize();
    this.sun.color.setRGB(...l.sunColor);
    this.sun.intensity = l.sunIntensity;
    this.hemi.color.setRGB(...l.hemiSky);
    this.hemi.groundColor.setRGB(...l.hemiGround);
    this.hemi.intensity = l.hemiIntensity;
    this.fog.color.setRGB(...l.fog);
    const dist = QUALITY[this.quality].draw;
    this.fog.near = lerp(biome === 'city' ? 50 : 70, 24, l.night);
    this.fog.far = lerp(Math.min(dist, biome === 'city' ? 280 : 340), 130, l.night);
    (this.skyUniforms.uTop.value as THREE.Color).setRGB(l.sky[0] * 0.55, l.sky[1] * 0.65, Math.min(1, l.sky[2] * 0.95 + 0.08 * (1 - l.night)));
    (this.skyUniforms.uHorizon.value as THREE.Color).setRGB(...l.fog);
    (this.skyUniforms.uSunColor.value as THREE.Color).setRGB(...l.sunColor);
    this.skyUniforms.uNight.value = l.night;
  }

  /** Adaptive resolution: keep the two halves within 0.1 of each other by using one shared scale. */
  adapt(frameMs: number) {
    this.frameEma = lerp(this.frameEma, frameMs, 0.06);
    const q = QUALITY[this.quality];
    if (this.frameEma > 21 && this.renderScale > 0.62) this.renderScale -= 0.01;
    else if (this.frameEma < 15.5 && this.renderScale < 1) this.renderScale += 0.005;
    this.gl.setPixelRatio(this.baseDpr * q.scale * this.renderScale);
  }

  render(time: number) {
    if (this.contextLost) return;
    this.skyUniforms.uTime.value = time;
    const gl = this.gl;
    gl.setScissorTest(true);
    const dpr = gl.getPixelRatio();
    void dpr;
    for (let i = 0; i < 2; i++) {
      const v = this.views[i];
      if (!v.active) continue;
      const r = v.rect;
      // three's setViewport/setScissor take CSS pixels with y from the bottom.
      const y = this.height - (r.y + r.h);
      gl.setViewport(r.x, y, r.w, r.h);
      gl.setScissor(r.x, y, r.w, r.h);
      this.sky.position.copy(v.camera.position);
      // Re-aim the single shadow map at this player.
      const f = v.focus;
      this.sun.target.position.copy(f);
      this.sun.position.copy(f).addScaledVector(this.sunDir, 130);
      this.sun.target.updateMatrixWorld();
      for (const cb of this.onBeforeView) cb(i, v.camera);
      gl.render(this.scene, v.camera);
    }
    gl.setScissorTest(false);
  }
}
