import type { LegDef, SetPiece, Stocks, ZombieKind } from '../data';
import { Rng, hash2 } from '../core/rng';
import { makeTerrainDef, roadX, heightAt, roadSlope, type TerrainDef } from './terrain';

export type AabbKind = 'building' | 'wall' | 'car' | 'rock' | 'barricade' | 'crate' | 'pillar' | 'tower';

/** Axis-aligned obstacle used by zombies, projectiles, camera and the Rapier collider builder. */
export interface Aabb {
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Base and top heights above ground. */
  y0: number;
  y1: number;
  kind: AabbKind;
  breakable?: 'flimsy' | 'reinforced';
  hp: number;
  /** Visual tint index for building variety. */
  tint?: number;
}

export type PropKind =
  | 'rock'
  | 'cairn'
  | 'deadTree'
  | 'wreck'
  | 'pole'
  | 'barrel'
  | 'tires'
  | 'sign'
  | 'bones'
  | 'tarp'
  | 'pylon'
  | 'crateStack'
  | 'shelf'
  | 'locker'
  | 'canopy'
  | 'dumpster'
  | 'streetlight'
  | 'rubble'
  | 'banner'
  | 'chain';

export interface PropSpawn {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  seed: number;
  /** Optional marker colour index. */
  tag?: number;
}

export type PickupKind = 'fuel' | 'scrap' | 'parts' | 'tech' | 'rations' | 'medicine' | 'ammo' | 'fragment' | 'chassis';
export interface PickupSpawn {
  id: string;
  kind: PickupKind;
  amount: number;
  x: number;
  y: number;
  z: number;
}

export interface ZombieSpawn {
  kind: ZombieKind;
  x: number;
  z: number;
  dormant: boolean;
  cluster: number;
}

export interface ScavContainer {
  id: string;
  x: number;
  z: number;
  depth: 0 | 1 | 2;
  loot: Partial<Stocks>;
  taken: boolean;
}

export interface ScavZone {
  id: string;
  kind: 'pharmacy' | 'depot' | 'parking' | 'hospital';
  x: number;
  z: number;
  w: number;
  d: number;
  /** Direction to the open side (towards the boulevard): +1 or -1 on x. */
  open: 1 | -1;
  containers: ScavContainer[];
}

export interface AmbushSpec {
  id: string;
  x: number;
  z: number;
  buggies: number;
  wagon: number;
  triggerRadius: number;
  canyon: boolean;
}

export interface EncounterSpot {
  id: string;
  encounter: string;
  x: number;
  z: number;
}

export interface TipSpot {
  id: string;
  tip: string;
  z: number;
}

export interface MineSpawn {
  x: number;
  z: number;
  id: number;
}

export interface Lot {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  side: -1 | 1;
  strip: number;
  slot: number;
  kind: 'building' | 'open' | 'zone';
}

export interface Passage {
  /** North-south passage spanning x0..x1 on one side. */
  x0: number;
  x1: number;
  width: number;
  side: -1 | 1;
}

export interface Slot {
  z0: number;
  z1: number;
  cross: number; // cross-street width after this block
}

export interface LegLayout {
  leg: LegDef;
  terrain: TerrainDef;
  slots: Slot[];
  /** Per side, the building strips (x ranges) and passages between them. */
  strips: { x0: number; x1: number; side: -1 | 1 }[];
  passages: Passage[];
  lots: Lot[];
  zones: ScavZone[];
  ambushes: AmbushSpec[];
  encounters: EncounterSpot[];
  tips: TipSpot[];
  mines: MineSpawn[];
  /** Hand-placed items by chunk key. */
  pickups: PickupSpawn[];
  props: PropSpawn[];
  zombies: ZombieSpawn[];
  aabbs: Aabb[];
  barricades: { z: number; grade: 'flimsy' | 'reinforced' }[];
  start: { x: number; z: number; yaw: number };
  end: { x: number; z: number; radius: number };
  campSpots: { x: number; z: number }[];
  blockedAt(x: number, z: number, r: number): boolean;
}

let nextId = 1;
export const newAabbId = () => nextId++;

const PASSAGE_WIDTHS = [1.8, 2.6, 3.6, 3.6, 5.0];
export const BOULEVARD_HALF = 7;
export const SIDEWALK = 3;

function pushZombies(layout: LegLayout, rng: Rng, x: number, z: number, count: number, kinds: ZombieKind[], spread: number, dormant: boolean, cluster: number) {
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * spread;
    const zx = x + Math.cos(a) * r;
    const zz = z + Math.sin(a) * r;
    if (layout.blockedAt(zx, zz, 0.8)) continue;
    layout.zombies.push({ kind: rng.pick(kinds), x: zx, z: zz, dormant, cluster });
  }
}

/** Builds everything that depends on the leg definition and is the same for every chunk. */
export function buildLayout(leg: LegDef): LegLayoutImpl {
  return new LegLayoutImpl(leg);
}

export class LegLayoutImpl implements LegLayout {
  leg: LegDef;
  terrain: TerrainDef;
  slots: Slot[] = [];
  strips: { x0: number; x1: number; side: -1 | 1 }[] = [];
  passages: Passage[] = [];
  lots: Lot[] = [];
  zones: ScavZone[] = [];
  ambushes: AmbushSpec[] = [];
  encounters: EncounterSpot[] = [];
  tips: TipSpot[] = [];
  mines: MineSpawn[] = [];
  pickups: PickupSpawn[] = [];
  props: PropSpawn[] = [];
  zombies: ZombieSpawn[] = [];
  aabbs: Aabb[] = [];
  barricades: { z: number; grade: 'flimsy' | 'reinforced' }[] = [];
  start = { x: 0, z: 10, yaw: 0 };
  end = { x: 0, z: 0, radius: 40 };
  campSpots: { x: number; z: number }[] = [];
  private lotGrid = new Map<number, Lot[]>();
  private rng: Rng;
  private pid = 0;

  constructor(leg: LegDef) {
    this.leg = leg;
    this.terrain = makeTerrainDef(leg);
    this.rng = new Rng(leg.seed * 7919 + 13);
    if (leg.biome === 'city') this.buildCityGrid();
    for (const s of leg.sets) this.place(s);
    this.end = { x: roadX(this.terrain, leg.length), z: leg.length, radius: 45 };
    this.start = { x: roadX(this.terrain, 12), z: 12, yaw: Math.atan2(roadSlope(this.terrain, 12), 1) };
    this.campSpots = [
      { x: this.end.x + 26, z: leg.length + 40 },
      { x: this.end.x - 26, z: leg.length + 40 },
    ];
    if (leg.biome === 'city') this.cityAmbient();
    else this.wastelandAmbient();
    // Later passes (parked cars, rocks) may overlap earlier spawns: nothing spawns inside an obstacle.
    this.zombies = this.zombies.filter((z) => !this.blockedAt(z.x, z.z, 0.3));
    this.pickups = this.pickups.filter((p) => !this.blockedAt(p.x, p.z, 0.2) || p.kind === 'fragment' || p.kind === 'chassis');
  }

  // ---------------------------------------------------------------- city grid

  private buildCityGrid() {
    const rng = new Rng(this.leg.seed ^ 0x5eed);
    // Z slots (blocks along the boulevard) with cross streets between.
    let z = -220;
    const zEnd = this.leg.length + 260;
    while (z < zEnd) {
      const bl = rng.range(34, 56);
      const cross = rng.pick([1.8, 2.6, 3.6, 5, 6, 8]);
      this.slots.push({ z0: z, z1: z + bl, cross });
      z += bl + cross;
    }
    // Strips and passages per side.
    for (const side of [-1, 1] as const) {
      let x = BOULEVARD_HALF + SIDEWALK;
      let i = 0;
      while (x < 148) {
        const w = rng.range(15, 27);
        const x1 = Math.min(x + w, 150);
        const sx0 = side === 1 ? x : -x1;
        const sx1 = side === 1 ? x1 : -x;
        this.strips.push({ x0: sx0, x1: sx1, side });
        x = x1;
        if (x >= 148) break;
        // The second gap on each side is always an interior alley so small vehicles have a way through.
        const gw = i === 1 ? 1.8 : rng.pick(PASSAGE_WIDTHS);
        const px0 = side === 1 ? x : -(x + gw);
        const px1 = side === 1 ? x + gw : -x;
        this.passages.push({ x0: px0, x1: px1, width: gw, side });
        x += gw;
        i++;
      }
    }
    // Lots: each strip x each slot.
    let si = 0;
    for (const strip of this.strips) {
      si++;
      const stripIndex = this.strips.filter((s) => s.side === strip.side).indexOf(strip);
      this.slots.forEach((slot, k) => {
        const roll = hash2(k, si * 13 + stripIndex, this.leg.seed);
        const kind: Lot['kind'] = roll < 0.74 ? 'building' : 'open';
        const lot: Lot = { x0: strip.x0, x1: strip.x1, z0: slot.z0, z1: slot.z1, side: strip.side, strip: stripIndex, slot: k, kind };
        this.lots.push(lot);
        this.indexLot(lot);
      });
    }
  }

  private indexLot(lot: Lot) {
    for (let gz = Math.floor(lot.z0 / 16); gz <= Math.floor(lot.z1 / 16); gz++) {
      const key = gz;
      let arr = this.lotGrid.get(key);
      if (!arr) this.lotGrid.set(key, (arr = []));
      arr.push(lot);
    }
  }

  /** True if a point (with radius) falls inside a solid building lot or an authored obstacle. */
  blockedAt(x: number, z: number, r: number): boolean {
    if (this.leg.biome === 'city') {
      const arr = this.lotGrid.get(Math.floor(z / 16));
      if (arr) {
        for (const l of arr) {
          if (l.kind !== 'building') continue;
          if (x > l.x0 - r && x < l.x1 + r && z > l.z0 - r && z < l.z1 + r) return true;
        }
      }
    }
    for (const a of this.aabbs) {
      if (x > a.minX - r && x < a.maxX + r && z > a.minZ - r && z < a.maxZ + r) return true;
    }
    return false;
  }

  slotNear(z: number): Slot {
    let best = this.slots[0];
    let bd = Infinity;
    for (const s of this.slots) {
      const c = (s.z0 + s.z1) / 2;
      const d = Math.abs(c - z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  private id(prefix: string) {
    return `${this.leg.id}:${prefix}${this.pid++}`;
  }

  // ---------------------------------------------------------------- authored set pieces

  private place(s: SetPiece) {
    const T = this.terrain;
    const rng = this.rng;
    const rxAt = (z: number) => roadX(T, z);
    const city = this.leg.biome === 'city';
    switch (s.type) {
      case 'tip':
        this.tips.push({ id: this.id('tip'), tip: String(s.id), z: s.at });
        break;
      case 'fuelCache': {
        const n = (s.count as number) ?? 2;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 14 + rng.range(-5, 5);
          const side = rng.sign();
          const x = rxAt(z) + side * rng.range(city ? 8 : 6, city ? 12 : 14);
          this.pickups.push({ id: this.id('f'), kind: 'fuel', amount: 5, x, z, y: heightAt(T, x, z) });
        }
        const wx = rxAt(s.at) + rng.sign() * 9;
        this.props.push({ kind: 'wreck', x: wx, y: heightAt(T, wx, s.at), z: s.at, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 9999) });
        break;
      }
      case 'scrapPile': {
        const n = (s.count as number) ?? 3;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 18 + rng.range(-8, 8);
          const x = rxAt(z) + rng.sign() * rng.range(9, 28);
          const y = heightAt(T, x, z);
          this.pickups.push({ id: this.id('s'), kind: 'scrap', amount: rng.int(14, 22), x, z, y });
          this.props.push({ kind: 'tires', x: x + 1.2, y, z: z + 0.8, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 9999) });
        }
        break;
      }
      case 'partsWreck': {
        const n = (s.count as number) ?? 3;
        for (let i = 0; i < n; i++) {
          const z = s.at + i * 22 + rng.range(-8, 8);
          const x = rxAt(z) + rng.sign() * rng.range(10, 34);
          const y = heightAt(T, x, z);
          this.props.push({ kind: 'wreck', x, y, z, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 9999) });
          this.pickups.push({ id: this.id('p'), kind: 'parts', amount: rng.int(9, 14), x: x + 2.2, z: z + 1.4, y });
          if (rng.chance(0.3)) this.pickups.push({ id: this.id('t'), kind: 'tech', amount: rng.int(1, 3), x: x - 2, z: z + 1, y });
        }
        break;
      }
      case 'radioFragment': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 11 : 16);
        const y = heightAt(T, x, s.at);
        this.props.push({ kind: 'pylon', x, y, z: s.at, yaw: 0, scale: 1, seed: 1, tag: 3 });
        this.pickups.push({ id: this.id('r'), kind: 'fragment', amount: (s.n as number) ?? 1, x, z: s.at + 2, y });
        break;
      }
      case 'chassisWreck': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 12 : 15);
        const y = heightAt(T, x, s.at);
        this.props.push({ kind: 'tarp', x, y, z: s.at, yaw: rng.range(-0.5, 0.5), scale: 1, seed: 7, tag: 1 });
        this.pickups.push({ id: this.id('c'), kind: 'chassis', amount: 1, x, z: s.at + 3, y });
        break;
      }
      case 'ambush':
      case 'canyonAmbush': {
        const canyon = s.type === 'canyonAmbush';
        const z = s.at;
        const x = rxAt(z);
        this.ambushes.push({
          id: this.id('a'),
          x,
          z,
          buggies: (s.buggies as number) ?? 2,
          wagon: (s.wagon as number) ?? 0,
          triggerRadius: canyon ? 170 : 150,
          canyon,
        });
        if (canyon) {
          // A spike strip across the road marks the choke.
          this.props.push({ kind: 'chain', x, y: heightAt(T, x, z), z, yaw: 0, scale: 1, seed: 2 });
        }
        if (typeof s.tip === 'string') this.tips.push({ id: this.id('tip'), tip: s.tip, z: s.at - 260 });
        break;
      }
      case 'minefield': {
        const len = s.length as number;
        const z0 = s.at;
        // Cairns mark the edges. Mines are scattered with room for a moped to thread through.
        let id = 0;
        for (let z = z0; z <= z0 + len; z += 5.5) {
          for (let k = 0; k < 2; k++) {
            const x = rxAt(z) + rng.range(-14, 14);
            if (rng.chance(0.55)) this.mines.push({ x, z: z + rng.range(-1.5, 1.5), id: id++ });
          }
        }
        for (let z = z0 - 18; z <= z0 + len + 18; z += 26) {
          for (const sgn of [-1, 1]) {
            const x = rxAt(z) + sgn * 20;
            this.props.push({ kind: 'cairn', x, y: heightAt(T, x, z), z, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 999) });
          }
        }
        break;
      }
      case 'rampCache': {
        const r = this.terrain.ramps.find((q) => q.z0 === s.at);
        if (r) {
          const xc = rxAt(r.z0 + r.len) + r.xOff;
          const cz = r.z0 + r.len + r.gap + r.plateauLen * 0.5;
          const cy = heightAt(T, xc, cz);
          this.props.push({ kind: 'crateStack', x: xc, y: cy, z: cz, yaw: 0, scale: 1.2, seed: 3, tag: 2 });
          this.pickups.push({ id: this.id('rc'), kind: 'scrap', amount: 34, x: xc - 1.5, z: cz, y: cy });
          this.pickups.push({ id: this.id('rc'), kind: 'parts', amount: 16, x: xc + 1.5, z: cz, y: cy });
          this.pickups.push({ id: this.id('rc'), kind: 'tech', amount: 4, x: xc, z: cz + 1.5, y: cy });
          this.props.push({ kind: 'sign', x: xc, y: heightAt(T, xc, r.z0 - 10), z: r.z0 - 10, yaw: 0, scale: 1, seed: 9, tag: 2 });
        }
        break;
      }
      case 'encounter': {
        const side = rng.sign();
        const x = rxAt(s.at) + side * (city ? 9.5 : 7.5);
        const y = heightAt(T, x, s.at);
        this.encounters.push({ id: this.id('e'), encounter: String(s.id), x, z: s.at });
        this.props.push({ kind: 'wreck', x: x + side * 2.5, y, z: s.at, yaw: 1.5, scale: 1, seed: rng.int(0, 99), tag: 5 });
        this.props.push({ kind: 'banner', x, y, z: s.at - 4, yaw: 0, scale: 1, seed: 1, tag: 4 });
        break;
      }
      case 'barricade': {
        const grade = (s.grade as 'flimsy' | 'reinforced') ?? 'flimsy';
        const slot = this.slotNear(s.at);
        const zc = (slot.z0 + slot.z1) / 2;
        this.barricades.push({ z: zc, grade });
        this.addBarricade(zc, grade);
        break;
      }
      case 'hordeStreet': {
        const z = s.at;
        const kinds: ZombieKind[] = ['walker', 'walker', 'runner'];
        for (let i = 0; i < 6; i++) pushZombies(this, rng, rxAt(z + i * 14) + rng.range(-3, 3), z + i * 14, rng.int(5, 8), kinds, 7, true, 1000 + (s.at as number) + i);
        pushZombies(this, rng, rxAt(z + 50), z + 50, 1, ['brute'], 2, true, 1099);
        pushZombies(this, rng, rxAt(z + 30), z + 30, 2, ['screamer'], 3, true, 1098);
        break;
      }
      case 'scavengeZone': {
        this.addZone(s);
        break;
      }
      default:
        break;
    }
  }

  private addBarricade(zc: number, grade: 'flimsy' | 'reinforced') {
    const T = this.terrain;
    const tint = grade === 'flimsy' ? 0 : 1;
    const t = 1.6; // slab thickness along z
    const span = (x0: number, x1: number) => {
      this.aabbs.push({
        id: newAabbId(),
        minX: x0,
        maxX: x1,
        minZ: zc - t / 2,
        maxZ: zc + t / 2,
        y0: 0,
        y1: grade === 'flimsy' ? 2.0 : 3.0,
        kind: 'barricade',
        breakable: grade,
        hp: grade === 'flimsy' ? 90 : 600,
        tint,
      });
    };
    if (T.biome === 'city') {
      span(-BOULEVARD_HALF - SIDEWALK, BOULEVARD_HALF + SIDEWALK);
      if (grade === 'reinforced') {
        // Welded steel also plugs every passage wide enough for a car. Only alleys stay open.
        for (const p of this.passages) {
          if (p.width >= 2.6 && Math.abs((p.x0 + p.x1) / 2) < 60) span(p.x0, p.x1);
        }
      } else {
        // Flimsy: just the boulevard and its service lanes.
        for (const p of this.passages) if (p.width >= 3.6 && Math.abs((p.x0 + p.x1) / 2) < 22 && Math.abs(p.x0) < 22) span(p.x0, p.x1);
      }
    } else {
      const rx = roadX(T, zc);
      span(rx - 14, rx + 14);
    }
  }

  private addZone(s: SetPiece) {
    const kind = (s.kind as ScavZone['kind']) ?? 'depot';
    const side = ((s.side as number) ?? 1) as 1 | -1;
    const slot = this.slotNear(s.at);
    // Use the boulevard-facing strip lot in this slot as the zone footprint.
    const lot = this.lots.find((l) => l.slot === this.slots.indexOf(slot) && l.side === side && l.strip === 0);
    if (!lot) return;
    lot.kind = 'zone';
    const w = lot.x1 - lot.x0;
    const d = lot.z1 - lot.z0;
    const cx = (lot.x0 + lot.x1) / 2;
    const cz = (lot.z0 + lot.z1) / 2;
    const rng = new Rng(this.leg.seed + Math.floor(s.at));
    const open = (side === 1 ? -1 : 1) as 1 | -1; // open face looks at the boulevard
    const zone: ScavZone = { id: this.id('z'), kind, x: cx, z: cz, w, d, open, containers: [] };
    const table: Record<ScavZone['kind'], (depth: number, r: Rng) => Partial<Stocks>> = {
      pharmacy: (d0, r) => ({ medicine: [1, 2, 3][d0] + (r.chance(0.3) ? 1 : 0), rations: d0 === 0 ? 1 : 0, tech: d0 === 2 && r.chance(0.5) ? 1 : 0 }),
      depot: (d0) => ({ scrap: [8, 14, 22][d0], parts: [2, 5, 9][d0], fuel: d0 === 2 ? 5 : 0 }),
      parking: (d0, r) => ({ parts: [4, 8, 14][d0], scrap: [4, 8, 12][d0], fuel: d0 === 1 && r.chance(0.6) ? 5 : 0, rations: d0 === 0 && r.chance(0.5) ? 1 : 0 }),
      hospital: (d0) => ({ medicine: [2, 4, 6][d0], tech: [1, 3, 5][d0], rations: d0 === 0 ? 2 : 0 }),
    };
    const nCont = 7 + rng.int(0, 2);
    for (let i = 0; i < nCont; i++) {
      const depth = (i < 2 ? 0 : i < 5 ? 1 : 2) as 0 | 1 | 2;
      // Depth runs from the open face inward along x.
      const frac = depth === 0 ? rng.range(0.1, 0.3) : depth === 1 ? rng.range(0.4, 0.6) : rng.range(0.7, 0.9);
      const px = side === 1 ? lot.x0 + frac * w : lot.x1 - frac * w;
      const pz = cz + rng.range(-0.38, 0.38) * d;
      zone.containers.push({ id: this.id('lc'), x: px, z: pz, depth, loot: table[kind](depth, rng), taken: false });
    }
    this.zones.push(zone);
    // Ruined walls on three sides (back and two flanks). The open face looks at the boulevard.
    const th = 0.6;
    const hgt = 4.2;
    const backX = side === 1 ? lot.x1 - th / 2 : lot.x0 + th / 2;
    const wall = (minX: number, maxX: number, minZ: number, maxZ: number, y1 = hgt) =>
      this.aabbs.push({ id: newAabbId(), minX, maxX, minZ, maxZ, y0: 0, y1, kind: 'wall', hp: 9999, tint: 2 });
    wall(backX - th / 2, backX + th / 2, lot.z0, lot.z1);
    // Flanks leave a gap so a person can slip in from the side streets.
    wall(lot.x0, lot.x1, lot.z0, lot.z0 + th);
    wall(lot.x0, lot.x1, lot.z1 - th, lot.z1);
    // A sign and a few shelves set the scene.
    const sx = side === 1 ? lot.x0 + 1 : lot.x1 - 1;
    this.props.push({ kind: 'sign', x: sx, y: 0, z: lot.z0 + 2, yaw: 0, scale: 1.3, seed: 1, tag: kind === 'pharmacy' ? 6 : kind === 'hospital' ? 7 : 5 });
    for (const c of zone.containers) {
      this.props.push({ kind: kind === 'pharmacy' || kind === 'hospital' ? 'shelf' : 'locker', x: c.x, y: 0, z: c.z, yaw: side === 1 ? Math.PI / 2 : -Math.PI / 2, scale: 1, seed: c.depth, tag: c.depth });
    }
    // Zombies lurk deeper in.
    const zr = new Rng(this.leg.seed * 31 + Math.floor(s.at));
    const kinds: ZombieKind[] = ['walker', 'walker', 'runner'];
    pushZombies(this, zr, cx, cz, 3 + this.leg.index, kinds, Math.min(w, d) * 0.4, true, 2000 + Math.floor(s.at));
    if (kind === 'hospital') {
      pushZombies(this, zr, cx, cz, 1, ['brute'], 3, true, 2999);
      pushZombies(this, zr, cx, cz, 1, ['bloater'], 3, true, 2998);
    }
  }

  // ---------------------------------------------------------------- ambient content

  private wastelandAmbient() {
    const rng = new Rng(this.leg.seed ^ 0xa11);
    const T = this.terrain;
    for (let z = 20; z < this.leg.length + 150; z += 11) {
      const rx = roadX(T, z);
      if (rng.chance(0.55)) {
        const x = rx + rng.sign() * rng.range(7, 120);
        const y = heightAt(T, x, z);
        const big = rng.chance(0.12);
        this.props.push({ kind: 'rock', x, y, z: z + rng.range(-5, 5), yaw: rng.range(0, 6.28), scale: big ? rng.range(2.4, 4.2) : rng.range(0.6, 1.6), seed: rng.int(0, 9999) });
        if (big) {
          const r = 1.4 * 3;
          this.aabbs.push({ id: newAabbId(), minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, y0: y - 1, y1: y + 4, kind: 'rock', hp: 9999 });
        }
      }
      if (rng.chance(0.12)) {
        const x = rx + rng.sign() * rng.range(8, 90);
        this.props.push({ kind: 'deadTree', x, y: heightAt(T, x, z), z, yaw: rng.range(0, 6.28), scale: rng.range(0.8, 1.5), seed: rng.int(0, 99) });
      }
      if (rng.chance(0.05)) {
        const x = rx + rng.sign() * rng.range(8, 70);
        this.props.push({ kind: 'bones', x, y: heightAt(T, x, z), z, yaw: rng.range(0, 6.28), scale: 1, seed: rng.int(0, 99) });
      }
      // Scrap shards on the roadside: low value, keeps the road rewarding to explore.
      if (rng.chance(0.09)) {
        const x = rx + rng.sign() * rng.range(7, 40);
        const y = heightAt(T, x, z);
        this.pickups.push({ id: this.id('rs'), kind: 'scrap', amount: rng.int(4, 8), x, z, y });
      }
      if (rng.chance(0.015)) {
        const x = rx + rng.sign() * rng.range(8, 36);
        this.pickups.push({ id: this.id('rf'), kind: 'fuel', amount: 5, x, z, y: heightAt(T, x, z) });
      }
    }
    // Roadside poles along the road.
    for (let z = 30; z < this.leg.length + 100; z += 60) {
      const x = roadX(T, z) + (Math.floor(z / 60) % 2 ? 6 : -6);
      this.props.push({ kind: 'pole', x, y: heightAt(T, x, z), z, yaw: rng.range(-0.1, 0.1), scale: 1, seed: 1 });
    }
    // A handful of wandering dead.
    for (let z = 300; z < this.leg.length; z += 340) {
      const rx = roadX(T, z);
      pushZombies(this, rng, rx + rng.range(-30, 30), z, rng.int(2, 4), ['walker'], 8, false, 3000 + z);
    }
  }

  private cityAmbient() {
    const rng = new Rng(this.leg.seed ^ 0xc17);
    const kinds: ZombieKind[] = ['walker', 'walker', 'walker', 'runner'];
    const index = this.leg.index;
    // Stalled cars along the boulevard form a slalom.
    for (let z = 30; z < this.leg.length + 120; z += 19) {
      if (rng.chance(0.45)) {
        const x = rng.range(-5.2, 5.2);
        const yaw = rng.range(-0.6, 0.6) + (rng.chance(0.5) ? Math.PI : 0);
        this.props.push({ kind: 'wreck', x, y: 0, z, yaw, scale: 1, seed: rng.int(0, 9999) });
        this.aabbs.push({ id: newAabbId(), minX: x - 1.0, maxX: x + 1.0, minZ: z - 2.2, maxZ: z + 2.2, y0: 0, y1: 1.5, kind: 'car', hp: 9999 });
      }
      if (rng.chance(0.2)) {
        const x = rng.sign() * (BOULEVARD_HALF + 1.6);
        this.props.push({ kind: 'streetlight', x, y: 0, z, yaw: x > 0 ? Math.PI : 0, scale: 1, seed: 1 });
      }
    }
    // Dormant clusters.
    let cluster = 5000;
    for (let z = 90; z < this.leg.length + 20; z += rng.range(36, 70)) {
      if (this.zones.some((q) => Math.abs(q.z - z) < 30)) continue;
      const x = rng.range(-6, 6) + (rng.chance(0.4) ? rng.sign() * rng.range(12, 40) : 0);
      const n = rng.int(3, 6) + index;
      pushZombies(this, rng, x, z, n, kinds, 6, true, cluster++);
      if (rng.chance(0.15 + index * 0.05)) pushZombies(this, rng, x, z, 1, ['screamer'], 3, true, cluster);
      if (rng.chance(0.12 + index * 0.04)) pushZombies(this, rng, x + 8, z, 1, ['bloater'], 3, true, cluster);
      if (rng.chance(0.08 + index * 0.03)) pushZombies(this, rng, x - 8, z, 1, ['brute'], 3, true, cluster);
      if (index >= 2 && rng.chance(0.15)) pushZombies(this, rng, x, z + 10, 1, ['stalker'], 2, false, cluster);
    }
    // Wanderers shuffling in the open.
    for (let z = 140; z < this.leg.length; z += 90) {
      pushZombies(this, rng, rng.range(-6, 6), z, rng.int(2, 3), kinds, 5, false, cluster++);
    }
    // Loose city loot on the sidewalks.
    for (let z = 40; z < this.leg.length; z += 33) {
      if (!rng.chance(0.5)) continue;
      const x = rng.sign() * rng.range(8, 11);
      const kind: PickupKind = rng.pick(['scrap', 'scrap', 'parts', 'rations', 'medicine']);
      const amount = kind === 'scrap' ? rng.int(5, 10) : kind === 'parts' ? rng.int(3, 6) : 1;
      this.pickups.push({ id: this.id('cl'), kind, amount, x, z, y: 0 });
    }
    // A few dumpsters and debris piles.
    for (let z = 25; z < this.leg.length + 60; z += 41) {
      const x = rng.sign() * rng.range(7.5, 9.5);
      this.props.push({ kind: rng.pick(['dumpster', 'rubble', 'barrel']), x, y: 0, z, yaw: rng.range(0, 6), scale: 1, seed: rng.int(0, 99) });
    }
    // Fuel and rations are rare in cities; a couple of canisters sit in side streets.
    for (let z = 200; z < this.leg.length; z += 380) {
      this.pickups.push({ id: this.id('cf'), kind: 'fuel', amount: 5, x: rng.sign() * rng.range(8, 10), z, y: 0 });
    }
  }
}

export function chunkKey(cx: number, cz: number) {
  return cx * 4096 + cz;
}
