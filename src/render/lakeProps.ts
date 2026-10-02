import * as THREE from 'three';
import { MeshBuilder, S } from './builder';
import { C } from './palette';
import type { PropKind } from '../world/layout';

/**
 * Landmarks of the lakes and the underground: piers, a lighthouse, a beached trawler, and the four ways down
 * (cave mouth, mine adit, bunker hatch, metro stairs). They stand on the far landscape like every other landmark,
 * so a pier or a lighthouse shows from across the water. Local frame: ground at y = 0, +Z toward the viewer's
 * approach (the way the entrance faces, or out over the water for a pier), metres.
 */

export const LAKE_KINDS = new Set<PropKind>(['dock', 'lighthouse', 'shipwreck', 'caveMouth', 'mineAdit', 'bunkerHatch', 'metroEntrance']);

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PLANK = [0x8a6a46, 0x7a5c3c, 0x6a4f34, 0x927350, 0x5e4630];

/** A pier: the deck top is y = 0, it starts 3.5 m up the beach (-Z) and reaches `len` metres over the water (+Z). */
export function dock(len: number, seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.07;
  const r = rng(seed + 5);
  const W = 2.6;
  const back = 3.5;
  const total = len + back;
  // Stringers under the planks, and cross beams where the pilings are.
  for (const x of [-1.0, 0, 1.0]) b.box(x, -0.2, (len - back) / 2, 0.16, 0.2, total, S.wood(0x4e3a26, 0.9));
  for (let z = -back; z < len; z += 0.235) {
    // A few planks have rotted away.
    if (r() < 0.035) continue;
    const tone = PLANK[Math.floor(r() * PLANK.length)];
    b.box((r() - 0.5) * 0.03, -0.05 + (r() - 0.5) * 0.012, z + 0.12, W + (r() - 0.5) * 0.08, 0.1, 0.205, S.wood(tone, 0.85), 0, (r() - 0.5) * 0.012, (r() - 0.5) * 0.02);
  }
  // Pilings: sunk deep, and every other pair rises into a mooring post.
  let n = 0;
  for (let z = 0.6; z < len; z += 3.6, n++) {
    for (const s of [-1, 1]) {
      const post = (n + (s > 0 ? 1 : 0)) % 2 === 0;
      const top = post ? 0.55 + r() * 0.1 : -0.08;
      const bot = -3.6;
      b.cyl(s * (W / 2 + 0.08), (top + bot) / 2, z, 0.3, top - bot, 0.3, S.wood(0x4a3a2a, 0.95), 0, 0, 0, 8);
      if (post) b.cyl(s * (W / 2 + 0.08), top + 0.02, z, 0.22, 0.05, 0.22, S.rubber(0x1d1812), 0, 0, 0, 8);
    }
    b.box(0, -0.3, z, W + 0.5, 0.16, 0.2, S.wood(0x4a3a2a, 0.9));
  }
  // Mooring cleats and a coil of rope.
  for (const z of [2.2, len - 2.4]) for (const s of [-1, 1]) b.box(s * (W / 2 - 0.12), 0.07, z, 0.22, 0.06, 0.07, S.steel(0x3a3c3e, 0.7));
  b.torus(0.5, 0.1, len - 3.4, 0.18, 0.05, S.cloth(0xa89a74, 0.7), Math.PI / 2, 0, 0, 5, 14);
  b.torus(0.5, 0.16, len - 3.4, 0.14, 0.05, S.cloth(0x9a8c68, 0.7), Math.PI / 2, 0, 0, 5, 14);
  // A lantern on the end post, and a ladder down the tip.
  const lz = len - 0.3;
  b.rod(1.38, 0.5, lz, 1.38, 1.9, lz, 0.045, S.wood(0x4a3a2a, 0.9), 6);
  b.rod(1.38, 1.85, lz, 1.0, 1.85, lz, 0.025, S.steel(0x3a3c3e, 0.7), 5);
  b.cyl(1.0, 1.6, lz, 0.22, 0.28, 0.22, S.glow(0xffd48a, 3), 0, 0, 0, 8);
  b.cyl(1.0, 1.8, lz, 0.28, 0.04, 0.28, S.steel(0x2a2a2c, 0.6), 0, 0, 0, 8);
  for (const s of [-0.35, 0.35]) b.rod(s, 0.05, len + 0.15, s, -2.0, len + 0.15, 0.03, S.steel(0x5a5d60, 0.7), 5);
  for (let y = -0.2; y > -1.9; y -= 0.32) b.rod(-0.35, y, len + 0.15, 0.35, y, len + 0.15, 0.02, S.steel(0x5a5d60, 0.7), 5);
  // Crates and a barrel at the root of the pier.
  b.box(-0.8, 0.3, 0.2, 0.7, 0.55, 0.7, S.wood(0x7a5e3a, 0.8), 0, 0.2, 0);
  b.cyl(0.6, 0.45, 0.5, 0.52, 0.8, 0.52, S.paint(0x5a6a4a, 0.85), 0, 0, 0, 10);
  return b;
}

/** A lighthouse about 24 m tall: banded tower, gallery, lantern room and a cap. Its base sits at y = 0. */
export function lighthouse(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.05;
  const r = rng(seed + 9);
  const H = 22;
  const radius = (y: number) => 3.2 - (y / H) * 1.25;
  const white = S.paint(0xd6d0c0, 0.75);
  const red = S.paint(0x9a3c2c, 0.8);
  b.cyl(0, 0.6, 0, 8.4, 1.2, 8.4, S.concrete(0x8a867c, 0.7), 0, 0, 0, 20);
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const y0 = (i / bands) * H;
    const y1 = ((i + 1) / bands) * H;
    b.frustum(0, (y0 + y1) / 2 + 0.6, 0, radius(y1), radius(y0), y1 - y0 + 0.02, i % 2 ? red : white, 0, 0, 0, 20);
    // Stringcourse where the colour changes.
    b.torus(0, y1 + 0.6, 0, radius(y1) + 0.04, 0.07, S.concrete(0x9a968a, 0.7), Math.PI / 2, 0, 0, 5, 24);
  }
  // Door, steps and narrow windows spiralling up the seaward side.
  b.box(0, 1.55, radius(1) + 0.01, 1.2, 2.0, 0.18, S.wood(0x4a3424, 0.8));
  b.box(0, 2.7, radius(1) + 0.02, 1.5, 0.2, 0.3, S.concrete(0x8a867c, 0.7));
  b.box(0, 0.4, 3.7, 2.4, 0.2, 1.0, S.concrete(0x8a867c, 0.7));
  for (let i = 0; i < 6; i++) {
    const y = 4 + i * 3;
    const a = 0.5 + i * 0.9;
    const rr = radius(y);
    b.box(Math.sin(a) * rr, y + 0.6, Math.cos(a) * rr, 0.34, 0.9, 0.34, S.glass(0x0b1218), 0, a, 0);
  }
  // Gallery.
  const gy = H + 0.6;
  b.cyl(0, gy, 0, 6.2, 0.32, 6.2, S.concrete(0x6e6a62, 0.7), 0, 0, 0, 20);
  b.torus(0, gy + 1.0, 0, 3.0, 0.035, S.steel(0x2a2c2e, 0.7), Math.PI / 2, 0, 0, 4, 28);
  b.torus(0, gy + 0.55, 0, 3.0, 0.03, S.steel(0x2a2c2e, 0.7), Math.PI / 2, 0, 0, 4, 28);
  for (let i = 0; i < 18; i++) {
    if (r() < 0.1) continue;
    const a = (i / 18) * Math.PI * 2;
    b.rod(Math.cos(a) * 3.0, gy + 0.1, Math.sin(a) * 3.0, Math.cos(a) * 3.0, gy + 1.0, Math.sin(a) * 3.0, 0.025, S.steel(0x2a2c2e, 0.7), 4);
  }
  // Lantern room: posts, a bright lens and a conical cap with a rod.
  b.cyl(0, gy + 1.25, 0, 3.6, 2.2, 3.6, S.glass(0x1e2d36), 0, 0, 0, 20);
  b.cyl(0, gy + 1.3, 0, 1.4, 1.4, 1.4, S.glow(0xfff0c0, 7), 0, 0, 0, 14);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.rod(Math.cos(a) * 1.8, gy + 0.15, Math.sin(a) * 1.8, Math.cos(a) * 1.8, gy + 2.4, Math.sin(a) * 1.8, 0.05, S.steel(0x2a2c2e, 0.7), 5);
  }
  b.cyl(0, gy + 2.5, 0, 4.1, 0.2, 4.1, S.steel(0x2a2c2e, 0.7), 0, 0, 0, 20);
  b.add('cone12', 0, gy + 3.5, 0, 4.0, 2.0, 4.0, S.paint(0x7a2e24, 0.7));
  b.rod(0, gy + 4.3, 0, 0, gy + 6.2, 0, 0.03, S.steel(0x4a4c4e, 0.6), 4);
  b.groundShade(0, 1.5, 0.3);
  return b;
}

/** A trawler thrown up on a beach, listing over, with her side stove in and the wheelhouse still standing. Centre at y = 0. */
export function shipwreck(seed: number): MeshBuilder {
  const r = rng(seed + 13);
  const hull = new MeshBuilder();
  hull.jitter = 0.06;
  const rust = S.rust(0x7a4a2c);
  const blue = S.paint(0x3a5a6a, 0.9);
  const white = S.paint(0xa8a496, 0.9);
  // Hull plates: a V-bottom body with flared sides, built from slabs so the stove-in section shows the ribs.
  const slab = (z: number, len: number, wTop: number, taper: number) => {
    hull.box(0, 0.35, z, wTop * 0.55 * taper, 0.18, len, rust);
    for (const s of [-1, 1]) {
      hull.box(s * wTop * 0.34 * taper, 1.25, z, 0.14, 2.1, len, s > 0 ? blue : rust, 0, 0, s * -0.22);
      hull.box(s * wTop * 0.47 * taper, 2.3, z, 0.18, 0.16, len, white, 0, 0, 0);
    }
  };
  slab(-3, 4.2, 4.6, 0.82);
  slab(0.9, 4, 4.6, 1);
  slab(4.6, 3.5, 4.6, 0.92);
  // The bow comes to a point.
  hull.box(0, 1.2, 7.6, 0.2, 2.3, 3.0, blue, 0, 0.4, 0);
  hull.box(0, 1.2, 7.6, 0.2, 2.3, 3.0, blue, 0, -0.4, 0);
  hull.add('cone6', 0, 1.15, 8.6, 0.5, 2.4, 0.5, rust, Math.PI / 2, 0, 0);
  // Ribs where the starboard side has been torn away.
  for (let i = 0; i < 7; i++) {
    const z = -1.6 + i * 0.75;
    hull.rod(1.6, 0.4, z, 2.2, 2.1, z, 0.045, S.rust(0x5a3a22), 5);
  }
  // Deck, hatch, wheelhouse and mast.
  hull.box(0, 2.15, -0.5, 4.0, 0.12, 12, S.wood(0x6a5238, 0.9));
  hull.box(0, 2.6, -3.4, 2.8, 0.9, 2.4, white);
  hull.box(0, 3.5, -3.6, 2.5, 1.5, 2.1, white);
  hull.box(0, 4.3, -3.6, 2.9, 0.12, 2.5, S.paint(0x7a2e24, 0.7));
  for (const x of [-0.8, 0.8]) hull.box(x, 3.6, -2.5, 0.6, 0.7, 0.05, S.glass(0x0c1318));
  hull.box(1.26, 3.5, -3.6, 0.05, 0.7, 0.9, S.glass(0x0c1318));
  hull.rod(0, 4.3, -3.6, 0.2, 7.6, -3.3, 0.06, S.steel(0x4a4c4e, 0.7), 6);
  hull.rod(0.2, 7.1, -3.3, 2.0, 7.0, -3.3, 0.035, S.steel(0x4a4c4e, 0.7), 5);
  // Winch, net, buoys and barrels.
  hull.cyl(0.4, 2.45, 3.0, 0.7, 0.5, 0.7, S.paint(0x5a5640, 0.8), 0, 0, 0, 10);
  for (let i = 0; i < 5; i++) hull.add('sphere', -1.0 + r() * 2, 2.4, 1.6 + r() * 3, 0.38, 0.38, 0.38, S.paint(i % 2 ? 0xc8442a : 0xd8d2c0, 0.7));
  for (let i = 0; i < 3; i++) hull.cyl(-1.4 + i * 0.5, 2.55, 4.4, 0.52, 0.8, 0.52, S.paint(0x5a6a4a, 0.85), 0, 0, 0, 10);
  // Lean the whole ship over and sink it into the sand.
  const out = new MeshBuilder();
  out.seed(seed);
  out.appendMatrix(hull, new THREE.Matrix4().compose(new THREE.Vector3(0, -0.7, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0, 0.22, 'YXZ')), new THREE.Vector3(1, 1, 1)));
  // Sand and spilled planks around the hull.
  out.add('ico1', 2.6, -0.1, 0.6, 2.4, 0.5, 9, S.concrete(0xb89a6a, 0.9), 0, 0.3, 0);
  for (let i = 0; i < 6; i++) out.box(-3 + r() * 6, 0.1, -4 + r() * 8, 0.16, 0.06, 1.8 + r(), S.wood(0x6a5238, 0.9), 0, r() * 3, 0.1);
  out.groundShade(0, 0.8, 0.3);
  return out;
}

const ROCK = [0x8a6a50, 0x7e6048, 0x9a7a5a, 0x6e5642, 0x95705a];

/** One angular, bedded rock: displaced, terraced into ledges at shared heights, then faceted. */
function rockAt(b: MeshBuilder, r: () => number, x: number, y: number, z: number, sx: number, sy: number, sz: number, tone: number) {
  const from = b.vertexCount;
  b.add('ico2', x, y, z, sx, sy, sz, S.rock(tone), (r() - 0.5) * 0.5, r() * 6.28, (r() - 0.5) * 0.5);
  const big = Math.max(sx, sz);
  const seed = Math.floor(x * 13 + z * 7 + y * 3 + 101);
  b.displace(big * 0.16, 0.7, seed, from);
  b.displace(big * 0.05, 2.2, seed + 5, from);
  b.terrace(0.7, 1.9, from);
  b.flatNormals(from);
}

/** A mass of rock filling a box: many mid-sized stones, denser low down, so the outline stays broken and craggy. */
function crag(b: MeshBuilder, r: () => number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n: number, size: number) {
  for (let i = 0; i < n; i++) {
    const t = r();
    const y = y0 + (y1 - y0) * t * t * 0.9 + size * 0.3;
    const k = 1 - ((y - y0) / Math.max(1, y1 - y0)) * 0.5;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const x = cx + (r() - 0.5) * (x1 - x0) * k;
    const z = cz + (r() - 0.5) * (z1 - z0) * k;
    const sz = size * (0.7 + r() * 0.7);
    rockAt(b, r, x, y, z, sz * (0.9 + r() * 0.5), sz * (0.55 + r() * 0.4), sz * (0.9 + r() * 0.5), ROCK[Math.floor(r() * ROCK.length)]);
  }
}

/** A cave mouth in a mound of rock: a low arch with a lintel stone, bones at the threshold and a lantern. */
export function caveMouth(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.07;
  const r = rng(seed + 17);
  // Left and right shoulders, a crown over the opening and the mass behind it.
  crag(b, r, -8.2, -2.1, 0, 6.4, -7, 1.2, 15, 3.8);
  crag(b, r, 2.1, 8.2, 0, 6.0, -7, 1.2, 15, 3.8);
  crag(b, r, -3.4, 3.4, 3.4, 6.8, -4, 0.2, 9, 3.2);
  crag(b, r, -9, 9, 0, 8.5, -11, -3, 22, 4.6);
  // Fallen stones in front.
  for (let i = 0; i < 7; i++) rockAt(b, r, -9 + r() * 18, 0.3, 2 + r() * 4.2, 0.9 + r() * 1.5, 0.6 + r() * 0.8, 0.9 + r() * 1.4, ROCK[Math.floor(r() * ROCK.length)]);
  // The opening: a dark recess, a lintel and two jamb stones.
  b.box(0, 1.75, -1.6, 3.4, 3.4, 0.3, S.rubber(0x040302));
  b.box(0, 3.55, -0.2, 4.2, 0.55, 2.4, S.rock(0x5a4636));
  for (const s of [-1, 1]) b.box(s * 1.95, 1.7, -0.2, 0.45, 3.4, 2.2, S.rock(0x5a4636));
  // Bones, a rusted lantern on a hook, and a warning cairn.
  for (let i = 0; i < 3; i++) b.add('sphere16', -1.2 + i * 1.1 + r() * 0.3, 0.1, 2.0 + r() * 1.0, 0.2, 0.16, 0.22, S.skin(C.bone), r(), r() * 6, 0);
  b.rod(2.4, 3.0, 1.0, 2.4, 2.2, 1.0, 0.02, S.steel(0x3a3c3e, 0.7), 4);
  b.cyl(2.4, 2.05, 1.0, 0.2, 0.3, 0.2, S.glow(0xffa24a, 3.5), 0, 0, 0, 8);
  b.groundShade(0, 1.2, 0.4);
  return b;
}

/** A mine adit: timber portal in a rock face, rails running into the dark, an ore cart and a spoil heap. */
export function mineAdit(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.08;
  const r = rng(seed + 19);
  crag(b, r, -10, -2.4, 0, 7.2, -8, 0.8, 18, 3.8);
  crag(b, r, 2.4, 10, 0, 6.8, -8, 0.8, 18, 3.8);
  crag(b, r, -4, 4, 3.6, 7.4, -5, -1, 10, 3.2);
  crag(b, r, -11, 11, 0, 9, -12, -4, 24, 4.8);
  for (let i = 0; i < 12; i++) rockAt(b, r, -5 + r() * 10, 0.35, 4.6 + r() * 3.4, 1 + r() * 1.4, 0.5 + r() * 0.6, 1 + r() * 1.3, 0x7a6248);
  const wood = S.wood(0x6a4c30, 0.9);
  const dark = S.wood(0x4a3422, 0.95);
  // Timber set: two posts, a cap beam, diagonal braces.
  for (const s of [-1, 1]) {
    b.box(s * 1.9, 1.65, 0.6, 0.42, 3.3, 0.42, wood, 0, 0, s * 0.03);
    b.box(s * 1.9, 1.65, -1.0, 0.36, 3.3, 0.36, dark);
    b.rod(s * 1.9, 0.9, 0.7, s * 1.1, 3.3, 0.7, 0.07, dark, 5);
  }
  b.box(0, 3.45, 0.6, 4.6, 0.42, 0.45, wood);
  b.box(0, 3.45, -1.0, 4.4, 0.36, 0.4, dark);
  b.box(0, 1.65, -1.9, 3.4, 3.2, 0.3, S.rubber(0x030201));
  // Rails and sleepers running out of the tunnel.
  for (const s of [-0.55, 0.55]) b.rod(s, 0.12, -1.6, s, 0.1, 9, 0.035, S.steel(0x5a5650, 0.7), 5);
  for (let z = -1.4; z < 9; z += 0.7) b.box(0, 0.07, z, 1.6, 0.08, 0.16, S.wood(0x4a3828, 0.95));
  // Ore cart, tipped over a little.
  b.rbox(0.0, 0.62, 5.2, 1.5, 0.8, 1.9, 0.06, S.rust(0x7a4a30), 0.05, 0.1, 0.18);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(sx * 0.62, 0.2, 5.2 + sz * 0.62, 0.34, 0.1, 0.34, S.steel(0x2a2a2c, 0.6), 0, 0, Math.PI / 2, 10);
  for (let i = 0; i < 7; i++) b.add('ico1', -0.5 + r() * 1.0, 1.0 + r() * 0.15, 4.6 + r() * 1.2, 0.35 + r() * 0.2, 0.25, 0.3 + r() * 0.2, S.rock(0x4a4642), 0, r() * 6, 0);
  // Warning sign on a post, and a hanging lamp.
  b.rod(-3.4, 0, 2.4, -3.4, 2.2, 2.4, 0.04, S.wood(0x4a3828, 0.9), 5);
  b.box(-3.4, 2.1, 2.45, 1.0, 0.7, 0.05, S.paint(0xc8a028, 0.7));
  b.box(-3.4, 2.1, 2.48, 0.7, 0.4, 0.02, S.paint(0x2a2018, 0.8));
  b.cyl(0, 3.0, 0.55, 0.22, 0.3, 0.22, S.glow(0xffb45a, 3.5), 0, 0, 0, 8);
  b.groundShade(0, 0.6, 0.35);
  return b;
}

/** A bunker hatch: a concrete headwall with a steel blast door, sandbags, vents and an antenna. */
export function bunkerHatch(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.05;
  const r = rng(seed + 23);
  const conc = S.concrete(0x8e8a80, 0.65);
  const dark = S.concrete(0x6e6a62, 0.7);
  // Earth-covered mound with a concrete face.
  b.add('ico2', 0, 1.0, -5.0, 16, 5, 12, S.concrete(0x9a8a6a, 0.9), 0, 0.4, 0);
  b.rbox(0, 2.1, -0.2, 8.4, 4.2, 1.2, 0.05, conc);
  b.rbox(0, 4.3, -0.2, 8.8, 0.4, 1.6, 0.04, dark);
  // The doorway, with a recessed steel door standing ajar.
  b.box(0, 1.5, 0.45, 2.7, 3.0, 0.4, dark);
  b.box(0, 1.35, 0.1, 2.2, 2.7, 0.3, S.rubber(0x040302));
  b.rbox(-1.5, 1.5, 0.85, 1.2, 2.6, 0.2, 0.03, S.steel(0x4e5a52, 0.8), 0, 0.9, 0);
  for (let i = 0; i < 4; i++) b.box(-1.5, 0.4 + i * 0.6, 0.95, 1.0, 0.1, 0.02, S.paint(0xd0b020, 0.7), 0, 0.9, 0.4);
  // Hazard bands and a stencilled number plate.
  for (let i = 0; i < 8; i++) b.box(-3.6 + i * 1.0, 3.9, 0.45, 0.5, 0.35, 0.02, S.paint(i % 2 ? 0x1a1a1a : 0xd0b020, 0.7), 0, 0, 0.6);
  b.box(3.0, 2.6, 0.45, 1.0, 0.6, 0.03, S.paint(0x2a3a2a, 0.8));
  // Sandbag walls either side of the approach.
  for (const s of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 5 - row; i++) {
        b.rbox(s * (3.2 + i * 0.95 + row * 0.45), 0.2 + row * 0.38, 2.2 + (r() - 0.5) * 0.1, 0.9, 0.34, 0.5, 0.12, S.cloth(r() > 0.5 ? 0x8a7a58 : 0x7a6c4c, 0.9), 0, (r() - 0.5) * 0.2, 0);
      }
    }
  }
  // Vent stacks and an antenna with a faded flag.
  for (const x of [-3.2, 3.4]) {
    b.cyl(x, 5.0, -2.2, 0.5, 1.4, 0.5, S.metal(0x6a6e70, 0.8), 0, 0, 0, 10);
    b.add('cone12', x, 5.9, -2.2, 0.8, 0.35, 0.8, S.metal(0x5a5e60, 0.8));
  }
  b.rod(2.2, 4.5, -1.6, 2.2, 10.5, -1.6, 0.03, S.steel(0x3a3c3e, 0.6), 4);
  b.box(2.5, 10.2, -1.6, 0.6, 0.35, 0.02, S.cloth(0xb04a2a, 0.7));
  b.cyl(0, 3.55, 0.7, 0.2, 0.18, 0.2, S.glow(0xff5a3a, 3), 0, 0, 0, 8);
  b.groundShade(0, 0.8, 0.3);
  return b;
}

/**
 * A metro headhouse: a tiled concrete kiosk over the stairs, standing on the pavement, with the stairwell as a dark
 * recess in its front face, a lit "M" sign on the roof and a ticket window on the flank. It stands inside the same
 * footprint as its colliders (walls either side of a 2.8 m doorway, 5.4 m deep).
 */
export function metroEntrance(seed: number): MeshBuilder {
  const b = new MeshBuilder();
  b.seed(seed);
  b.jitter = 0.04;
  const r = rng(seed + 31);
  const tile = S.concrete(0xb4b2a4, 0.55);
  const conc = S.concrete(0x8a8c8a, 0.6);
  const dark = S.concrete(0x4e504e, 0.7);
  const rail = S.steel(0x2e3032, 0.65);
  const blue = S.paint(0x1c6aa8, 0.5);
  // The two wings and the back block, with a plinth.
  for (const s of [-1, 1]) b.box(s * 2.15, 1.8, -2.3, 1.5, 3.6, 5.4, tile);
  b.box(0, 1.8, -3.3, 2.8, 3.6, 3.4, tile);
  b.box(0, 0.15, -2.3, 6.1, 0.3, 5.7, dark);
  // Roof slab overhanging the door, a parapet and a dark underside.
  b.box(0, 3.75, -1.9, 6.3, 0.3, 6.4, conc);
  b.box(0, 3.98, -1.9, 6.5, 0.16, 6.6, dark);
  b.box(0, 3.55, 0.35, 3.0, 0.14, 1.0, dark);
  // The stairwell: black void, a lit sign above it, a flight of steps dropping away and yellow-painted handrails.
  b.box(0, 1.6, -1.55, 2.8, 3.2, 0.2, S.rubber(0x020202));
  for (let i = 0; i < 4; i++) b.box(0, 0.32 - i * 0.07, 0.15 - i * 0.42, 2.7, 0.06, 0.4, dark);
  b.box(0, 3.3, 0.2, 2.2, 0.28, 0.06, S.glow(0xe8f4ff, 3.5));
  for (const s of [-1, 1]) {
    b.rod(s * 1.15, 1.05, 0.38, s * 1.15, 1.05, -1.2, 0.035, S.paint(0xd0b020, 0.6), 5);
    b.rod(s * 1.15, 0.0, 0.38, s * 1.15, 1.05, 0.38, 0.03, rail, 4);
  }
  // Window slots and a ticket hatch on the flanks.
  for (const s of [-1, 1]) for (const z of [-3.6, -1.6]) b.box(s * 2.93, 2.3, z, 0.05, 0.9, 1.1, S.glass(0x0c1318));
  b.box(-2.93, 1.15, -0.4, 0.06, 0.6, 1.0, S.glass(0x10181c));
  b.box(-2.96, 1.5, -0.4, 0.04, 0.05, 1.3, S.paint(0xd0b020, 0.7));
  // Roof sign: blue plate on two posts with a glowing M.
  for (const x of [-1.1, 1.1]) b.rod(x, 4.05, 0.3, x, 4.7, 0.3, 0.05, rail, 5);
  b.rbox(0, 5.2, 0.3, 2.4, 1.1, 0.16, 0.05, blue);
  const m = S.glow(0xf4faff, 4);
  b.rod(-0.7, 4.85, 0.4, -0.7, 5.55, 0.4, 0.06, m, 5);
  b.rod(0.7, 4.85, 0.4, 0.7, 5.55, 0.4, 0.06, m, 5);
  b.rod(-0.7, 5.55, 0.4, 0, 4.95, 0.4, 0.06, m, 5);
  b.rod(0.7, 5.55, 0.4, 0, 4.95, 0.4, 0.06, m, 5);
  // Litter and a dead bin by the door, so it reads as abandoned.
  b.rbox(2.1, 0.4, 1.0, 0.6, 0.8, 0.6, 0.08, S.rust(0x5a5a52), 0, r() * 0.4, 0);
  for (let i = 0; i < 5; i++) b.add('ico1', -2.2 + r() * 4.4, 0.04, 0.8 + r() * 1.8, 0.14 + r() * 0.12, 0.05, 0.12, S.cloth(r() > 0.5 ? 0x8a8a7a : 0x6a6a5e, 0.9), 0, r() * 6, 0);
  b.groundShade(0, 0.5, 0.3);
  return b;
}

/** Entry point for the landmark dispatcher: returns null for kinds this module does not draw. */
export function buildLakeLandmark(kind: PropKind, seed: number, tag: number): MeshBuilder | null {
  switch (kind) {
    case 'dock':
      return dock(Math.max(6, tag), seed);
    case 'lighthouse':
      return lighthouse(seed);
    case 'shipwreck':
      return shipwreck(seed);
    case 'caveMouth':
      return caveMouth(seed);
    case 'mineAdit':
      return mineAdit(seed);
    case 'bunkerHatch':
      return bunkerHatch(seed);
    case 'metroEntrance':
      return metroEntrance(seed);
    default:
      return null;
  }
}
