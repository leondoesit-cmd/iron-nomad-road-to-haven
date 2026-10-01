import * as THREE from 'three';
import { RAPIER, GROUPS, G, groups, type Collider, type RigidBody } from '../physics/physics';
import { Btn, heldFor, isHeld, wasPressed, type PlayerIntent } from '../input/intents';
import { ChaseCamera, type CamMode } from '../render/camera';
import { Humanoid } from '../render/humanoid';
import { PLAYER_COLORS } from '../render/palette';
import { clamp, damp, dampAngle, lerp } from '../core/math';
import { ENEMIES, t } from '../data';
import { roadX } from '../world/terrain';
import { steerTo, newSteerState } from './aiDrive';
import { needsRepair } from '../sim/damage';
import type { DriveInput } from '../physics/vehicle';
import type { Ctx } from './ctx';
import type { Pilot, Vehicle } from './vehicle';
import type { Interactable } from './interact';

export type PState = 'foot' | 'entering' | 'driving' | 'gunner' | 'downed' | 'dead';
export type Equip = 'pistol' | 'wrench' | 'jerrycan' | 'utility';
export type Utility = 'flare' | 'charge' | 'molotov' | 'horn';
export const UTILITIES: Utility[] = ['flare', 'molotov', 'charge', 'horn'];

export interface Note {
  text: string;
  kind: 'info' | 'good' | 'warn' | 'bad';
  t: number;
}

export interface Prompt {
  text: string;
  /** 0..1 hold progress, or -1 for tap prompts. */
  progress: number;
  button: 'A' | 'Y' | 'X' | 'RT' | 'RB';
}

const WALK = 3.4;
const SPRINT = 5.9;
const CROUCH = 1.7;
const BODY_H = 1.7;
const BODY_R = 0.3;
const RAY_STATIC = groups(0xffff, G.STATIC | G.VEHICLE | G.BUILD);
const _v = new THREE.Vector3();

export class Player implements Pilot {
  readonly isPlayer = true;
  state: PState = 'foot';
  pos = new THREE.Vector3();
  prevPos = new THREE.Vector3();
  vy = 0;
  yaw = 0;
  aimYaw = 0;
  aimPitch = 0;
  ads = 0;
  crouch = false;
  grounded = true;
  moveSpeed = 0;
  hp = 100;
  maxHp = 100;
  vehicle: Vehicle | null = null;
  ownVehicle: Vehicle | null = null;
  human: Humanoid;
  cam = new ChaseCamera();
  equip: Equip = 'pistol';
  utility: Utility;
  mag = 12;
  reloadT = 0;
  fireCd = 0;
  meleeCd = 0;
  notes: Note[] = [];
  prompt: Prompt | null = null;
  commandWheel = false;
  sheet = false;
  // state timers
  downT = 0;
  reviveProgress = 0;
  respawnT = 0;
  pinned = 0;
  pinBreak = 0;
  enterT = 0;
  private enterFrom = new THREE.Vector3();
  private enterTo: Vehicle | null = null;
  private enterSeat: 'driver' | 'gunner' = 'driver';
  bailHold = 0;
  lookBack = false;
  camFar = false;
  shoulder = 0.6;
  /** Seconds since last hit, for regen delay and Mechanic checks. */
  sinceHit = 99;
  /** Hold-action in progress. */
  action: { kind: string; t: number; dur: number; target?: unknown; label: string } | null = null;
  takedownT = 0;
  body: RigidBody;
  collider: Collider;
  kcc: RAPIER.KinematicCharacterController;
  /** Convoy tether state for the HUD. */
  tetherWarn = 0;
  signatureShown = 0;
  invuln = 0;
  muzzleT = 0;
  throwHeld = 0;
  fatigue = 0;
  /** Where the aim ray currently lands (for the reticle and the gun). */
  aimPoint = new THREE.Vector3();
  aimDist = 60;
  lastKnownVehicleSpeed = 0;
  private hitCooldown = 0;
  private lastHurtDir = 0;
  watchSector = -1;
  /** Camp build phase: input drives the placement reticle instead of weapons. */
  buildMode = false;
  private colliderOn = true;
  /** Debug and tooling: follow the road automatically. */
  autopilot: { speed: number; lane?: number } | null = null;
  private apState = newSteerState();

  constructor(
    public ctx: Ctx,
    public index: 0 | 1,
    public name: string,
  ) {
    this.utility = ctx.campaign.players[index].utility;
    const col = PLAYER_COLORS[index];
    this.human = new Humanoid({ jacket: col, trim: col, helmet: index === 0 ? 0x3b2a1a : 0x1c2a3a });
    ctx.root.add(this.human.root);
    this.body = ctx.P.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1, 0));
    this.collider = ctx.P.world.createCollider(
      RAPIER.ColliderDesc.capsule((BODY_H - BODY_R * 2) / 2, BODY_R).setCollisionGroups(GROUPS.player).setTranslation(0, 0, 0),
      this.body,
    );
    this.kcc = ctx.P.world.createCharacterController(0.03);
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setApplyImpulsesToDynamicBodies(false);
    this.cam.occlude = (from, dir, maxDist) => {
      const r = ctx.P.raycast(from.x, from.y, from.z, dir.x, dir.y, dir.z, maxDist, groups(0xffff, G.STATIC | G.BUILD));
      return r ? r.toi : Infinity;
    };
    this.cam.groundAt = (x, z) => ctx.groundAt(x, z);
  }

  get targetable() {
    return (this.state === 'foot' || this.state === 'entering' || this.state === 'downed') && this.invuln <= 0;
  }
  get intent(): PlayerIntent {
    return this.ctx.input.intents[this.index];
  }
  get partner(): Player | undefined {
    return this.ctx.players[1 - this.index];
  }
  get alive() {
    return this.state !== 'dead';
  }
  get inVehicle() {
    return this.state === 'driving' || this.state === 'gunner';
  }

  /** Place the player on foot at a point (feet position). */
  placeAt(x: number, z: number, yaw = 0) {
    const y = this.ctx.groundAt(x, z);
    this.pos.set(x, y + 0.05, z);
    this.prevPos.copy(this.pos);
    this.yaw = yaw;
    this.aimYaw = yaw;
    this.body.setTranslation({ x, y: y + BODY_H / 2 + 0.05, z }, true);
    this.cam.snap();
  }

  note(text: string, kind: Note['kind'] = 'info') {
    this.notes.push({ text, kind, t: 3.6 });
    if (this.notes.length > 4) this.notes.shift();
  }

  // ------------------------------------------------------------------ Pilot

  /** Convert controller input to vehicle controls while driving. */
  drive(v: Vehicle, dt: number): DriveInput {
    if (this.autopilot && this.ctx.terrain) {
      const T = this.ctx.terrain;
      const z = v.position.z + 28;
      if (!v.engineOn && v.fuel > 0.001) v.setEngine(true);
      return steerTo(v, roadX(T, z) + (this.autopilot.lane ?? (this.index === 0 ? 2.2 : -2.2)), z, this.autopilot.speed, this.apState, this.ctx.obs, dt);
    }
    const it = this.intent;
    const kb = it.device === 'keyboard';
    let throttle: number;
    let brake: number;
    if (kb) {
      throttle = Math.max(0, it.move[1]);
      brake = Math.max(0, -it.move[1]);
    } else {
      throttle = it.rt;
      brake = it.lt;
    }
    // Hold B to kill the engine for a silent coast; tap toggles headlights.
    if (isHeld(it, Btn.B) && heldFor(it, Btn.B) > 0.45) {
      if (v.engineOn) {
        v.setEngine(false);
        this.note('Engine off: silent coast', 'info');
      }
    }
    if (!v.engineOn && (throttle > 0.2) && v.fuel > 0.001 && !(isHeld(it, Btn.B) && heldFor(it, Btn.B) > 0.45)) {
      v.setEngine(true);
    }
    void dt;
    return { steer: it.move[0], throttle, brake, handbrake: it.handbrake };
  }

  // ------------------------------------------------------------------ damage

  hurt(amount: number, fromX: number, fromZ: number, kind: 'bullet' | 'melee' | 'blast' | 'fall' | 'fire' | 'bite' | 'spore' | 'ram') {
    if (this.state === 'dead' || this.invuln > 0) return;
    const ctx = this.ctx;
    const dmg = amount * (kind === 'bite' || kind === 'melee' ? 1 : 1) * ctx.campaign.difficulty.damage;
    this.sinceHit = 0;
    this.lastHurtDir = Math.atan2(fromX - this.pos.x, fromZ - this.pos.z);
    // Taking a hit interrupts hold actions such as repairs.
    if (this.action && this.action.kind !== 'revive' && kind !== 'spore') {
      this.action = null;
    }
    if (this.state === 'downed') {
      // Hits on a downed player speed up the bleed-out.
      this.downT += dmg * 0.04;
      return;
    }
    if (this.inVehicle) return; // vehicle takes hits instead
    this.hp = Math.max(0, this.hp - dmg);
    if (kind !== 'bite' || this.hitCooldown <= 0) {
      this.cam.addShake(Math.min(0.6, dmg / 60));
      ctx.input.rumble(this.index, Math.min(1, dmg / 30), 0.5, 100);
      this.hitCooldown = 0.25;
      if (kind === 'bullet') ctx.audio.play('hit', this.pos.x, this.pos.z, 0.6);
    }
    if (this.hp <= 0) this.goDown();
  }

  private goDown() {
    this.state = 'downed';
    this.downT = 0;
    this.pinned = 0;
    this.action = null;
    this.equip = 'pistol';
    this.ctx.campaign.stats.downs[this.index]++;
    this.ctx.radio(t('radio.downed', { name: this.name }));
    this.note('You are down! Wait for your partner to revive you.', 'bad');
    this.partner?.note(`${this.name} is down: hold A near them to revive`, 'warn');
  }

  heal(amount: number) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  revive() {
    this.state = 'foot';
    this.hp = this.maxHp * 0.4;
    this.downT = 0;
    this.invuln = 1.2;
    this.ctx.radio(t('radio.revived', { name: this.name }));
    this.ctx.campaign.stats.revives[1 - this.index]++;
  }

  // ------------------------------------------------------------------ enter / exit

  nearestDoor(): { v: Vehicle; seat: 'driver' | 'gunner'; d: number } | null {
    let best: { v: Vehicle; seat: 'driver' | 'gunner'; d: number } | null = null;
    for (const v of this.ctx.vehicles) {
      if (v.wreck || v.faction !== 'convoy' || v.kind === 'crew') continue;
      const pos = v.position;
      const dc = Math.hypot(pos.x - this.pos.x, pos.z - this.pos.z);
      const reach = v.def.length * 0.5 + 1.6;
      if (dc > reach) continue;
      if (Math.abs(v.speed) > 2.2) continue;
      // Gunner seat: partner may ride the bed of a Tier 3.
      if (!v.driver && !(this.partner && this.partner.vehicle === v && this.partner.state === 'driving' && false)) {
        const d1 = Math.min(...[1, -1].map((s) => Math.hypot(v.doorPos(s as 1 | -1)[0] - this.pos.x, v.doorPos(s as 1 | -1)[2] - this.pos.z)));
        if (!best || d1 < best.d) best = { v, seat: 'driver', d: d1 };
      } else if (v.driver && v.driver !== this && v.def.seats >= 2 && !v.passenger && v.def.weapon === 'bedMG') {
        const g = v.gunnerPos();
        const d2 = Math.hypot(g[0] - this.pos.x, g[2] - this.pos.z);
        if (d2 < 3.2 && (!best || d2 < best.d)) best = { v, seat: 'gunner', d: d2 };
      }
    }
    return best;
  }

  tryEnter(): boolean {
    const door = this.nearestDoor();
    if (!door) return false;
    this.state = 'entering';
    this.enterT = 0;
    this.enterFrom.copy(this.pos);
    this.enterTo = door.v;
    this.enterSeat = door.seat;
    this.action = null;
    return true;
  }

  private finishEnter() {
    const v = this.enterTo;
    if (!v) {
      this.state = 'foot';
      return;
    }
    this.vehicle = v;
    if (this.enterSeat === 'driver') {
      v.driver = this;
      this.ownVehicle = v.ownerIndex === this.index ? v : this.ownVehicle;
      this.state = 'driving';
      if (v.fuel > 0.001) v.setEngine(true);
      if (this.ctx.night > 0.45) v.lights = true;
    } else {
      v.passenger = { index: this.index };
      this.state = 'gunner';
    }
    this.equip = 'pistol';
    this.cam.snap();
    this.aimYaw = v.yaw;
    this.aimPitch = 0.05;
    this.enterTo = null;
    if (this.ctx.biome === 'city' && this.ctx.night < 0.4) this.note('Engines are Noise in the city: park and walk to stay quiet', 'info');
  }

  /** Leave the vehicle. `bail` is a tuck-and-roll at speed. */
  exitVehicle(bail: boolean) {
    const v = this.vehicle;
    if (!v) return;
    const spot = v.exitSpot();
    const speed = Math.abs(v.speed);
    if (this.state === 'driving') {
      v.driver = null;
      v.setEngine(false);
      v.lights = false;
    } else v.passenger = null;
    this.vehicle = null;
    this.state = 'foot';
    this.pos.set(spot.x, this.ctx.groundAt(spot.x, spot.z) + 0.1, spot.z);
    this.prevPos.copy(this.pos);
    this.body.setTranslation({ x: spot.x, y: this.pos.y + BODY_H / 2, z: spot.z }, true);
    this.vy = 0;
    this.yaw = v.yaw;
    this.aimYaw = v.yaw;
    this.cam.snap();
    if (bail && speed > 3) {
      const dmg = 10 + clamp(speed / 20, 0, 1) * 20;
      this.hurt(dmg, spot.x, spot.z, 'fall');
      this.note(`Bailed out at ${(speed * 3.6).toFixed(0)} km/h`, 'warn');
    }
  }

  // ------------------------------------------------------------------ tick

  update(dt: number) {
    const ctx = this.ctx;
    const it = this.intent;
    this.prevPos.copy(this.pos);
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    this.sinceHit += dt;
    for (const n of this.notes) n.t -= dt;
    while (this.notes.length && this.notes[0].t <= 0) this.notes.shift();
    this.commandWheel = isHeld(it, Btn.Up) && this.state !== 'dead';
    this.sheet = isHeld(it, Btn.Back) && heldFor(it, Btn.Back) > 0.25;
    if (this.fireCd > 0) this.fireCd -= dt;
    if (this.meleeCd > 0) this.meleeCd -= dt;
    if (this.muzzleT > 0) this.muzzleT -= dt;
    if (this.reloadT > 0) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) this.finishReload();
    }
    this.prompt = null;
    // A seated player must not collide: a kinematic capsule inside the cab would shove the chassis into the ground.
    const wantBody = this.state === 'foot' || this.state === 'downed';
    if (wantBody !== this.colliderOn) {
      this.body.setEnabled(wantBody);
      this.colliderOn = wantBody;
    }

    switch (this.state) {
      case 'foot':
        this.updateFoot(dt, it);
        break;
      case 'entering':
        this.updateEntering(dt);
        break;
      case 'driving':
        this.updateDriving(dt, it);
        break;
      case 'gunner':
        this.updateGunner(dt, it);
        break;
      case 'downed':
        this.updateDowned(dt, it);
        break;
      case 'dead':
        this.updateDead(dt);
        break;
    }
    if (!this.commandWheel) this.updateCamera(dt, it);
    else this.updateCamera(dt, it);

    // Signature meter for the HUD.
    this.signatureShown = this.currentSignature();
    if (this.state === 'foot' || this.state === 'downed') {
      const s = this.footSignature();
      if (s > 0) ctx.sig.emit(this.pos.x, this.pos.z, s * ctx.signatureMult, 'noise');
    }
  }

  footSignature(): number {
    if (this.state === 'downed') return 8;
    if (this.state !== 'foot') return 0;
    if (this.moveSpeed > 4.5) return 20;
    if (this.moveSpeed > 0.5) return this.crouch ? 3 : 8;
    return this.crouch ? 2 : 3;
  }

  currentSignature(): number {
    if (this.vehicle && (this.state === 'driving' || this.state === 'gunner')) return Math.round(this.vehicle.signature());
    return this.footSignature() + (this.muzzleT > 0 ? 60 : 0);
  }

  // ------------------------------------------------------------------ on foot

  private updateFoot(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    this.updateAim(dt, it);
    // Movement relative to the camera.
    let mx = it.move[0];
    let my = it.move[1];
    const mag = Math.hypot(mx, my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }
    if (it.device !== 'pad' && it.move[1] === 0 && it.move[0] === 0) {
      // keep idle
    }
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    const rx = -Math.cos(this.aimYaw);
    const rz = Math.sin(this.aimYaw);
    let wx = fx * my + rx * mx;
    let wz = fz * my + rz * mx;
    const aiming = this.ads > 0.35;
    const wantSprint = it.sprint && my > 0.3 && !aiming && !this.crouch && this.equip !== 'jerrycan';
    // Crouch is a toggle on B (hold option via settings), cancelled by sprint.
    if (wasPressed(it, Btn.B)) this.crouch = !this.crouch;
    if (wantSprint) this.crouch = false;
    let speed = wantSprint ? SPRINT : this.crouch ? CROUCH : WALK;
    if (aiming) speed = Math.min(speed, 2.3);
    if (this.equip === 'jerrycan') speed *= 0.82;
    if (this.pinned >= ENEMIES.zombieRules.pinAt) speed = 0;
    // Fatigue from watch duty slows the next day.
    speed *= 1 - clamp(this.fatigue, 0, 0.2);
    this.moveSpeed = damp(this.moveSpeed, Math.hypot(wx, wz) * speed, 14, dt);
    const targetVx = wx * speed;
    const targetVz = wz * speed;
    // Facing: toward the aim when aiming or shooting, otherwise toward travel.
    if (aiming || this.muzzleT > 0 || isHeld(it, Btn.RT)) this.yaw = dampAngle(this.yaw, this.aimYaw, 16, dt);
    else if (mag > 0.15 && speed > 0) this.yaw = dampAngle(this.yaw, Math.atan2(targetVx, targetVz), 12, dt);
    this.moveBody(dt, targetVx, targetVz);

    // Pin: break free with five left-stick rotations.
    if (this.pinned >= ENEMIES.zombieRules.pinAt) {
      this.pinBreak += it.stickLoops;
      if (this.pinBreak >= ENEMIES.zombieRules.pinBreakRotations) {
        this.pinBreak = 0;
        ctx.zombies.breakGrab(this);
        this.note('Broke free!', 'good');
      }
    } else this.pinBreak = Math.max(0, this.pinBreak - dt * 0.3);

    this.updateTools(dt, it);
    this.updateInteractions(dt, it);

    // Pick up swap: LB cycles equipment.
    if (!this.buildMode && wasPressed(it, Btn.LB)) this.cycleEquip();
    if (heldFor(it, Btn.X) > 0.6 && isHeld(it, Btn.X) && !this.action) {
      // hold X: swap utility item
      if (it.heldTime[Btn.X] < 0.6 + dt * 1.5 && it.heldTime[Btn.X] >= 0.6) this.cycleUtility();
    }
    if (wasPressed(it, Btn.R3)) this.cam.snap();
    // Y: enter / exit.
    if (wasPressed(it, Btn.Y)) {
      if (!this.tryEnter()) this.note('No vehicle in reach', 'info');
    }
    // Ground hazards: spore clouds are handled by the zombie system.
  }

  private moveBody(dt: number, vx: number, vz: number) {
    const ctx = this.ctx;
    this.vy -= 22 * dt;
    if (this.vy < -30) this.vy = -30;
    const desired = { x: vx * dt, y: this.vy * dt, z: vz * dt };
    this.kcc.computeColliderMovement(this.collider, desired, undefined, RAY_STATIC);
    const m = this.kcc.computedMovement();
    this.grounded = this.kcc.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = 0;
    // The body is the capsule centre: update our feet position from it.
    const t = this.body.translation();
    const nx = t.x + m.x;
    const ny = t.y + m.y;
    const nz = t.z + m.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });
    this.body.setTranslation({ x: nx, y: ny, z: nz }, false);
    this.pos.set(nx, ny - BODY_H / 2, nz);
    // Hard floor in case a heightfield seam lets us fall.
    const gy = ctx.groundAt(nx, nz);
    if (this.pos.y < gy - 2) {
      this.pos.y = gy + 0.5;
      this.body.setTranslation({ x: nx, y: gy + 0.5 + BODY_H / 2, z: nz }, true);
      this.vy = 0;
    }
    if (ctx.bounds) {
      const b = ctx.bounds;
      const cx = clamp(this.pos.x, b.minX, b.maxX);
      const cz = clamp(this.pos.z, b.minZ, b.maxZ);
      if (cx !== this.pos.x || cz !== this.pos.z) {
        this.pos.x = cx;
        this.pos.z = cz;
        this.body.setTranslation({ x: cx, y: this.pos.y + BODY_H / 2, z: cz }, true);
      }
    }
  }

  private updateAim(dt: number, it: PlayerIntent) {
    const sens = lerp(2.9, 1.55, this.ads) * (it.device === 'keyboard' ? 0.9 : 1);
    this.aimYaw -= it.look[0] * sens * dt;
    this.aimPitch = clamp(this.aimPitch + it.look[1] * sens * 0.7 * dt, -0.55, 0.75);
    this.ads = damp(this.ads, it.lt > 0.3 && this.equip === 'pistol' ? 1 : it.device === 'keyboard' && isHeld(it, Btn.RT) ? 1 : 0, 12, dt);
    if (it.device === 'keyboard') this.aimPitch = damp(this.aimPitch, 0.04, 3, dt);
  }

  /** Raycast from the camera through the reticle and find where the shot lands. */
  computeAim(ignoreVehicle?: Vehicle | null) {
    const ctx = this.ctx;
    const cam = this.ctx.R.views[this.index].camera;
    cam.updateMatrixWorld();
    cam.getWorldDirection(_v);
    const ox = cam.position.x;
    const oy = cam.position.y;
    const oz = cam.position.z;
    let dist = 80;
    const r = ctx.P.raycast(ox, oy, oz, _v.x, _v.y, _v.z, 80, RAY_STATIC, ignoreVehicle?.body.body);
    if (r) dist = Math.min(dist, r.toi);
    const zr = ctx.zombies.rayTest(ox, oy, oz, _v.x, _v.y, _v.z, dist);
    if (zr) dist = Math.min(dist, zr.dist);
    const ir = ctx.raiders.infantryRayTest(ox, oy, oz, _v.x, _v.y, _v.z, dist);
    if (ir) dist = Math.min(dist, ir.dist);
    // Ignore the player's own body: skip hits closer than the camera-to-player distance.
    const toPlayer = Math.hypot(this.pos.x - ox, this.pos.z - oz);
    if (dist < toPlayer * 0.9 && dist < 80) dist = Math.max(dist, toPlayer + 1);
    this.aimDist = dist;
    this.aimPoint.set(ox + _v.x * dist, oy + _v.y * dist, oz + _v.z * dist);
    return { ox, oy, oz, dx: _v.x, dy: _v.y, dz: _v.z };
  }

  private muzzlePos(): [number, number, number] {
    const f = this.aimYaw;
    return [this.pos.x + Math.sin(f) * 0.45 - Math.cos(f) * 0.18, this.pos.y + (this.crouch ? 0.95 : 1.4), this.pos.z + Math.cos(f) * 0.45 + Math.sin(f) * 0.18];
  }

  private cycleEquip() {
    const order: Equip[] = ['pistol', 'wrench', 'jerrycan', 'utility'];
    let i = order.indexOf(this.equip);
    this.action = null;
    for (let n = 0; n < 4; n++) {
      i = (i + 1) % order.length;
      if (order[i] === 'utility' && this.ctx.campaign.items[this.utility === 'horn' ? 'flare' : (this.utility as 'flare' | 'molotov' | 'charge')] <= 0 && this.utility !== 'horn') continue;
      break;
    }
    this.equip = order[i];
    this.reloadT = 0;
  }

  private cycleUtility() {
    const i = UTILITIES.indexOf(this.utility);
    this.utility = UTILITIES[(i + 1) % UTILITIES.length];
    this.ctx.campaign.players[this.index].utility = this.utility;
    this.note(`Utility: ${utilityName(this.utility)}`, 'info');
  }

  private finishReload() {
    const camp = this.ctx.campaign;
    const need = 12 - this.mag;
    const take = Math.min(need, camp.ammo);
    this.mag += take;
    camp.ammo -= take;
    if (take === 0 && this.mag === 0) this.note('Out of ammo: craft more at camp', 'warn');
  }

  private updateTools(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    if (this.buildMode) {
      ctx.campHook?.(this, it, dt);
      return;
    }
    if (this.equip === 'pistol') {
      if (wasPressed(it, Btn.X) && this.mag < 12 && this.reloadT <= 0 && ctx.campaign.ammo > 0) {
        this.reloadT = 1.3;
        ctx.audio.play('reload', this.pos.x, this.pos.z, 0.5);
      }
      const wantFire = it.rt > 0.5 && (it.device !== 'pad' || this.ads > 0.0 || true);
      if (wantFire && this.fireCd <= 0 && this.reloadT <= 0) {
        if (this.mag > 0) this.firePistol();
        else if (ctx.campaign.ammo > 0) {
          this.reloadT = 1.3;
        } else if (this.fireCd <= 0) {
          this.fireCd = 0.4;
          this.note('Out of ammo: craft more at camp', 'warn');
        }
      }
      // RB: melee tap, takedown hold.
      this.updateMelee(dt, it);
    } else if (this.equip === 'utility') {
      if (wasPressed(it, Btn.RT)) this.useUtility();
      this.updateMelee(dt, it);
    } else {
      this.updateMelee(dt, it);
    }
  }

  private firePistol() {
    const ctx = this.ctx;
    const a = this.computeAim();
    const [mx, my, mz] = this.muzzlePos();
    let dx = this.aimPoint.x - mx;
    let dy = this.aimPoint.y - my;
    let dz = this.aimPoint.z - mz;
    const l = Math.hypot(dx, dy, dz);
    if (l < 2.5) {
      dx = a.dx;
      dy = a.dy;
      dz = a.dz;
    } else {
      dx /= l;
      dy /= l;
      dz /= l;
    }
    this.fireCd = 0.2;
    this.mag--;
    this.muzzleT = 0.12;
    ctx.combat.shoot(mx, my, mz, dx, dy, dz, {
      side: 'convoy',
      damage: 27 * ctx.campaign.players[this.index].mods.weapon * 0 + 27,
      spread: lerp(0.03, 0.008, this.ads) * (this.crouch ? 0.7 : 1) * (this.moveSpeed > 3 ? 1.6 : 1),
      assist: it0(this.intent.aimAssist),
      noise: 60,
      range: 75,
      headshots: true,
      owner: this,
    });
    ctx.fx.flash(mx, my, mz, 0.9);
    ctx.audio.play('pistol', mx, mz, 0.8);
    this.cam.addShake(0.05);
    ctx.input.rumble(this.index, 0.15, 0.3, 50);
  }

  private updateMelee(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const heldRB = isHeld(it, Btn.RB);
    const rbTime = heldFor(it, Btn.RB);
    const tk = ctx.zombies.takedownTarget(this);
    if (heldRB && rbTime > 0.22 && tk) {
      this.takedownT += dt;
      this.prompt = { text: t('prompt.takedown'), progress: this.takedownT / 1.2, button: 'RB' };
      this.moveSpeed = 0.3;
      if (this.takedownT >= 1.2) {
        this.takedownT = 0;
        ctx.zombies.takedown(tk, this.index);
        ctx.sig.emit(this.pos.x, this.pos.z, 4, 'noise');
        this.note('Silent takedown', 'good');
      }
      return;
    }
    this.takedownT = 0;
    if (it.released & (1 << Btn.RB) && rbTime < 0.3 && this.meleeCd <= 0) this.melee();
    else if (wasPressed(it, Btn.RB) && !tk && this.meleeCd <= 0 && false) this.melee();
    else if (tk && !heldRB) this.prompt = { text: `Hold RB: ${t('prompt.takedown')}`, progress: -1, button: 'RB' };
  }

  private melee() {
    const ctx = this.ctx;
    this.meleeCd = 0.55;
    const f = this.aimYaw;
    const hx = this.pos.x + Math.sin(f) * 1.0;
    const hz = this.pos.z + Math.cos(f) * 1.0;
    ctx.audio.play('swing', this.pos.x, this.pos.z, 0.5);
    ctx.zombies.meleeHit(this, hx, hz, f, 1.9, 35);
    ctx.raiders.meleeHit(this, hx, hz, f, 1.9, 35);
    ctx.sig.emit(this.pos.x, this.pos.z, 12, 'noise');
    this.cam.addShake(0.08);
  }

  private useUtility() {
    const ctx = this.ctx;
    const camp = ctx.campaign;
    const a = this.computeAim();
    const [mx, my, mz] = this.muzzlePos();
    const dir = [a.dx, Math.max(a.dy, 0) + 0.35, a.dz] as const;
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    switch (this.utility) {
      case 'flare':
        if (camp.items.flare <= 0) return this.note('No flares left: craft some at camp', 'warn');
        camp.items.flare--;
        ctx.projectiles.throw('flare', mx, my, mz, (dir[0] / dl) * 16, (dir[1] / dl) * 16, (dir[2] / dl) * 16, this);
        break;
      case 'molotov':
        if (camp.items.molotov <= 0) return this.note('No molotovs left: craft some at camp', 'warn');
        camp.items.molotov--;
        ctx.projectiles.throw('molotov', mx, my, mz, (dir[0] / dl) * 15, (dir[1] / dl) * 15, (dir[2] / dl) * 15, this);
        break;
      case 'charge': {
        if (camp.items.charge <= 0) return this.note('No breaching charges: craft one at camp', 'warn');
        const target = ctx.projectiles.nearestBreachable(this.pos.x, this.pos.z, 4.5);
        if (!target) return this.note('Stand next to a reinforced barricade to place a charge', 'info');
        camp.items.charge--;
        ctx.projectiles.placeCharge(target, this);
        break;
      }
      case 'horn':
        ctx.projectiles.decoy(this.pos.x + Math.sin(this.aimYaw) * 1.2, this.pos.z + Math.cos(this.aimYaw) * 1.2);
        this.note('Decoy horn planted', 'info');
        break;
    }
  }

  // ------------------------------------------------------------------ interactions

  private updateInteractions(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const heldA = isHeld(it, Btn.A);
    type Cand = { kind: string; prompt: string; dur: number; target: unknown; ok: boolean; run: () => void; label: string; tick?: () => boolean };
    let cand: Cand | null = null;

    // 1. Revive the partner.
    const pt = this.partner;
    if (pt && pt.state === 'downed' && Math.hypot(pt.pos.x - this.pos.x, pt.pos.z - this.pos.z) < 2.4) {
      const med = ctx.campaign.items.medkit > 0;
      cand = {
        kind: 'revive',
        prompt: t('prompt.revive') + (med ? ' (medkit)' : ''),
        dur: med ? 3.4 : 6.5,
        target: pt,
        ok: true,
        label: 'revive',
        run: () => {
          if (med) ctx.campaign.items.medkit--;
          pt.revive();
          this.note(`${pt.name} is up`, 'good');
        },
      };
    }
    // 2. Repair with the wrench; 3. refuel with the jerrycan.
    if (!cand && (this.equip === 'wrench' || this.equip === 'jerrycan')) {
      const v = this.nearestOwnVehicle(3.8);
      if (v) {
        if (this.equip === 'wrench') {
          const need = needsRepair(v.health);
          cand = {
            kind: 'repair',
            prompt: need ? t('prompt.repair') : 'Vehicle is in good shape',
            dur: 6,
            target: v,
            ok: need && ctx.campaign.stocks.scrap >= 1,
            label: 'repair',
            run: () => {
              if (ctx.campaign.stocks.scrap < 2) return this.note('Not enough Scrap', 'warn');
              ctx.campaign.stocks.scrap -= 2;
              const r = v.repair();
              this.note(r === 'hp' ? 'Repaired' : `Fixed: ${r}`, 'good');
              ctx.audio.play('wrench', v.position.x, v.position.z, 0.7);
            },
            tick: () => {
              if (Math.random() < 0.15) ctx.fx.spark(v.position.x, v.position.y + 0.8, v.position.z, 2, 3);
              return true;
            },
          };
          if (need && ctx.campaign.stocks.scrap < 1) cand.prompt = 'Not enough Scrap to repair';
        } else {
          const space = v.tankMax - v.fuel;
          cand = {
            kind: 'refuel',
            prompt: space > 0.4 ? t('prompt.refuel') : 'Tank is full',
            dur: 4,
            target: v,
            ok: space > 0.4 && ctx.campaign.stocks.fuel > 0.4,
            label: 'refuel',
            run: () => {
              const amt = Math.min(5, space, ctx.campaign.stocks.fuel);
              v.fuel += amt;
              ctx.campaign.stocks.fuel -= amt;
              this.note(`+${amt.toFixed(1)} FU`, 'good');
            },
          };
          if (space > 0.4 && ctx.campaign.stocks.fuel <= 0.4) cand.prompt = 'Convoy reserve is empty';
        }
      }
    }
    // 4. Registry items (loot containers, camp posts).
    if (!cand) {
      const r = ctx.interact.nearest(this);
      if (r) {
        cand = {
          kind: 'reg:' + r.id,
          prompt: r.prompt,
          dur: r.dur,
          target: r,
          ok: true,
          label: r.id,
          run: () => r.run(this),
          tick: () => r.onTick?.(this, this.action?.t ?? 0) !== false,
        };
      }
    }

    // Enter prompt when nothing else is going on and a vehicle is near.
    if (!cand) {
      const door = this.nearestDoor();
      if (door) this.prompt = { text: door.seat === 'gunner' ? 'Ride gunner seat' : t('prompt.enter'), progress: -1, button: 'Y' };
    }

    if (cand) {
      if (this.action && this.action.kind === cand.kind && this.action.target === cand.target) {
        if (!heldA || !cand.ok) {
          this.action = null;
        } else {
          this.action.t += dt;
          this.moveSpeed = Math.min(this.moveSpeed, 0.5);
          if (cand.tick && cand.tick() === false) this.action = null;
          else if (this.action.t >= this.action.dur) {
            const run = cand.run;
            this.action = null;
            run();
            ctx.sig.emit(this.pos.x, this.pos.z, cand.kind === 'repair' ? 22 : 12, 'noise');
          }
        }
      } else if (heldA && cand.ok && wasPressedOrFresh(it)) {
        this.action = { kind: cand.kind, t: 0, dur: cand.dur, target: cand.target, label: cand.label };
      } else if (this.action) {
        this.action = null;
      }
      this.prompt = {
        text: cand.prompt,
        progress: this.action && this.action.kind === cand.kind ? this.action.t / this.action.dur : -1,
        button: 'A',
      };
      if (!cand.ok && !this.action) this.prompt.progress = -1;
    } else if (this.action) {
      this.action = null;
    }
    if (this.action) this.speedPenalty();
  }

  private speedPenalty() {
    this.moveSpeed *= 0.2;
  }

  private nearestOwnVehicle(r: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bd = Infinity;
    for (const v of this.ctx.vehicles) {
      if (v.faction !== 'convoy' || v.wreck) continue;
      const d = Math.hypot(v.position.x - this.pos.x, v.position.z - this.pos.z) - v.def.length * 0.4;
      if (d < r && d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ entering / driving / gunner

  private updateEntering(dt: number) {
    this.enterT += dt;
    const v = this.enterTo;
    if (!v || v.wreck) {
      this.state = 'foot';
      return;
    }
    const k = clamp(this.enterT / 0.45, 0, 1);
    const seat = this.enterSeat === 'driver' ? v.body.toWorld(0, -0.4, -0.1) : v.gunnerPos();
    this.pos.set(lerp(this.enterFrom.x, seat[0], k), lerp(this.enterFrom.y, seat[1] - 0.6, k), lerp(this.enterFrom.z, seat[2], k));
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y + BODY_H / 2, z: this.pos.z }, false);
    this.moveSpeed = 0;
    if (k >= 1) this.finishEnter();
  }

  private updateDriving(dt: number, it: PlayerIntent) {
    const v = this.vehicle;
    const ctx = this.ctx;
    if (!v || v.wreck) {
      this.vehicle = null;
      this.state = 'foot';
      return;
    }
    this.lastKnownVehicleSpeed = v.speed;
    const p = v.position;
    this.pos.set(p.x, p.y, p.z);
    this.body.setTranslation({ x: p.x, y: p.y + 1.0, z: p.z }, false);
    // Horn / siren
    if (wasPressed(it, Btn.X)) {
      v.hornT = 0.6;
      ctx.audio.play('horn', p.x, p.z, 1);
    }
    if (heldFor(it, Btn.X) > 0.5 && isHeld(it, Btn.X)) {
      v.sirenT = 0.3;
    }
    if (it.released & (1 << Btn.B) && heldFor(it, Btn.B) < 0.45 && it.heldTime[Btn.B] < 0.45) {
      v.lights = !v.lights;
    }
    // Fire the vehicle gun. T2 fires along the nose; T3's gun belongs to the gunner.
    if (v.def.weapon === 'frontLMG' && (isHeld(it, Btn.RB) || (it.device === 'pad' && false))) v.fireGun(dt);
    // Camera toggles
    if (wasPressed(it, Btn.L3)) this.camFar = !this.camFar;
    this.lookBack = isHeld(it, Btn.R3);
    // Exit: tap Y when slow; hold Y to bail at speed.
    if (isHeld(it, Btn.Y)) {
      const slow = Math.abs(v.speed) < 2.2;
      if (slow && wasPressed(it, Btn.Y)) this.exitVehicle(false);
      else if (!slow && heldFor(it, Btn.Y) > 0.6) this.exitVehicle(true);
    }
    // Low fuel / fire warnings.
    if (v.fuel < v.tankMax * 0.15 && v.fuel > 0.001 && Math.random() < dt * 0.05) this.note('Fuel is low', 'warn');
    if (this.ctx.biome === 'city' && ctx.night < 0.4 && Math.abs(v.speed) > 5) {
      /* noise tip handled elsewhere */
    }
  }

  private updateGunner(dt: number, it: PlayerIntent) {
    const v = this.vehicle;
    if (!v || v.wreck) {
      this.vehicle = null;
      this.state = 'foot';
      return;
    }
    const p = v.gunnerPos();
    this.pos.set(p[0], p[1] - 0.2, p[2]);
    this.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, false);
    // Aim the bed gun with the right stick (keyboard turns with Q/E).
    this.ads = damp(this.ads, it.lt > 0.3 ? 1 : 0, 10, dt);
    const sens = lerp(2.6, 1.4, this.ads);
    this.aimYaw -= it.look[0] * sens * dt;
    this.aimPitch = clamp(this.aimPitch + it.look[1] * sens * 0.7 * dt, -0.35, 0.8);
    if (it.device === 'keyboard') this.aimPitch = damp(this.aimPitch, 0.08, 3, dt);
    const a = this.computeAim(v);
    v.gunAim = { x: this.aimPoint.x, y: this.aimPoint.y, z: this.aimPoint.z };
    const firing = it.rt > 0.5 || isHeld(it, Btn.RB);
    if (firing) {
      // Direction from the muzzle to where the reticle lands.
      const m = new THREE.Vector3();
      v.visual.muzzle.updateWorldMatrix(true, false);
      m.setFromMatrixPosition(v.visual.muzzle.matrixWorld);
      let dx = this.aimPoint.x - m.x;
      let dy = this.aimPoint.y - m.y;
      let dz = this.aimPoint.z - m.z;
      const l = Math.hypot(dx, dy, dz);
      if (l < 3) {
        dx = a.dx;
        dy = a.dy;
        dz = a.dz;
      } else {
        dx /= l;
        dy /= l;
        dz /= l;
      }
      if (v.fireGun(dt, [dx, dy, dz])) {
        this.cam.addShake(0.04);
        this.ctx.input.rumble(this.index, 0.1, 0.35, 40);
      }
    }
    if (wasPressed(it, Btn.Y)) this.exitVehicle(false);
    this.prompt = { text: 'Gunner: RT to fire, Y to exit', progress: -1, button: 'RT' };
    // Only show the hint briefly.
    if (this.ctx.time > 14) this.prompt = null;
  }

  // ------------------------------------------------------------------ downed / dead

  private updateDowned(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const bleed = ENEMIES.zombieRules.bleedOut * (ctx.campaign.stocks.medicine <= 0 ? 0.7 : 1);
    this.downT += dt;
    // Crawl slowly.
    const fx = Math.sin(this.aimYaw);
    const fz = Math.cos(this.aimYaw);
    const rx = -Math.cos(this.aimYaw);
    const rz = Math.sin(this.aimYaw);
    const vx = fx * it.move[1] + rx * it.move[0];
    const vz = fz * it.move[1] + rz * it.move[0];
    this.aimYaw -= it.look[0] * 1.6 * dt;
    this.moveSpeed = damp(this.moveSpeed, Math.hypot(vx, vz) * 0.9, 8, dt);
    if (this.moveSpeed > 0.1) this.yaw = dampAngle(this.yaw, Math.atan2(vx, vz), 6, dt);
    this.moveBody(dt, vx * 0.9, vz * 0.9);
    if (this.downT >= bleed) {
      this.state = 'dead';
      this.respawnT = 8;
      this.ctx.radio(`${this.name} bled out.`);
      this.note('You bled out. Respawning at the convoy for a Scrap fee…', 'bad');
    }
    this.prompt = { text: `${t('prompt.revive').replace('Hold to ', 'Waiting for ')} (${Math.max(0, Math.ceil(bleed - this.downT))}s)`, progress: -1, button: 'A' };
    this.prompt = { text: `Bleeding out: ${Math.max(0, Math.ceil(bleed - this.downT))}s`, progress: clamp(this.downT / bleed, 0, 1), button: 'A' };
  }

  private updateDead(dt: number) {
    this.respawnT -= dt;
    this.human.root.visible = false;
    const pt = this.partner;
    this.prompt = { text: `Respawn in ${Math.max(0, Math.ceil(this.respawnT))}s`, progress: -1, button: 'A' };
    if (this.respawnT <= 0) {
      // Respawn at the convoy: near the partner or the nearest convoy vehicle.
      const ref = pt && pt.alive ? pt.pos : this.ownVehicle ? this.ownVehicle.position : this.pos;
      const ang = Math.random() * Math.PI * 2;
      this.placeAt(ref.x + Math.cos(ang) * 3, ref.z + Math.sin(ang) * 3, this.yaw);
      this.state = 'foot';
      this.hp = this.maxHp * 0.5;
      this.invuln = 2;
      const fee = Math.min(10, this.ctx.campaign.stocks.scrap);
      this.ctx.campaign.stocks.scrap -= fee;
      this.note(`Back on your feet (-${fee} Scrap)`, 'warn');
    }
  }

  // ------------------------------------------------------------------ camera & visuals

  private updateCamera(dt: number, it: PlayerIntent) {
    const ctx = this.ctx;
    const v = this.vehicle;
    let mode: CamMode = 'foot';
    let target = { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, speed: 0, topSpeed: 10 };
    // The blueprint says 3.2 m / 1.6 m, but on a 3.5:1 strip that fills most of the height. Pulled back so it reads.
    let dist = 4.9;
    let height = 2.15;
    if (this.state === 'driving' && v) {
      mode = 'vehicle';
      const p = v.position;
      target = { x: p.x, y: p.y, z: p.z, yaw: v.yaw, speed: Math.abs(v.speed), topSpeed: v.topSpeed };
      dist = v.def.camera.dist * (this.camFar ? 1.35 : 1);
      height = v.def.camera.height * (this.camFar ? 1.3 : 1);
    } else if (this.state === 'gunner' && v) {
      mode = 'gunner';
      const g = v.gunnerPos();
      target = { x: g[0], y: g[1] - 1.0, z: g[2], yaw: v.yaw, speed: Math.abs(v.speed), topSpeed: v.topSpeed };
      dist = 4.4;
      height = 1.9;
    } else if (this.state === 'downed' || this.state === 'dead') {
      mode = 'downed';
    }
    this.cam.update(dt, target, mode, {
      dist,
      height,
      aimYaw: this.aimYaw,
      aimPitch: this.aimPitch,
      lookYaw: -it.look[0] * 1.1,
      lookPitch: it.look[1],
      shoulder: this.shoulder,
      lookBack: this.lookBack,
      zoom: this.ads,
    });
    void ctx;
  }

  /** Called every render frame. */
  syncVisual(alpha: number, dt: number) {
    const h = this.human;
    const showOnFoot = this.state === 'foot' || this.state === 'downed' || this.state === 'entering';
    h.root.visible = showOnFoot;
    if (!showOnFoot) return;
    const x = lerp(this.prevPos.x, this.pos.x, alpha);
    const y = lerp(this.prevPos.y, this.pos.y, alpha);
    const z = lerp(this.prevPos.z, this.pos.z, alpha);
    h.root.position.set(x, y, z);
    h.root.rotation.y = this.yaw;
    const aim = this.equip === 'pistol' ? clamp(this.ads + (this.muzzleT > 0 ? 0.7 : 0), 0, 1) : 0;
    const weapon = this.equip === 'pistol' ? 'pistol' : this.equip === 'wrench' ? 'wrench' : this.equip === 'jerrycan' ? 'jerrycan' : this.utility === 'charge' ? 'none' : this.utility === 'horn' ? 'none' : 'flare';
    h.setWeapon(this.state === 'downed' ? 'none' : (weapon as 'pistol'));
    h.update(dt, this.state === 'downed' ? 'downed' : 'stand', this.moveSpeed, aim, this.crouch ? 1 : 0, this.aimPitch);
    h.muzzle(this.muzzleT > 0.05);
    if (this.invuln > 0) h.root.visible = Math.floor(this.invuln * 12) % 2 === 0;
  }

  destroy() {
    this.ctx.P.world.removeCollider(this.collider, false);
    this.ctx.P.world.removeRigidBody(this.body);
    this.ctx.P.world.removeCharacterController(this.kcc);
    this.human.root.removeFromParent();
    this.human.dispose();
  }
}

function it0(v: number) {
  return v;
}

function wasPressedOrFresh(it: PlayerIntent) {
  return (it.pressed & (1 << Btn.A)) !== 0 || it.heldTime[Btn.A] < 0.4;
}

export function utilityName(u: Utility) {
  return u === 'flare' ? 'Flare' : u === 'molotov' ? 'Molotov' : u === 'charge' ? 'Breaching charge' : 'Decoy horn';
}

export type InteractableLike = Interactable;
