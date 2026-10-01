import { MERCS, STOCK_IDS, type MercDef, type MercRole, type Stocks } from '../data';

export type LoyaltyBand = 'loyal' | 'steady' | 'resentful' | 'mutinous' | 'breaking';

export interface Merc {
  id: string;
  role: MercRole;
  name: string;
  loyalty: number;
  cut: number;
  hungryNights: number;
  warned1: boolean;
  warned2: boolean;
  alive: boolean;
  deserted: boolean;
  owed: Partial<Stocks>;
  grievances: string[];
  fatigue: number;
  /** Dispute pending at the next camp (Pay, Rivalry, Cowardice). */
  dispute: null | 'pay' | 'cowardice';
}

export function newMerc(role: MercRole, name: string, cut?: number): Merc {
  const def = MERCS.roles[role];
  const c = cut ?? def.defaultCut;
  // A higher cut than default raises starting loyalty, a lower cut lowers it (5 points per percentage point step).
  const base = 55 + Math.round((c - def.defaultCut) * 100) * 2;
  return {
    id: `${role}-${name.toLowerCase()}`,
    role,
    name,
    loyalty: Math.max(20, Math.min(90, base)),
    cut: c,
    hungryNights: 0,
    warned1: false,
    warned2: false,
    alive: true,
    deserted: false,
    owed: {},
    grievances: [],
    fatigue: 0,
    dispute: null,
  };
}

export function loyaltyBand(l: number): LoyaltyBand {
  const b = MERCS.loyalty.bands;
  if (l >= b.loyal) return 'loyal';
  if (l >= b.steady) return 'steady';
  if (l >= b.resentful) return 'resentful';
  if (l >= b.mutinous) return 'mutinous';
  return 'breaking';
}

/** +10% for Loyal, -25% for Resentful and worse. */
export function performanceMult(l: number): number {
  const band = loyaltyBand(l);
  if (band === 'loyal') return 1.1;
  if (band === 'steady') return 1;
  return 0.75;
}

export function refusesOrders(m: Merc) {
  return m.loyalty < MERCS.loyalty.refuse;
}

export type LoyaltyEvent = 'warn1' | 'warn2' | 'refuse' | 'dispute' | 'desert';

export function applyLoyalty(m: Merc, delta: number, reason?: string): LoyaltyEvent[] {
  const before = m.loyalty;
  m.loyalty = Math.max(0, Math.min(100, m.loyalty + delta));
  if (delta < 0 && reason) {
    m.grievances.unshift(reason);
    if (m.grievances.length > 4) m.grievances.pop();
  }
  const ev: LoyaltyEvent[] = [];
  if (before > MERCS.loyalty.warn1 && m.loyalty <= MERCS.loyalty.warn1 && !m.warned1) {
    m.warned1 = true;
    ev.push('warn1');
  }
  if (before >= MERCS.loyalty.refuse && m.loyalty < MERCS.loyalty.refuse) ev.push('refuse');
  if (before >= MERCS.loyalty.bands.mutinous && m.loyalty < MERCS.loyalty.bands.mutinous && !m.warned2) {
    m.warned2 = true;
    ev.push('warn2');
  }
  return ev;
}

export function moraleOf(crew: Merc[], modifier = 0): number {
  const live = crew.filter((c) => c.alive && !c.deserted);
  if (!live.length) return 50;
  return Math.max(0, Math.min(100, live.reduce((a, c) => a + c.loyalty, 0) / live.length + modifier));
}

/** Per the doc's skeleton: pay upkeep from stocks; shortfalls cost -10 and count a hungry night. */
export function nightlyUpkeep(m: Merc, stocks: Stocks, def: MercDef): { ok: boolean; events: LoyaltyEvent[] } {
  const ok = stocks.rations >= def.upkeep.rations && stocks.fuel >= def.upkeep.fu;
  if (ok) {
    stocks.rations -= def.upkeep.rations;
    stocks.fuel -= def.upkeep.fu;
    m.hungryNights = 0;
    return { ok, events: applyLoyalty(m, MERCS.loyalty.paidInFull) };
  }
  if (stocks.rations < def.upkeep.rations) m.hungryNights++;
  return { ok, events: applyLoyalty(m, MERCS.loyalty.missedUpkeep, 'Missed upkeep') };
}

/** Pay the withheld loot cut at camp. Shorting the crew keeps the escrow but costs -15. */
export function settleCut(m: Merc, stocks: Stocks, pay: boolean): LoyaltyEvent[] {
  let had = false;
  for (const id of STOCK_IDS) {
    const v = m.owed[id] ?? 0;
    if (v > 0.001) had = true;
    if (!pay) stocks[id] += v;
    m.owed[id] = 0;
  }
  if (!pay && had) return applyLoyalty(m, MERCS.loyalty.cutShorted, 'Cut shorted');
  return [];
}

export interface CampVerdict {
  desert: boolean;
  dispute: Merc['dispute'];
}

/**
 * Evaluated at camp. Betrayal is telegraphed first: a radio warning at 35, a second at 10, and a Camp Dispute
 * while Mutinous. Breaking (under 10) or two hungry nights (unless Loyal) means desertion at this camp.
 */
export function campVerdict(m: Merc): CampVerdict {
  if (!m.alive || m.deserted) return { desert: false, dispute: null };
  const band = loyaltyBand(m.loyalty);
  const starving = m.hungryNights >= 2 && band !== 'loyal';
  if (band === 'breaking' || starving) return { desert: true, dispute: null };
  if (band === 'mutinous') return { desert: false, dispute: m.dispute ?? (m.cut <= 0.1 ? 'pay' : 'cowardice') };
  return { desert: false, dispute: null };
}
