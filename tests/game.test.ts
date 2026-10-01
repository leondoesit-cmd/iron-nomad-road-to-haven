import { describe, expect, it } from 'vitest';
import { ObstacleIndex } from '../src/game/obstacles';
import { Campaign } from '../src/game/campaign';
import { newIntent, Btn, isHeld, wasPressed } from '../src/input/intents';
import { radialDeadzone, wrapAngle, angleDiff, formatClock } from '../src/core/math';
import { Rng, hash2, noise2 } from '../src/core/rng';
import { sectorOf, sectorAngle } from '../src/game/campScene';
import { fovFor, viewFov, VERTICAL_SPLIT_VFOV } from '../src/render/renderer';
import type { Aabb } from '../src/world/layout';

const box = (id: number, x0: number, x1: number, z0: number, z1: number, y1 = 3): Aabb => ({ id, minX: x0, maxX: x1, minZ: z0, maxZ: z1, y0: 0, y1, kind: 'wall', hp: 9999 });

describe('obstacle index', () => {
  it('pushes a circle out of a box and reports the hit', () => {
    const o = new ObstacleIndex();
    const a = box(1, 0, 4, 0, 4);
    o.add(a);
    const p = { x: 4.2, z: 2 };
    const hit = o.resolveCircle(p, 0.5);
    expect(hit).toBe(a);
    expect(p.x).toBeGreaterThanOrEqual(4.5 - 1e-6);
    expect(p.z).toBeCloseTo(2);
  });
  it('shoves a centre-inside circle out through the nearest face', () => {
    const o = new ObstacleIndex();
    o.add(box(1, 0, 10, 0, 2));
    const p = { x: 5, z: 1.7 };
    o.resolveCircle(p, 0.3);
    expect(p.z).toBeGreaterThanOrEqual(2.3 - 1e-6);
  });
  it('segments are blocked by tall boxes only at their height', () => {
    const o = new ObstacleIndex();
    o.add(box(1, 4, 6, -2, 2, 1.0)); // low wall, 1 m tall
    expect(o.segmentBlocked(0, 0, 10, 0, 0.5)).toBe(true);
    expect(o.segmentBlocked(0, 0, 10, 0, 1.6)).toBe(false); // shooting over it
    expect(o.segmentBlocked(0, 5, 10, 5, 0.5)).toBe(false);
  });
  it('first hit returns the nearest box along the segment', () => {
    const o = new ObstacleIndex();
    o.add(box(1, 8, 9, -1, 1));
    o.add(box(2, 3, 4, -1, 1));
    const h = o.segmentFirst(0, 0, 20, 0);
    expect(h?.a.id).toBe(2);
    expect(h!.t).toBeCloseTo(3 / 20);
  });
  it('add and remove keep the grid consistent across cells', () => {
    const o = new ObstacleIndex();
    const a = box(7, 10, 60, 0, 2); // spans several 16 m cells
    o.add(a);
    expect(o.segmentBlocked(30, -5, 30, 5)).toBe(true);
    o.remove(a);
    expect(o.segmentBlocked(30, -5, 30, 5)).toBe(false);
    expect(o.count).toBe(0);
  });
  it('pointInside respects height', () => {
    const o = new ObstacleIndex();
    o.add(box(1, 0, 2, 0, 2, 2));
    expect(o.pointInside(1, 1, 1)).not.toBeNull();
    expect(o.pointInside(1, 1, 5)).toBeNull();
  });
});

describe('campaign state', () => {
  it('serializes and restores everything that matters', () => {
    const c = new Campaign(['Ash', 'Rook']);
    c.seed = 42;
    c.stocks.scrap = 123;
    c.fragments.add(2);
    c.seenEncounters.add('toll_road');
    c.hire('mechanic', 0.15);
    c.players[0].tier = 3;
    c.players[1].mods.engine = 2;
    c.axes.mercy = 5;
    const back = Campaign.deserialize(JSON.parse(JSON.stringify(c.serialize())));
    expect(back.seed).toBe(42);
    expect(back.stocks.scrap).toBe(123);
    expect(back.fragments.has(2)).toBe(true);
    expect(back.seenEncounters.has('toll_road')).toBe(true);
    expect(back.crew).toHaveLength(1);
    expect(back.crew[0].cut).toBeCloseTo(0.15);
    expect(back.players[0].tier).toBe(3);
    expect(back.players[1].mods.engine).toBe(2);
    expect(back.axes.mercy).toBe(5);
  });
  it('only living, undeserted crew count', () => {
    const c = new Campaign();
    const m = c.hire('mechanic')!;
    expect(c.crewLive).toHaveLength(1);
    m.deserted = true;
    expect(c.crewLive).toHaveLength(0);
  });
});

describe('input helpers', () => {
  it('button masks', () => {
    const it = newIntent();
    it.held = 1 << Btn.A;
    it.pressed = 1 << Btn.A;
    expect(isHeld(it, Btn.A)).toBe(true);
    expect(isHeld(it, Btn.B)).toBe(false);
    expect(wasPressed(it, Btn.A)).toBe(true);
  });
  it('radial deadzone zeros small input and rescales the rest', () => {
    expect(radialDeadzone(0.1, 0.1, 0.15)).toEqual([0, 0]);
    const [x, y] = radialDeadzone(1, 0, 0.15);
    expect(x).toBeCloseTo(1);
    expect(y).toBe(0);
    const [mx] = radialDeadzone(0.575, 0, 0.15);
    expect(mx).toBeCloseTo(0.5, 1);
  });
});

describe('math and rng', () => {
  it('wraps and diffs angles through pi', () => {
    expect(Math.abs(wrapAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 5);
    expect(wrapAngle(Math.PI * 2 + 0.5)).toBeCloseTo(0.5, 5);
    expect(angleDiff(3, -3)).toBeCloseTo(2 * Math.PI - 6, 5);
    expect(formatClock(75)).toBe('1:15');
  });
  it('rng and noise are deterministic', () => {
    const a = new Rng(5);
    const b = new Rng(5);
    for (let i = 0; i < 20; i++) expect(a.next()).toBe(b.next());
    expect(hash2(3, 4, 5)).toBe(hash2(3, 4, 5));
    expect(noise2(1.5, 2.5, 9)).toBe(noise2(1.5, 2.5, 9));
    const n = noise2(0.3, 0.7, 1);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1);
  });
  it('shuffle keeps every element', () => {
    const r = new Rng(1);
    const arr = [1, 2, 3, 4, 5, 6];
    expect([...r.shuffle([...arr])].sort()).toEqual(arr);
  });
});

describe('camp sectors', () => {
  it('sector 0 is north (+Z) and they run toward +X, which is west when facing north', () => {
    expect(sectorOf(0, 10)).toBe(0);
    expect(sectorOf(10, 0)).toBe(2); // 'w'
    expect(sectorOf(-10, 0)).toBe(6); // 'e'
    expect(sectorOf(0, -10)).toBe(4);
    for (let k = 0; k < 8; k++) expect(sectorOf(Math.sin(sectorAngle(k)), Math.cos(sectorAngle(k)))).toBe(k);
  });
});

describe('split-screen camera', () => {
  it('derives the vertical FOV from a fixed 100 degree horizontal FOV, matching the blueprint table', () => {
    expect(fovFor(1920 / 540)).toBeCloseTo(37, 0);
    expect(fovFor(1280 / 360)).toBeCloseTo(37, 0);
    expect(fovFor(3440 / 720, 108)).toBeGreaterThanOrEqual(32); // ultrawide floor
  });
  it('never drops below the 32 degree floor', () => {
    expect(fovFor(10)).toBe(32);
  });
  it('left/right halves use a fixed vertical FOV instead of a fisheye horizontal one', () => {
    const half = 958 / 1080; // one half of a 1920x1080 window
    expect(fovFor(half)).toBeGreaterThan(100); // what the strip rule would give: far too wide
    expect(viewFov(half, 'vertical')).toBe(VERTICAL_SPLIT_VFOV);
    expect(viewFov(1920 / 540, 'horizontal')).toBeCloseTo(37, 0); // strips keep the blueprint rule
    expect(viewFov(1920 / 540, 'vertical')).toBeCloseTo(37, 0); // never wider than the strip rule allows
  });
});
