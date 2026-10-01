import * as THREE from 'three';
import { shared } from './dispose';

/**
 * Procedural textures generated on the CPU into typed arrays: tileable gradient noise, Voronoi cells,
 * normal maps from height fields. Everything is lazy and cached, so importing this module touches no DOM.
 */

export type Field = Float32Array;

function perm(seed: number): Uint8Array {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = (seed >>> 0) || 1;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  return p;
}

const GX = new Float32Array(16);
const GY = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  GX[i] = Math.cos((i / 16) * Math.PI * 2);
  GY[i] = Math.sin((i / 16) * Math.PI * 2);
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Gradient noise in about [-0.7, 0.7] that wraps every `px` x `py` lattice cells (both at most 256). */
export function perlin(x: number, y: number, px: number, py: number, p: Uint8Array): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const x0 = ((xi % px) + px) % px;
  const y0 = ((yi % py) + py) % py;
  const x1 = (x0 + 1) % px;
  const y1 = (y0 + 1) % py;
  const g00 = p[p[x0] + y0] & 15;
  const g10 = p[p[x1] + y0] & 15;
  const g01 = p[p[x0] + y1] & 15;
  const g11 = p[p[x1] + y1] & 15;
  const n00 = GX[g00] * xf + GY[g00] * yf;
  const n10 = GX[g10] * (xf - 1) + GY[g10] * yf;
  const n01 = GX[g01] * xf + GY[g01] * (yf - 1);
  const n11 = GX[g11] * (xf - 1) + GY[g11] * (yf - 1);
  const u = fade(xf);
  const v = fade(yf);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

export interface FbmOpts {
  octaves?: number;
  gain?: number;
  /** Lattice cells across the tile on x and y for the first octave. */
  px?: number;
  py?: number;
  /** Absolute value per octave: sharp ridges and creases instead of soft bumps. */
  ridged?: boolean;
  seed?: number;
}

/** Tileable fractal noise normalised to [0, 1]. */
export function fbm(size: number, period: number, o: FbmOpts = {}): Field {
  const oct = o.octaves ?? 5;
  const gain = o.gain ?? 0.5;
  const px0 = o.px ?? period;
  const py0 = o.py ?? period;
  const out = new Float32Array(size * size);
  const perms: Uint8Array[] = [];
  for (let k = 0; k < oct; k++) perms.push(perm((o.seed ?? 1) * 131 + k * 977));
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amp = 1;
      let sum = 0;
      let f = 1;
      for (let k = 0; k < oct; k++) {
        const px = Math.min(256, px0 * f);
        const py = Math.min(256, py0 * f);
        let n = perlin((x / size) * px, (y / size) * py, px, py, perms[k]);
        if (o.ridged) n = 0.7 - Math.abs(n) * 2;
        sum += n * amp;
        amp *= gain;
        f *= 2;
      }
      out[y * size + x] = sum;
      if (sum < lo) lo = sum;
      if (sum > hi) hi = sum;
    }
  }
  const k = 1 / Math.max(1e-6, hi - lo);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k;
  return out;
}

export interface Cells {
  f1: Field;
  f2: Field;
  /** Random value per cell in [0, 1). */
  id: Field;
}

/** Tileable Voronoi: distance to the nearest and second nearest feature point (in cell units) and a cell id. */
export function voronoi(size: number, cells: number, seed: number, jitter = 0.9): Cells {
  const fx = new Float32Array(cells * cells);
  const fy = new Float32Array(cells * cells);
  const fid = new Float32Array(cells * cells);
  let s = (seed >>> 0) || 7;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < cells * cells; i++) {
    fx[i] = 0.5 + (rnd() - 0.5) * jitter;
    fy[i] = 0.5 + (rnd() - 0.5) * jitter;
    fid[i] = rnd();
  }
  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const id = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cells;
    const cy = Math.floor(gy);
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const cx = Math.floor(gx);
      let d1 = 9;
      let d2 = 9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          const wx = ((nx % cells) + cells) % cells;
          const wy = ((ny % cells) + cells) % cells;
          const k = wy * cells + wx;
          const dx = nx + fx[k] - gx;
          const dy = ny + fy[k] - gy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            best = fid[k];
          } else if (d < d2) d2 = d;
        }
      }
      const i = y * size + x;
      f1[i] = d1;
      f2[i] = d2;
      id[i] = best;
    }
  }
  return { f1, f2, id };
}

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, v: number) => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Normal (x, y) in [0, 1] encoding from a wrapping height field. */
function normalXY(h: Field, size: number, strength: number, i: number): [number, number] {
  const x = i % size;
  const y = (i / size) | 0;
  const l = h[y * size + ((x - 1 + size) % size)];
  const r = h[y * size + ((x + 1) % size)];
  const d = h[((y - 1 + size) % size) * size + x];
  const u = h[((y + 1) % size) * size + x];
  const nx = (l - r) * strength;
  const ny = (d - u) * strength;
  const m = 1 / Math.sqrt(nx * nx + ny * ny + 1);
  return [nx * m * 0.5 + 0.5, ny * m * 0.5 + 0.5];
}

function toTexture(bytes: Uint8Array, size: number, opts: { srgb?: boolean; h?: number } = {}): THREE.DataTexture {
  const t = new THREE.DataTexture(bytes, size, opts.h ?? size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return shared(t);
}

const cache = new Map<string, THREE.Texture>();
function cached<T extends THREE.Texture>(key: string, make: () => T): T {
  let t = cache.get(key) as T | undefined;
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

const b8 = (v: number) => Math.round(sat(v) * 255);

/**
 * Wear map shared by every hard-surface model: R broad grime, G fine speckle, B rust blotches, A vertical streaks.
 * Sampled triplanar in object space so vehicles, props and buildings never show a seam or a UV.
 */
export function grungeTexture(): THREE.DataTexture {
  return cached('grunge', () => {
    const S = 256;
    const broad = fbm(S, 3, { octaves: 6, seed: 11 });
    const fine = fbm(S, 24, { octaves: 3, seed: 12 });
    const blot = fbm(S, 5, { octaves: 5, seed: 13, gain: 0.6 });
    const cells = voronoi(S, 14, 14);
    const streak = fbm(S, 2, { octaves: 4, px: 40, py: 2, seed: 15 });
    const out = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      out[i * 4] = b8(sstep(0.25, 0.8, broad[i]));
      out[i * 4 + 1] = b8(fine[i]);
      out[i * 4 + 2] = b8(sstep(0.5, 0.78, blot[i] * 0.8 + (1 - cells.f1[i]) * 0.3));
      out[i * 4 + 3] = b8(sstep(0.35, 0.9, streak[i]));
    }
    return toTexture(out, S);
  });
}

/** Small surface bumps for hard surfaces: pits, dents and casting texture. */
export function detailNormalTexture(): THREE.DataTexture {
  return cached('detailN', () => {
    const S = 256;
    const a = fbm(S, 8, { octaves: 5, seed: 21 });
    const b = fbm(S, 32, { octaves: 3, seed: 22 });
    const cells = voronoi(S, 20, 23);
    const h = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) h[i] = a[i] * 0.55 + b[i] * 0.35 - (1 - sstep(0.0, 0.12, cells.f2[i] - cells.f1[i])) * 0.1;
    const out = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      const [nx, ny] = normalXY(h, S, 6, i);
      out[i * 4] = b8(nx);
      out[i * 4 + 1] = b8(ny);
      out[i * 4 + 2] = 255;
      out[i * 4 + 3] = b8(h[i]);
    }
    return toTexture(out, S);
  });
}

export interface TerrainTextures {
  /** (sand albedo, sand height, earth albedo, earth height) */
  a: THREE.DataTexture;
  /** (rock albedo, rock height, gravel albedo, gravel height) */
  b: THREE.DataTexture;
  /** normals: (sand nx, sand ny, earth nx, earth ny) */
  an: THREE.DataTexture;
  /** normals: (rock nx, rock ny, gravel nx, gravel ny) */
  bn: THREE.DataTexture;
}

/** Four ground materials packed two per texture: wind-rippled sand, cracked hardpan, layered rock and gravel. */
export function terrainTextures(): TerrainTextures {
  const a = cache.get('terrA') as THREE.DataTexture | undefined;
  if (a) return { a, b: cache.get('terrB') as THREE.DataTexture, an: cache.get('terrAN') as THREE.DataTexture, bn: cache.get('terrBN') as THREE.DataTexture };
  const S = 512;
  const N = S * S;
  // --- sand: wind ripples, warped, over soft grain
  const warp = fbm(S, 4, { octaves: 4, seed: 31 });
  const grain = fbm(S, 64, { octaves: 2, seed: 32 });
  const drift = fbm(S, 3, { octaves: 4, seed: 33 });
  const sandH = new Float32Array(N);
  const sandA = new Float32Array(N);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const u = x / S;
      const v = y / S;
      const ph = (u * 3 + v * 19 + warp[i] * 2.2) * Math.PI * 2;
      // Asymmetric ripple profile: long windward slope, short lee face.
      const s = (Math.sin(ph) * 0.5 + 0.5) ** 1.6;
      const r = s * (0.55 + drift[i] * 0.45);
      sandH[i] = r * 0.7 + grain[i] * 0.3;
      sandA[i] = 0.78 + r * 0.14 + (grain[i] - 0.5) * 0.12 + (drift[i] - 0.5) * 0.12;
    }
  }
  // --- earth: dried mud plates with cracks and scattered pebbles
  const plates = voronoi(S, 9, 41, 0.95);
  const small = voronoi(S, 26, 42, 0.95);
  const pebbles = voronoi(S, 48, 43, 0.8);
  const mottle = fbm(S, 6, { octaves: 5, seed: 44 });
  const earthH = new Float32Array(N);
  const earthA = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const edge = plates.f2[i] - plates.f1[i];
    const crack = 1 - sstep(0.0, 0.06 + mottle[i] * 0.05, edge);
    const edge2 = small.f2[i] - small.f1[i];
    const crack2 = (1 - sstep(0.0, 0.05, edge2)) * sstep(0.45, 0.7, mottle[i]);
    const dome = sstep(0.0, 0.35, edge) * 0.25;
    const peb = (1 - sstep(0.12, 0.3, pebbles.f1[i])) * sstep(0.55, 0.75, pebbles.id[i]);
    earthH[i] = 0.55 + dome + mottle[i] * 0.2 - crack * 0.55 - crack2 * 0.3 + peb * 0.25;
    earthA[i] = 0.8 + (mottle[i] - 0.5) * 0.2 + (plates.id[i] - 0.5) * 0.12 - crack * 0.45 - crack2 * 0.25 + peb * (pebbles.id[i] - 0.6) * 0.8;
  }
  // --- rock: strata bands, fractures and lichen-free weathering
  const rwarp = fbm(S, 3, { octaves: 5, seed: 51 });
  const rfine = fbm(S, 24, { octaves: 3, seed: 52, ridged: true });
  const rcell = voronoi(S, 7, 53, 0.9);
  const rockH = new Float32Array(N);
  const rockA = new Float32Array(N);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const band = (y / S) * 7 + rwarp[i] * 1.8;
      const f = band - Math.floor(band);
      const ledge = sstep(0.0, 0.18, f) * (1 - sstep(0.75, 1.0, f) * 0.6);
      const frac = 1 - sstep(0.0, 0.05, rcell.f2[i] - rcell.f1[i]);
      rockH[i] = ledge * 0.55 + rfine[i] * 0.35 - frac * 0.4 + rwarp[i] * 0.1;
      rockA[i] = 0.62 + ledge * 0.18 + (rfine[i] - 0.5) * 0.25 - frac * 0.35 + (Math.sin(band * 2.1) * 0.5 + 0.5) * 0.15;
    }
  }
  // --- gravel: packed stones
  const stones = voronoi(S, 36, 61, 0.9);
  const sfine = fbm(S, 32, { octaves: 2, seed: 62 });
  const gravH = new Float32Array(N);
  const gravA = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = stones.f1[i];
    const gap = stones.f2[i] - stones.f1[i];
    const stone = sstep(0.0, 0.14, gap);
    gravH[i] = stone * (0.55 + (1 - d) * 0.35) + sfine[i] * 0.1;
    gravA[i] = 0.35 + stone * (0.45 + (stones.id[i] - 0.5) * 0.5) + (sfine[i] - 0.5) * 0.1;
  }
  const pack = (p: Field, q: Field, r: Field, s: Field) => {
    const out = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      out[i * 4] = b8(p[i]);
      out[i * 4 + 1] = b8(q[i]);
      out[i * 4 + 2] = b8(r[i]);
      out[i * 4 + 3] = b8(s[i]);
    }
    return out;
  };
  const packN = (h1: Field, s1: number, h2: Field, s2: number) => {
    const out = new Uint8Array(N * 4);
    for (let i = 0; i < N; i++) {
      const [ax, ay] = normalXY(h1, S, s1, i);
      const [bx, by] = normalXY(h2, S, s2, i);
      out[i * 4] = b8(ax);
      out[i * 4 + 1] = b8(ay);
      out[i * 4 + 2] = b8(bx);
      out[i * 4 + 3] = b8(by);
    }
    return out;
  };
  const tA = toTexture(pack(sandA, sandH, earthA, earthH), S);
  const tB = toTexture(pack(rockA, rockH, gravA, gravH), S);
  const tAN = toTexture(packN(sandH, 5, earthH, 9), S);
  const tBN = toTexture(packN(rockH, 10, gravH, 8), S);
  cache.set('terrA', tA);
  cache.set('terrB', tB);
  cache.set('terrAN', tAN);
  cache.set('terrBN', tBN);
  return { a: tA, b: tB, an: tAN, bn: tBN };
}

/** Large-scale variation, sampled at a few hundred metres to break up tiling everywhere. */
export function macroTexture(): THREE.DataTexture {
  return cached('macro', () => {
    const S = 256;
    const a = fbm(S, 4, { octaves: 6, seed: 71 });
    const b = fbm(S, 8, { octaves: 4, seed: 72 });
    const c = fbm(S, 2, { octaves: 5, seed: 73 });
    const d = fbm(S, 16, { octaves: 3, seed: 74 });
    const out = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) {
      out[i * 4] = b8(a[i]);
      out[i * 4 + 1] = b8(b[i]);
      out[i * 4 + 2] = b8(c[i]);
      out[i * 4 + 3] = b8(d[i]);
    }
    return toTexture(out, S);
  });
}

// ------------------------------------------------------------------------------------------ road

export interface RoadTextures {
  /** sRGB albedo with paint. */
  map: THREE.DataTexture;
  /** (normal x, normal y, roughness, cavity) */
  surface: THREE.DataTexture;
  /** Metres covered by one repeat along the road. */
  repeatLen: number;
}

/**
 * Asphalt strip: U across the road, V along it. Aggregate, polished wheel tracks, crack networks with tar
 * sealant, patches, oil stains and worn paint. Built at roughly 3 cm per texel.
 */
export function roadTextures(kind: 'wasteland' | 'city'): RoadTextures {
  const key = `road:${kind}`;
  const hit = cache.get(key) as THREE.DataTexture | undefined;
  if (hit) return { map: hit, surface: cache.get(key + ':s') as THREE.DataTexture, repeatLen: 32 };
  const W = 256;
  const H = 1024;
  const N = W * H;
  let s = kind === 'city' ? 991 : 517;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  // Tileable fields at the road's aspect: build square noise and sample it with wrap.
  const n1 = fbm(256, 16, { octaves: 4, seed: s + 1 });
  const n2 = fbm(256, 4, { octaves: 5, seed: s + 2 });
  const agg = voronoi(256, 96, s + 3, 0.9);
  const at = (f: Field, u: number, v: number) => {
    const x = ((Math.floor(u * 256) % 256) + 256) % 256;
    const y = ((Math.floor(v * 256) % 256) + 256) % 256;
    return f[y * 256 + x];
  };
  const height = new Float32Array(N);
  const lum = new Float32Array(N);
  const rough = new Float32Array(N);
  const paintR = new Float32Array(N);
  const paintG = new Float32Array(N);
  const paintB = new Float32Array(N);
  const paintA = new Float32Array(N);
  const lanes = kind === 'city' ? [0.125, 0.375, 0.625, 0.875] : [0.25, 0.75];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = x / W;
      const v = y / H;
      // Sample square noise with 4 repeats along so features stay round.
      const nu = u;
      const nv = v * 4;
      const big = at(n2, nu, nv);
      const fine = at(n1, nu * 2, nv * 2);
      const stone = 1 - sstep(0.0, 0.12, at(agg.f2, nu * 2, nv * 2) - at(agg.f1, nu * 2, nv * 2));
      const stoneLight = at(agg.id, nu * 2, nv * 2);
      // Wheel tracks: darker and smoother.
      let track = 0;
      for (const c of lanes) {
        const half = kind === 'city' ? 0.06 : 0.11;
        for (const o of [-half, half]) {
          const d = Math.abs(u - (c + o));
          track = Math.max(track, 1 - sstep(0.015, 0.05, d));
        }
      }
      track *= 0.6 + big * 0.4;
      height[i] = 0.5 + (1 - stone) * 0.12 * (stoneLight - 0.3) + fine * 0.08 - track * 0.04;
      lum[i] = 0.24 + (stoneLight - 0.5) * 0.12 * (1 - stone) + (fine - 0.5) * 0.06 + (big - 0.5) * 0.1 - track * 0.05 - stone * 0.03;
      rough[i] = 0.86 + (fine - 0.5) * 0.1 - track * 0.22;
    }
  }
  // Cracks: random walks, sealed with glossy black tar on some.
  const crackCount = kind === 'city' ? 26 : 34;
  for (let c = 0; c < crackCount; c++) {
    let x = rnd() * W;
    let y = rnd() * H;
    let dir = rnd() < 0.5 ? Math.PI / 2 + (rnd() - 0.5) * 0.8 : (rnd() - 0.5) * 1.2;
    const len = 60 + rnd() * 260;
    const sealed = rnd() < 0.45;
    const width = sealed ? 2.2 + rnd() * 1.5 : 0.9 + rnd() * 0.8;
    for (let k = 0; k < len; k++) {
      dir += (rnd() - 0.5) * 0.5;
      x += Math.cos(dir);
      y += Math.sin(dir);
      if (rnd() < 0.015) {
        // Branch: a short side crack.
        let bx = x;
        let by = y;
        let bd = dir + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.6);
        for (let j = 0; j < 30 + rnd() * 40; j++) {
          bd += (rnd() - 0.5) * 0.6;
          bx += Math.cos(bd);
          by += Math.sin(bd);
          stamp(bx, by, 0.8, -0.35, sealed);
        }
      }
      stamp(x, y, width, sealed ? 0.05 : -0.4, sealed);
    }
  }
  function stamp(cx: number, cy: number, r: number, depth: number, sealed: boolean) {
    const r2 = r * r;
    for (let oy = -Math.ceil(r); oy <= Math.ceil(r); oy++) {
      for (let ox = -Math.ceil(r); ox <= Math.ceil(r); ox++) {
        const d2 = ox * ox + oy * oy;
        if (d2 > r2) continue;
        const px = ((Math.round(cx + ox) % W) + W) % W;
        const py = ((Math.round(cy + oy) % H) + H) % H;
        const i = py * W + px;
        const k = 1 - d2 / (r2 + 0.01);
        if (sealed) {
          lum[i] = Math.min(lum[i], 0.09 + (1 - k) * 0.05);
          rough[i] = Math.min(rough[i], 0.35);
          height[i] = Math.max(height[i], 0.5 + k * 0.05);
        } else {
          lum[i] *= 1 - 0.55 * k;
          height[i] = Math.min(height[i], 0.5 + depth * k);
        }
      }
    }
  }
  // Patches: rectangles of newer, darker asphalt with a seam.
  const patches = kind === 'city' ? 5 : 4;
  for (let p = 0; p < patches; p++) {
    const pw = 30 + rnd() * 70;
    const ph = 40 + rnd() * 160;
    const px0 = rnd() * (W - pw);
    const py0 = rnd() * H;
    const tone = 0.7 + rnd() * 0.15;
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const px = Math.floor(px0 + x);
        const py = Math.floor(py0 + y) % H;
        const i = py * W + px;
        const edge = Math.min(x, y, pw - x, ph - y);
        lum[i] *= edge < 1.5 ? 0.6 : tone;
        rough[i] = edge < 1.5 ? 0.6 : rough[i] * 0.95;
        height[i] += edge < 1.5 ? -0.05 : 0.02;
      }
    }
  }
  // Oil and rubber stains near the lane centres.
  for (let k = 0; k < 14; k++) {
    const lc = lanes[Math.floor(rnd() * lanes.length)];
    const cx = (lc + (rnd() - 0.5) * 0.08) * W;
    const cy = rnd() * H;
    const r = 6 + rnd() * 14;
    for (let oy = -r * 2; oy <= r * 2; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const d = Math.hypot(ox / r, oy / (r * 2));
        if (d > 1) continue;
        const px = ((Math.round(cx + ox) % W) + W) % W;
        const py = ((Math.round(cy + oy) % H) + H) % H;
        const i = py * W + px;
        const k2 = (1 - d) ** 1.5 * 0.5;
        lum[i] *= 1 - k2;
        rough[i] -= k2 * 0.35;
      }
    }
  }
  // Paint: worn, chipped, with gaps where the aggregate shows through.
  const line = (u0: number, u1: number, r: number, g: number, b: number, dash?: [number, number], wear = 0.35) => {
    const x0 = Math.floor(u0 * W);
    const x1 = Math.ceil(u1 * W);
    for (let y = 0; y < H; y++) {
      if (dash) {
        const m = y % (dash[0] + dash[1]);
        if (m >= dash[0]) continue;
      }
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        const chip = at(n1, x / W * 3, (y / H) * 12) * 0.6 + at(n2, x / W, (y / H) * 4) * 0.4;
        const a = sstep(wear, wear + 0.18, chip);
        if (a <= paintA[i]) continue;
        paintR[i] = r;
        paintG[i] = g;
        paintB[i] = b;
        paintA[i] = a;
      }
    }
  };
  if (kind === 'wasteland') {
    line(0.035, 0.05, 0.86, 0.84, 0.78, undefined, 0.3);
    line(0.95, 0.965, 0.86, 0.84, 0.78, undefined, 0.3);
    line(0.488, 0.512, 0.9, 0.68, 0.16, [96, 160], 0.4);
  } else {
    line(0.015, 0.028, 0.86, 0.84, 0.78, undefined, 0.35);
    line(0.972, 0.985, 0.86, 0.84, 0.78, undefined, 0.35);
    line(0.486, 0.496, 0.9, 0.7, 0.18, undefined, 0.3);
    line(0.504, 0.514, 0.9, 0.7, 0.18, undefined, 0.3);
    line(0.245, 0.256, 0.84, 0.82, 0.78, [96, 160], 0.42);
    line(0.744, 0.755, 0.84, 0.82, 0.78, [96, 160], 0.42);
  }
  const map = new Uint8Array(N * 4);
  const surf = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const a = paintA[i];
    // Paint sits proud of the surface, is brighter and a little smoother.
    const l = lum[i];
    map[i * 4] = b8(l * (1 - a) + paintR[i] * a * (0.75 + l));
    map[i * 4 + 1] = b8(l * (1 - a) + paintG[i] * a * (0.75 + l));
    map[i * 4 + 2] = b8(l * 1.03 * (1 - a) + paintB[i] * a * (0.75 + l));
    map[i * 4 + 3] = 255;
    height[i] += a * 0.05;
    rough[i] = rough[i] * (1 - a) + 0.7 * a;
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const l = height[y * W + ((x - 1 + W) % W)];
      const r = height[y * W + ((x + 1) % W)];
      const d = height[((y - 1 + H) % H) * W + x];
      const u = height[((y + 1) % H) * W + x];
      const nx = (l - r) * 7;
      const ny = (d - u) * 7;
      const m = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      surf[i * 4] = b8(nx * m * 0.5 + 0.5);
      surf[i * 4 + 1] = b8(ny * m * 0.5 + 0.5);
      surf[i * 4 + 2] = b8(rough[i]);
      surf[i * 4 + 3] = b8(sstep(0.3, 0.55, height[i]));
    }
  }
  const tm = toTexture(map, W, { srgb: true, h: H });
  const ts = toTexture(surf, W, { h: H });
  tm.wrapS = ts.wrapS = THREE.ClampToEdgeWrapping;
  cache.set(key, tm);
  cache.set(key + ':s', ts);
  return { map: tm, surface: ts, repeatLen: 32 };
}

// ------------------------------------------------------------------------------------------ sprites

/** Alpha-tested dry grass: a fan of bent blades with seed heads. RGB is tint-ready (near white), A is coverage. */
export function grassTexture(): THREE.Texture {
  return cached('grass', () => {
    const S = 256;
    const out = new Uint8Array(S * S * 4);
    let s = 4242;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const blades = 46;
    for (let b = 0; b < blades; b++) {
      const base = 0.18 + rnd() * 0.64;
      const lean = (rnd() - 0.5) * 0.9;
      const height = 0.45 + rnd() * 0.52;
      const width = 2.2 + rnd() * 2.8;
      const shade = 0.55 + rnd() * 0.45;
      const head = rnd() < 0.25;
      const steps = 120;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const cx = (base + lean * t * t * 0.6) * S;
        const cy = S - 1 - t * height * S;
        const w = width * (1 - t * 0.85) * (head && t > 0.8 ? 1.8 : 1);
        for (let ox = -Math.ceil(w); ox <= Math.ceil(w); ox++) {
          const px = Math.round(cx + ox);
          const py = Math.round(cy);
          if (px < 0 || px >= S || py < 0 || py >= S) continue;
          const i = (py * S + px) * 4;
          const edge = 1 - Math.abs(ox) / (w + 0.5);
          const l = (0.5 + 0.5 * t) * shade * (0.85 + edge * 0.15);
          out[i] = b8(l);
          out[i + 1] = b8(l * 0.97);
          out[i + 2] = b8(l * 0.86);
          out[i + 3] = Math.max(out[i + 3], b8(edge * 3));
        }
      }
    }
    // Bleed colour into transparent texels so mipmaps don't darken the edges.
    for (let i = 0; i < S * S; i++) {
      if (out[i * 4 + 3] === 0) {
        out[i * 4] = 150;
        out[i * 4 + 1] = 140;
        out[i * 4 + 2] = 115;
      }
    }
    const t = toTexture(out, S, { srgb: true });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Soft billowing puff for smoke and dust: noisy alpha with a round falloff. */
export function smokeTexture(): THREE.Texture {
  return cached('smoke', () => {
    const S = 128;
    const n = fbm(S, 4, { octaves: 5, seed: 81 });
    const m = fbm(S, 8, { octaves: 3, seed: 82 });
    const out = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const dx = x / S - 0.5;
        const dy = y / S - 0.5;
        const r = Math.sqrt(dx * dx + dy * dy) * 2;
        const fall = sat(1 - r) ** 1.4;
        const a = sat(fall * (0.45 + n[i] * 0.9) - (1 - fall) * 0.2);
        const l = 0.75 + n[i] * 0.2 + m[i] * 0.1 - r * 0.15;
        out[i * 4] = b8(l);
        out[i * 4 + 1] = b8(l);
        out[i * 4 + 2] = b8(l);
        out[i * 4 + 3] = b8(a);
      }
    }
    const t = toTexture(out, S);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}
