import type { LegDef } from '../data';
import { Rng, fbm2, noise2 } from '../core/rng';
import { clamp, smoothstep, lerp } from '../core/math';

export const CHUNK = 128;
export const CELL = 4; // heightfield resolution in metres
export const CELLS = CHUNK / CELL; // 32

export type Surface = 'asphalt' | 'hardpan' | 'sand' | 'mud';

export interface Ramp {
  z0: number;
  len: number;
  xOff: number;
  halfWidth: number;
  height: number;
  /** Gap between the lip and the plateau. */
  gap: number;
  plateauLen: number;
  plateauHalfWidth: number;
}

export interface Canyon {
  z0: number;
  z1: number;
  halfWidth: number;
}

export interface Minefield {
  z0: number;
  z1: number;
  halfWidth: number;
}

export interface TerrainDef {
  biome: 'wasteland' | 'city';
  seed: number;
  length: number;
  roadHalf: number;
  ramps: Ramp[];
  canyons: Canyon[];
  minefields: Minefield[];
  phase: [number, number, number, number];
}

export function makeTerrainDef(leg: LegDef): TerrainDef {
  const rng = new Rng(leg.seed);
  const def: TerrainDef = {
    biome: leg.biome,
    seed: leg.seed,
    length: leg.length,
    roadHalf: leg.biome === 'city' ? 7 : 4.2,
    ramps: [],
    canyons: [],
    minefields: [],
    phase: [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28)],
  };
  for (const s of leg.sets) {
    if (s.type === 'rampCache') {
      def.ramps.push({
        z0: s.at,
        len: 26,
        xOff: rng.range(-10, 10),
        halfWidth: 5.5,
        height: 2.7,
        gap: 12,
        plateauLen: 26,
        plateauHalfWidth: 10,
      });
    } else if (s.type === 'canyonAmbush') {
      def.canyons.push({ z0: s.at - 150, z1: s.at + 190, halfWidth: 38 });
    } else if (s.type === 'minefield') {
      def.minefields.push({ z0: s.at, z1: s.at + (s.length as number), halfWidth: 20 });
    }
  }
  return def;
}

/** Road centre-line x for a given z. Straight in cities, winding in the wastelands. */
export function roadX(def: TerrainDef, z: number): number {
  if (def.biome === 'city') return 0;
  const lead = smoothstep(0, 260, z);
  const [p1, p2] = def.phase;
  return lead * (46 * Math.sin(z / 330 + p1) + 20 * Math.sin(z / 141 + p2));
}

/** dx/dz of the road, for heading. */
export function roadSlope(def: TerrainDef, z: number): number {
  return (roadX(def, z + 1) - roadX(def, z - 1)) / 2;
}

export function roadElev(def: TerrainDef, z: number): number {
  if (def.biome === 'city') return 0;
  const lead = smoothstep(0, 200, z);
  const [, , p3, p4] = def.phase;
  return lead * (6 * Math.sin(z / 470 + p3) + 1.8 * Math.sin(z / 173 + p4));
}

/** Half-width of the open corridor at z: the wasteland is wide, canyons squeeze it. */
export function corridorHalf(def: TerrainDef, z: number): number {
  let w = def.biome === 'city' ? 150 : 170;
  for (const c of def.canyons) {
    const t = smoothstep(c.z0, c.z0 + 70, z) * (1 - smoothstep(c.z1 - 70, c.z1, z));
    if (t > 0) w = lerp(w, c.halfWidth + 6 * Math.sin(z / 23) + 4 * Math.sin(z / 9.7), t);
  }
  return w;
}

function rampHeight(r: Ramp, rx: number, z: number, xc: number): number {
  const u = (z - r.z0) / r.len;
  const dx = Math.abs(rx - xc);
  let h = 0;
  if (u >= 0 && u <= 1) {
    const s = smoothstep(r.halfWidth, r.halfWidth * 0.55, dx);
    h = r.height * Math.pow(u, 1.15) * s;
  } else if (u > 1) {
    // Sharp lip drop over about 6 m.
    const s = smoothstep(r.halfWidth, r.halfWidth * 0.55, dx);
    h = r.height * s * Math.max(0, 1 - ((u - 1) * r.len) / 6);
  }
  // Raised plateau holding the cache. It slopes down gently at the back so slower vehicles can still reach it.
  const pz0 = r.z0 + r.len + r.gap;
  const pz1 = pz0 + r.plateauLen;
  const pz2 = pz1 + 30;
  if (z >= pz0 - 3 && z <= pz2) {
    const lat = smoothstep(r.plateauHalfWidth + 3, r.plateauHalfWidth - 2, dx);
    const front = smoothstep(pz0 - 3, pz0 + 2, z);
    const back = 1 - smoothstep(pz1, pz2, z);
    h = Math.max(h, (r.height - 0.2) * lat * front * back);
  }
  return h;
}

/** Terrain height under (x, z). The same function drives meshes, colliders, props and AI. */
export function heightAt(def: TerrainDef, x: number, z: number): number {
  const rx = roadX(def, z);
  const re = roadElev(def, z);
  if (def.biome === 'city') {
    // Flat, with tall outer walls of rubble beyond the corridor.
    const d = Math.abs(x - rx);
    const wall = smoothstep(corridorHalf(def, z), corridorHalf(def, z) + 10, d);
    return wall * 40;
  }
  const dx = x - rx;
  const d = Math.abs(dx);
  const w = smoothstep(def.roadHalf + 1, def.roadHalf + 18, d);
  const dunes = 4.2 * fbm2(x / 78, z / 78, def.seed, 3) + 1.1 * fbm2(x / 19, z / 19, def.seed + 7, 2);
  let h = re + w * dunes;
  for (const r of def.ramps) {
    const xc = roadX(def, r.z0 + r.len) + r.xOff;
    const rh = rampHeight(r, x, z, xc);
    if (rh > 0) h = Math.max(h, re + rh);
  }
  // Cliff walls bound the corridor. They rise too steeply to climb.
  const ch = corridorHalf(def, z);
  const cliff = smoothstep(ch, ch + 11, d);
  h += cliff * (30 + 14 * noise2(x / 37, z / 37, def.seed + 3)) + Math.max(0, d - ch - 11) * 0.5;
  // Dead end beyond the last camp ground.
  const endWall = smoothstep(def.length + 150, def.length + 170, z);
  const startWall = 1 - smoothstep(-70, -50, z);
  h += (endWall + startWall) * 36;
  return h;
}

export function surfaceAt(def: TerrainDef, x: number, z: number): Surface {
  const rx = roadX(def, z);
  const d = Math.abs(x - rx);
  if (def.biome === 'city') return d < def.roadHalf ? 'asphalt' : Math.abs(Math.floor(z / 7)) % 9 === 0 ? 'asphalt' : 'hardpan';
  if (d < def.roadHalf) return 'asphalt';
  if (d < def.roadHalf + 3) return 'hardpan';
  const sand = noise2(x / 65 + 40, z / 65 - 11, def.seed + 21);
  if (sand > 0.64) return 'sand';
  const mud = noise2(x / 48 - 90, z / 48 + 33, def.seed + 45);
  if (mud > 0.76 && heightAt(def, x, z) < roadElev(def, z) + 0.8) return 'mud';
  return 'hardpan';
}

/** Terrain normal by central differences. */
export function normalAt(def: TerrainDef, x: number, z: number, out: [number, number, number] = [0, 1, 0]) {
  const e = 1.2;
  const hl = heightAt(def, x - e, z);
  const hr = heightAt(def, x + e, z);
  const hd = heightAt(def, x, z - e);
  const hu = heightAt(def, x, z + e);
  const nx = hl - hr;
  const nz = hd - hu;
  const ny = 2 * e;
  const m = Math.hypot(nx, ny, nz);
  out[0] = nx / m;
  out[1] = ny / m;
  out[2] = nz / m;
  return out;
}

/** Heights for one chunk in Rapier's column-major layout: index = col*(n+1)+row, col along x and row along z. */
export function chunkHeights(def: TerrainDef, cx: number, cz: number): Float32Array {
  const n = CELLS;
  const out = new Float32Array((n + 1) * (n + 1));
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  for (let c = 0; c <= n; c++) {
    for (let r = 0; r <= n; r++) out[c * (n + 1) + r] = heightAt(def, x0 + c * CELL, z0 + r * CELL);
  }
  return out;
}

export function inMinefield(def: TerrainDef, x: number, z: number): Minefield | null {
  for (const m of def.minefields) {
    if (z >= m.z0 && z <= m.z1 && Math.abs(x - roadX(def, z)) <= m.halfWidth) return m;
  }
  return null;
}

export const clampToCorridor = (def: TerrainDef, x: number, z: number) => {
  const rx = roadX(def, z);
  const h = corridorHalf(def, z) - 2;
  return clamp(x, rx - h, rx + h);
};
