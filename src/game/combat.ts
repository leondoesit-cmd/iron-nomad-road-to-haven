import { G, groups } from '../physics/physics';
import type { Ctx } from './ctx';
import type { Vehicle } from './vehicle';
import type { Player } from './player';

export interface ShotOpts {
  side: 'convoy' | 'raider';
  /** Vehicle whose own body the ray must ignore. */
  ownVehicle?: Vehicle | null;
  owner?: Player | null;
  damage: number;
  range?: number;
  /** Half-angle of the cone the bullet may wander in, radians. */
  spread?: number;
  /** Fraction of target armor ignored. */
  pierce?: number;
  tracer?: boolean;
  incendiary?: boolean;
  /** Player aim assist multiplier (0 disables). */
  assist?: number;
  /** Loudness added to the Signature grid at the shooter. */
  noise?: number;
  headshots?: boolean;
}

export interface ShotResult {
  kind: 'none' | 'static' | 'zombie' | 'vehicle' | 'infantry' | 'player';
  x: number;
  y: number;
  z: number;
  dist: number;
  killed: boolean;
}

const RAY_FILTER = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD);

export class Combat {
  constructor(private ctx: Ctx) {}

  /** Nudge a shot direction toward the nearest enemy in a narrow cone. Stronger assist on keyboard. */
  assist(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, strength: number): [number, number, number] {
    if (strength <= 0) return [dx, dy, dz];
    const cone = Math.cos((5.5 * strength * Math.PI) / 180);
    let best: { x: number; y: number; z: number; score: number } | null = null;
    const consider = (x: number, y: number, z: number) => {
      const vx = x - ox;
      const vy = y - oy;
      const vz = z - oz;
      const len = Math.hypot(vx, vy, vz);
      if (len < 2 || len > 70) return;
      const c = (vx * dx + vy * dy + vz * dz) / len;
      if (c < cone) return;
      const score = c * 100 - len * 0.1;
      if (!best || score > best.score) best = { x, y, z, score };
    };
    this.ctx.zombies.forEachNear(ox, oz, 70, (zb) => {
      if (zb.dead) return;
      consider(zb.x, zb.y + 1.2 * zb.def.scale, zb.z);
    });
    this.ctx.raiders.forEachTarget(ox, oz, 80, (x, y, z) => consider(x, y, z));
    if (!best) return [dx, dy, dz];
    const b = best as { x: number; y: number; z: number };
    let tx = b.x - ox;
    let ty = b.y - oy;
    let tz = b.z - oz;
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const k = Math.min(0.75, 0.55 * strength);
    let nx = dx + (tx - dx) * k;
    let ny = dy + (ty - dy) * k;
    let nz = dz + (tz - dz) * k;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl;
    ny /= nl;
    nz /= nl;
    return [nx, ny, nz];
  }

  shoot(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, o: ShotOpts): ShotResult {
    const ctx = this.ctx;
    const range = o.range ?? 90;
    if (o.assist) [dx, dy, dz] = this.assist(ox, oy, oz, dx, dy, dz, o.assist);
    if (o.spread) {
      const s = o.spread;
      const rx = (ctx.rng.next() - 0.5) * 2 * s;
      const ry = (ctx.rng.next() - 0.5) * 2 * s;
      const rz = (ctx.rng.next() - 0.5) * 2 * s;
      dx += rx;
      dy += ry;
      dz += rz;
      const l = Math.hypot(dx, dy, dz);
      dx /= l;
      dy /= l;
      dz /= l;
    }
    const res: ShotResult = { kind: 'none', x: ox + dx * range, y: oy + dy * range, z: oz + dz * range, dist: range, killed: false };

    // Static geometry and vehicles through Rapier.
    let vehHit: Vehicle | null = null;
    const own = o.ownVehicle?.body.body;
    const rh = ctx.P.raycast(ox, oy, oz, dx, dy, dz, range, RAY_FILTER, own);
    if (rh) {
      res.dist = rh.toi;
      res.kind = 'static';
      res.x = ox + dx * rh.toi;
      res.y = oy + dy * rh.toi;
      res.z = oz + dz * rh.toi;
      const v = ctx.vehicleByCollider.get(rh.collider.handle);
      if (v && !v.wreck) {
        // Friendly vehicles never stop friendly bullets.
        if (!(o.side === 'convoy' && v.faction === 'convoy') && !(o.side === 'raider' && v.faction === 'raider')) {
          res.kind = 'vehicle';
          vehHit = v;
        } else {
          // pass through friendlies: re-cast beyond them
          res.kind = 'none';
          res.dist = range;
          res.x = ox + dx * range;
          res.y = oy + dy * range;
          res.z = oz + dz * range;
        }
      }
    }

    // Logical targets in front of the static hit.
    const maxD = res.dist;
    if (o.side === 'convoy') {
      const z = ctx.zombies.rayTest(ox, oy, oz, dx, dy, dz, maxD);
      let zd = Infinity;
      if (z) zd = z.dist;
      const inf = ctx.raiders.infantryRayTest(ox, oy, oz, dx, dy, dz, maxD);
      let id = Infinity;
      if (inf) id = inf.dist;
      if (z && zd <= id && zd < res.dist) {
        res.kind = 'zombie';
        res.dist = zd;
        res.x = ox + dx * zd;
        res.y = oy + dy * zd;
        res.z = oz + dz * zd;
        const head = !!o.headshots && z.head;
        const dmg = o.damage * (head ? 2 : 1) * (1 - z.zombie.def.armor * (1 - (o.pierce ?? 0)));
        res.killed = ctx.zombies.damage(z.zombie, dmg, { fromX: ox, fromZ: oz, head, killer: o.owner?.index ?? -1 });
        ctx.fx.blood(res.x, res.y, res.z, head ? 5 : 3);
      } else if (inf && id < res.dist) {
        res.kind = 'infantry';
        res.dist = id;
        res.x = ox + dx * id;
        res.y = oy + dy * id;
        res.z = oz + dz * id;
        res.killed = ctx.raiders.damageInfantry(inf.unit, o.damage * (inf.head && o.headshots ? 2 : 1), o.owner?.index ?? -1);
        ctx.fx.blood(res.x, res.y, res.z, 3);
      } else if (vehHit) {
        res.killed = this.applyVehicleHit(vehHit, ox, oz, o);
      } else if (res.kind === 'static') {
        ctx.fx.spark(res.x, res.y, res.z, 3, 4);
        ctx.fx.puff(res.x, res.y, res.z, 0.55, 0.5, 0.45, 0.7, 0.4);
      }
    } else {
      // Raiders shoot players and convoy vehicles.
      const pl = this.playerRay(ox, oy, oz, dx, dy, dz, maxD);
      if (pl && pl.dist < res.dist) {
        res.kind = 'player';
        res.dist = pl.dist;
        res.x = ox + dx * pl.dist;
        res.y = oy + dy * pl.dist;
        res.z = oz + dz * pl.dist;
        // Raider rounds are tuned to chew vehicles; people on foot take a reduced share.
        pl.player.hurt(o.damage * 0.55, ox, oz, 'bullet');
        ctx.fx.blood(res.x, res.y, res.z, 3);
      } else if (vehHit) {
        res.killed = this.applyVehicleHit(vehHit, ox, oz, o);
      } else if (res.kind === 'static') {
        ctx.fx.spark(res.x, res.y, res.z, 2, 3);
        ctx.fx.puff(res.x, res.y, res.z, 0.6, 0.5, 0.4, 0.9, 0.5);
        if (rh) ctx.structureHit?.(rh.collider.handle, o.damage);
      }
    }

    if (o.tracer !== false) ctx.tracers.add(ox, oy, oz, res.x, res.y, res.z, o.side === 'raider' ? 1 : 1, o.side === 'raider' ? 0.5 : 0.85, o.side === 'raider' ? 0.3 : 0.45);
    if (o.noise) ctx.sig.emit(ox, oz, o.noise * ctx.signatureMult, 'noise');
    return res;
  }

  private applyVehicleHit(v: Vehicle, ox: number, oz: number, o: ShotOpts): boolean {
    const ctx = this.ctx;
    const r = v.takeHit(o.damage * (o.side === 'raider' ? ctx.campaign.difficulty.damage : 1), ox, oz, { incendiary: o.incendiary, pierce: o.pierce });
    ctx.fx.spark(v.position.x, v.position.y + 0.8, v.position.z, 2, 3);
    return r;
  }

  private playerRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxD: number): { player: Player; dist: number } | null {
    let best: { player: Player; dist: number } | null = null;
    for (const p of this.ctx.players) {
      if (!p.targetable) continue;
      const px = p.pos.x;
      const pz = p.pos.z;
      const py = p.pos.y;
      const vx = px - ox;
      const vz = pz - oz;
      // closest approach in XZ along the ray
      const dh = Math.hypot(dx, dz) || 1;
      const t = (vx * dx + vz * dz) / dh;
      if (t < 0 || t > maxD) continue;
      const cx = ox + (dx / dh) * t;
      const cz = oz + (dz / dh) * t;
      if (Math.hypot(cx - px, cz - pz) > 0.45) continue;
      const ty = oy + (dy / dh) * t;
      if (ty < py - 0.1 || ty > py + 1.9) continue;
      if (!best || t < best.dist) best = { player: p, dist: t };
    }
    return best;
  }

  /** Area damage. Zombies and raiders take full damage, vehicles are reduced by armor, players take half. */
  explode(x: number, y: number, z: number, radius: number, damage: number, o: { side: 'convoy' | 'raider' | 'neutral'; owner?: Player | null; incendiary?: boolean }) {
    const ctx = this.ctx;
    ctx.fx.explosion(x, y, z, Math.max(0.6, radius / 5));
    ctx.audio.play('boom', x, z, 1);
    ctx.sig.emit(x, z, 100, 'noise');
    for (const p of ctx.players) p.cam.addShake(Math.max(0, 0.9 - Math.hypot(p.pos.x - x, p.pos.z - z) / (radius * 4)));
    ctx.zombies.blast(x, z, radius, damage, o.owner?.index ?? -1);
    ctx.raiders.blast(x, z, radius, damage, o.owner?.index ?? -1, o.side !== 'raider');
    for (const v of ctx.vehicles) {
      if (v.wreck) continue;
      const d = Math.hypot(v.position.x - x, v.position.z - z);
      if (d > radius + v.def.length * 0.5) continue;
      const f = 1 - Math.min(1, d / (radius + v.def.length * 0.5));
      if (o.side === 'convoy' && v.faction === 'convoy' && !o.owner) continue;
      v.takeHit(damage * f * 0.8, x, z, { incendiary: !!o.incendiary, ram: true });
      const k = f * v.mass * 2;
      const dx = v.position.x - x;
      const dz = v.position.z - z;
      const l = Math.hypot(dx, dz) || 1;
      v.shove((dx / l) * k, (dz / l) * k);
    }
    for (const p of ctx.players) {
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d < radius) p.hurt(damage * 0.5 * (1 - d / radius), x, z, 'blast');
    }
  }
}
