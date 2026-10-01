import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { C } from './palette';
import type { ZombieKind } from '../data';

export const MAX_ZOMBIES = 600;

/** Humanoid geometry with per-vertex limb ids and pivots so the vertex shader can swing the arms and legs. */
function zombieGeometry(): THREE.BufferGeometry {
  type P = { b: MeshBuilder; id: number; pivot: [number, number, number] };
  const parts: P[] = [];
  const mk = (id: number, pivot: [number, number, number], fn: (b: MeshBuilder) => void) => {
    const b = new MeshBuilder();
    b.jitter = 0.07;
    b.seed(id * 31 + 5);
    fn(b);
    parts.push({ b, id, pivot });
  };
  mk(0, [0, 0, 0], (b) => {
    b.box(0, 1.25, 0, 0.46, 0.62, 0.27, C.zombieCloth); // torso
    b.box(0, 1.62, 0.02, 0.24, 0.26, 0.25, C.zombieSkin); // head
    b.box(0, 1.0, 0, 0.44, 0.14, 0.25, 0x37352f); // hips
    b.box(0, 1.28, 0.14, 0.2, 0.3, 0.03, 0x6b2a24); // wound
  });
  for (const [id, sx] of [[1, 1], [2, -1]] as const) {
    mk(id, [sx * 0.12, 0.92, 0], (b) => {
      b.box(sx * 0.12, 0.47, 0, 0.17, 0.9, 0.19, 0x3c3f3a);
      b.box(sx * 0.12, 0.05, 0.04, 0.17, 0.1, 0.27, 0x2a2a2a);
    });
  }
  for (const [id, sx] of [[3, 1], [4, -1]] as const) {
    mk(id, [sx * 0.3, 1.52, 0], (b) => {
      b.box(sx * 0.3, 1.22, 0, 0.14, 0.62, 0.14, C.zombieCloth);
      b.box(sx * 0.3, 0.88, 0, 0.13, 0.12, 0.13, C.zombieSkin2);
    });
  }
  const merged = new MeshBuilder();
  const part: number[] = [];
  const pivot: number[] = [];
  for (const p of parts) {
    merged.append(p.b);
    const n = p.b.pos.length / 3;
    for (let i = 0; i < n; i++) {
      part.push(p.id);
      pivot.push(...p.pivot);
    }
  }
  const g = merged.build();
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(pivot, 3));
  return g;
}

const KIND_TINT: Record<ZombieKind, number> = {
  walker: 0xffffff,
  runner: 0xf0e0d0,
  screamer: 0xd8c8ff,
  bloater: 0xc8e070,
  brute: 0xc89080,
  stalker: 0xa8c0d8,
};

export class ZombieRenderer {
  mesh: THREE.InstancedMesh;
  private anim = new Float32Array(MAX_ZOMBIES * 4);
  private animAttr: THREE.InstancedBufferAttribute;
  private shaderRef: { uniforms: { uTime: { value: number } } } | null = null;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private col = new THREE.Color();
  count = 0;

  constructor() {
    const geo = zombieGeometry();
    this.animAttr = new THREE.InstancedBufferAttribute(this.anim, 4);
    this.animAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', this.animAttr);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      this.shaderRef = shader as unknown as { uniforms: { uTime: { value: number } } };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
attribute float aPart;
attribute vec3 aPivot;
attribute vec4 aAnim; // phase, stride rad/s, chase 0..1, spare
uniform float uTime;`,
        )
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(position);
float zt = uTime * aAnim.y + aAnim.x;
float zs = sin(zt);
float zang = 0.0;
if (aPart > 0.5 && aPart < 1.5) zang = zs * 0.62;
else if (aPart > 1.5 && aPart < 2.5) zang = -zs * 0.62;
else if (aPart > 2.5 && aPart < 3.5) zang = -zs * 0.35 - aAnim.z * 1.25 - 0.35;
else if (aPart > 3.5) zang = zs * 0.35 - aAnim.z * 1.25 - 0.35;
if (aPart > 0.5) {
  vec3 zd = transformed - aPivot;
  float zc = cos(zang); float zn = sin(zang);
  zd = vec3(zd.x, zd.y * zc - zd.z * zn, zd.y * zn + zd.z * zc);
  transformed = aPivot + zd;
}
// Whole-body lean and sway about the hips; chasing zombies hunch forward.
float zl = smoothstep(0.95, 1.5, transformed.y);
float zlean = (0.18 + aAnim.z * 0.25) * zl;
transformed.z += zlean * (transformed.y - 0.95);
transformed.x += sin(zt * 0.5) * 0.04 * zl;`,
        );
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_ZOMBIES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ZOMBIES * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }

  begin() {
    this.count = 0;
  }

  /**
   * Add one instance. `fall` runs 0..1 for the death animation (topples backwards and sinks).
   */
  push(kind: ZombieKind, scale: number, x: number, y: number, z: number, yaw: number, phase: number, stride: number, chase: number, fall: number, variant: number) {
    if (this.count >= MAX_ZOMBIES) return;
    const i = this.count++;
    this.p.set(x, y, z);
    this.e.set(-fall * (Math.PI / 2) * 0.95, yaw, 0, 'YXZ');
    this.q.setFromEuler(this.e);
    this.s.set(scale, scale, scale);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.col.setHex(KIND_TINT[kind]);
    const v = 0.88 + (variant % 5) * 0.045;
    this.mesh.setColorAt(i, this.col.multiplyScalar(v));
    this.anim[i * 4] = phase;
    this.anim[i * 4 + 1] = stride;
    this.anim[i * 4 + 2] = chase;
    this.anim[i * 4 + 3] = fall;
  }

  end(time: number) {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.animAttr.needsUpdate = true;
    if (this.shaderRef) this.shaderRef.uniforms.uTime.value = time;
  }
}
