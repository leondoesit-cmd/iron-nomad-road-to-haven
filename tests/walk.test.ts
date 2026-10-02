import { beforeAll, describe, expect, it } from 'vitest';
import { GROUPS, G, groups, initPhysics, PhysicsWorld, RAPIER } from '../src/physics/physics';
import { generatePlan, levelBase, planAabbs, type BuildingPlan, type Look } from '../src/world/interiors';

const RAY_STATIC = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD | G.FURN);
const BODY_H = 1.7;
const BODY_R = 0.3;

/** A player capsule driven the way the game drives it: kinematic body, character controller with auto-step. */
class Walker {
  world: PhysicsWorld;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kcc: RAPIER.KinematicCharacterController;
  vy = 0;
  constructor(plan: BuildingPlan, opt: { minWidth?: number; snap?: number; maxStep?: number } = {}) {
    this.world = new PhysicsWorld();
    const w = this.world;
    w.addStaticBox((plan.x0 + plan.x1) / 2, plan.floorY - 0.5, (plan.z0 + plan.z1) / 2, 40, 0.5, 40, 0, GROUPS.static);
    let id = 0;
    for (const a of planAabbs(plan, () => id++)) {
      if (a.ramp) {
        w.addStaticTilted(a.ramp.x, a.ramp.y, a.ramp.z, a.ramp.hx, a.ramp.hy, a.ramp.hz, a.ramp.q, GROUPS.furn);
        continue;
      }
      w.addStaticBox((a.minX + a.maxX) / 2, (a.y0 + a.y1) / 2, (a.minZ + a.maxZ) / 2, (a.maxX - a.minX) / 2, (a.y1 - a.y0) / 2, (a.maxZ - a.minZ) / 2, 0, a.kind === 'furniture' || a.kind === 'floor' ? GROUPS.furn : GROUPS.static);
    }
    this.body = w.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    this.collider = w.world.createCollider(RAPIER.ColliderDesc.capsule((BODY_H - BODY_R * 2) / 2, BODY_R).setCollisionGroups(GROUPS.player), this.body);
    this.kcc = w.world.createCharacterController(0.03);
    this.kcc.enableAutostep(opt.maxStep ?? 0.45, opt.minWidth ?? 0.2, false);
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    if ((opt.snap ?? 0.35) > 0) this.kcc.enableSnapToGround(opt.snap ?? 0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
  }
  put(x: number, y: number, z: number) {
    this.body.setTranslation({ x, y: y + BODY_H / 2 + 0.02, z }, true);
    this.world.step();
  }
  get x() {
    return this.body.translation().x;
  }
  get y() {
    return this.body.translation().y - BODY_H / 2;
  }
  get z() {
    return this.body.translation().z;
  }
  /** One 60 Hz tick toward (tx, tz) at `speed` m/s. */
  step(tx: number, tz: number, speed = 3.2) {
    const dt = 1 / 60;
    const dx = tx - this.x;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dz) || 1;
    const k = Math.min(1, d / (speed * dt));
    this.vy = Math.max(-30, this.vy - 22 * dt);
    this.kcc.computeColliderMovement(this.collider, { x: (dx / d) * speed * dt * k, y: this.vy * dt, z: (dz / d) * speed * dt * k }, undefined, RAY_STATIC);
    const m = this.kcc.computedMovement();
    if (this.kcc.computedGrounded() && this.vy < 0) this.vy = 0;
    const t = this.body.translation();
    const n = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(n);
    this.body.setTranslation(n, false);
    this.world.step();
  }
}

/** Grid path (8-connected) around anything solid at body height. */
function path(plan: BuildingPlan, level: number, from: [number, number], room: { x0: number; x1: number; z0: number; z1: number }): [number, number][] | null {
  const C = 0.1;
  const R = 0.32;
  let id = 0;
  const base = levelBase(plan, level);
  const solid = planAabbs(plan, () => id++).filter((a) => (a.kind === 'partition' || a.kind === 'furniture') && a.y1 > base + 0.45 && a.y0 < base + 1.7);
  const ox = plan.x0 - 3;
  const oz = plan.z0 - 3;
  const nx = Math.ceil((plan.x1 - plan.x0 + 6) / C);
  const nz = Math.ceil((plan.z1 - plan.z0 + 6) / C);
  const blocked = new Uint8Array(nx * nz);
  for (const a of solid) {
    const i0 = Math.max(0, Math.floor((a.minX - R - ox) / C));
    const i1 = Math.min(nx - 1, Math.ceil((a.maxX + R - ox) / C));
    const j0 = Math.max(0, Math.floor((a.minZ - R - oz) / C));
    const j1 = Math.min(nz - 1, Math.ceil((a.maxZ + R - oz) / C));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = ox + (i + 0.5) * C;
        const z = oz + (j + 0.5) * C;
        const cx = Math.max(a.minX, Math.min(x, a.maxX));
        const cz = Math.max(a.minZ, Math.min(z, a.maxZ));
        if ((x - cx) ** 2 + (z - cz) ** 2 < R * R) blocked[j * nx + i] = 1;
      }
    }
  }
  const idx = (x: number, z: number) => Math.floor((z - oz) / C) * nx + Math.floor((x - ox) / C);
  const start = idx(from[0], from[1]);
  if (blocked[start]) return null;
  const prev = new Int32Array(nx * nz).fill(-2);
  prev[start] = -1;
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    const i = c % nx;
    const j = (c - i) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const n = b * nx + a;
      if (prev[n] !== -2 || blocked[n]) continue;
      if (di && dj && (blocked[j * nx + a] || blocked[b * nx + i])) continue;
      prev[n] = c;
      queue.push(n);
    }
  }
  // The reachable spot in the room nearest its centre.
  const rcx = (room.x0 + room.x1) / 2;
  const rcz = (room.z0 + room.z1) / 2;
  let goal = -1;
  let bd = Infinity;
  for (let c = 0; c < nx * nz; c++) {
    if (prev[c] === -2) continue;
    const i = c % nx;
    const x = ox + (i + 0.5) * C;
    const z = oz + ((c - i) / nx + 0.5) * C;
    if (x < room.x0 + R || x > room.x1 - R || z < room.z0 + R || z > room.z1 - R) continue;
    const d = Math.hypot(x - rcx, z - rcz);
    if (d < bd) {
      bd = d;
      goal = c;
    }
  }
  if (goal < 0) return null;
  const out: [number, number][] = [];
  for (let c = goal; c !== -1; c = prev[c]) {
    const i = c % nx;
    out.push([ox + (i + 0.5) * C, oz + ((c - i) / nx + 0.5) * C]);
  }
  out.reverse();
  // Thin out: one waypoint every 0.5 m.
  return out.filter((_, k) => k % 5 === 0 || k === out.length - 1);
}

function walkPath(wk: Walker, pts: [number, number][], maxSeconds = 90) {
  let t = 0;
  for (const [tx, tz] of pts) {
    let guard = 0;
    while (Math.hypot(tx - wk.x, tz - wk.z) > 0.15 && guard++ < 60 * 8) {
      wk.step(tx, tz);
      t += 1 / 60;
      if (t > maxSeconds) return false;
    }
    if (guard >= 60 * 8) return false;
  }
  return true;
}

describe('walking through generated buildings with the player capsule', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  const looks: [Look, number, number, number][] = [
    ['house', 10, 9, 11],
    ['house', 9, 10, 12],
    ['store', 9, 16, 13],
    ['motel', 9, 24, 14],
    ['warehouse', 20, 30, 15],
    ['barn', 14, 24, 16],
    ['shack', 5, 6, 17],
  ];

  it.each(looks)('%s %ix%i: from the doorstep to every room', (look, w, d, seed) => {
    for (let s = 0; s < 4; s++) {
      const plan = generatePlan({ x0: 100, x1: 100 + w, z0: 200, z1: 200 + d, look, door: s % 2 ? -1 : 1, seed: seed * 10 + s, floors: 1, floorY: 3, wear: 0.3, roof: 'gable' });
      const front = plan.walls.find((q) => q.level === 0 && q.ext && q.axis === 'z' && q.out === plan.door)!;
      const door = front.ops.find((o) => o.kind === 'door' || o.kind === 'gate')!;
      const startPt: [number, number] = [front.c + plan.door * 1.2, (door.a + door.b) / 2];
      for (const room of plan.rooms.filter((r) => r.level === 0)) {
        const wk = new Walker(plan);
        wk.put(startPt[0], plan.floorY, startPt[1]);
        // Aim for a free spot: try the centre, then a few others.
        const route = path(plan, 0, startPt, room);
        expect(route, `${look} seed ${seed * 10 + s}: no route to ${room.role}`).not.toBeNull();
        const ok = walkPath(wk, route!);
        const goal = route![route!.length - 1];
        expect(ok, `${look} seed ${seed * 10 + s}: stuck on the way to ${room.role} at ${wk.x.toFixed(2)},${wk.z.toFixed(2)} (goal ${goal[0].toFixed(2)},${goal[1].toFixed(2)})`).toBe(true);
        expect(wk.y).toBeCloseTo(plan.floorY, 0);
      }
    }
  });

  it('a person can climb the stairs of a two-storey house and walk into the rooms upstairs', () => {
    let climbed = 0;
    const dirs = new Set<string>();
    for (let s = 0; s < 200 && climbed < 24; s++) {
      const wide = s % 2 === 0;
      const plan = generatePlan({ x0: 100, x1: wide ? 110 : 109, z0: 200, z1: wide ? 209 : 210, look: 'house', door: s % 4 < 2 ? 1 : -1, seed: 700 + s, floors: 2, floorY: 3, wear: 0.2, roof: 'gable' });
      if (plan.levels < 2) continue;
      if ([...dirs].filter((d) => d === plan.stairs[0].dir).length >= 6) continue;
      dirs.add(plan.stairs[0].dir);
      climbed++;
      const st = plan.stairs[0];
      const dx = st.dir === '+x' ? 1 : st.dir === '-x' ? -1 : 0;
      const dz = st.dir === '+z' ? 1 : st.dir === '-z' ? -1 : 0;
      const wk = new Walker(plan);
      const foot: [number, number] = [st.x - dx * 0.5, st.z - dz * 0.5];
      wk.put(foot[0], plan.floorY, foot[1]);
      const top: [number, number] = [st.x + dx * ((st.steps - 1) * st.tread + 0.7), st.z + dz * ((st.steps - 1) * st.tread + 0.7)];
      // Straight up the stairs.
      const up: [number, number][] = [[st.x, st.z], top];
      expect(walkPath(wk, up), `seed ${700 + s}: stuck on the stairs at y ${wk.y.toFixed(2)}`).toBe(true);
      expect(wk.y).toBeGreaterThan(plan.floorY + plan.levelH - 0.35);
      // Then to each room upstairs.
      for (const room of plan.rooms.filter((r) => r.level === 1)) {
        const w2 = new Walker(plan);
        w2.put(top[0], plan.floorY + plan.levelH, top[1]);
        const route = path(plan, 1, top, room);
        expect(route, `seed ${700 + s}: no route upstairs to ${room.role}`).not.toBeNull();
        expect(walkPath(w2, route!), `seed ${700 + s}: stuck upstairs on the way to ${room.role} dir ${plan.stairs[0].dir} at ${w2.x.toFixed(2)},${w2.y.toFixed(2)},${w2.z.toFixed(2)} route ${JSON.stringify(route!.slice(0, 6).map((q) => q.map((v) => +v.toFixed(2))))}`).toBe(true);
        expect(w2.y).toBeGreaterThan(plan.floorY + plan.levelH - 0.3);
      }
    }
    expect(climbed).toBeGreaterThanOrEqual(4);
  });
});
