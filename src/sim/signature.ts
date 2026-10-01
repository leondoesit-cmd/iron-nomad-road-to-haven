import { ENEMIES } from '../data';

export const CELL = 16;
export const DECAY_PER_SEC = 40;

export interface SigSource {
  level: number;
  x: number;
  z: number;
  /** Which channel: Noise is heard in cities, Dust is seen in wastelands. */
  channel: 'noise' | 'dust';
}

/** Sense radius is 0.8 m per Noise point, halved indoors. */
export function hearingRadius(level: number, indoors: boolean) {
  return level * ENEMIES.zombieRules.senseRadiusPerPoint * (indoors ? ENEMIES.zombieRules.indoorFactor : 1);
}

/** Dust plume: visible at 3 m per point, halved in storms. */
export function dustRadius(level: number, storm: boolean) {
  return level * 3 * (storm ? 0.5 : 1);
}

/** 16 m spatial hash. Emitters write at 3 Hz; listeners do grid lookups instead of N-by-M distance checks. */
export class SignatureGrid {
  private cells = new Map<number, SigSource>();

  private key(cx: number, cz: number) {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  emit(x: number, z: number, level: number, channel: 'noise' | 'dust' = 'noise') {
    if (level <= 0) return;
    const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL));
    const c = this.cells.get(k);
    if (!c || level >= c.level) this.cells.set(k, { level, x, z, channel });
  }

  /** Loudest source this listener can hear. */
  loudestFor(x: number, z: number, indoors: boolean, channel: 'noise' | 'dust' = 'noise'): SigSource | null {
    const r = Math.ceil((100 * ENEMIES.zombieRules.senseRadiusPerPoint) / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: SigSource | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = this.cells.get(this.key(cx + dx, cz + dz));
        if (!c || c.channel !== channel) continue;
        const d = Math.hypot(c.x - x, c.z - z);
        if (d > hearingRadius(c.level, indoors)) continue;
        if (!best || c.level > best.level) best = c;
      }
    }
    return best;
  }

  /** Strongest source within a radius regardless of channel rules (used by raiders reading Dust). */
  strongestWithin(x: number, z: number, radius: number, channel: 'noise' | 'dust'): SigSource | null {
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: SigSource | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = this.cells.get(this.key(cx + dx, cz + dz));
        if (!c || c.channel !== channel) continue;
        if (Math.hypot(c.x - x, c.z - z) > radius) continue;
        if (!best || c.level > best.level) best = c;
      }
    }
    return best;
  }

  decay(dt: number) {
    for (const [k, c] of this.cells) {
      c.level -= DECAY_PER_SEC * dt;
      if (c.level <= 0) this.cells.delete(k);
    }
  }

  get size() {
    return this.cells.size;
  }

  clear() {
    this.cells.clear();
  }
}
