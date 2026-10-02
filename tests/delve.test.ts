import { describe, expect, it } from 'vitest';
import { CELL, cellOf, floorAt, generateDelve, wallColliders, type DelveMap } from '../src/world/delve';
import type { DelveTheme } from '../src/world/delveSites';
import { LEGS } from '../src/data';
import { buildLayout } from '../src/world/layout';

const THEMES: DelveTheme[] = ['cave', 'mine', 'bunker', 'metro'];
const SEEDS = [1, 7, 42, 311, 4096, 9999, 25123, 77777];

/** Flood the floor from a point, treating door cells as walls when asked. */
function flood(m: DelveMap, from: { x: number; z: number }, blockDoors: boolean): Set<number> {
  const seen = new Set<number>();
  const [si, sj] = cellOf(m, from.x, from.z);
  const blocked = (i: number, j: number) => {
    if (!blockDoors) return false;
    const x = (i - m.w / 2) * CELL + 1;
    const z = (j - m.h / 2) * CELL + 1;
    return m.doors.some((d) => Math.abs(x - d.x) <= d.w / 2 + 1 && Math.abs(z - d.z) <= d.d / 2 + 1 && Math.abs(x - d.x) <= (d.w > d.d ? d.w / 2 : 1) && Math.abs(z - d.z) <= (d.d > d.w ? d.d / 2 : 1));
  };
  const stack = [[si, sj]];
  seen.add(sj * m.w + si);
  while (stack.length) {
    const [i, j] = stack.pop()!;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di;
      const nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= m.w || nj >= m.h) continue;
      const k = nj * m.w + ni;
      if (!m.grid[k] || seen.has(k) || blocked(ni, nj)) continue;
      seen.add(k);
      stack.push([ni, nj]);
    }
  }
  return seen;
}

const reach = (m: DelveMap, set: Set<number>, p: { x: number; z: number }) => {
  const [i, j] = cellOf(m, p.x, p.z);
  return set.has(j * m.w + i);
};

describe.each(THEMES)('delve generator: %s', (theme) => {
  for (const seed of SEEDS) {
    for (const tier of [1, 3]) {
      it(`seed ${seed} tier ${tier}: a connected, populated place`, () => {
        const m = generateDelve(theme, seed, tier);
        // Deterministic.
        const again = generateDelve(theme, seed, tier);
        expect(Buffer.from(again.grid).equals(Buffer.from(m.grid))).toBe(true);
        expect(JSON.stringify(again.chests)).toBe(JSON.stringify(m.chests));
        // Plenty of floor, and everything stands on it.
        let floor = 0;
        for (const v of m.grid) floor += v;
        expect(floor).toBeGreaterThan(m.w * m.h * 0.12);
        expect(floorAt(m, m.start.x, m.start.z)).toBe(true);
        expect(floorAt(m, m.exit.x, m.exit.z)).toBe(true);
        expect(floorAt(m, m.boss.x, m.boss.z)).toBe(true);
        expect(floorAt(m, m.lift.x, m.lift.z)).toBe(true);
        for (const c of m.chests) expect(floorAt(m, c.x, c.z)).toBe(true);
        for (const s of m.spawns) expect(floorAt(m, s.x, s.z)).toBe(true);
        for (const k of m.keys) expect(floorAt(m, k.x, k.z)).toBe(true);
        // Everyone can walk to the boss and to every chest that is not behind the boss's door.
        const open = flood(m, m.start, true);
        const all = flood(m, m.start, false);
        expect(reach(m, all, m.boss)).toBe(true);
        for (const c of m.chests) expect(reach(m, all, c)).toBe(true);
        if (theme === 'cave') {
          expect(m.doors).toHaveLength(0);
          expect(m.keys).toHaveLength(0);
        } else {
          // A locked door guards the boss, and the key is on the near side of it.
          expect(m.doors.length).toBeGreaterThanOrEqual(1);
          expect(m.keys).toHaveLength(1);
          expect(reach(m, open, m.keys[0])).toBe(true);
          expect(reach(m, open, m.boss)).toBe(false);
        }
        // The boss is a real fight, and the hoard is the richest chest.
        expect(m.spawns.some((s) => s.boss)).toBe(true);
        const hoard = m.chests.find((c) => c.boss)!;
        expect(hoard).toBeDefined();
        expect(m.chests.length).toBeGreaterThanOrEqual(4);
        expect(m.rooms.filter((r) => r.role === 'lair' || r.role === 'key').length).toBeGreaterThanOrEqual(1);
      });
    }
  }

  it('wall colliders cover the rock around the floor and never the floor', () => {
    const m = generateDelve(theme, 42, 2);
    const boxes = wallColliders(m, 4);
    expect(boxes.length).toBeGreaterThan(10);
    for (let j = 0; j < m.h; j += 1) {
      for (let i = 0; i < m.w; i += 1) {
        const x = (i - m.w / 2) * CELL + CELL / 2;
        const z = (j - m.h / 2) * CELL + CELL / 2;
        const inBox = boxes.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ);
        if (m.grid[j * m.w + i]) expect(inBox).toBe(false);
      }
    }
    // Every floor cell with rock beside it has that rock boxed in.
    for (let j = 1; j < m.h - 1; j++) {
      for (let i = 1; i < m.w - 1; i++) {
        if (m.grid[j * m.w + i]) continue;
        const touches = m.grid[j * m.w + i - 1] || m.grid[j * m.w + i + 1] || m.grid[(j - 1) * m.w + i] || m.grid[(j + 1) * m.w + i];
        if (!touches) continue;
        const x = (i - m.w / 2) * CELL + CELL / 2;
        const z = (j - m.h / 2) * CELL + CELL / 2;
        expect(boxes.some((b) => x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ)).toBe(true);
      }
    }
  });
});

describe.each(LEGS.legs.filter((l) => l.biome === 'city').map((l) => [l.id, l] as const))('metro station on %s', (_id, leg) => {
  const layout = buildLayout(leg);
  const d = layout.delves[0];

  it('has one station, registered with the terrain, on the sidewalk facing the boulevard', () => {
    expect(layout.delves).toHaveLength(1);
    expect(d.theme).toBe('metro');
    expect(layout.terrain.delves).toContain(d);
    expect(Math.abs(d.x)).toBeGreaterThan(7);
    expect(Math.abs(d.x)).toBeLessThan(10);
    // Facing the road: the facing direction points at x = 0.
    expect(Math.sign(Math.sin(d.yaw))).toBe(-Math.sign(d.x));
  });

  it('leaves the mouth and the walk in to the stairs clear, and walls the rest of the headhouse', () => {
    const fx = Math.round(Math.sin(d.yaw));
    for (let t = 0; t <= 4.0; t += 0.4) expect(layout.blockedAt(d.x + fx * -t, d.z, 0.4)).toBe(false);
    // Behind the doorway the building is solid, and so are its flanks.
    expect(layout.blockedAt(d.x - fx * 7, d.z, 0.3)).toBe(true);
    expect(layout.blockedAt(d.x - fx * 4.5, d.z + 2.2, 0.3)).toBe(true);
    expect(layout.blockedAt(d.x - fx * 4.5, d.z - 2.2, 0.3)).toBe(true);
  });

  it('stands in a lot that no building was built on', () => {
    const inLot = layout.lots.filter((l) => d.x > l.x0 - 3 && d.x < l.x1 + 3 && d.z > l.z0 && d.z < l.z1 && l.strip === 0);
    expect(inLot.length).toBeGreaterThan(0);
    for (const l of inLot) expect(l.kind).not.toBe('building');
  });
});
