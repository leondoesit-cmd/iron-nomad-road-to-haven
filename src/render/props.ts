import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { C } from './palette';
import { shared } from './dispose';
import type { PropKind, PropSpawn } from '../world/layout';

const protoCache = new Map<string, MeshBuilder>();

/** Tag colours for signs and markers. */
const TAG_COL: Record<number, number> = {
  1: C.chassis,
  2: C.gold,
  3: C.fragment,
  4: C.raiderFlag,
  5: 0xe0832a,
  6: 0x3fbf6a,
  7: 0xd94a4a,
};

function rockProto(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const r = (n: number) => ((Math.sin(seed * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const base = [0x8a6a4a, 0x7c5a42, 0x9b7b58, 0x6f5440][seed % 4];
  b.add('ico', 0, 0.35, 0, 1.7 + r(1) * 0.9, 1.2 + r(2) * 0.6, 1.5 + r(3) * 0.9, base, r(4), r(5) * 6, r(6));
  if (r(7) > 0.4) b.add('ico', 0.7, 0.2, 0.4, 0.9, 0.7, 0.8, 0x9b7b58, r(8), r(9) * 6, 0);
  return b;
}

function wreckProto(seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  const body = [C.rust, 0x6d6a5c, 0x7a5a3a, 0x59606a][seed % 4];
  b.box(0, 0.55, 0, 1.8, 0.55, 4.0, body);
  b.box(0, 1.05, -0.25, 1.55, 0.5, 2.0, body === C.rust ? C.rust2 : body);
  b.box(0, 1.08, -0.25, 1.58, 0.28, 1.7, C.glass);
  // Missing wheels, collapsed to one side.
  for (const [x, z] of [[0.9, 1.3], [-0.9, 1.3], [0.9, -1.3], [-0.9, -1.3]] as const) {
    if ((seed + Math.floor(x * 3) + Math.floor(z * 3)) % 3 !== 0) b.cyl(x, 0.35, z, 0.7, 0.28, 0.7, C.tire, 0, 0, Math.PI / 2);
  }
  b.box(0.2, 0.9, 1.9, 1.1, 0.2, 0.2, C.rust2, 0.3, 0.4, 0); // hanging bumper
  if (tag === 5) {
    // Encounter marker: bright scarf on the antenna
    b.tube(-0.6, 1.3, -0.9, -0.6, 2.6, -0.9, 0.05, C.darkMetal);
    b.box(-0.6, 2.55, -0.7, 0.04, 0.3, 0.4, C.raiderFlag);
  }
  return b;
}

function build(kind: PropKind, seed: number, tag: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed * 7 + 1);
  switch (kind) {
    case 'rock':
      return rockProto(seed);
    case 'cairn': {
      b.add('ico', 0, 0.28, 0, 0.9, 0.56, 0.9, C.cairn);
      b.add('ico', 0.05, 0.75, 0.03, 0.62, 0.42, 0.6, C.cairn);
      b.add('ico', -0.03, 1.1, 0, 0.4, 0.34, 0.4, C.cairn);
      b.box(0, 1.5, 0, 0.04, 0.5, 0.04, C.darkMetal);
      b.box(0.12, 1.65, 0, 0.26, 0.2, 0.03, C.raiderRed);
      return b;
    }
    case 'deadTree': {
      b.tube(0, 0, 0, 0.1, 2.4, 0, 0.28, C.woodDark);
      b.tube(0.1, 1.8, 0, 0.9, 3.0, 0.2, 0.12, C.woodDark);
      b.tube(0.05, 2.2, 0, -0.8, 3.2, -0.3, 0.12, C.woodDark);
      b.tube(0.1, 2.4, 0, 0.1, 3.7, 0.5, 0.1, C.woodDark);
      return b;
    }
    case 'wreck':
      return wreckProto(seed, tag);
    case 'pole': {
      b.box(0, 3.5, 0, 0.22, 7, 0.22, C.woodDark);
      b.box(0, 6.3, 0, 1.6, 0.14, 0.14, C.woodDark);
      return b;
    }
    case 'barrel': {
      b.cyl(0, 0.45, 0, 0.62, 0.9, 0.62, seed % 2 ? C.rust : 0x3a5f8a, 0, 0, 0, 10);
      b.cyl(0, 0.9, 0, 0.64, 0.05, 0.64, C.darkMetal, 0, 0, 0, 10);
      return b;
    }
    case 'tires': {
      for (let i = 0; i < 3; i++) b.cyl(0, 0.15 + i * 0.3, 0, 1.0, 0.3, 1.0, C.tire, 0, 0, 0, 14);
      return b;
    }
    case 'sign': {
      const c = TAG_COL[tag] ?? C.signYellow;
      b.box(0, 1.4, 0, 0.12, 2.8, 0.12, C.darkMetal);
      b.box(0, 2.6, 0, 1.5, 1.0, 0.1, c);
      b.box(0, 2.6, 0.06, 1.2, 0.7, 0.04, 0x1d1d1d);
      b.box(0, 2.6, 0.09, 0.9, 0.12, 0.03, c);
      return b;
    }
    case 'bones': {
      b.add('ico', 0, 0.1, 0, 0.5, 0.2, 0.4, C.bone);
      b.tube(0.3, 0.06, 0, -0.5, 0.06, 0.3, 0.07, C.bone);
      b.tube(0.2, 0.06, 0.3, 0.8, 0.06, -0.2, 0.07, C.bone);
      return b;
    }
    case 'tarp': {
      b.box(0, 0.5, 0, 1.6, 0.9, 3.0, C.tarp);
      b.box(0, 1.0, 0, 1.2, 0.2, 2.4, 0x246089);
      b.box(0.82, 0.3, 0.8, 0.06, 0.4, 0.8, C.rust2);
      return b;
    }
    case 'pylon': {
      const c = TAG_COL[tag] ?? C.fragment;
      b.box(0, 2.2, 0, 0.5, 4.4, 0.5, C.metal);
      b.box(0, 5.2, 0, 0.3, 2, 0.3, C.steel);
      b.tube(0, 3.4, 0, 0.6, 1.0, 0.6, 0.08, C.darkMetal);
      b.tube(0, 3.4, 0, -0.6, 1.0, -0.6, 0.08, C.darkMetal);
      b.box(0, 6.3, 0, 0.35, 0.35, 0.35, c);
      return b;
    }
    case 'crateStack': {
      b.box(0, 0.5, 0, 1.0, 1.0, 1.0, C.wood);
      b.box(1.0, 0.5, 0.2, 1.0, 1.0, 1.0, C.woodDark);
      b.box(0.4, 1.4, 0.1, 0.9, 0.9, 0.9, C.wood, 0, 0.4, 0);
      b.box(0.4, 2.0, 0.1, 0.9, 0.12, 0.9, TAG_COL[tag] ?? C.gold);
      return b;
    }
    case 'shelf': {
      b.box(0, 0.95, 0, 0.5, 1.9, 1.5, C.darkMetal);
      for (let i = 0; i < 4; i++) b.box(0.02, 0.35 + i * 0.5, 0, 0.5, 0.06, 1.5, C.steel);
      const goods = [0xe8e0cc, 0x6ab07a, 0xd9a050, 0xc84d4d];
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) b.box(0.0, 0.5 + i * 0.5, -0.5 + j * 0.5, 0.35, 0.22, 0.28, goods[(i + j + seed) % 4]);
      return b;
    }
    case 'locker': {
      b.box(0, 0.9, 0, 0.7, 1.8, 1.4, C.metal);
      b.box(0.36, 0.9, -0.35, 0.03, 1.5, 0.6, C.darkMetal);
      b.box(0.36, 0.9, 0.35, 0.03, 1.5, 0.6, C.darkMetal);
      return b;
    }
    case 'dumpster': {
      b.box(0, 0.7, 0, 1.5, 1.4, 2.4, 0x3a5a44);
      b.box(0, 1.45, -0.2, 1.55, 0.1, 2.0, 0x2c4434, 0.05, 0, 0);
      return b;
    }
    case 'streetlight': {
      b.box(0, 3.5, 0, 0.18, 7, 0.18, C.darkMetal);
      b.box(0.9, 7.0, 0, 1.9, 0.14, 0.14, C.darkMetal);
      b.box(1.7, 6.9, 0, 0.5, 0.12, 0.3, 0xffd48a);
      return b;
    }
    case 'rubble': {
      for (let i = 0; i < 5; i++) b.add('ico', (i - 2) * 0.5, 0.3 + (i % 2) * 0.2, ((i * 7) % 3) * 0.4 - 0.4, 1.0, 0.7, 0.9, i % 2 ? C.concrete : C.concreteDark, i, i * 2, 0);
      b.box(0.6, 0.8, 0.2, 0.08, 1.2, 0.08, C.rust2, 0.2, 0, 0.3);
      return b;
    }
    case 'banner': {
      b.box(0, 2.0, 0, 0.1, 4.0, 0.1, C.darkMetal);
      b.box(0.5, 3.4, 0, 1.0, 0.8, 0.04, C.raiderFlag);
      b.box(0.5, 3.4, 0.02, 0.5, 0.35, 0.03, 0x1c1c1c);
      return b;
    }
    case 'chain': {
      b.box(-6, 0.7, 0, 0.3, 1.4, 0.3, C.darkMetal);
      b.box(6, 0.7, 0, 0.3, 1.4, 0.3, C.darkMetal);
      b.box(0, 0.55, 0, 12, 0.08, 0.08, C.metal);
      for (let i = -5; i <= 5; i += 2) b.box(i, 0.9, 0, 0.9, 0.5, 0.05, C.raiderRed);
      return b;
    }
    default:
      return b;
  }
}

/** Cached prototypes: 4 variants per kind. Appending copies vertices with yaw, scale and offset. */
export function propProto(kind: PropKind, seed: number, tag = 0): MeshBuilder {
  const v = Math.abs(seed) % 4;
  const key = `${kind}:${v}:${tag}`;
  let p = protoCache.get(key);
  if (!p) {
    p = build(kind, v + 1 + (tag || 0) * 7, tag);
    protoCache.set(key, p);
  }
  return p;
}

export function appendProp(target: MeshBuilder, p: PropSpawn) {
  target.append(propProto(p.kind, p.seed, p.tag ?? 0), p.x, p.y, p.z, p.yaw, p.scale);
}

// ------------------------------------------------------------------- pickups

export interface PickupModel {
  group: THREE.Group;
  glow: THREE.Mesh;
}

const glowTex = (() => {
  let t: THREE.Texture | null = null;
  return () => {
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    t = shared(new THREE.CanvasTexture(c));
    return t;
  };
})();
export const glowTexture = glowTex;

const pickupGeo = new Map<string, THREE.BufferGeometry>();
const pickupMat = shared(new THREE.MeshLambertMaterial({ vertexColors: true }));
const glowMats = new Map<number, THREE.SpriteMaterial>();

function pickupGeometry(kind: string): THREE.BufferGeometry {
  let g = pickupGeo.get(kind);
  if (g) return g;
  const b = new MeshBuilder();
  b.jitter = 0.02;
  switch (kind) {
    case 'fuel':
      b.box(0, 0.32, 0, 0.5, 0.64, 0.22, C.fuel);
      b.box(0.1, 0.7, 0, 0.14, 0.1, 0.16, C.darkMetal);
      b.box(0, 0.32, 0.12, 0.3, 0.2, 0.02, 0xf0d0a0);
      break;
    case 'scrap':
      b.add('ico', 0, 0.2, 0, 0.7, 0.4, 0.6, C.metal);
      b.box(0.25, 0.5, 0.1, 0.5, 0.06, 0.3, C.steel, 0.2, 0.4, 0.1);
      b.box(-0.2, 0.35, -0.1, 0.12, 0.5, 0.12, C.rust, 0, 0.2, 0.7);
      break;
    case 'parts':
      b.box(0, 0.25, 0, 0.55, 0.4, 0.45, C.rust);
      b.cyl(0, 0.52, 0, 0.18, 0.2, 0.18, C.steel);
      b.cyl(0.2, 0.52, 0, 0.14, 0.18, 0.14, C.steel);
      b.box(-0.3, 0.3, 0, 0.1, 0.1, 0.5, C.signYellow);
      break;
    case 'tech':
      b.box(0, 0.12, 0, 0.55, 0.08, 0.4, 0x1f6b4a);
      b.box(0.1, 0.2, 0, 0.18, 0.1, 0.18, 0x1c1c1c);
      b.box(-0.15, 0.2, 0.1, 0.1, 0.08, 0.1, C.tech);
      break;
    case 'rations':
      b.box(0, 0.18, 0, 0.5, 0.36, 0.38, 0xd8bf8a);
      b.box(0, 0.37, 0, 0.5, 0.04, 0.2, 0xb04a3a);
      break;
    case 'medicine':
      b.box(0, 0.18, 0, 0.46, 0.36, 0.34, C.medicine);
      b.box(0, 0.2, 0.18, 0.2, 0.05, 0.02, 0xd23a3a);
      b.box(0, 0.2, 0.18, 0.05, 0.2, 0.02, 0xd23a3a);
      break;
    case 'ammo':
      b.box(0, 0.12, 0, 0.45, 0.24, 0.3, 0x5a6a3a);
      break;
    case 'fragment':
      b.box(0, 0.3, 0, 0.5, 0.4, 0.3, 0x2a2e33);
      b.box(0, 0.32, 0.16, 0.34, 0.2, 0.02, C.fragment);
      b.tube(0.2, 0.5, 0, 0.3, 1.0, 0, 0.03, C.steel);
      break;
    case 'chassis':
      b.box(0, 0.4, 0, 1.0, 0.5, 1.8, C.chassis);
      b.box(0, 0.7, 0, 0.8, 0.1, 1.4, 0x1f6aa8);
      break;
    default:
      b.box(0, 0.2, 0, 0.4, 0.4, 0.4, C.gold);
  }
  g = shared(b.build());
  pickupGeo.set(kind, g);
  return g;
}

const GLOW: Record<string, number> = {
  fuel: 0xff5a3a,
  scrap: 0xcfd6dc,
  parts: 0xffa030,
  tech: 0x3adc9c,
  rations: 0xf0d090,
  medicine: 0xffffff,
  ammo: 0xd8c050,
  fragment: 0x3ad0ff,
  chassis: 0x3aa0ff,
};

export function makePickup(kind: string): PickupModel {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(pickupGeometry(kind), pickupMat);
  mesh.castShadow = true;
  group.add(mesh);
  const gc = GLOW[kind] ?? 0xffffff;
  let m = glowMats.get(gc);
  if (!m) {
    m = shared(new THREE.SpriteMaterial({ map: glowTexture(), color: gc, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    glowMats.set(gc, m);
  }
  const sprite = new THREE.Sprite(m);
  sprite.scale.set(kind === 'chassis' ? 4.2 : 2.4, kind === 'chassis' ? 4.2 : 2.4, 1);
  sprite.position.y = 0.55;
  group.add(sprite);
  return { group, glow: sprite as unknown as THREE.Mesh };
}

/** A tall thin beam so valuable pickups read from a distance. */
export function makeBeam(color: number, height = 14): THREE.Mesh {
  const g = new THREE.CylinderGeometry(0.08, 0.08, height, 6, 1, true);
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = height / 2;
  return mesh;
}
