import type * as THREE from 'three';
import type { PhysicsWorld } from '../physics/physics';
import type { GameRenderer } from '../render/renderer';
import type { Particles, Tracers } from '../render/particles';
import type { SignatureGrid } from '../sim/signature';
import type { ObstacleIndex } from './obstacles';
import type { TerrainDef, Surface } from '../world/terrain';
import type { Campaign } from './campaign';
import type { InputManager } from '../input/input';
import type { Rng } from '../core/rng';
import type { Stocks } from '../data';
import type { Player } from './player';
import type { Vehicle } from './vehicle';
import type { ZombieSystem } from './zombies';
import type { RaiderSystem } from './raiders';
import type { CrewSystem } from './crew';
import type { Combat } from './combat';
import type { AudioEngine } from '../audio/audio';
import type { InteractRegistry } from './interact';
import type { Projectiles } from './projectiles';
import type { Aabb } from '../world/layout';

export type NoteKind = 'info' | 'good' | 'warn' | 'bad';

/** The shared world a running scene (a leg or a camp) exposes to every entity and system. */
export interface Ctx {
  P: PhysicsWorld;
  R: GameRenderer;
  root: THREE.Group;
  fx: Particles;
  tracers: Tracers;
  sig: SignatureGrid;
  obs: ObstacleIndex;
  biome: 'wasteland' | 'city';
  mode: 'leg' | 'camp';
  terrain: TerrainDef | null;
  campaign: Campaign;
  audio: AudioEngine;
  input: InputManager;
  rng: Rng;
  combat: Combat;
  /** Simulation seconds since the scene started. */
  time: number;
  /** 0 by day, 1 deep night. */
  night: number;
  players: Player[];
  vehicles: Vehicle[];
  zombies: ZombieSystem;
  raiders: RaiderSystem;
  crew: CrewSystem;
  vehicleByCollider: Map<number, Vehicle>;
  interact: InteractRegistry;
  projectiles: Projectiles;
  /** Remove a barricade (rammed, breached or smashed). */
  breakBarricade(a: Aabb, how: 'ram' | 'charge' | 'smash'): void;
  groundAt(x: number, z: number): number;
  surfaceAt(x: number, z: number): { grip: number; drag: number; name: Surface };
  notify(player: number, text: string, kind?: NoteKind): void;
  radio(text: string): void;
  tip(id: string): void;
  /** Loot gained by the convoy. Crew cuts are withheld automatically. */
  addLoot(gross: Partial<Stocks>, label?: string): void;
  onVehicleDestroyed(v: Vehicle): void;
  /** Is a world point inside any player's view frustum (with margin)? Used so spawns never pop in view. */
  visibleToAnyView(x: number, y: number, z: number, margin?: number): boolean;
  /** Extra Signature added by the scene (night headlights, camp lights). */
  signatureMult: number;
  /** Camp: handle a player's build-mode input. Returns true if the input was consumed. */
  campHook?: (p: Player, it: import('../input/intents').PlayerIntent, dt: number) => boolean;
  /** Camp: a bullet or blast hit a static collider that may be a built structure. */
  structureHit?: (colliderHandle: number, dmg: number) => void;
  /** Axis-aligned world bounds the convoy should stay inside (camp arena). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}
