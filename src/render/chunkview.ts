import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { appendProp } from './props';
import { appendLandmark, LANDMARK_KINDS } from './landmarks';
import { C } from './palette';
import { makePavingMaterial, makeRoadMaterial, makeTerrainMaterial, ROAD_REPEAT, type GroundTheme } from './terrainMaterial';
import { FacadeBuilder, facadeMaterial } from './facade';
import { crate, plate, spareTyre } from './parts';
import { buildScatter } from './scatter';
import { kitMaterial } from './materials';
import { CELL, CELLS, CHUNK, corridorHalf, heightAt, normalAt, roadX, surfaceAt, waterAt, type TerrainDef } from '../world/terrain';
import type { ChunkData } from '../world/chunkgen';
import type { Aabb } from '../world/layout';
import { BOULEVARD_HALF, SIDEWALK } from '../world/layout';
import { GROUPS, type Collider, type PhysicsWorld } from '../physics/physics';
import { hash2, noise2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { shoreShade } from '../world/lakes';

export interface ChunkMaterials {
  terrain: THREE.Material;
  props: THREE.Material;
  walls: THREE.MeshStandardMaterial;
  roofs: THREE.Material;
  road: THREE.Material;
}

export function makeChunkMaterials(biome: 'wasteland' | 'city', theme?: GroundTheme): ChunkMaterials {
  return {
    terrain: makeTerrainMaterial(biome, undefined, theme),
    props: kitMaterial(),
    walls: facadeMaterial(),
    roofs: kitMaterial(),
    road: makeRoadMaterial(biome),
  };
}

/** Free the per-leg materials and textures (shared kit materials and cached textures stay). */
export function disposeChunkMaterials(mats: ChunkMaterials) {
  for (const m of [mats.terrain, mats.props, mats.walls, mats.roofs, mats.road]) {
    if (m.userData.shared) continue;
    const mm = m as THREE.MeshStandardMaterial;
    if (mm.map && !mm.map.userData.shared) mm.map.dispose();
    m.dispose();
  }
}

let paving: THREE.MeshStandardMaterial | null = null;
const pavingMaterial = () => {
  if (!paving) {
    paving = makePavingMaterial();
    paving.userData.shared = true;
  }
  return paving;
};

export interface ChunkOpts {
  /** Ground cover density, 0..1 (quality setting). */
  scatter: number;
}

/** Visual-only crags on cliff faces nobody can reach, so the walls read as broken rock instead of a smooth ramp. */
export function cliffDetail(def: TerrainDef, x: number, z: number): number {
  if (def.biome === 'city') return 0;
  const d = Math.abs(x - roadX(def, z));
  const ch = corridorHalf(def, z);
  let m = smoothstep(ch + 1.5, ch + 7, d);
  m = Math.max(m, Math.min(1, smoothstep(def.length + 152, def.length + 168, z) + (1 - smoothstep(-68, -52, z))));
  if (m <= 0) return 0;
  const ridge = 1 - Math.abs(noise2(x / 9, z / 9, def.seed + 61) * 2 - 1);
  const ridge2 = 1 - Math.abs(noise2(x / 23 + 4, z / 23, def.seed + 64) * 2 - 1);
  const fine = noise2(x / 3.7, z / 3.7, def.seed + 62);
  const ledge = Math.floor(noise2(x / 37, z / 37, def.seed + 63) * 5) * 1.1;
  return m * (ridge * 4.2 + ridge2 * 3.5 + fine * 1.6 + ledge - 5.5) + mountainRelief(def, x, z, d, ch);
}

/** Big ridges and peaks on the slopes beyond the canyon rim: the far scenery, never reachable. */
export function mountainRelief(def: TerrainDef, x: number, z: number, d = Math.abs(x - roadX(def, z)), ch = corridorHalf(def, z)): number {
  const m = smoothstep(ch + 70, ch + 300, d);
  if (m <= 0) return 0;
  const r1 = 1 - Math.abs(noise2(x / 190, z / 190, def.seed + 81) * 2 - 1);
  const r2 = 1 - Math.abs(noise2(x / 61 + 9, z / 61, def.seed + 82) * 2 - 1);
  const mesa = smoothstep(0.55, 0.62, noise2(x / 260, z / 260, def.seed + 83));
  return m * (r1 * r1 * 85 + r2 * 20 + mesa * 40) - smoothstep(ch + 40, ch + 140, d) * 18;
}

/** Horizontal push for cliff vertices: bulges and recesses that a heightfield alone can't express. */
function cliffPush(def: TerrainDef, x: number, z: number, h: number): [number, number] | null {
  if (def.biome === 'city') return null;
  const rx = roadX(def, z);
  const d = Math.abs(x - rx);
  const ch = corridorHalf(def, z);
  const m = smoothstep(ch + 2, ch + 6, d) * (1 - smoothstep(ch + 16, ch + 24, d));
  if (m <= 0) return null;
  const n1 = noise2(z / 15 + h / 9, h / 13 + x / 40, def.seed + 66) * 2 - 1;
  const n2 = noise2(z / 5.5 - h / 4, h / 5 + 3.1, def.seed + 67) * 2 - 1;
  const amt = (n1 * 3.2 + n2 * 1.1) * m;
  // Toward the corridor (negative = into the rock).
  return [-Math.sign(x - rx) * amt, 0];
}

/** Meshes plus colliders for one 128 m chunk. Created and disposed by the streaming system. */
export class ChunkView {
  group = new THREE.Group();
  colliders: Collider[] = [];
  aabbColliders = new Map<number, Collider>();
  barricadeMeshes = new Map<number, THREE.Mesh>();
  private geos: THREE.BufferGeometry[] = [];
  private instanced: THREE.InstancedMesh[] = [];

  constructor(
    public data: ChunkData,
    def: TerrainDef,
    mats: ChunkMaterials,
    private phys: PhysicsWorld,
    opts: ChunkOpts = { scatter: 1 },
  ) {
    const x0 = data.cx * CHUNK;
    const z0 = data.cz * CHUNK;
    this.buildTerrain(def, mats, x0, z0);
    this.buildRoad(def, mats, z0);
    this.buildBuildings(data, mats);
    this.buildProps(data, mats, def.biome === 'city');
    this.buildScatter(def, opts.scatter);
    this.buildColliders(def, x0, z0);
  }

  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    this.group.add(m);
    this.geos.push(geo);
    return m;
  }

  private buildTerrain(def: TerrainDef, mats: ChunkMaterials, x0: number, z0: number) {
    const n = CELLS;
    const N1 = n + 1;
    const W = n + 3;
    const city = def.biome === 'city';
    const seed = def.seed;
    // Positions with a one-cell border so normals match across chunk seams. Cliff faces nobody can reach get
    // crags (vertical noise) and bulges (horizontal push toward the corridor), so they read as broken rock.
    const hb = new Float32Array(W * W);
    const px = new Float32Array(W * W);
    const pz = new Float32Array(W * W);
    for (let r = -1; r <= n + 1; r++) {
      for (let c = -1; c <= n + 1; c++) {
        const x = x0 + c * CELL;
        const z = z0 + r * CELL;
        const inside = c >= 0 && c <= n && r >= 0 && r <= n;
        const base = inside ? this.data.heights[c * N1 + r] : heightAt(def, x, z);
        const h = base + cliffDetail(def, x, z);
        const k = (r + 1) * W + (c + 1);
        hb[k] = h;
        px[k] = x;
        pz[k] = z;
        const push = cliffPush(def, x, z, h);
        if (push) {
          px[k] += push[0];
          pz[k] += push[1];
        }
      }
    }
    const H = (c: number, r: number) => hb[(r + 1) * W + (c + 1)];
    const PX = (c: number, r: number) => px[(r + 1) * W + (c + 1)];
    const PZ = (c: number, r: number) => pz[(r + 1) * W + (c + 1)];
    const vcount = N1 * N1;
    const skirtCount = 4 * N1;
    const total = vcount + skirtCount;
    const pos = new Float32Array(total * 3);
    const nor = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const spl = new Float32Array(total * 4);
    const tdat = new Float32Array(total * 4);
    const ao = new Float32Array(vcount).fill(1);
    // Contact darkening around props and obstacles.
    const shade = (cx: number, cz: number, rad: number, amount: number) => {
      const c0 = Math.max(0, Math.floor((cx - rad - x0) / CELL));
      const c1 = Math.min(n, Math.ceil((cx + rad - x0) / CELL));
      const r0 = Math.max(0, Math.floor((cz - rad - z0) / CELL));
      const r1 = Math.min(n, Math.ceil((cz + rad - z0) / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const d = Math.hypot(x0 + c * CELL - cx, z0 + r * CELL - cz) / rad;
          if (d < 1) ao[r * N1 + c] *= 1 - amount * (1 - d) * (1 - d);
        }
      }
    };
    for (const p of this.data.props) {
      const rad = p.kind === 'rock' ? 2.6 * p.scale : p.kind === 'wreck' ? 4.2 : p.kind === 'deadTree' ? 2.2 : p.kind === 'pole' || p.kind === 'sign' || p.kind === 'streetlight' ? 1.2 : 2.4;
      shade(p.x, p.z, rad, p.kind === 'pole' || p.kind === 'sign' ? 0.35 : 0.55);
    }
    for (const a of this.data.aabbs) {
      const hx = (a.maxX - a.minX) / 2;
      const hz = (a.maxZ - a.minZ) / 2;
      if (hx > 30 || hz > 30 || a.kind === 'partition' || a.kind === 'furniture' || a.kind === 'stair' || a.kind === 'floor') continue;
      shade((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2, Math.max(hx, hz) + 2.4, a.kind === 'building' ? 0.4 : 0.5);
    }
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        const i = r * N1 + c;
        const x = x0 + c * CELL;
        const z = z0 + r * CELL;
        const h = H(c, r);
        // Normal from the displaced surface: cross of the central differences along z and x.
        const ux = PX(c + 1, r) - PX(c - 1, r);
        const uy = H(c + 1, r) - H(c - 1, r);
        const uz = PZ(c + 1, r) - PZ(c - 1, r);
        const vx = PX(c, r + 1) - PX(c, r - 1);
        const vy = H(c, r + 1) - H(c, r - 1);
        const vz = PZ(c, r + 1) - PZ(c, r - 1);
        let nx = vy * uz - vz * uy;
        let ny = vz * ux - vx * uz;
        let nz = vx * uy - vy * ux;
        const m = 1 / (Math.hypot(nx, ny, nz) || 1);
        nx *= m;
        ny *= m;
        nz *= m;
        pos[i * 3] = PX(c, r) - x0;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = PZ(c, r) - z0;
        nor[i * 3] = nx;
        nor[i * 3 + 1] = ny;
        nor[i * 3 + 2] = nz;
        // Material weights: sand, earth, rock, gravel.
        const slope = 1 - ny;
        const d = Math.abs(x - roadX(def, z));
        const surf = surfaceAt(def, x, z);
        let rock = smoothstep(0.26, 0.5, slope);
        let sand = 0;
        let earth = 0;
        let gravel = 0;
        let wet = 0;
        if (city) {
          earth = 0.7 + noise2(x / 21, z / 21, seed + 73) * 0.5;
          gravel = smoothstep(0.62, 0.8, noise2(x / 15, z / 15, seed + 71)) * 0.9;
          sand = smoothstep(0.55, 0.8, noise2(x / 27 + 5, z / 27, seed + 72)) * 0.6;
        } else {
          const cliff = smoothstep(corridorHalf(def, z) + 2, corridorHalf(def, z) + 9, d);
          rock = Math.max(rock, cliff * 0.9);
          gravel = 1 - smoothstep(def.roadHalf + 1.2, def.roadHalf + 4.2, d);
          gravel = Math.max(gravel, smoothstep(0.68, 0.84, noise2(x / 17, z / 17, seed + 71)) * 0.75);
          sand = surf === 'sand' ? 1 : smoothstep(0.5, 0.78, noise2(x / 36 + 3, z / 36, seed + 72)) * 0.85;
          earth = 0.55 + noise2(x / 23, z / 23, seed + 73) * 0.6;
          if (surf === 'mud') {
            wet = 0.75;
            sand *= 0.2;
          }
        }
        // Damp sand along a lake's beach, and a murky green-grey floor under its water.
        let tr = 1;
        let tg = 1;
        let tb = 1;
        const shore = def.lakes.length ? shoreShade(def.lakes, x, z, h) : null;
        if (shore) {
          rock *= 1 - shore.damp;
          sand = Math.max(sand, shore.damp * 0.9);
          earth *= 1 - shore.damp * 0.8;
          if (shore.depth > 0) gravel = 0.5 + shore.depth * 0.1;
          wet = Math.max(wet, 0.35 + shore.damp * 0.5);
          if (shore.depth > 0) {
            const dk = Math.min(1, shore.depth / 3);
            tr = 0.62 - 0.3 * dk;
            tg = 0.82 - 0.24 * dk;
            tb = 0.78 - 0.18 * dk;
          }
        }
        const keep = 1 - rock;
        sand *= keep;
        earth *= keep;
        gravel *= keep;
        const sum = sand + earth + rock + gravel || 1;
        spl[i * 4] = sand / sum;
        spl[i * 4 + 1] = earth / sum;
        spl[i * 4 + 2] = rock / sum;
        spl[i * 4 + 3] = gravel / sum;
        // Ambient occlusion: hollows and cliff feet collect shadow, plus the contact shade above.
        const concave = (H(c - 1, r) + H(c + 1, r) + H(c, r - 1) + H(c, r + 1)) / 4 - h;
        const a = Math.min(1, Math.max(0.45, 1 - Math.max(0, concave) * 0.22)) * ao[i];
        tdat[i * 4] = a;
        tdat[i * 4 + 1] = wet;
        const k = 0.93 + hash2(Math.round(x / CELL), Math.round(z / CELL), 5) * 0.14;
        const kk = k * (0.82 + 0.18 * a);
        col[i * 3] = kk * tr;
        col[i * 3 + 1] = kk * tg;
        col[i * 3 + 2] = kk * tb;
      }
    }
    // Skirts hang below each edge so the seams to neighbouring chunks (and the far landscape) never crack.
    const edges: number[][] = [[], [], [], []];
    for (let k = 0; k <= n; k++) {
      edges[0].push(0 * N1 + k);
      edges[1].push(n * N1 + k);
      edges[2].push(k * N1 + 0);
      edges[3].push(k * N1 + n);
    }
    let sv = vcount;
    const idx: number[] = [];
    for (let e = 0; e < 4; e++) {
      const start = sv;
      for (const vi of edges[e]) {
        pos[sv * 3] = pos[vi * 3];
        pos[sv * 3 + 1] = pos[vi * 3 + 1] - 4;
        pos[sv * 3 + 2] = pos[vi * 3 + 2];
        nor.copyWithin(sv * 3, vi * 3, vi * 3 + 3);
        col.copyWithin(sv * 3, vi * 3, vi * 3 + 3);
        spl.copyWithin(sv * 4, vi * 4, vi * 4 + 4);
        tdat.copyWithin(sv * 4, vi * 4, vi * 4 + 4);
        sv++;
      }
      for (let k = 0; k < n; k++) {
        const a = edges[e][k];
        const b = edges[e][k + 1];
        const as = start + k;
        const bs = start + k + 1;
        idx.push(a, b, as, b, bs, as, a, as, b, b, as, bs);
      }
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const a = r * N1 + c;
        const b = a + 1;
        const d = a + N1;
        const e = d + 1;
        // Same diagonal as the physics heightfield, so wheels sit on what you see.
        idx.push(a, d, e, a, e, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    g.setAttribute('tdata', new THREE.BufferAttribute(tdat, 4));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const m = this.addMesh(g, mats.terrain, false, true);
    m.position.set(x0, 0, z0);
  }

  /** The road: a gently crowned strip with crumbling shoulders, built only in the chunk column it runs through. */
  private buildRoad(def: TerrainDef, mats: ChunkMaterials, z0: number) {
    const city = def.biome === 'city';
    const half = city ? BOULEVARD_HALF : def.roadHalf;
    const ext = city ? 0.04 : 0.7;
    const crown = city ? 0.07 : 0.05;
    const step = 2;
    const us = [-ext / (2 * half), 0, 0.18, 0.5, 0.82, 1, 1 + ext / (2 * half)];
    const cols = us.length;
    const verts: number[] = [];
    const nors: number[] = [];
    const uvs: number[] = [];
    const tans: number[] = [];
    const idx: number[] = [];
    const nSeg = CHUNK / step;
    const tmp: [number, number, number] = [0, 1, 0];
    const x0 = this.data.cx * CHUNK;
    let rows = 0;
    let lastIn = false;
    for (let i = 0; i <= nSeg; i++) {
      const z = z0 + i * step;
      const cx = roadX(def, z);
      const zm = z + step / 2;
      const inCol: boolean = Math.floor(roadX(def, zm) / CHUNK) === this.data.cx || (i === nSeg && lastIn);
      const ahead = roadX(def, z + 1) - roadX(def, z - 1);
      const len = Math.hypot(ahead / 2, 1);
      const px = 1 / len;
      const pz = -(ahead / 2) / len;
      for (const u of us) {
        const off = (u - 0.5) * 2 * half;
        const x = cx + off * px;
        const zz = z + off * pz;
        const uc = Math.min(1, Math.max(0, u));
        verts.push(x - x0, heightAt(def, x, zz) + 0.035 + crown * (1 - (uc * 2 - 1) ** 2), zz - z0);
        normalAt(def, x, zz, tmp);
        nors.push(tmp[0], tmp[1], tmp[2]);
        uvs.push(u, z / ROAD_REPEAT);
        tans.push(px, 0, pz);
      }
      if (i < nSeg && inCol) {
        const a = rows * cols;
        for (let k = 0; k < cols - 1; k++) idx.push(a + k, a + cols + k, a + k + 1, a + k + 1, a + cols + k, a + cols + k + 1);
      }
      lastIn = inCol;
      rows++;
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('rtan', new THREE.Float32BufferAttribute(tans, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = this.addMesh(g, mats.road, false, true);
    m.position.set(x0, 0, z0);
  }

  private buildScatter(def: TerrainDef, density: number) {
    if (density <= 0) return;
    // Nothing grows on the lake bed.
    const submerged = def.lakes.length ? (x: number, z: number) => waterAt(def, x, z) !== null : undefined;
    const set = buildScatter(def, this.data.cx, this.data.cz, this.data.aabbs, this.data.props, density, submerged);
    for (const im of [set.grass, set.shrubs, ...set.pebbles, ...set.boulders]) {
      if (!im) continue;
      this.group.add(im);
      this.instanced.push(im);
    }
    this.scatterSet = set;
  }

  private scatterSet: ReturnType<typeof buildScatter> | null = null;

  /** Distance from the nearest player to this chunk's edge: small ground cover switches off beyond its fade range. */
  setDetailDistance(d: number) {
    const s = this.scatterSet;
    if (!s) return;
    if (s.grass) s.grass.visible = d < 90;
    for (const p of s.pebbles) p.visible = d < 110;
    if (s.shrubs) s.shrubs.visible = d < 190;
  }

  private buildBuildings(data: ChunkData, mats: ChunkMaterials) {
    if (data.blocks.length && (data.cx === 0 || data.cx === -1)) this.buildSidewalks(data);
    if (!data.buildings.length) return;
    const fb = new FacadeBuilder();
    const det = new MeshBuilder();
    det.jitter = 0.05;
    for (const bs of data.buildings) {
      const a = bs.aabb;
      const seed = hash2(Math.round(a.minX * 2), Math.round(a.minZ * 2), 77);
      const tall = bs.floors >= 9;
      const k = hash2(Math.round(a.minX), Math.round(a.maxZ), 78);
      const style = tall ? (k < 0.35 ? 3 : k < 0.75 ? 0 : 2) : k < 0.45 ? 1 : k < 0.75 ? 2 : 0;
      const tint = new THREE.Color(FACADE_TINT[style][Math.floor(seed * FACADE_TINT[style].length) % FACADE_TINT[style].length]);
      const face = BOULEVARD_HALF + 4 > Math.min(Math.abs(a.minX), Math.abs(a.maxX)) ? (a.minX > 0 ? 'w' : 'e') : null;
      this.buildingShell(fb, det, a.minX, a.maxX, a.minZ, a.maxZ, 0, a.y1, tint, style, seed, true, face);
      if (bs.stepped) {
        const inset = 3;
        if (a.maxX - a.minX > inset * 3 && a.maxZ - a.minZ > inset * 3) {
          this.buildingShell(fb, det, a.minX + inset, a.maxX - inset, a.minZ + inset, a.maxZ - inset, a.y1, a.y1 + 6.6, tint, style, seed + 0.31, false, null);
        }
      }
      this.rooftop(det, a.minX, a.maxX, a.minZ, a.maxZ, a.y1 + (bs.stepped ? 6.6 : 0), seed, bs.stepped ? 3 : 0);
      if (style === 1 && seed > 0.4 && a.y1 > 9) this.fireEscape(det, a, seed);
    }
    if (!fb.empty) this.addMesh(fb.build(), facadeMaterial(), true, true);
    if (!det.empty) this.addMesh(det.build(), mats.roofs, true, true);
  }

  /** Walls, ledges, cornice, parapet and (on the boulevard side) shopfront awnings for one block. */
  private buildingShell(fb: FacadeBuilder, det: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, tint: THREE.Color, style: number, seed: number, ground: boolean, shopFace: 'w' | 'e' | null) {
    const floorH = 3.3;
    const target = style === 3 ? 1.6 : 2.6 + seed * 0.7;
    const cell = (len: number) => len / Math.max(1, Math.round(len / target));
    // Walls counter-clockwise from above so they face outward. A raised base hides the shop band on upper blocks.
    const yb = ground ? y0 : y0 - floorH * 1.3;
    const corners: [number, number][] = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
    let u = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      fb.wall(ax, az, bx, bz, ground ? y0 : y0, y1, 0, tint, style, seed * 97 + i * 0.37, floorH, cell(len));
      u += len;
    }
    void yb;
    void u;
    const wallC = S.concrete(tint.clone().multiplyScalar(0.92).getHex(), 0.7);
    const trim = S.concrete(tint.clone().multiplyScalar(1.08).getHex(), 0.6);
    const w = x1 - x0;
    const d = z1 - z0;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    // Floor ledges on panel and stucco buildings, a heavier cornice at the top.
    if (style === 0 || style === 2) {
      const gh = floorH * 1.3;
      for (let y = gh; y < y1 - 1; y += floorH * (style === 2 ? 2 : 1)) {
        det.box(cx, y0 + y, z1 + 0.05, w + 0.1, 0.12, 0.1, trim);
        det.box(cx, y0 + y, z0 - 0.05, w + 0.1, 0.12, 0.1, trim);
        det.box(x1 + 0.05, y0 + y, cz, 0.1, 0.12, d + 0.1, trim);
        det.box(x0 - 0.05, y0 + y, cz, 0.1, 0.12, d + 0.1, trim);
      }
    }
    if (ground) {
      // Shop band lintel.
      const lh = floorH * 1.3 - 0.1;
      det.box(cx, lh, z1 + 0.06, w + 0.12, 0.2, 0.12, trim);
      det.box(cx, lh, z0 - 0.06, w + 0.12, 0.2, 0.12, trim);
      det.box(x1 + 0.06, lh, cz, 0.12, 0.2, d + 0.12, trim);
      det.box(x0 - 0.06, lh, cz, 0.12, 0.2, d + 0.12, trim);
    }
    const ct = style === 3 ? 0.2 : 0.38;
    det.box(cx, y1 - ct / 2, z1 + 0.12, w + 0.3, ct, 0.24, trim);
    det.box(cx, y1 - ct / 2, z0 - 0.12, w + 0.3, ct, 0.24, trim);
    det.box(x1 + 0.12, y1 - ct / 2, cz, 0.24, ct, d + 0.3, trim);
    det.box(x0 - 0.12, y1 - ct / 2, cz, 0.24, ct, d + 0.3, trim);
    // Roof slab and parapet with coping; some parapets broken away.
    det.box(cx, y1 + 0.02, cz, w - 0.1, 0.06, d - 0.1, S.concrete(C.concreteDark, 0.8));
    const ph = 0.9;
    const parapet = (px: number, pz: number, sx: number, sz: number) => {
      det.box(px, y1 + ph / 2, pz, sx, ph, sz, wallC);
      det.box(px, y1 + ph + 0.04, pz, sx + 0.08, 0.08, sz + 0.08, trim);
    };
    const gap = hash2(Math.round(x0), Math.round(z0), 5) > 0.7;
    parapet(cx, z1 - 0.15, w, 0.3);
    if (gap) {
      parapet(x0 + w * 0.2, z0 + 0.15, w * 0.4, 0.3);
      parapet(x1 - w * 0.15, z0 + 0.15, w * 0.3, 0.3);
    } else parapet(cx, z0 + 0.15, w, 0.3);
    parapet(x1 - 0.15, cz, 0.3, d - 0.6);
    parapet(x0 + 0.15, cz, 0.3, d - 0.6);
    // Awnings over the shopfronts that face the boulevard.
    if (ground && shopFace) {
      const fx = shopFace === 'w' ? x0 : x1;
      const out = shopFace === 'w' ? -1 : 1;
      const bay = cell(d) * 2;
      const n = Math.max(1, Math.round(d / bay));
      for (let i = 0; i < n; i++) {
        const h = hash2(Math.round(fx * 3) + i, Math.round(z0), 41);
        if (h < 0.45) continue;
        const bz = z0 + (i + 0.5) * (d / n);
        const col = AWNING[Math.floor(h * 97) % AWNING.length];
        const torn = h > 0.8;
        det.box(fx + out * 0.65, 3.55, bz, 1.3, 0.04, d / n - 0.5, S.cloth(col, 0.8), 0, 0, out * -0.32);
        if (!torn) det.box(fx + out * 1.28, 3.28, bz, 0.03, 0.32, d / n - 0.5, S.cloth(col, 0.8));
        for (const dz of [-1, 1]) det.rod(fx, 3.75, bz + dz * (d / n / 2 - 0.3), fx + out * 1.3, 3.33, bz + dz * (d / n / 2 - 0.3), 0.015, S.metal(0x3a3a3a), 6);
      }
    }
  }

  /** Rooftop clutter: AC units, vents, a stair hut, sometimes a water tower or antenna mast. */
  private rooftop(det: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, seed: number, inset: number) {
    const r = (k: number) => hash2(Math.round(seed * 1000) + k * 13, k, 91);
    const w = x1 - x0 - inset * 2;
    const d = z1 - z0 - inset * 2;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const metal = S.metal(0x8a8e90, 0.75);
    const at = (k: number): [number, number] => [cx + (r(k) - 0.5) * (w - 3), cz + (r(k + 50) - 0.5) * (d - 3)];
    const nAc = 1 + Math.floor(r(1) * 3);
    for (let i = 0; i < nAc; i++) {
      const [ax, az] = at(10 + i);
      det.rbox(ax, y + 0.55, az, 1.4, 1.0, 1.1, 0.05, metal);
      det.cyl(ax, y + 1.07, az, 0.8, 0.06, 0.8, S.metal(0x2a2a2a, 0.6), 0, 0, 0, 16);
      for (let k = 0; k < 4; k++) det.box(ax, y + 1.1, az, 0.75, 0.02, 0.06, S.metal(0x5a5a5a), 0, (k / 4) * Math.PI, 0);
    }
    for (let i = 0; i < 3; i++) {
      const [vx, vz] = at(30 + i);
      det.cyl(vx, y + 0.4, vz, 0.3, 0.8, 0.3, S.metal(0x6a6e70, 0.8), 0, 0, 0, 10);
      det.add('cone12', vx, y + 0.9, vz, 0.42, 0.22, 0.42, S.metal(0x6a6e70, 0.8));
    }
    if (w > 6 && d > 6) {
      const [hx, hz] = at(40);
      det.rbox(hx, y + 1.3, hz, 2.6, 2.6, 2.2, 0.05, S.concrete(C.concrete, 0.7));
      det.box(hx, y + 2.68, hz, 2.9, 0.12, 2.5, S.concrete(C.concreteDark, 0.7));
      det.box(hx + 1.31, y + 1.0, hz, 0.03, 2.0, 0.9, S.paint(0x4a3a2e, 0.8));
    }
    if (r(2) > 0.62) {
      // Water tower on legs, timber tank with steel hoops.
      const [tx, tz] = at(60);
      for (const [lx, lz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) det.rod(tx + lx * 1.0, y, tz + lz * 1.0, tx + lx * 0.85, y + 3.2, tz + lz * 0.85, 0.06, S.steel(0x3a3c3e), 6);
      det.cyl(tx, y + 4.4, tz, 2.6, 2.4, 2.6, S.wood(0x6a5038, 0.8), 0, 0, 0, 16);
      for (const hy of [3.6, 4.4, 5.2]) det.torus(tx, y + hy, tz, 1.31, 0.03, S.steel(0x3a3c3e), Math.PI / 2, 0, 0, 5, 24);
      det.add('cone12', tx, y + 6.0, tz, 2.8, 0.9, 2.8, S.wood(0x4a3828, 0.8));
    }
    if (r(3) > 0.7) {
      const [mx, mz] = at(70);
      det.rod(mx, y, mz, mx, y + 7, mz, 0.05, metal, 6);
      for (let i = 0; i < 3; i++) det.rod(mx - 0.6, y + 4 + i * 1.1, mz, mx + 0.6, y + 4 + i * 1.1, mz, 0.02, metal, 5);
      det.lathe('roofDish', [[0, 0], [0.3, 0.05], [0.55, 0.18]], mx + 0.3, y + 2.6, mz, S.paint(0xd0d0c8, 0.6), Math.PI / 2 - 0.4, 0.8, 0, 14);
    }
  }

  /** Steel fire escape zig-zagging down one end wall. */
  private fireEscape(det: MeshBuilder, a: Aabb, seed: number) {
    const onPlusZ = seed > 0.7;
    const z = onPlusZ ? a.maxZ : a.minZ;
    const out = onPlusZ ? 1 : -1;
    const cx = (a.minX + a.maxX) / 2 + (seed - 0.5) * 4;
    const steel = S.paint(0x2a2a28, 0.85);
    const floors = Math.floor(a.y1 / 3.3);
    for (let f = 1; f < floors; f++) {
      const y = f * 3.3 + 0.9;
      det.box(cx, y, z + out * 0.6, 3.2, 0.05, 1.2, steel);
      det.box(cx, y + 0.95, z + out * 1.18, 3.2, 0.04, 0.04, steel);
      for (let i = 0; i <= 4; i++) det.rod(cx - 1.6 + i * 0.8, y, z + out * 1.18, cx - 1.6 + i * 0.8, y + 0.95, z + out * 1.18, 0.012, steel, 5);
      // Stair down to the platform below.
      const s = f % 2 ? 1 : -1;
      det.rod(cx + s * 1.3, y, z + out * 0.85, cx - s * 0.9, y - 3.3, z + out * 0.85, 0.03, steel, 5);
      det.rod(cx + s * 1.3, y + 0.9, z + out * 0.4, cx - s * 0.9, y - 2.4, z + out * 0.4, 0.015, steel, 5);
    }
    // The bottom ladder, retracted.
    det.rod(cx + 1.3, 1.5, z + out * 0.85, cx + 1.3, 4.2, z + out * 0.85, 0.02, steel, 5);
    det.rod(cx + 1.6, 1.5, z + out * 0.85, cx + 1.6, 4.2, z + out * 0.85, 0.02, steel, 5);
  }

  /** Sidewalk slabs and kerbs along the boulevard, interrupted at the cross streets. */
  private buildSidewalks(data: ChunkData) {
    const zc0 = data.cz * CHUNK;
    const zc1 = zc0 + CHUNK;
    const side = data.cx === 0 ? 1 : -1;
    const verts: number[] = [];
    const nors: number[] = [];
    const uvs: number[] = [];
    const tans: number[] = [];
    const idx: number[] = [];
    const kerb = new MeshBuilder();
    kerb.jitter = 0.05;
    const xa = side * (BOULEVARD_HALF + 0.22);
    const xb = side * (BOULEVARD_HALF + SIDEWALK);
    for (const blk of data.blocks) {
      const z0 = Math.max(zc0, blk.z0);
      const z1 = Math.min(zc1, blk.z1);
      if (z1 <= z0) continue;
      const base = verts.length / 3;
      const lo = Math.min(xa, xb);
      const hi = Math.max(xa, xb);
      verts.push(lo, 0.03, z0, hi, 0.03, z0, hi, 0.03, z1, lo, 0.03, z1);
      for (let i = 0; i < 4; i++) {
        nors.push(0, 1, 0);
        tans.push(1, 0, 0);
      }
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
      // Kerb stones with rounded corners at the street ends.
      kerb.rbox(side * (BOULEVARD_HALF + 0.11), 0.06, (z0 + z1) / 2, 0.22, 0.12, z1 - z0, 0.03, S.concrete(0x9a9890, 0.6));
      // Gutter grates every so often.
      for (let z = Math.ceil(z0 / 18) * 18; z < z1 - 1; z += 18) kerb.box(side * (BOULEVARD_HALF - 0.25), 0.025, z, 0.35, 0.02, 0.8, S.metal(0x1e1e1e, 0.8));
    }
    if (!idx.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setAttribute('rtan', new THREE.Float32BufferAttribute(tans, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.addMesh(g, pavingMaterial(), false, true);
    this.addMesh(kerb.build(), kitMaterial(), false, true);
  }

  private buildProps(data: ChunkData, mats: ChunkMaterials, city: boolean) {
    const b = new MeshBuilder();
    // Wasteland landmarks are drawn by the far landscape; a city has no such pass, so its few (the metro headhouse) are drawn here.
    const lm = city ? new MeshBuilder() : null;
    for (const p of data.props) {
      if (!LANDMARK_KINDS.has(p.kind)) appendProp(b, p);
      else if (lm) appendLandmark(lm, p);
    }
    if (lm && !lm.empty) this.addMesh(lm.build(), kitMaterial(), true, true);
    for (const a of data.aabbs) {
      if (a.kind === 'wall') this.wallProp(b, a);
      else if (a.kind === 'barricade') {
        // Barricades are separate meshes so they can be rammed or blown apart.
        const bb = new MeshBuilder();
        this.barricadeProp(bb, a);
        this.barricadeMeshes.set(a.id, this.addMesh(bb.build(), mats.props, true, true));
      }
    }
    if (!b.empty) this.addMesh(b.build(), mats.props, true, true);
  }

  /** Ruined wall: brick courses with a broken top, a few holes and rubble heaped at the base. */
  private wallProp(b: MeshBuilder, a: Aabb) {
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const h = a.y1;
    const along = w > d;
    const len = along ? w : d;
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    const brick = S.concrete(0x8a5240, 0.75);
    const brick2 = S.concrete(0x7a4636, 0.8);
    const n = Math.max(2, Math.round(len / 1.2));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const k = hash2(Math.round(cx * 7) + i, Math.round(cz * 7), 3);
      // Each section stands to a different height: a jagged, collapsed top.
      const top = h * (0.62 + k * 0.38);
      const x = along ? a.minX + t * w : cx;
      const z = along ? cz : a.minZ + t * d;
      const sw = len / n + 0.02;
      b.box(x, top / 2, z, along ? sw : w, top, along ? d : sw, k > 0.5 ? brick : brick2);
      // Courses: proud bands every 0.6 m.
      for (let y = 0.3; y < top - 0.2; y += 0.6) b.box(x, y, z, along ? sw : w + 0.03, 0.05, along ? d + 0.03 : sw, S.concrete(0x9a8a7a, 0.6));
      if (k > 0.75) b.add('ico1', x, top + 0.1, z, sw * 0.7, 0.3, (along ? d : w) * 1.1, brick2, 0, k * 6, 0);
    }
    // Rubble at the foot of the wall.
    for (let i = 0; i < Math.round(len / 2); i++) {
      const k = hash2(Math.round(cx) + i * 3, Math.round(cz), 9);
      const x = along ? a.minX + (i + 0.5) * (w / Math.round(len / 2)) : cx + (k > 0.5 ? 1 : -1) * (w / 2 + 0.4);
      const z = along ? cz + (k > 0.5 ? 1 : -1) * (d / 2 + 0.4) : a.minZ + (i + 0.5) * (d / Math.round(len / 2));
      b.add('ico1', x, 0.12, z, 0.7 + k * 0.5, 0.35, 0.6 + k * 0.4, k > 0.6 ? brick : S.concrete(C.concreteDark), 0, k * 9, 0);
    }
  }

  private barricadeProp(b: MeshBuilder, a: Aabb) {
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const flimsy = a.breakable === 'flimsy';
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    b.jitter = 0.07;
    if (flimsy) {
      // Scrap barricade: pallets, doors, crates and tyres lashed together.
      const n = Math.max(2, Math.round(w / 1.4));
      for (let i = 0; i < n; i++) {
        const x = a.minX + ((i + 0.5) / n) * w;
        const k = hash2(a.id, i, 11);
        const tilt = (k - 0.5) * 0.25;
        if (k < 0.33) {
          // Pallet on end.
          for (let s = 0; s < 5; s++) b.box(x - 0.5 + s * 0.25, 0.75, cz, 0.18, 1.5, 0.04, S.wood(k > 0.15 ? C.wood : C.woodDark, 0.8), 0, tilt * 0.5, tilt);
          b.box(x, 0.4, cz - 0.08, 1.2, 0.12, 0.08, S.wood(C.woodDark, 0.8), 0, tilt * 0.5, tilt);
          b.box(x, 1.2, cz - 0.08, 1.2, 0.12, 0.08, S.wood(C.woodDark, 0.8), 0, tilt * 0.5, tilt);
        } else if (k < 0.66) {
          // A door torn off a car or a house.
          b.rbox(x, 0.9, cz, 1.3, 1.7, 0.08, 0.04, S.paint(CAR_DOOR[Math.floor(k * 37) % CAR_DOOR.length], 0.9), 0.08, tilt, tilt);
        } else {
          crate(b, x, 0.45, cz, 0.9, 0.9, 0.9, k);
          spareTyre(b, x, 1.0, cz, 0.38, 0.22, Math.PI / 2, k * 3);
        }
      }
      b.rod(a.minX, 1.1, cz + 0.12, a.maxX, 1.0, cz + 0.12, 0.012, S.steel(0x5a5a5a, 0.7), 5);
      for (let i = 0; i < 3; i++) spareTyre(b, a.minX + (i + 0.5) * (w / 3), 0.12, cz + 0.5, 0.4, 0.24, 0, i);
    } else {
      // Reinforced: concrete jersey barriers capped with welded plate and razor wire.
      const n = Math.max(2, Math.round(w / 3));
      for (let i = 0; i < n; i++) {
        const x = a.minX + ((i + 0.5) / n) * w;
        b.extrude('jersey', () => {
          const s = new THREE.Shape();
          s.moveTo(-0.6, 0);
          s.lineTo(0.6, 0);
          s.lineTo(0.42, 0.28);
          s.lineTo(0.2, 1.3);
          s.lineTo(-0.2, 1.3);
          s.lineTo(-0.42, 0.28);
          s.closePath();
          return s;
        }, w / n - 0.06, 0.02, x, 0, cz, S.concrete(0xa8a49a, 0.7), 0, Math.PI / 2, 0);
        b.box(x, 0.7, cz + 0.45, w / n - 0.3, 0.12, 0.02, S.paint(C.signYellow, 0.8));
        plate(b, x, 2.05, cz, w / n - 0.1, 1.5, 0.05, i % 2 ? S.steel(0x4e5052, 0.9) : S.rust(C.rust2), 0, 0, 0);
      }
      // Razor wire coil along the top.
      const pts: [number, number, number][] = [];
      for (let i = 0; i <= w * 8; i++) {
        const t = i / (w * 8);
        const ang = t * w * 8 * 1.2;
        pts.push([a.minX + t * w, 2.95 + Math.sin(ang) * 0.18, cz + Math.cos(ang) * 0.18]);
      }
      b.pipe(pts, 0.008, S.steel(0x9a9ea2, 0.5), 4);
      for (let i = 0; i < 4; i++) b.tube(a.minX + (i + 0.5) * (w / 4) - 0.5, 0.3, cz + d * 0.4, a.minX + (i + 0.5) * (w / 4) + 0.5, 2.6, cz + d * 0.4, 0.14, S.steel(0x5a5d60, 0.8));
    }
  }

  private buildColliders(def: TerrainDef, x0: number, z0: number) {
    // Heightfield for the ground.
    this.colliders.push(this.phys.addHeightfield(x0, z0, CHUNK, CELLS, this.data.heights));
    for (const a of this.data.aabbs) {
      if (a.ramp) {
        const r = a.ramp;
        const rc = this.phys.addStaticTilted(r.x, r.y, r.z, r.hx, r.hy, r.hz, r.q, GROUPS.furn);
        this.colliders.push(rc);
        this.aabbColliders.set(a.id, rc);
        continue;
      }
      const hy = (a.y1 - a.y0) / 2;
      const c = this.phys.addStaticBox(
        (a.minX + a.maxX) / 2,
        (a.y1 + a.y0) / 2 + (a.kind === 'rock' ? 0 : 0),
        (a.minZ + a.maxZ) / 2,
        (a.maxX - a.minX) / 2,
        hy,
        (a.maxZ - a.minZ) / 2,
        0,
        a.kind === 'furniture' || a.kind === 'floor' ? GROUPS.furn : GROUPS.static,
      );
      this.colliders.push(c);
      this.aabbColliders.set(a.id, c);
    }
    void def;
  }

  removeAabb(id: number) {
    const bm = this.barricadeMeshes.get(id);
    if (bm) {
      bm.visible = false;
      this.barricadeMeshes.delete(id);
    }
    const c = this.aabbColliders.get(id);
    if (c) {
      this.phys.removeCollider(c);
      this.aabbColliders.delete(id);
      this.colliders = this.colliders.filter((q) => q !== c);
    }
  }

  dispose() {
    for (const c of this.colliders) this.phys.removeCollider(c);
    this.colliders = [];
    for (const g of this.geos) g.dispose();
    for (const im of this.instanced) im.dispose();
    this.group.removeFromParent();
  }
}

/** Base wall colours per facade style: panel concrete, brick, stucco, curtain wall. */
const FACADE_TINT: number[][] = [
  [0xb8b6ae, 0xa8a8a2, 0xc2bcb0, 0x9ea4a6],
  [0x9a5a44, 0x8a4c3a, 0xa86a50, 0x7e5244],
  [0xd2c6a8, 0xc8b8a0, 0xb8b0a0, 0xd8cbb8],
  [0x5a6670, 0x4e5a62, 0x66707a, 0x56626a],
];
const AWNING = [0x8a2a24, 0x2a5a3a, 0x2a4a6a, 0xa87a2a, 0x5a3a5a];
const CAR_DOOR = [0x8a4b2d, 0x5d7a8a, 0xc8c3b6, 0x6b6e5a];
