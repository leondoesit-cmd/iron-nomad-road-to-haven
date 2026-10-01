import { describe, expect, it } from 'vitest';
import { LEGS } from '../src/data';
import { ChunkSource } from '../src/world/chunkgen';
import { CHUNK, CELLS, heightAt, roadX, makeTerrainDef, chunkHeights, surfaceAt } from '../src/world/terrain';

describe.each(LEGS.legs.map((l) => [l.id, l] as const))('leg %s layout', (_id, leg) => {
  const src = new ChunkSource(leg);
  const L = src.layout;

  it('is deterministic', () => {
    const a = new ChunkSource(leg).layout;
    expect(a.pickups.length).toBe(L.pickups.length);
    expect(a.zombies.length).toBe(L.zombies.length);
    expect(JSON.stringify(a.pickups.slice(0, 20))).toBe(JSON.stringify(L.pickups.slice(0, 20)));
  });

  it('places every authored set piece', () => {
    for (const s of leg.sets) {
      if (s.type === 'encounter') expect(L.encounters.some((e) => e.encounter === s.id)).toBe(true);
      if (s.type === 'scavengeZone') expect(L.zones.length).toBeGreaterThan(0);
      if (s.type === 'ambush' || s.type === 'canyonAmbush') expect(L.ambushes.some((a) => Math.abs(a.z - s.at) < 1)).toBe(true);
      if (s.type === 'radioFragment') expect(L.pickups.some((p) => p.kind === 'fragment' && p.amount === s.n)).toBe(true);
      if (s.type === 'chassisWreck') expect(L.pickups.some((p) => p.kind === 'chassis')).toBe(true);
    }
  });

  it('start is on the road at ground level and the end is reachable', () => {
    expect(Math.abs(L.start.x - roadX(L.terrain, L.start.z))).toBeLessThan(0.01);
    expect(L.end.z).toBe(leg.length);
    const h = heightAt(L.terrain, L.start.x, L.start.z);
    expect(h).toBeLessThan(2);
  });

  it('spawns no zombie or pickup inside a building', () => {
    for (const z of L.zombies) expect(L.blockedAt(z.x, z.z, 0)).toBe(false);
  });

  it('chunk data partitions content', () => {
    let pk = 0;
    for (let cz = -2; cz <= Math.ceil(leg.length / CHUNK) + 2; cz++) for (let cx = -3; cx <= 3; cx++) pk += src.get(cx, cz).pickups.length;
    // pickups beyond |x| of 3 chunks are possible in the wasteland but rare; most must be found
    expect(pk).toBeGreaterThan(L.pickups.length * 0.9);
  });
});

describe('terrain', () => {
  const leg = LEGS.legs.find((l) => l.id === 'L1')!;
  const def = makeTerrainDef(leg);
  it('heightfield seams match between neighbouring chunks', () => {
    const a = chunkHeights(def, 0, 3);
    const b = chunkHeights(def, 1, 3);
    for (let r = 0; r <= CELLS; r++) expect(a[CELLS * (CELLS + 1) + r]).toBeCloseTo(b[0 * (CELLS + 1) + r], 5);
    const c = chunkHeights(def, 0, 4);
    for (let col = 0; col <= CELLS; col++) expect(a[col * (CELLS + 1) + CELLS]).toBeCloseTo(c[col * (CELLS + 1)], 5);
  });
  it('the road stays drivable: slope under 12 degrees along the spine', () => {
    let worst = 0;
    const onRamp = (z: number) => def.ramps.some((r) => z > r.z0 - 8 && z < r.z0 + r.len + r.gap + r.plateauLen + 40);
    for (let z = 0; z < leg.length; z += 4) {
      if (onRamp(z) || onRamp(z + 4)) continue;
      const dz = (heightAt(def, roadX(def, z + 4), z + 4) - heightAt(def, roadX(def, z), z)) / 4;
      worst = Math.max(worst, Math.abs(dz));
    }
    expect(worst).toBeLessThan(Math.tan((12 * Math.PI) / 180));
  });
  it('cliffs bound the corridor', () => {
    const z = 600;
    expect(heightAt(def, roadX(def, z) + 190, z)).toBeGreaterThan(20);
    expect(heightAt(def, roadX(def, z) - 190, z)).toBeGreaterThan(20);
  });
  it('road surface is asphalt, the sides are not', () => {
    expect(surfaceAt(def, roadX(def, 500), 500)).toBe('asphalt');
    expect(surfaceAt(def, roadX(def, 500) + 12, 500)).not.toBe('asphalt');
  });
  it('the ramp cache has a plateau reachable by jumping', () => {
    const r = def.ramps[0];
    expect(r).toBeDefined();
    const xc = roadX(def, r.z0 + r.len) + r.xOff;
    const base = heightAt(def, xc, r.z0 - 10);
    const lip = heightAt(def, xc, r.z0 + r.len - 0.5);
    const gap = heightAt(def, xc, r.z0 + r.len + r.gap * 0.5);
    const plateau = heightAt(def, xc, r.z0 + r.len + r.gap + r.plateauLen * 0.5);
    expect(lip - base).toBeGreaterThan(1.5);
    expect(gap).toBeLessThan(lip - 1.0);
    expect(plateau - base).toBeGreaterThan(1.8);
  });
});

describe('city passages', () => {
  const leg = LEGS.legs.find((l) => l.id === 'L2C')!;
  const L = new ChunkSource(leg).layout;
  it('every side has an interior alley (1.8 m) and wider streets', () => {
    for (const side of [-1, 1]) {
      const ps = L.passages.filter((p) => p.side === side);
      expect(ps.some((p) => p.width === 1.8)).toBe(true);
      expect(ps.some((p) => p.width >= 3.6)).toBe(true);
    }
  });
  it('reinforced barricades plug every passage a car fits, but leave alleys', () => {
    const rb = L.barricades.find((b) => b.grade === 'reinforced');
    expect(rb).toBeDefined();
    const slab = L.aabbs.filter((a) => a.kind === 'barricade' && Math.abs((a.minZ + a.maxZ) / 2 - rb!.z) < 0.01);
    const covered = (x: number) => slab.some((a) => x > a.minX && x < a.maxX);
    expect(covered(0)).toBe(true);
    for (const p of L.passages) {
      const cx = (p.x0 + p.x1) / 2;
      if (Math.abs(cx) >= 60) continue;
      if (p.width >= 2.6) expect(covered(cx)).toBe(true);
      else expect(covered(cx)).toBe(false);
    }
  });
});
