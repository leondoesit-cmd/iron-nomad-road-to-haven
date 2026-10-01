import * as THREE from 'three';
import { PhysicsWorld } from '../physics/physics';
import { Particles, Tracers } from '../render/particles';
import { ZombieRenderer } from '../render/zombieRender';
import { QUALITY, type GameRenderer } from '../render/renderer';
import { SignatureGrid } from '../sim/signature';
import { splitLoot, whole } from '../sim/resources';
import { DayClock, lightAt } from '../sim/dayclock';
import { Rng } from '../core/rng';
import { clamp } from '../core/math';
import { VEHICLES, vehicleDef, STOCK_IDS, type Stocks } from '../data';
import type { Surface, TerrainDef } from '../world/terrain';
import type { Aabb } from '../world/layout';
import type { InputManager } from '../input/input';
import type { AudioEngine, EngineState } from '../audio/audio';
import { Campaign } from './campaign';
import { Combat } from './combat';
import type { Ctx, NoteKind } from './ctx';
import { CrewSystem } from './crew';
import { InteractRegistry } from './interact';
import { ObstacleIndex } from './obstacles';
import { Player } from './player';
import { Projectiles } from './projectiles';
import { RaiderSystem } from './raiders';
import { Vehicle } from './vehicle';
import { ZombieSystem } from './zombies';
import { LABEL } from '../sim/resources';
import { disposeTree } from '../render/dispose';

export interface SceneServices {
  R: GameRenderer;
  audio: AudioEngine;
  input: InputManager;
  campaign: Campaign;
  /** Called with radio subtitles (shown on both halves). */
  onRadio: (text: string) => void;
  onTip: (id: string) => void;
  onBanner?: (title: string, sub: string) => void;
}

/** Shared runtime for a leg or a camp. Implements Ctx so every entity talks to one interface. */
export abstract class Scene implements Ctx {
  P = new PhysicsWorld();
  R: GameRenderer;
  root = new THREE.Group();
  fx = new Particles();
  tracers = new Tracers();
  sig = new SignatureGrid();
  obs = new ObstacleIndex();
  abstract biome: 'wasteland' | 'city';
  abstract mode: 'leg' | 'camp';
  terrain: TerrainDef | null = null;
  campaign: Campaign;
  audio: AudioEngine;
  input: InputManager;
  rng: Rng;
  combat: Combat;
  time = 0;
  night = 0;
  players: Player[] = [];
  vehicles: Vehicle[] = [];
  zombies: ZombieSystem;
  raiders: RaiderSystem;
  crew: CrewSystem;
  vehicleByCollider = new Map<number, Vehicle>();
  interact = new InteractRegistry();
  projectiles: Projectiles;
  signatureMult = 1;
  bounds: Ctx['bounds'] = null;
  campHook?: Ctx['campHook'];
  structureHit?: Ctx['structureHit'];
  clock = new DayClock(540, 0.02);
  protected zr = new ZombieRenderer();
  protected spots: THREE.SpotLight[] = [];
  protected frustums = [new THREE.Frustum(), new THREE.Frustum()];
  private pm = new THREE.Matrix4();
  protected services: SceneServices;
  private sigDecayT = 0;
  protected lootFeed: { text: string; t: number }[] = [];
  private lootAcc: Partial<Stocks> = {};
  private lootAccT = 0;
  private engineT = 0;
  /** Set when the scene wants the Game to react (fail, camp, etc.). */
  onResult: (r: SceneResult) => void = () => {};
  paused = false;
  /** Whole-scene fixed tick count. */
  ticks = 0;
  protected disposed = false;

  constructor(svc: SceneServices) {
    this.services = svc;
    this.R = svc.R;
    this.audio = svc.audio;
    this.input = svc.input;
    this.campaign = svc.campaign;
    this.rng = new Rng(svc.campaign.seed * 977 + svc.campaign.day * 131);
    this.combat = new Combat(this);
    this.zombies = new ZombieSystem(this);
    this.raiders = new RaiderSystem(this);
    this.crew = new CrewSystem(this);
    this.projectiles = new Projectiles(this);
    this.R.scene.add(this.root);
    this.R.scene.add(this.fx.smoke.points);
    this.R.scene.add(this.fx.glow.points);
    this.R.scene.add(this.tracers.mesh);
    this.root.add(this.zr.mesh);
    // Constant light count: two headlight spots always exist, off by default.
    for (let i = 0; i < 2; i++) {
      const s = new THREE.SpotLight(0xfff0c8, 0, 70, 0.5, 0.6, 1.4);
      s.castShadow = false;
      this.root.add(s);
      this.root.add(s.target);
      this.spots.push(s);
    }
  }

  // ------------------------------------------------------------------ Ctx

  abstract groundAt(x: number, z: number): number;
  abstract surfaceAt(x: number, z: number): { grip: number; drag: number; name: Surface };

  notify(player: number, text: string, kind: NoteKind = 'info') {
    if (player < 0) {
      for (const p of this.players) p.note(text, kind);
      return;
    }
    this.players[player]?.note(text, kind);
  }

  radio(text: string) {
    this.services.onRadio(text);
    this.audio.play('radio');
  }

  tip(id: string) {
    this.services.onTip(id);
  }

  /** Loot reaches the convoy minus each crew member's cut, held in escrow. Night scavenging pays a bonus. */
  addLoot(gross: Partial<Stocks>, label = '') {
    const bonus = this.clock.night && this.mode === 'leg' ? 1.5 : 1;
    const g: Partial<Stocks> = {};
    for (const id of STOCK_IDS) if (gross[id]) g[id] = (gross[id] as number) * bonus;
    const crew = this.campaign.crewLive.map((c) => ({ id: c.id, cut: c.cut }));
    const { net, owed } = splitLoot(g, crew);
    for (const id of STOCK_IDS) {
      if (net[id]) this.campaign.stocks[id] += net[id] as number;
    }
    for (const c of this.campaign.crewLive) {
      const o = owed[c.id];
      if (!o) continue;
      for (const id of STOCK_IDS) if (o[id]) c.owed[id] = (c.owed[id] ?? 0) + (o[id] as number);
    }
    for (const id of STOCK_IDS) if (net[id]) this.lootAcc[id] = (this.lootAcc[id] ?? 0) + (net[id] as number);
    this.lootAccT = 0.5;
    void label;
  }

  onVehicleDestroyed(v: Vehicle) {
    this.raiders.onVehicleDestroyed(v);
    if (v.faction !== 'convoy') return;
    // Eject anyone aboard, hurt.
    for (const p of this.players) {
      if (p.vehicle === v) {
        const wasDriver = p.state === 'driving';
        p.vehicle = null;
        p.state = 'foot';
        const spot = v.exitSpot();
        p.pos.set(spot.x, this.groundAt(spot.x, spot.z) + 0.2, spot.z);
        p.body.setTranslation({ x: spot.x, y: p.pos.y + 0.85, z: spot.z }, true);
        p.prevPos.copy(p.pos);
        p.hurt(wasDriver ? 28 : 18, v.position.x, v.position.z, 'blast');
        p.cam.snap();
      }
    }
    v.driver = null;
    v.passenger = null;
    if (v.kind === 'player') {
      this.campaign.stats.vehiclesLost++;
      const owner = this.players[v.ownerIndex];
      if (owner) {
        this.radio(`${owner.name}'s ride is wrecked.`);
        this.campaign.players[v.ownerIndex].alive = false;
      }
    }
    this.audio.play('boom', v.position.x, v.position.z, 1);
  }

  visibleToAnyView(x: number, y: number, z: number, margin = 6): boolean {
    const p = new THREE.Vector3(x, y, z);
    for (let i = 0; i < 2; i++) {
      const f = this.frustums[i];
      if (f.containsPoint(p)) return true;
      // Margin: test points around.
      for (const [dx, dz] of [[margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
        p.set(x + dx, y, z + dz);
        if (f.containsPoint(p)) return true;
      }
      p.set(x, y, z);
    }
    return false;
  }

  breakBarricade(a: Aabb, how: 'ram' | 'charge' | 'smash') {
    void a;
    void how;
  }

  // ------------------------------------------------------------------ vehicles & players

  spawnVehicle(opts: { tier: number; x: number; z: number; yaw: number; ownerIndex: number; hpFrac?: number; fuelFrac?: number }): Vehicle {
    const save = opts.ownerIndex >= 0 ? this.campaign.players[opts.ownerIndex] : null;
    const def = vehicleDef(opts.tier);
    const v = new Vehicle(this, {
      def,
      x: opts.x,
      z: opts.z,
      yaw: opts.yaw,
      faction: 'convoy',
      kind: 'player',
      ownerIndex: opts.ownerIndex,
      mods: save?.mods,
      hpFrac: opts.hpFrac ?? save?.hpFrac ?? 1,
    });
    v.fuel = v.tankMax * (opts.fuelFrac ?? 1);
    this.vehicles.push(v);
    return v;
  }

  /** Create both players and (optionally) seat them in their vehicles. */
  spawnConvoy(x: number, z: number, yaw: number, spacing = 3.4, seat = true) {
    const names = this.campaign.players.map((p) => p.name);
    for (let i = 0; i < 2; i++) {
      const p = new Player(this, i as 0 | 1, names[i]);
      this.players.push(p);
      const side = i === 0 ? 1 : -1;
      const px = x + Math.cos(yaw) * side * spacing;
      const pz = z - Math.sin(yaw) * side * spacing;
      p.placeAt(px, pz, yaw);
      const save = this.campaign.players[i];
      if (save.alive || true) {
        const v = this.spawnVehicle({ tier: save.tier, x: px, z: pz, yaw, ownerIndex: i, fuelFrac: undefined });
        p.ownVehicle = v;
        if (seat) {
          v.driver = p;
          p.vehicle = v;
          p.state = 'driving';
          p.aimYaw = yaw;
          v.setEngine(true);
          p.pos.set(px, v.position.y, pz);
          p.body.setTranslation({ x: px, y: v.position.y + 1, z: pz }, true);
        }
      }
    }
    // Pull each vehicle's tank from the convoy reserve (up to its capacity) so the HUD gauge reflects supplies.
    this.fillTanksFromReserve();
  }

  /** Move fuel from the convoy reserve into vehicle tanks, at halts and at the Ledger. */
  fillTanksFromReserve() {
    const own = this.vehicles.filter((v) => v.faction === 'convoy' && v.kind === 'player');
    for (const v of own) {
      const need = v.tankMax - v.fuel;
      const take = Math.min(need, this.campaign.stocks.fuel);
      v.fuel += take;
      this.campaign.stocks.fuel -= take;
    }
  }

  // ------------------------------------------------------------------ fixed tick

  /** Runs after the mode's own pre-tick work. Order follows the blueprint's game loop. */
  tick(dt: number) {
    this.ticks++;
    this.time += dt;
    for (const v of this.vehicles) v.snapshotPrev();
    for (const p of this.players) p.update(dt);
    // Vehicles (convoy and raiders) apply driver intent and step wheel models.
    for (const v of this.vehicles) v.update(dt);
    this.raiders.update(dt);
    this.zombies.update(dt);
    this.crew.update(dt);
    this.projectiles.update(dt);
    this.P.step();
    // Post-step gameplay systems.
    for (const v of this.vehicles) if (v.faction === 'convoy' || v.kind !== 'wagon') this.zombies.plow(v, dt);
    this.updateVehiclePlayerHits(dt);
    this.sigDecayT += dt;
    this.sig.decay(dt);
    this.modeTick(dt);
    this.clock.tick(dt);
    // Loot popups
    if (this.lootAccT > 0) {
      this.lootAccT -= dt;
      if (this.lootAccT <= 0) this.flushLoot();
    }
    this.tickNight();
  }

  protected abstract modeTick(dt: number): void;

  private flushLoot() {
    const parts: string[] = [];
    for (const id of STOCK_IDS) {
      const v = this.lootAcc[id];
      if (v && whole(v * 10) > 0) parts.push(`+${v >= 10 || id !== 'fuel' ? Math.round(v) : v.toFixed(1)} ${LABEL[id]}`);
    }
    this.lootAcc = {};
    if (parts.length) this.notify(-1, parts.join('  '), 'good');
  }

  private tickNight() {
    const light = lightAt(this.clock.t, this.biome);
    this.night = light.night;
  }

  /** Moving vehicles can run over players on foot. */
  private updateVehiclePlayerHits(dt: number) {
    for (const v of this.vehicles) {
      if (v.wreck || Math.abs(v.speed) < 4.5) continue;
      const [fx, , fz] = v.body.forward();
      for (const p of this.players) {
        if (p.state !== 'foot' && p.state !== 'downed') continue;
        if (p.vehicle === v) continue;
        const rx = p.pos.x - v.position.x;
        const rz = p.pos.z - v.position.z;
        const lz = rx * fx + rz * fz;
        const lx = rx * fz - rz * fx;
        const half = v.def.length / 2 + 0.3;
        if (Math.abs(lz) < half && Math.abs(lx) < v.def.width / 2 + 0.4 && p.invuln <= 0) {
          p.hurt(Math.min(70, Math.abs(v.speed) * 4.5) * (v.faction === 'convoy' ? 0.6 : 1), v.position.x, v.position.z, 'ram');
          p.invuln = 0.6;
          const k = Math.sign(lx) || 1;
          p.vy = 4;
          void k;
        }
      }
    }
    void dt;
  }

  // ------------------------------------------------------------------ rendering

  /** Called once per rendered frame with the interpolation alpha. */
  renderFrame(alpha: number, dt: number) {
    const R = this.R;
    // Visual sync
    for (const v of this.vehicles) v.syncVisual(alpha, dt);
    for (const p of this.players) p.syncVisual(alpha, dt);
    this.syncExtra(alpha, dt);
    this.fx.setBudget(QUALITY[R.quality].particles);
    this.fx.update(dt);
    this.tracers.update(dt);
    // Cameras
    for (let i = 0; i < 2; i++) {
      const p = this.players[i];
      const v = R.views[i];
      if (!p) {
        v.active = false;
        continue;
      }
      v.active = true;
      p.cam.apply(v.camera);
      v.focus.set(p.pos.x, p.pos.y, p.pos.z);
      if (p.vehicle) v.focus.set(p.vehicle.position.x, p.vehicle.position.y, p.vehicle.position.z);
      v.camera.updateMatrixWorld();
      this.pm.multiplyMatrices(v.camera.projectionMatrix, v.camera.matrixWorldInverse);
      this.frustums[i].setFromProjectionMatrix(this.pm);
    }
    // Light and headlights
    this.applyLighting();
    this.zombies.render(this.zr, this.time, this.frustums, QUALITY[R.quality].zombies, R.views.map((v) => v.camera.position));
  }

  protected syncExtra(alpha: number, dt: number) {
    void alpha;
    void dt;
  }

  protected applyLighting() {
    const light = lightAt(this.clock.t, this.mode === 'camp' ? this.biome : this.biome);
    this.R.setLight(light, this.biome);
    const walls = (this as unknown as { wallMat?: THREE.MeshLambertMaterial }).wallMat;
    if (walls) walls.emissiveIntensity = clamp(light.night * 1.2, 0, 0.95);
    // Headlights: one spot per player vehicle with lights on.
    for (let i = 0; i < 2; i++) {
      const s = this.spots[i];
      const p = this.players[i];
      const v = p?.vehicle ?? p?.ownVehicle ?? null;
      if (v && v.lights && !v.wreck && v.faction === 'convoy') {
        const [x, y, z] = v.body.toWorld(0, 0.5, v.def.length / 2 - 0.1);
        const [tx, ty, tz] = v.body.toWorld(0, -0.2, v.def.length / 2 + 25);
        s.position.set(x, y, z);
        s.target.position.set(tx, ty, tz);
        s.target.updateMatrixWorld();
        s.intensity = 480 * (0.35 + light.night);
      } else s.intensity = 0;
    }
  }

  /** Engines for the audio mix. */
  updateAudio(dt: number) {
    const list: EngineState[] = [];
    for (const v of this.vehicles) {
      if (v.wreck || !v.engineOn) continue;
      list.push({
        id: v.id,
        x: v.position.x,
        z: v.position.z,
        rpm: clamp(Math.abs(v.speed) / Math.max(6, v.topSpeed), 0, 1),
        throttle: clamp(v.lastIntent.throttle, 0, 1),
        tier: v.def.tier,
        signature: Math.max(15, v.signature()),
      });
    }
    this.audio.setListeners(this.players.map((p) => ({ x: p.vehicle?.position.x ?? p.pos.x, z: p.vehicle?.position.z ?? p.pos.z })));
    this.audio.updateEngines(list, dt);
    this.audio.updateMusic(dt);
    this.updateMusicState();
  }

  protected abstract updateMusicState(): void;

  // ------------------------------------------------------------------ HUD helpers

  /** Pins for the HUD compass: world markers other than the partner. */
  abstract compassPins(): CompassPin[];

  dispose() {
    this.disposed = true;
    this.crew.clear();
    this.raiders.clearAll();
    this.projectiles.clear();
    for (const p of this.players) p.destroy();
    for (const v of this.vehicles) v.destroy();
    this.vehicles.length = 0;
    this.players.length = 0;
    this.root.removeFromParent();
    disposeTree(this.root);
    this.R.scene.remove(this.fx.smoke.points);
    this.R.scene.remove(this.fx.glow.points);
    this.R.scene.remove(this.tracers.mesh);
    disposeTree(this.fx.smoke.points);
    disposeTree(this.fx.glow.points);
    disposeTree(this.tracers.mesh);
    for (const s of this.spots) s.dispose();
    this.zr.mesh.dispose();
    this.audio.silenceEngines();
  }
}

export interface CompassPin {
  x: number;
  z: number;
  kind: 'end' | 'encounter' | 'zone' | 'ping' | 'ambush' | 'camp' | 'fragment' | 'chassis' | 'threat' | 'watch' | 'sector' | 'hub';
  label?: string;
  color?: string;
}

export type SceneResult =
  | { type: 'fail'; reason: string }
  | { type: 'legEnd' }
  | { type: 'campDone' }
  | { type: 'encounter'; id: string; spotId: string }
  | { type: 'dusk' };

void VEHICLES;
