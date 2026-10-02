import { describe, expect, it } from 'vitest';
import { ObstacleIndex } from '../src/game/obstacles';
import { Zombie, ZombieSystem, type DoorBuilding } from '../src/game/zombies';
import { generatePlan, planAabbs, type Look } from '../src/world/interiors';

/** The dead walk toward a target inside a building: they have to find a doorway. */
function run(look: Look, w: number, d: number, seed: number, floorY: number, furniture: boolean) {
  const plan = generatePlan({ x0: 100, x1: 100 + w, z0: 200, z1: 200 + d, look, door: 1, seed, floors: 1, floorY, wear: 0.3, roof: 'gable' });
  const obs = new ObstacleIndex();
  obs.ground = () => floorY;
  let id = 0;
  for (const a of planAabbs(plan, () => id++)) if (!a.physOnly && (furniture || a.kind !== 'furniture')) obs.add(a);
  const doors: { x: number; z: number; nx: number; nz: number }[] = [];
  for (const wl of plan.walls) {
    if (wl.level !== 0) continue;
    for (const op of wl.ops) {
      if (op.kind === 'window') continue;
      const mid = (op.a + op.b) / 2;
      doors.push(wl.axis === 'z' ? { x: wl.c, z: mid, nx: 1, nz: 0 } : { x: mid, z: wl.c, nx: 0, nz: 1 });
    }
  }
  const zs = new ZombieSystem({ obs } as never);
  zs.buildings = [{ x0: plan.x0 - 1, x1: plan.x1 + 1, z0: plan.z0 - 1, z1: plan.z1 + 1, doors } as DoorBuilding];
  const results: { room: string; ok: boolean; at: string }[] = [];
  for (const room of plan.rooms.filter((r) => r.level === 0)) {
    // A free spot in the room for the target.
    let target: { x: number; z: number } | null = null;
    for (let x = (room.x0 + room.x1) / 2, k = 0; k < 40 && !target; k++) {
      const z = (room.z0 + room.z1) / 2 + Math.sin(k) * 0.6;
      const xx = x + Math.cos(k * 1.7) * 0.7;
      const c = obs.pointInside(xx, z, floorY + 0.5);
      if (!c && !obs.pointInside(xx + 0.4, z, floorY + 0.5) && !obs.pointInside(xx - 0.4, z, floorY + 0.5) && !obs.pointInside(xx, z + 0.4, floorY + 0.5) && !obs.pointInside(xx, z - 0.4, floorY + 0.5)) target = { x: xx, z };
    }
    if (!target) continue;
    const zb = new Zombie('walker', plan.x1 + 7, (plan.z0 + plan.z1) / 2 + 3, false, 1);
    zb.hasTarget = true;
    zb.tx = target.x;
    zb.tz = target.z;
    const dt = 0.05;
    let ok = false;
    for (let step = 0; step < 2400; step++) {
      (zs as unknown as { route(z: Zombie, dt: number): void }).route(zb, dt);
      const aimX = zb.routeT > 0 ? zb.routeX : zb.tx;
      const aimZ = zb.routeT > 0 ? zb.routeZ : zb.tz;
      const dx = aimX - zb.x;
      const dz = aimZ - zb.z;
      const dd = Math.hypot(dx, dz) || 1;
      const sp = 1.8 * dt;
      const p = { x: zb.x + (dx / dd) * Math.min(sp, dd), z: zb.z + (dz / dd) * Math.min(sp, dd) };
      obs.resolveCircle(p, zb.def.radius, undefined, floorY);
      zb.x = p.x;
      zb.z = p.z;
      if (Math.hypot(zb.tx - zb.x, zb.tz - zb.z) < 0.6) {
        ok = true;
        break;
      }
    }
    results.push({ room: room.role, ok, at: `${zb.x.toFixed(1)},${zb.z.toFixed(1)}` });
  }
  return results;
}

describe('the dead find their way into buildings', () => {
  const sweep = (furniture: boolean) => {
    let total = 0;
    let reached = 0;
    const fails: string[] = [];
    for (const [look, w, d] of [['house', 10, 9], ['house', 9, 10], ['store', 9, 16], ['motel', 9, 24], ['warehouse', 20, 30], ['shack', 5, 6]] as [Look, number, number][]) {
      for (let seed = 1; seed <= 6; seed++) {
        for (const r of run(look, w, d, seed * 7, seed % 2 ? 0 : 9.5, furniture)) {
          total++;
          if (r.ok) reached++;
          else fails.push(`${look} ${seed} ${r.room} stuck at ${r.at}`);
        }
      }
    }
    return { rate: reached / total, fails };
  };
  it('walls and doorways: nearly every room is reached, on flat and raised ground', () => {
    const r = sweep(false);
    expect(r.rate, r.fails.slice(0, 10).join('\n')).toBeGreaterThan(0.95);
  });
  it('with furniture in the way most rooms are still reached by a walker that only slides', () => {
    const r = sweep(true);
    expect(r.rate, r.fails.slice(0, 10).join('\n')).toBeGreaterThan(0.7);
  });
});
