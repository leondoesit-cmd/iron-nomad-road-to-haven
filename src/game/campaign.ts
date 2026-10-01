import { LEGS, MERCS, type MercRole, type Stocks } from '../data';
import { newAxes, type Axes } from '../sim/endings';
import { emptyModules, newStocks, type ModuleLevels } from '../sim/resources';
import { newMerc, type Merc } from '../sim/loyalty';

export interface PlayerSave {
  name: string;
  tier: 1 | 2 | 3;
  mods: ModuleLevels;
  /** 0..1 of max HP carried over (repairs are paid at the Ledger). */
  hpFrac: number;
  /** Convoy-owned kit counts are on the campaign; these are per-player toggles. */
  utility: 'flare' | 'charge' | 'molotov' | 'horn';
  alive: boolean;
}

export interface Items {
  medkit: number;
  molotov: number;
  flare: number;
  charge: number;
}

export interface Stats {
  zombiesKilled: number;
  raidersKilled: number;
  distance: number;
  downs: [number, number];
  revives: [number, number];
  vehiclesLost: number;
  nights: number;
  timeApart: number;
}

/** Everything that persists between scenes and into saves. */
export class Campaign {
  seed = 1;
  legId: string = LEGS.route.start;
  history: string[] = [];
  /** Which hub we are currently resting at (Ledger context). */
  hub: string | null = null;
  stocks: Stocks = newStocks(LEGS.start.stocks);
  ammo = LEGS.start.ammo;
  items: Items = { medkit: 1, molotov: 1, flare: 2, charge: 0 };
  chassis = 0;
  fragments = new Set<number>();
  crew: Merc[] = [];
  axes: Axes = newAxes();
  seenEncounters = new Set<string>();
  /** Alternates each Roadside Encounter. */
  lead: 0 | 1 = 0;
  day = 1;
  players: [PlayerSave, PlayerSave];
  stats: Stats = { zombiesKilled: 0, raidersKilled: 0, distance: 0, downs: [0, 0], revives: [0, 0], vehiclesLost: 0, nights: 0, timeApart: 0 };
  flags: Record<string, boolean> = {};
  hotCamp = true;
  /** Difficulty sliders: Drain, Aggro and Damage (1 is baseline). */
  difficulty = { drain: 1, aggro: 1, damage: 1 };

  constructor(names: [string, string] = ['Ash', 'Rook']) {
    this.players = [0, 1].map((i) => ({
      name: names[i],
      tier: 1 as const,
      mods: emptyModules(),
      hpFrac: 1,
      utility: i === 0 ? 'flare' : 'horn',
      alive: true,
    })) as [PlayerSave, PlayerSave];
  }

  get crewLive() {
    return this.crew.filter((c) => c.alive && !c.deserted);
  }

  hire(role: MercRole, cut?: number): Merc | null {
    const name = MERCS.names[(this.crew.length + this.day * 3 + this.seed) % MERCS.names.length];
    const m = newMerc(role, name, cut);
    this.crew.push(m);
    return m;
  }

  serialize() {
    return {
      v: 1,
      seed: this.seed,
      legId: this.legId,
      history: this.history,
      hub: this.hub,
      stocks: this.stocks,
      ammo: this.ammo,
      items: this.items,
      chassis: this.chassis,
      fragments: [...this.fragments],
      crew: this.crew,
      axes: this.axes,
      seen: [...this.seenEncounters],
      lead: this.lead,
      day: this.day,
      players: this.players,
      stats: this.stats,
      flags: this.flags,
      hotCamp: this.hotCamp,
      difficulty: this.difficulty,
    };
  }

  static deserialize(d: ReturnType<Campaign['serialize']>): Campaign {
    const c = new Campaign([d.players[0].name, d.players[1].name]);
    c.seed = d.seed;
    c.legId = d.legId;
    c.history = d.history;
    c.hub = d.hub;
    c.stocks = d.stocks;
    c.ammo = d.ammo;
    c.items = d.items;
    c.chassis = d.chassis;
    c.fragments = new Set(d.fragments);
    c.crew = d.crew;
    c.axes = d.axes;
    c.seenEncounters = new Set(d.seen);
    c.lead = d.lead;
    c.day = d.day;
    c.players = d.players;
    c.stats = d.stats;
    c.flags = d.flags;
    c.hotCamp = d.hotCamp;
    c.difficulty = d.difficulty;
    return c;
  }
}
