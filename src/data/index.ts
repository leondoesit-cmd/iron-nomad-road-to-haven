import vehiclesJson from './vehicles.json';
import enemiesJson from './enemies.json';
import mercsJson from './mercs.json';
import structuresJson from './structures.json';
import legsJson from './legs.json';
import encountersJson from './encounters.json';
import stringsJson from './strings.en.json';

export type StockId = 'fuel' | 'rations' | 'scrap' | 'parts' | 'tech' | 'medicine';
export const STOCK_IDS: StockId[] = ['fuel', 'rations', 'scrap', 'parts', 'tech', 'medicine'];
export type Stocks = Record<StockId, number>;
export type Cost = Partial<Record<StockId | 'fu', number>>;

export type ModuleSlot = 'engine' | 'armor' | 'wheels' | 'weapon' | 'utility';
export const MODULE_SLOTS: ModuleSlot[] = ['engine', 'armor', 'wheels', 'weapon', 'utility'];

export interface VehiclePhysicsDef {
  mass: number;
  wheelCount: number;
  maxSteerDeg: number;
  suspension: { stiffness: number; travel: number; rest: number };
  frictionSlip: number;
  sideFriction: number;
  engineForce: number;
  brake: number;
  wheelRadius: number;
  halfExtents: [number, number, number];
  hardY: number;
  wheelsZ: number[];
  wheelsX: number[];
  uprightGain: number;
  lean: boolean;
}

export interface VehicleDef {
  tier: number;
  id: string;
  name: string;
  width: number;
  length: number;
  topSpeedKmh: number;
  hp: number;
  armor: number;
  cargo: number;
  seats: number;
  weapon: string | null;
  signature: { idle: number; moving: number };
  tank: number;
  burn: number;
  beta?: boolean;
  camera: { dist: number; height: number };
  physics: VehiclePhysicsDef;
  upgrade: { parts: number; scrap: number; tech: number; chassis: number; needsGarage?: boolean };
}

export type ZombieKind = 'walker' | 'runner' | 'screamer' | 'bloater' | 'brute' | 'stalker';
export interface ZombieDef {
  name: string;
  hp: number;
  armor: number;
  wander: number;
  chase: number;
  damage: number;
  radius: number;
  weight: number;
  scale: number;
  shriek?: number;
  sporeRadius?: number;
  sporeDps?: number;
  sporeTime?: number;
  vehicleDamage?: number;
  hesitateRadius?: number;
}

export type RaiderKind = 'buggy' | 'wagon' | 'gunman' | 'sniper' | 'saboteur';
export interface RaiderDef {
  name: string;
  hp: number;
  armor: number;
  speed: number;
  dps: number;
  range: number;
  weight: number;
  mass?: number;
  ramDamage?: number;
  rearTireHp?: number;
}

export type MercRole = 'mechanic' | 'scout' | 'scavenger' | 'vanguard';
export interface MercDef {
  name: string;
  available: boolean;
  signOn: Cost;
  upkeep: { rations: number; fu: number };
  defaultCut: number;
  stars: number;
  blurb: string;
  repairHalted?: number;
  repairMoving?: number;
}

export interface BuildElementDef {
  id: string;
  name: string;
  cost: Cost;
  size: [number, number, number];
  hp: number;
  blocks: boolean;
  blurb: string;
  slow?: number;
  dps?: number;
  coneRange?: number;
  signature?: number;
  range?: number;
  radius?: number;
  damage?: number;
}

export interface SetPiece {
  at: number;
  type: string;
  [k: string]: unknown;
}

export interface LegDef {
  id: string;
  index: number;
  act: number;
  name: string;
  subtitle: string;
  biome: 'wasteland' | 'city';
  length: number;
  seed: number;
  baseThreat: number;
  dayLength: number;
  tutorial?: boolean;
  endHub?: string;
  campSites: string[];
  sets: SetPiece[];
}

export interface HubDef {
  name: string;
  features: string[];
  safeNight: boolean;
  blurb: string;
}

export interface CampSiteDef {
  name: string;
  exposure: number;
  cover: number;
  room: number;
  blurb: string;
}

export interface EncounterEffects {
  stocks?: Partial<Record<StockId, number>>;
  axes?: Partial<Record<'mercy' | 'trust' | 'notoriety', number>>;
  loyalty?: number;
  ambush?: number;
  zombies?: number;
  fragment?: boolean;
  chance?: { p: number; fail: EncounterEffects };
}
export interface EncounterDef {
  id: string;
  biome: 'wasteland' | 'city';
  choices: { id: string; effects: EncounterEffects }[];
}

export const VEHICLES = vehiclesJson as unknown as {
  armorFacing: { front: number; side: number; rear: number };
  tiers: VehicleDef[];
  modules: {
    slots: ModuleSlot[];
    levels: { level: number; parts: number; scrap: number; tech: number }[];
    perLevel: Record<ModuleSlot, Record<string, number>>;
    labels: Record<ModuleSlot, string>;
  };
  surfaces: Record<string, { grip: number; drag: number }>;
};
export const ENEMIES = enemiesJson as unknown as {
  zombies: Record<ZombieKind, ZombieDef>;
  zombieRules: {
    senseRadiusPerPoint: number;
    indoorFactor: number;
    cascadeChasers: number;
    cascadeRadius: number;
    grabDps: number;
    pinDps: number;
    pinAt: number;
    pinBreakRotations: number;
    plowSpeedLoss: number;
    tierSpeedLoss: number[];
    bleedOut: number;
  };
  raiders: Record<RaiderKind, RaiderDef>;
};
export const MERCS = mercsJson as unknown as {
  roles: Record<MercRole, MercDef>;
  names: string[];
  loyalty: {
    paidInFull: number;
    missedUpkeep: number;
    cutShorted: number;
    stranded: number;
    savedByPlayer: number;
    riskyNoPay: number;
    wonRaid: number;
    restDay: number;
    bands: { loyal: number; steady: number; resentful: number; mutinous: number };
    warn1: number;
    refuse: number;
  };
};
export const STRUCTURES = structuresJson as unknown as {
  build: { buildSeconds: number; snap: number; elements: BuildElementDef[] };
  sectors: number;
  watchDetect: number;
  unwatchedDetect: number;
  sites: Record<string, CampSiteDef>;
  raids: {
    waves: string[];
    waveSeconds: number;
    hot: { loyalty: number; signatureMult: number };
    cold: { loyalty: number; signatureMult: number };
  };
};
export const LEGS = legsJson as unknown as {
  start: { stocks: Stocks; ammo: number };
  route: { start: string; next: Record<string, string[]> };
  hubs: Record<string, HubDef>;
  legs: LegDef[];
};
export const ENCOUNTERS = (encountersJson as unknown as { encounters: EncounterDef[] }).encounters;
const STRINGS = stringsJson as Record<string, string>;

/** Localized string lookup. All story text is a key into the per-language table. */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = STRINGS[key] ?? key;
  if (params) for (const k in params) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(params[k]));
  return s;
}
export function hasString(key: string) {
  return key in STRINGS;
}

export function legById(id: string): LegDef {
  const l = LEGS.legs.find((x) => x.id === id);
  if (!l) throw new Error(`Unknown leg ${id}`);
  return l;
}
export function vehicleDef(tier: number): VehicleDef {
  const v = VEHICLES.tiers[tier - 1];
  if (!v) throw new Error(`Unknown tier ${tier}`);
  return v;
}
export function encounterById(id: string): EncounterDef {
  const e = ENCOUNTERS.find((x) => x.id === id);
  if (!e) throw new Error(`Unknown encounter ${id}`);
  return e;
}

/** Schema checks. Run in the test suite (build-time) and in debug mode at boot. */
export function validateData(): string[] {
  const errs: string[] = [];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  VEHICLES.tiers.forEach((v, i) => {
    need(v.tier === i + 1, `vehicle ${v.id}: tier index mismatch`);
    need(v.physics.wheelsZ.length * v.physics.wheelsX.length >= v.physics.wheelCount - 0, `vehicle ${v.id}: wheel layout too small for wheelCount`);
    need(v.hp > 0 && v.tank > 0, `vehicle ${v.id}: hp/tank must be positive`);
    need(v.armor >= 0 && v.armor < 1, `vehicle ${v.id}: armor range`);
  });
  for (const leg of LEGS.legs) {
    need(leg.length > 500, `leg ${leg.id}: too short`);
    let last = -1;
    for (const s of leg.sets) {
      need(s.at >= last, `leg ${leg.id}: set pieces must be ordered`);
      need(s.at >= 0 && s.at <= leg.length, `leg ${leg.id}: set piece beyond end`);
      last = s.at;
      if (s.type === 'encounter') need(ENCOUNTERS.some((e) => e.id === s.id), `leg ${leg.id}: unknown encounter ${String(s.id)}`);
    }
    for (const c of leg.campSites) need(c in STRUCTURES.sites, `leg ${leg.id}: unknown camp site ${c}`);
    if (leg.endHub) need(leg.endHub in LEGS.hubs, `leg ${leg.id}: unknown hub ${leg.endHub}`);
  }
  for (const [from, tos] of Object.entries(LEGS.route.next)) {
    need(LEGS.legs.some((l) => l.id === from), `route: unknown leg ${from}`);
    for (const to of tos) need(LEGS.legs.some((l) => l.id === to), `route: unknown target ${to}`);
  }
  for (const e of ENCOUNTERS) {
    need(hasString(`enc.${e.id}.title`) && hasString(`enc.${e.id}.text`), `encounter ${e.id}: missing title/text strings`);
    need(e.choices.length >= 2, `encounter ${e.id}: needs at least 2 choices`);
    for (const c of e.choices) {
      need(hasString(`enc.${e.id}.${c.id}`), `encounter ${e.id}.${c.id}: missing label`);
      need(hasString(`enc.${e.id}.${c.id}.result`), `encounter ${e.id}.${c.id}: missing result`);
    }
  }
  for (const el of STRUCTURES.build.elements) need(el.size.length === 3, `build element ${el.id}: size`);
  return errs;
}
