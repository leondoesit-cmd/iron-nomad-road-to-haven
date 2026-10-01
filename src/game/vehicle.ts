import * as THREE from 'three';
import { VehicleBody, defaultEnv, rotateByQuat, type DriveEnv, type DriveInput } from '../physics/vehicle';
import { applyHit, collisionDamage, facingOf, newHealth, performance, repairStep, tickHazards, type DamageEvent, type VehicleHealth } from '../sim/damage';
import { effectiveStats, emptyModules, type ModuleLevels } from '../sim/resources';
import { buildRaiderBuggy, buildVehicleVisual, buildWagon, type VehicleVisual } from '../render/vehicleModels';
import { PLAYER_COLORS } from '../render/palette';
import { shared, disposeTree } from '../render/dispose';
import { clamp, damp, lerp } from '../core/math';
import type { VehicleDef } from '../data';
import type { Ctx } from './ctx';

export type Faction = 'convoy' | 'raider';
export type VehicleKind = 'player' | 'crew' | 'raiderBuggy' | 'wagon';

/** Whoever is in the driver's seat: a Player (gamepad / keyboard) or an AI. */
export interface Pilot {
  readonly isPlayer: boolean;
  readonly index: number;
  drive(v: Vehicle, dt: number): DriveInput;
}

export interface VehicleOpts {
  def: VehicleDef;
  x: number;
  z: number;
  yaw: number;
  faction: Faction;
  kind: VehicleKind;
  ownerIndex?: number;
  mods?: ModuleLevels;
  hpFrac?: number;
  fuel?: number;
  color?: number;
  y?: number;
}

const IDLE: DriveInput = { steer: 0, throttle: 0, brake: 0, handbrake: true };
let nextId = 1;
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class Vehicle {
  id = nextId++;
  def: VehicleDef;
  body: VehicleBody;
  visual: VehicleVisual;
  health: VehicleHealth;
  mods: ModuleLevels;
  stats: ReturnType<typeof effectiveStats>;
  faction: Faction;
  kind: VehicleKind;
  ownerIndex: number;
  driver: Pilot | null = null;
  passenger: { index: number } | null = null;
  fuel: number;
  tankMax: number;
  engineOn = false;
  lights = false;
  hornT = 0;
  sirenT = 0;
  wreck = false;
  parkedAt = 0;
  /** Set by the leg's tether: >1 = slipstream boost, <1 = leader slowed. */
  tetherPower = 1;
  tetherTop = 1;
  /** Seconds the gun has been firing recently (drives Signature). */
  firing = 0;
  private fireCd = 0;
  gunAim: { x: number; y: number; z: number } | null = null;
  lastIntent: DriveInput = IDLE;
  env: DriveEnv = defaultEnv();
  distance = 0;
  private prev = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private spin: number[] = [];
  private lean = 0;
  private sigT = 0;
  private fx = 0;
  private fireFx = 0;
  /** Seconds since last damage, for "under fire" checks by the Mechanic. */
  sinceHit = 99;
  burnT = 0;
  onGround = true;
  /** Convoy slot data for crew vehicles. */
  group = new THREE.Group();

  constructor(
    public ctx: Ctx,
    o: VehicleOpts,
  ) {
    this.def = o.def;
    this.faction = o.faction;
    this.kind = o.kind;
    this.ownerIndex = o.ownerIndex ?? -1;
    this.mods = o.mods ?? emptyModules();
    this.stats = effectiveStats(Math.min(3, o.def.tier), this.mods);
    const base = o.def.physics;
    const gOff = base.suspension.rest + base.wheelRadius - base.hardY;
    const gy = o.y ?? ctx.groundAt(o.x, o.z);
    this.body = new VehicleBody(ctx.P, o.def, o.x, gy + gOff + 0.25, o.z, o.yaw);
    const isRaider = o.faction === 'raider';
    const color = o.color ?? (this.ownerIndex >= 0 ? PLAYER_COLORS[this.ownerIndex] : 0x6b8a5a);
    if (o.kind === 'raiderBuggy') this.visual = buildRaiderBuggy(o.def, this.body.wheelLocal, this.body.steered);
    else if (o.kind === 'wagon') this.visual = buildWagon(o.def, this.body.wheelLocal, this.body.steered);
    else this.visual = buildVehicleVisual(o.def, this.body.wheelLocal, this.body.steered, color);
    this.group.add(this.visual.root);
    this.visual.root.traverse((m) => {
      if ((m as THREE.Mesh).isMesh) {
        (m as THREE.Mesh).castShadow = true;
      }
    });
    ctx.root.add(this.group);
    const maxHp = isRaider ? o.def.hp : o.def.hp * (1 + 0);
    this.health = newHealth(maxHp, this.stats.armor, this.body.wheelCount);
    this.health.hp = maxHp * (o.hpFrac ?? 1);
    this.tankMax = isRaider ? 999 : this.stats.tank;
    this.fuel = o.fuel ?? this.tankMax;
    this.spin = this.body.wheelLocal.map(() => 0);
    ctx.vehicleByCollider.set(this.body.collider.handle, this);
    // Mounted rider models start hidden until someone drives.
    if (this.visual.driver && this.faction === 'convoy') this.visual.driver.root.visible = false;
    if (this.visual.passenger) {
      this.visual.inner.add(this.visual.passenger.root);
      this.visual.passenger.root.visible = false;
    }
    this.snapshotPrev();
  }

  get position() {
    return this.body.position;
  }
  get yaw() {
    return this.body.yaw;
  }
  get speed() {
    return this.body.speed;
  }
  get mass() {
    return this.body.mass;
  }
  get topSpeed() {
    return this.body.topSpeed(this.env);
  }

  get hpFrac() {
    return this.health.hp / this.health.maxHp;
  }

  get occupied() {
    return !!this.driver;
  }

  setEngine(on: boolean) {
    if (on && this.fuel <= 0.001) {
      this.engineOn = false;
      return;
    }
    this.engineOn = on && !this.wreck;
  }

  /** Current Signature: engines are Noise in cities and Dust on the open road. */
  signature(): number {
    if (this.wreck) return this.burnT > 0 ? 25 : 0;
    const sig = this.def.signature;
    let s = !this.engineOn ? 0 : Math.abs(this.speed) > 1.5 ? sig.moving : sig.idle;
    if (this.def.tier === 1 && this.engineOn && Math.abs(this.speed) < 1.5) s = sig.idle;
    if (this.firing > 0) s += 60;
    if (this.hornT > 0 || this.sirenT > 0) s = 100;
    if (this.lights && this.ctx.night > 0.4 && this.faction === 'convoy') s *= 2;
    return clamp(s * this.ctx.signatureMult, 0, 100);
  }

  /** Dust plume level for wastelands: grows with speed. */
  dust(): number {
    if (!this.engineOn) return 0;
    const f = clamp(Math.abs(this.speed) / Math.max(8, this.topSpeed), 0, 1);
    return clamp(this.signature() * (0.35 + 0.9 * f), 0, 100);
  }

  snapshotPrev() {
    const t = this.body.body.translation();
    const r = this.body.body.rotation();
    this.prev.x = t.x;
    this.prev.y = t.y;
    this.prev.z = t.z;
    this.prev.qx = r.x;
    this.prev.qy = r.y;
    this.prev.qz = r.z;
    this.prev.qw = r.w;
  }

  /** Called once per fixed tick, before the world step. */
  update(dt: number) {
    const ctx = this.ctx;
    this.sinceHit += dt;
    if (this.hornT > 0) this.hornT -= dt;
    if (this.sirenT > 0) this.sirenT -= dt;
    if (this.firing > 0) this.firing -= dt;
    if (this.fireCd > 0) this.fireCd -= dt;
    let input: DriveInput = IDLE;
    if (this.wreck) {
      this.env.engineOn = false;
    } else {
      if (this.driver) input = this.driver.drive(this, dt);
      else input = { steer: 0, throttle: 0, brake: 0, handbrake: Math.abs(this.speed) < 3 };
      this.lastIntent = input;
      const perf = performance(this.health);
      const e = this.env;
      e.engineOn = this.engineOn && this.fuel > 0.001;
      if (!e.engineOn && this.engineOn) this.engineOn = false;
      e.power = perf.power * this.tetherPower * (this.sinceHit < 0 ? 1 : 1);
      e.grip = perf.grip * this.stats.gripMult;
      e.forceMult = this.stats.forceMult;
      e.topSpeedMult = this.stats.topSpeedMult * this.tetherTop;
      e.travelMult = this.stats.travelMult;
      e.flats = this.health.comp.tires.map((t) => t <= 0);
      e.surface = (x, z) => ctx.surfaceAt(x, z);
    }
    this.body.update(this.wreck ? { steer: 0, throttle: 0, brake: 0, handbrake: true } : input, this.env, dt);
    this.onGround = this.body.grounded > 0;

    // Fuel burn per km driven, scaled by the Drain slider. Raiders never run dry.
    if (this.faction === 'convoy' && this.engineOn && !this.wreck) {
      const d = Math.abs(this.speed) * dt;
      this.distance += d;
      this.fuel = Math.max(0, this.fuel - (this.def.burn / 1000) * d * ctx.campaign.difficulty.drain - 0.0006 * dt);
      if (this.fuel <= 0.001) {
        this.engineOn = false;
        if (this.driver?.isPlayer) ctx.notify(this.driver.index, 'Out of fuel', 'bad');
      }
    }

    const hz = tickHazards(this.health, dt);
    if (hz.fuelLeak > 0) this.fuel = Math.max(0, this.fuel - hz.fuelLeak);
    if (this.health.destroyed && !this.wreck) this.destroyNow();

    // Collisions: damage by relative speed and mass ratio.
    if (this.body.impact > 0 && !this.wreck) {
      const dmg = collisionDamage(this.body.impact, this.mass, 3500);
      if (dmg > 0.5) {
        this.takeHit(dmg, this.position.x - this.body.impactDirX, this.position.z - this.body.impactDirZ, { ram: true, silent: true });
        if (this.driver?.isPlayer) {
          ctx.input.rumble(this.driver.index, clamp(this.body.impact / 14, 0.2, 1), 0.6, 160);
          const pl = ctx.players[this.driver.index];
          pl?.cam.addShake(clamp(this.body.impact / 18, 0.1, 0.9));
        }
        ctx.audio.play('crash', this.position.x, this.position.z, clamp(this.body.impact / 14, 0.3, 1));
        ctx.fx.spark(this.position.x, this.position.y, this.position.z, 5, 5);
      }
    }

    // Signature at 3 Hz.
    this.sigT -= dt;
    if (this.sigT <= 0) {
      this.sigT = 1 / 3;
      const s = this.signature();
      if (s > 0 && this.faction === 'convoy') {
        ctx.sig.emit(this.position.x, this.position.z, s, 'noise');
        ctx.sig.emit(this.position.x, this.position.z, this.dust(), 'dust');
      }
    }

    // Effects
    this.fx += dt;
    const p = this.position;
    if (this.onGround && !this.wreck && ctx.biome === 'wasteland' && Math.abs(this.speed) > 5 && this.fx > 0.04) {
      this.fx = 0;
      const [bx, , bz] = this.body.toWorld(0, 0, -this.def.length * 0.45);
      const surf = ctx.surfaceAt(bx, bz);
      const tint: [number, number, number] = surf.name === 'sand' ? [0.85, 0.72, 0.5] : surf.name === 'mud' ? [0.35, 0.28, 0.2] : surf.name === 'asphalt' ? [0.55, 0.52, 0.48] : [0.72, 0.6, 0.42];
      const k = clamp(Math.abs(this.speed) / 24, 0.3, 1.6) * (surf.name === 'asphalt' ? 0.5 : 1);
      ctx.fx.dust(bx, ctx.groundAt(bx, bz), bz, -Math.sin(this.yaw) * this.speed, -Math.cos(this.yaw) * this.speed, k, tint);
    }
    if (this.health.burning || (this.wreck && this.burnT > 0)) {
      ctx.fx.fire(p.x, p.y + 0.6, p.z, this.wreck ? 1.4 : 0.7);
      if (Math.random() < 0.5) ctx.fx.blackSmoke(p.x, p.y + 1.0, p.z);
    } else if (this.hpFrac < 0.4 && !this.wreck && Math.random() < 0.3) {
      ctx.fx.blackSmoke(p.x, p.y + 0.9, p.z);
    }
    if (this.wreck) this.burnT = Math.max(0, this.burnT - dt);
  }

  /** Fire the vehicle's mounted gun. Direction is explicit for aimed guns, else along the nose. */
  fireGun(dt: number, aim?: [number, number, number]): boolean {
    if (this.wreck || this.fireCd > 0 || !this.def.weapon) return false;
    const ctx = this.ctx;
    const camp = ctx.campaign;
    const isT2 = this.def.tier === 2 && this.def.id === 'quad';
    if (this.faction === 'convoy') {
      if (camp.ammo <= 0) {
        if (this.driver?.isPlayer && this.fx > 0.5) ctx.notify(this.driver.index, 'Out of ammo: craft more at camp', 'warn');
        return false;
      }
      camp.ammo--;
    }
    const rate = isT2 ? 11 : this.def.tier === 3 ? 9 : 8;
    this.fireCd = 1 / rate;
    this.firing = 0.4;
    let ox: number;
    let oy: number;
    let oz: number;
    let dx: number;
    let dy: number;
    let dz: number;
    if (this.visual.gun && aim) {
      const m = this.visual.muzzle;
      m.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
      ox = wp.x;
      oy = wp.y;
      oz = wp.z;
      [dx, dy, dz] = aim;
    } else {
      [ox, oy, oz] = this.body.toWorld(0, this.def.tier === 1 ? 0.5 : 0.5, this.def.length * 0.5 + 0.2);
      [dx, dy, dz] = this.body.forward();
    }
    const dmgMult = this.stats.damageMult * (0.5 + 0.5 * this.health.comp.mount);
    const base = isT2 ? 14 : 18;
    ctx.combat.shoot(ox, oy, oz, dx, dy, dz, {
      side: this.faction,
      ownVehicle: this,
      damage: base * dmgMult,
      spread: isT2 ? 0.03 : 0.022,
      tracer: true,
      assist: this.driver?.isPlayer || this.passenger ? 0.6 * (ctx.input.intents[this.driver?.index ?? this.passenger?.index ?? 0].aimAssist) : 0,
      noise: 60,
      range: 85,
      headshots: true,
      owner: ctx.players[this.driver?.index ?? this.passenger?.index ?? 0] ?? null,
    });
    ctx.fx.flash(ox, oy, oz, 1.1);
    ctx.audio.play('mg', ox, oz, 0.7);
    return true;
  }

  /** Apply damage from a source at (srcX, srcZ). Returns true if this killed the vehicle. */
  takeHit(raw: number, srcX: number, srcZ: number, o: { incendiary?: boolean; ram?: boolean; pierce?: number; silent?: boolean; wheel?: number } = {}): boolean {
    if (this.wreck) return false;
    const ctx = this.ctx;
    const dir = Math.atan2(srcX - this.position.x, srcZ - this.position.z);
    const facing = facingOf(dir, this.yaw);
    const h = this.health;
    const savedArmor = h.armor;
    if (o.pierce) h.armor = h.armor * (1 - o.pierce);
    const res = applyHit(h, raw, { facing, roll: () => ctx.rng.next(), incendiary: o.incendiary, ram: o.ram, wheel: o.wheel });
    h.armor = savedArmor;
    this.sinceHit = 0;
    this.report(res.events);
    if (this.driver?.isPlayer && !o.silent) ctx.input.rumble(this.driver.index, 0.4, 0.5, 90);
    if (this.passenger && !o.silent) ctx.input.rumble(this.passenger.index, 0.25, 0.4, 70);
    if (res.dealt > 0 && this.driver?.isPlayer) ctx.players[this.driver.index]?.cam.addShake(Math.min(0.5, res.dealt / 80));
    return h.destroyed;
  }

  private report(events: DamageEvent[]) {
    const ctx = this.ctx;
    const who = this.driver?.isPlayer ? this.driver.index : this.passenger ? this.passenger.index : -1;
    for (const e of events) {
      let msg = '';
      let kind: 'warn' | 'bad' = 'warn';
      if (e.kind === 'tire') msg = 'Tire blown';
      else if (e.kind === 'engine') msg = 'Engine damaged';
      else if (e.kind === 'leak') msg = 'Fuel leak!';
      else if (e.kind === 'fire') {
        msg = 'ON FIRE: repair to put it out';
        kind = 'bad';
      } else if (e.kind === 'mount') msg = 'Weapon mount damaged';
      if (msg && who >= 0) ctx.notify(who, msg, kind);
      if (msg && this.faction === 'raider') ctx.fx.spark(this.position.x, this.position.y + 0.6, this.position.z, 4, 4);
    }
  }

  /** Field repair step used by wrench and Mechanic. */
  repair(): string {
    const r = repairStep(this.health);
    return r;
  }

  private destroyNow() {
    this.wreck = true;
    this.engineOn = false;
    this.burnT = 30;
    const p = this.position;
    this.ctx.fx.explosion(p.x, p.y + 0.6, p.z, this.mass > 1500 ? 1.4 : 0.9);
    this.ctx.audio.play('boom', p.x, p.z, 1);
    this.body.body.setLinearDamping(1.5);
    this.body.body.setAngularDamping(3);
    this.body.body.applyImpulse({ x: 0, y: this.mass * 3.2, z: 0 }, true);
    this.visual.setHeadlights(false);
    // Char the body.
    this.visual.body.material = charMat;
    for (const w of this.visual.wheels) w.pivot.visible = true;
    if (this.visual.driver) this.visual.driver.root.visible = false;
    if (this.visual.passenger) this.visual.passenger.root.visible = false;
    this.ctx.onVehicleDestroyed(this);
  }

  /** World point of a seat's door, used for enter/exit proximity. */
  doorPos(side: 1 | -1): [number, number, number] {
    return this.body.toWorld(side * (this.def.width / 2 + 0.55), 0, this.def.tier === 3 ? 0.1 : -0.1);
  }
  gunnerPos(): [number, number, number] {
    return this.body.toWorld(0, 0.2, -0.95);
  }

  /** Where a player ends up after bailing or exiting: a free side, or on top. */
  exitSpot(): { x: number; z: number } {
    for (const side of [1, -1] as const) {
      const [x, , z] = this.doorPos(side);
      if (!this.ctx.obs.pointInside(x, z, 1)) return { x, z };
    }
    const [x, , z] = this.doorPos(1);
    return { x, z };
  }

  shove(ix: number, iz: number) {
    this.body.shove(ix, iz);
  }

  /** Pose the Three.js group from the interpolated physics state. */
  syncVisual(alpha: number, dt: number) {
    const t = this.body.body.translation();
    const r = this.body.body.rotation();
    const p = this.prev;
    this.visual.root.position.set(lerp(p.x, t.x, alpha), lerp(p.y, t.y, alpha), lerp(p.z, t.z, alpha));
    _q.set(p.qx, p.qy, p.qz, p.qw);
    _q2.set(r.x, r.y, r.z, r.w);
    _q.slerp(_q2, alpha);
    this.visual.root.quaternion.copy(_q);
    const v = this.visual;
    const sp = this.speed;
    // Wheels: suspension travel, steering, spin.
    for (let i = 0; i < v.wheels.length; i++) {
      const w = v.wheels[i];
      const susp = this.body.wheelSusp(i);
      w.pivot.position.y = this.def.physics.hardY - susp;
      w.pivot.rotation.y = w.steered ? this.body.steerAngle : 0;
      this.spin[i] += (sp * dt) / w.radius;
      w.spin.rotation.x = this.spin[i];
    }
    if (this.def.physics.lean) {
      const target = clamp(-this.body.steerAngle * Math.min(1, Math.abs(sp) / 8) * 1.1, -0.45, 0.45);
      this.lean = damp(this.lean, target, 8, dt);
      v.lean.rotation.z = this.lean;
    }
    // Seat occupants.
    if (v.driver && this.faction === 'convoy') v.driver.root.visible = !!this.driver && !this.wreck;
    if (v.passenger) v.passenger.root.visible = !!this.passenger && !this.wreck;
    if (v.driver) v.driver.update(dt, this.def.tier === 1 ? 'ride' : 'seat', 0, 0, 0);
    if (v.passenger) {
      v.passenger.setWeapon('none');
      v.passenger.update(dt, 'gun', 0, 1, 0);
    }
    if (this.firing > 0) {
      this.fireFx += dt;
    }
    v.setHeadlights(this.lights && !this.wreck);
    // Gun pivot follows the aim point.
    if (v.gun && this.gunAim) {
      const g = v.gun;
      const wp = new THREE.Vector3();
      g.updateWorldMatrix(true, false);
      wp.setFromMatrixPosition(g.matrixWorld);
      const dx = this.gunAim.x - wp.x;
      const dy = this.gunAim.y - wp.y;
      const dz = this.gunAim.z - wp.z;
      // convert world dir to vehicle-local yaw/pitch
      const inv = new THREE.Quaternion().copy(_q).invert();
      const ld = new THREE.Vector3(dx, dy, dz).applyQuaternion(inv);
      g.rotation.set(-Math.atan2(ld.y, Math.hypot(ld.x, ld.z)), Math.atan2(ld.x, ld.z), 0, 'YXZ');
      this.visual.passenger?.root.position.set(0, 0.0, -1.05);
    }
  }

  destroy() {
    this.ctx.vehicleByCollider.delete(this.body.collider.handle);
    this.body.destroy();
    disposeTree(this.group);
    this.group.removeFromParent();
    this.visual.dispose();
  }
}

const charMat = shared(new THREE.MeshLambertMaterial({ color: 0x1a1816 }));
void rotateByQuat;
