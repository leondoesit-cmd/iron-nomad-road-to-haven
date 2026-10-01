import { LEGS, MERCS, MODULE_SLOTS, VEHICLES, legById, vehicleDef, STRUCTURES, type Cost, type ModuleSlot, type StockId } from '../data';
import { FocusUI, type FocusItem } from './focus';
import { escapeHtml } from './hud';
import { PLAYER_CSS } from '../render/palette';
import {
  LABEL,
  RECIPES,
  canAfford,
  checkTierUp,
  costText,
  effectiveStats,
  moduleCost,
  spend,
  whole,
} from '../sim/resources';
import { loyaltyBand, settleCut } from '../sim/loyalty';
import { moraleOf } from '../sim/loyalty';
import type { Game } from '../game/game';
import type { CampScene } from '../game/campScene';

type Act = (player: number) => void;

/**
 * The Dawn Ledger: a shared clipboard layered over both halves. Each player has their own coloured cursor;
 * spend from the shared stocks, upgrade your ride, hire crew, pick the next road, then both roll out.
 */
export class LedgerPanel {
  private acts = new Map<string, Act>();
  private chosen = 0;
  private ready: [boolean, boolean] = [false, false];
  private tab: 'main' | 'trade' = 'main';
  private msg = '';

  constructor(
    private game: Game,
    private root: HTMLElement,
    private camp: CampScene,
    private depart: (nextLeg: string) => void,
    private sliceEnd: () => void,
  ) {}

  private get c() {
    return this.game.campaign;
  }

  open() {
    this.game.focus.active = true;
    this.game.focus.onCancel = () => {};
    this.render();
  }

  private say(m: string) {
    this.msg = m;
  }

  private buyCost(cost: Cost) {
    return spend(this.c.stocks, cost);
  }

  private get nextLegs(): string[] {
    return LEGS.route.next[this.c.legId] ?? [];
  }

  private get hub() {
    const leg = legById(this.c.legId);
    return leg.endHub ? LEGS.hubs[leg.endHub] : null;
  }

  private btn(id: string, label: string, act: Act, enabled = true, title = '') {
    this.acts.set(id, act);
    return `<button data-fid="${id}" ${enabled ? '' : 'disabled'} title="${escapeHtml(title)}">${label}</button>`;
  }

  /** Rebuild the whole page and keep each cursor on the same logical button. */
  render() {
    const g = this.game;
    const keys = g.focus.keys();
    this.acts.clear();
    const c = this.c;
    const hub = this.hub;
    const leg = legById(c.legId);
    const stocksHtml = (['fuel', 'rations', 'scrap', 'parts', 'tech', 'medicine'] as StockId[])
      .map((k) => `<div class="stockrow"><span>${LABEL[k]}</span><b>${k === 'fuel' ? c.stocks[k].toFixed(1) : whole(c.stocks[k])}</b></div>`)
      .join('');
    const owedTotal = c.crewLive.reduce((a, m) => a + Object.values(m.owed).reduce((x, y) => x + (y ?? 0), 0), 0);
    const left = `<section><h3>Stores</h3>${stocksHtml}
      <div class="stockrow"><span>Ammo</span><b>${c.ammo}</b></div>
      <div class="stockrow"><span>Medkits / Flares / Molotovs / Charges</span><b>${c.items.medkit}/${c.items.flare}/${c.items.molotov}/${c.items.charge}</b></div>
      <div class="stockrow"><span>Salvaged chassis</span><b>${c.chassis}</b></div>
      <div class="stockrow"><span>Radio fragments</span><b>${c.fragments.size}/4</b></div>
      <h3>Crafting</h3>
      <div class="card"><div class="btns">${RECIPES.map((r) => this.btn(`craft-${r.id}`, `${r.name} <span class="cost">${costText(r.cost)}</span>`, () => this.craft(r.id), canAfford(c.stocks, r.cost))).join('')}</div></div>
      ${hub?.features.includes('trade') ? `<h3>Trader</h3><div class="card"><div class="btns">${this.tradeButtons()}</div></div>` : ''}
      </section>`;
    const cards = [0, 1].map((i) => this.vehicleCard(i)).join('');
    const mid = `<section><h3>Vehicles</h3>${cards}<div class="mutedtxt">Tanks are filled from the convoy reserve (${c.stocks.fuel.toFixed(1)} FU) when you roll out. Upgrades take effect straight away.</div></section>`;
    const right = `<section><h3>Crew</h3>${this.crewHtml(owedTotal)}<h3>Next road</h3>${this.routeHtml()}</section>`;
    this.root.innerHTML = `<div class="ledger panel paper">
      <h2><span>Dawn Ledger · ${escapeHtml(leg.name)}${hub ? ' · ' + escapeHtml(hub.name) : ''}</span><small>DAY ${c.day} · MORALE ${Math.round(moraleOf(c.crew))} · ${hub?.safeNight ? 'SAFE NIGHT' : 'ROADSIDE CAMP'}</small></h2>
      ${left}${mid}${right}
      <div style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:12px;border-top:2px solid rgba(38,28,16,.4);padding-top:6px">
        <span class="mutedtxt" id="ledger-msg">${escapeHtml(this.msg)}</span>
        <span style="display:flex;gap:10px;align-items:center">${this.readyHtml()}</span>
      </div></div>`;
    this.root.querySelectorAll<HTMLElement>('button').forEach((b) => (b.style.pointerEvents = 'auto'));
    const items: FocusItem[] = [];
    this.root.querySelectorAll<HTMLElement>('[data-fid]').forEach((el) => {
      const id = el.dataset.fid!;
      const act = this.acts.get(id);
      if (!act) return;
      items.push({ el, press: (p) => act(p), disabled: (el as HTMLButtonElement).disabled });
    });
    g.focus.setItems(items, keys);
  }

  // ------------------------------------------------------------------ pieces

  private tradeButtons() {
    const offers: { id: string; label: string; cost: Cost; give: Partial<Record<StockId, number>> }[] = [
      { id: 'rations', label: '2 Rations', cost: { scrap: 10 }, give: { rations: 2 } },
      { id: 'fuel', label: '5 FU', cost: { scrap: 14 }, give: { fuel: 5 } },
      { id: 'medicine', label: '1 Medicine', cost: { scrap: 14 }, give: { medicine: 1 } },
      { id: 'tech', label: '2 Tech', cost: { scrap: 20 }, give: { tech: 2 } },
      { id: 'parts', label: '4 Parts', cost: { scrap: 16 }, give: { parts: 4 } },
    ];
    return offers
      .map((o) =>
        this.btn(
          `buy-${o.id}`,
          `Buy ${o.label} <span class="cost">${costText(o.cost)}</span>`,
          () => {
            if (!this.buyCost(o.cost)) return this.deny('Not enough Scrap');
            for (const k of Object.keys(o.give) as StockId[]) this.c.stocks[k] += o.give[k] ?? 0;
            this.ok(`Bought ${o.label}`);
          },
          canAfford(this.c.stocks, o.cost),
        ),
      )
      .join('');
  }

  private vehicleCard(i: number) {
    const c = this.c;
    const sv = c.players[i];
    const def = vehicleDef(sv.tier);
    const st = effectiveStats(sv.tier, sv.mods);
    const missing = 1 - sv.hpFrac;
    const repairCost: Cost = { scrap: Math.max(missing > 0.01 ? 1 : 0, Math.ceil(missing * (10 + 10 * sv.tier))) };
    const upg = checkTierUp(c.stocks, sv.tier, c.chassis, !!this.hub?.features.includes('garage'));
    const up = VEHICLES.tiers[sv.tier];
    const lines: string[] = [];
    lines.push(
      `<h4><span class="pcolor" style="background:${PLAYER_CSS[i]}"></span>${escapeHtml(sv.name.toUpperCase())} · ${escapeHtml(def.name)}</h4>`,
      `<div class="sub2">HP ${Math.round(sv.hpFrac * def.hp)}/${def.hp} · ARMOR ${Math.round(st.armor * 100)}% · TANK ${st.tank.toFixed(0)} FU · TOP ${Math.round(def.topSpeedKmh * st.topSpeedMult)} km/h · W ${def.width} m</div>`,
    );
    const btns: string[] = [];
    btns.push(this.btn(`rep${i}`, `Repair <span class="cost">${missing > 0.01 ? costText(repairCost) : 'OK'}</span>`, () => this.repair(i, repairCost), missing > 0.01 && canAfford(c.stocks, repairCost)));
    if (up) {
      btns.push(
        this.btn(
          `tier${i}`,
          up.beta ? `Tier ${up.tier}: ${escapeHtml(up.name)} (Beta)` : `Rebuild as Tier ${up.tier} <span class="cost">${costText(upg.cost)}${up.upgrade && VEHICLES.tiers[sv.tier - 1].upgrade.chassis ? ' + chassis' : ''}</span>`,
          () => this.tierUp(i),
          upg.ok,
          upg.reason ?? '',
        ),
      );
    }
    lines.push(`<div class="btns">${btns.join('')}</div>`);
    if (!upg.ok && upg.reason && up && !up.beta) lines.push(`<div class="mutedtxt">${escapeHtml(upg.reason)}</div>`);
    // Module slots
    const mods = MODULE_SLOTS.map((slot) => {
      const lvl = sv.mods[slot];
      const cost = moduleCost(lvl);
      return this.btn(
        `mod${i}-${slot}`,
        `${VEHICLES.modules.labels[slot].split(' ')[0]}<br>Mk${lvl}${cost ? `<br><span class="cost">${costText(cost)}</span>` : ''}`,
        () => this.upgradeModule(i, slot),
        !!cost && canAfford(c.stocks, cost),
        VEHICLES.modules.labels[slot],
      );
    });
    lines.push(`<div class="mods">${mods.join('')}</div>`);
    return `<div class="card p${i + 1}">${lines.join('')}</div>`;
  }

  private crewHtml(owedTotal: number) {
    const c = this.c;
    const mech = MERCS.roles.mechanic;
    const hasMech = c.crewLive.some((m) => m.role === 'mechanic');
    const parts: string[] = [];
    for (const m of c.crew) {
      if (!m.alive || m.deserted) continue;
      const band = loyaltyBand(m.loyalty);
      const owed = Object.entries(m.owed).filter(([, v]) => (v ?? 0) > 0.05);
      const owedTxt = owed.map(([k, v]) => `${Math.round(v ?? 0)} ${LABEL[k as StockId]}`).join(', ');
      parts.push(`<div class="card"><h4>${escapeHtml(m.name.toUpperCase())} · ${m.role.toUpperCase()}</h4>
        <div class="sub2">${band.toUpperCase()} (${Math.round(m.loyalty)}) · CUT ${Math.round(m.cut * 100)}% · ${escapeHtml(m.grievances[0] ?? 'No grievances')}</div>
        <div class="btns">
          ${owed.length ? this.btn(`pay-${m.id}`, `Pay cut <span class="cost">${escapeHtml(owedTxt)}</span>`, () => { settleCut(m, this.c.stocks, true); this.ok(`Paid ${m.name}`); }) : '<span class="mutedtxt">Cut paid</span>'}
          ${owed.length ? this.btn(`short-${m.id}`, `Short the crew <span class="cost">keep it, -15 loyalty</span>`, () => { settleCut(m, this.c.stocks, false); this.warn(`${m.name} noticed.`); }) : ''}
          ${this.btn(`fire-${m.id}`, 'Dismiss', () => { m.alive = false; m.deserted = true; this.c.axes.notoriety += 0; this.say(`${m.name} left the convoy.`); this.render(); })}
        </div></div>`);
    }
    if (!parts.length) parts.push('<div class="mutedtxt">No crew yet.</div>');
    if (owedTotal > 0.05) void owedTotal;
    // Hiring
    if (this.hub?.features.includes('hire')) {
      const hireBtns = [-0.05, 0, 0.05].map((d) => {
        const cut = Math.max(0.02, mech.defaultCut + d);
        return this.btn(
          `hire-${d}`,
          `Hire Mechanic ${Math.round(cut * 100)}% cut <span class="cost">${costText(mech.signOn)}</span>`,
          () => this.hire(cut),
          !hasMech && canAfford(c.stocks, mech.signOn),
        );
      });
      parts.push(`<div class="card"><h4>Hire at ${escapeHtml(this.hub.name)}</h4><div class="mutedtxt">${escapeHtml(mech.blurb)} A higher cut raises starting Loyalty; a lower cut lowers it.</div><div class="btns">${hireBtns.join('')}</div>
        <div class="mutedtxt">Scout, Scavenger and Heavy Vanguard arrive in the Beta.</div></div>`);
    } else parts.push('<div class="mutedtxt">Mercenaries are hired at Waypoints and settlements.</div>');
    return parts.join('');
  }

  private routeHtml() {
    const next = this.nextLegs;
    if (!next.length) {
      return `<div class="card"><h4>End of the vertical slice</h4><div class="mutedtxt">The road north continues in the Beta.</div><div class="btns">${this.btn('end', 'See how it went', () => this.sliceEnd())}</div></div>`;
    }
    const rumor = (id: string) => {
      const l = legById(id);
      const r = l.baseThreat >= 20 ? 3 : l.baseThreat >= 14 ? 2 : 1;
      const tag = l.biome === 'city' ? 'Tech, Medicine, hordes' : 'Fuel, Parts, ambushes';
      return { stars: '★'.repeat(r) + '☆'.repeat(3 - r), tag, l };
    };
    const items = next.map((id, i) => {
      const r = rumor(id);
      return `<div class="card" style="${this.chosen === i ? 'background:rgba(255,200,100,.5)' : ''}"><h4>${escapeHtml(r.l.name)} ${this.chosen === i ? '· CHOSEN' : ''}</h4><div class="sub2">${r.l.biome.toUpperCase()} · RISK ${r.stars} · ${escapeHtml(r.tag)}</div>
        <div class="btns">${this.btn(`route-${i}`, this.chosen === i ? 'Chosen' : 'Take this road', () => { this.chosen = i; this.ready = [false, false]; this.render(); })}</div></div>`;
    });
    return items.join('');
  }

  private readyHtml() {
    const next = this.nextLegs;
    const mk = (i: number) => `<span class="vote p${i + 1}" style="opacity:${this.ready[i] ? 1 : 0.35};padding:2px 8px">${escapeHtml(this.c.players[i].name.toUpperCase())} ${this.ready[i] ? 'READY' : '…'}</span>`;
    if (!next.length) return '';
    return `${mk(0)}${mk(1)}${this.btn('go', 'Roll out', (p) => this.toggleReady(p), true)}`;
  }

  // ------------------------------------------------------------------ actions

  private ok(msg: string) {
    this.game.audio.play('confirm');
    this.say(msg);
    this.render();
  }
  private warn(msg: string) {
    this.game.audio.play('deny');
    this.say(msg);
    this.render();
  }
  private deny(msg: string) {
    this.warn(msg);
  }

  private repair(i: number, cost: Cost) {
    const sv = this.c.players[i];
    if (!this.buyCost(cost)) return this.deny('Not enough Scrap');
    sv.hpFrac = 1;
    this.camp.refreshVehicles();
    this.ok(`${sv.name}'s ride is patched up.`);
  }

  private tierUp(i: number) {
    const c = this.c;
    const sv = c.players[i];
    const chk = checkTierUp(c.stocks, sv.tier, c.chassis, !!this.hub?.features.includes('garage'));
    if (!chk.ok) return this.deny(chk.reason ?? 'Cannot upgrade');
    spend(c.stocks, chk.cost);
    if (VEHICLES.tiers[sv.tier - 1].upgrade.chassis) c.chassis -= VEHICLES.tiers[sv.tier - 1].upgrade.chassis;
    sv.tier = (sv.tier + 1) as 1 | 2 | 3;
    sv.hpFrac = 1;
    sv.alive = true;
    this.camp.refreshVehicles();
    this.ok(`${sv.name} drives away in a ${vehicleDef(sv.tier).name}.`);
  }

  private upgradeModule(i: number, slot: ModuleSlot) {
    const sv = this.c.players[i];
    const cost = moduleCost(sv.mods[slot]);
    if (!cost) return;
    if (!this.buyCost(cost)) return this.deny('Not enough stock');
    sv.mods[slot]++;
    this.camp.refreshVehicles();
    this.ok(`${VEHICLES.modules.labels[slot]} → Mk${sv.mods[slot]}`);
  }

  private craft(id: string) {
    const r = RECIPES.find((x) => x.id === id)!;
    if (!this.buyCost(r.cost)) return this.deny('Not enough stock');
    const y = r.yields;
    if (y.ammo) this.c.ammo += y.ammo;
    if (y.medkit) this.c.items.medkit += y.medkit;
    if (y.molotov) this.c.items.molotov += y.molotov;
    if (y.flare) this.c.items.flare += y.flare;
    if (y.charge) this.c.items.charge += y.charge;
    this.ok(`Crafted: ${r.name}`);
  }

  private hire(cut: number) {
    const c = this.c;
    const def = MERCS.roles.mechanic;
    if (!spend(c.stocks, def.signOn)) return this.deny('Not enough stock');
    const m = c.hire('mechanic', cut);
    this.ok(`${m?.name} joins the convoy as Mechanic.`);
  }

  private toggleReady(p: number) {
    this.ready[p] = !this.ready[p];
    this.game.audio.play('click');
    if (this.ready[0] && this.ready[1]) {
      const id = this.nextLegs[this.chosen];
      // Tanks are filled from the reserve as the convoy rolls out.
      this.depart(id);
      return;
    }
    this.render();
  }
}

void STRUCTURES;
void FocusUI;
