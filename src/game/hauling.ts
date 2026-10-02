import type { PartSlot } from '../data';
import { OIL_RESERVE_MAX } from './campaign';
import { carriedName, liftSecs, planFit, planStow, pourFuel, type Carried } from '../sim/carry';
import { installPart } from '../sim/garage';
import { pourOil } from '../sim/oil';
import { partName } from '../sim/parts';
import type { Cand, Player } from './player';
import type { Vehicle } from './vehicle';

/**
 * Carrying things by hand. Lift a part, a fuel can or an oil can off the ground, walk it to one of your own vehicles,
 * and either put it straight on (A: bolt it on, pour it in, top the sump up) or stow it in the trucks (X) for later.
 * X anywhere else sets it down.
 */

/** Vehicles that count as "our ride": the convoy's own cars with a build, standing still. */
const isOwnRide = (v: Vehicle) => v.faction === 'convoy' && !!v.build && !v.wreck && v.kind !== 'crew';

/** How close a loose item must be to lift it. */
export const LIFT_REACH = 1.9;

function ownRideNear(p: Player): Vehicle | null {
  return p.nearestVehicle(3.8, isOwnRide);
}

/** The hold-A candidate: lift what is at your feet, or fit what is in your hands to the car beside you. */
export function haulCandidate(p: Player): Cand | null {
  const ctx = p.ctx;
  if (!p.carry) {
    const lifting = p.action?.kind === 'lift' ? String(p.action.target) : undefined;
    const near = ctx.loose?.nearest(p.pos.x, p.pos.z, LIFT_REACH, lifting);
    if (!near) return null;
    const label = carriedName(near.carried);
    return {
      kind: 'lift',
      prompt: `Pick up ${label}`,
      dur: liftSecs(near.carried),
      target: near.id,
      ok: true,
      label: 'lift',
      noise: 6,
      run: () => {
        const c = ctx.loose?.take(near.id);
        if (!c) return p.note('Someone got there first', 'info');
        p.carry = c;
        ctx.audio.play('pickup', near.x, near.z, 0.8);
        p.note(`Carrying ${carriedName(c)}: walk it to your car`, 'good');
      },
    };
  }
  const c = p.carry;
  const v = ownRideNear(p);
  if (!v) return null;
  const plan = planFit(c, { def: v.def, fitted: (slot) => v.build?.fit[slot as PartSlot], fuel: v.fuel, tankMax: v.tankMax, oil: v.health.comp.oil });
  const moving = Math.abs(v.speed) > 2;
  return {
    kind: 'fit',
    prompt: moving ? `${v.def.name} is moving` : plan.label,
    dur: plan.secs,
    target: v,
    ok: plan.ok && !moving,
    label: 'fit',
    noise: c.kind === 'part' ? 22 : 14,
    run: () => fit(p, v, c),
    tick: () => {
      if (c.kind === 'part' && Math.random() < 0.18) ctx.fx.spark(v.position.x + (Math.random() - 0.5), v.position.y + 0.8, v.position.z + (Math.random() - 0.5), 2, 3);
      return true;
    },
  };
}

/** Put what is in your hands onto the vehicle. */
function fit(p: Player, v: Vehicle, c: Carried) {
  const camp = p.ctx.campaign;
  const ctx = p.ctx;
  if (p.carry !== c) return;
  switch (c.kind) {
    case 'part': {
      const b = v.build!;
      // Write the live wear into the build first, so what comes off carries the condition it really had.
      v.commit();
      const res = installPart(b, c.item);
      if (!res.ok) return p.note(res.reason ?? 'It does not fit', 'warn');
      v.syncFromBuild();
      p.carry = null;
      ctx.audio.play('wrench', v.position.x, v.position.z, 0.8);
      const name = partName(c.item);
      if (!res.removed) {
        p.note(`${name} fitted`, 'good');
      } else if (camp.stowPart(res.removed)) {
        p.note(`${name} fitted; ${partName(res.removed)} stowed in the trunk`, 'good');
      } else {
        p.carry = { kind: 'part', item: res.removed };
        p.note(`${name} fitted; trunk is full, so you are holding the old ${partName(res.removed)}`, 'warn');
      }
      break;
    }
    case 'fuel': {
      const r = pourFuel(v.fuel, v.tankMax, c.amount);
      v.fuel = r.fuel;
      p.carry = r.left > 0.05 ? { kind: 'fuel', amount: r.left } : null;
      p.note(`+${r.used.toFixed(1)} FU in the tank${p.carry ? ', some left in the can' : ''}`, 'good');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
    case 'oil': {
      const r = pourOil(v.health.comp.oil, c.amount);
      v.health.comp.oil = r.oil;
      v.commit();
      p.carry = r.left > 0.02 ? { kind: 'oil', amount: r.left } : null;
      p.note(`Oil topped up to ${Math.round(r.oil * 100)}%`, 'good');
      ctx.audio.play('pickup', v.position.x, v.position.z, 0.5);
      break;
    }
  }
}

/** Stow what is in your hands in the trucks. Returns true if the hands are now empty. */
export function stowCarry(p: Player, quiet = false): boolean {
  const c = p.carry;
  if (!c) return true;
  const camp = p.ctx.campaign;
  const plan = planStow(c, { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil });
  if (!plan.ok) {
    if (!quiet) p.note(plan.label, 'warn');
    return false;
  }
  switch (c.kind) {
    case 'part':
      camp.stowPart(c.item);
      p.carry = null;
      if (!quiet) p.note(`${partName(c.item)} stowed in the trunk`, 'good');
      break;
    case 'fuel':
      camp.stowFuel(c.amount);
      p.carry = null;
      if (!quiet) p.note(`+${c.amount.toFixed(1)} FU in the reserve cans`, 'good');
      break;
    case 'oil': {
      const took = camp.stowOil(c.amount);
      p.carry = c.amount - took > 0.02 ? { kind: 'oil', amount: c.amount - took } : null;
      if (!quiet) p.note(p.carry ? 'Reserve is full: some oil is left in the can' : 'Oil stowed', p.carry ? 'warn' : 'good');
      break;
    }
  }
  p.ctx.audio.play('pickup', p.pos.x, p.pos.z, 0.5);
  return !p.carry;
}

/** Set what is in your hands down in front of you. With nowhere to put it, it goes to the trucks instead. */
export function dropCarry(p: Player) {
  const c = p.carry;
  if (!c) return;
  if (!p.ctx.loose) return void returnCarry(p);
  p.carry = null;
  const x = p.pos.x + Math.sin(p.yaw) * 0.9;
  const z = p.pos.z + Math.cos(p.yaw) * 0.9;
  p.ctx.loose.drop(x, z, c);
  p.note(`Put down ${carriedName(c)}`, 'info');
}

/** Hand it back to the convoy whatever the room: used when the scene ends. A full trunk scraps parts. */
export function returnCarry(p: Player) {
  const c = p.carry;
  if (!c) return;
  const camp = p.ctx.campaign;
  p.carry = null;
  if (c.kind === 'part') camp.addPart(c.item);
  else if (c.kind === 'fuel') camp.stowFuel(c.amount);
  else if (camp.stowOil(c.amount) < c.amount - 0.02) camp.stocks.scrap += 1;
}

/** Climbing in with full hands: it goes in the trunk if it fits, otherwise it is set down beside the car. */
export function stashBeforeEntering(p: Player) {
  if (!p.carry) return;
  if (!stowCarry(p, true)) dropCarry(p);
  else p.note('Stowed in the trunk', 'info');
}

/** X while carrying: stow it at your car, or set it down anywhere else. */
export function haulKey(p: Player) {
  if (!p.carry) return;
  if (ownRideNear(p)) stowCarry(p);
  else dropCarry(p);
}

/** The prompt for a player whose hands are full: A does the fit (already in `p.prompt`), X stows or sets it down. */
export function haulPrompt(p: Player) {
  const c = p.carry;
  if (!c) return;
  const camp = p.ctx.campaign;
  const near = ownRideNear(p);
  const x = near
    ? planStow(c, { parts: camp.inventoryRoom, oil: OIL_RESERVE_MAX - camp.items.oil })
    : { ok: true, label: `Put down ${carriedName(c)}  ·  walk it to your car to fit or stow it` };
  // Another prompt (a fit in progress, "enter the car") keeps the main slot; X rides underneath it.
  if (p.prompt) p.promptAlt = { text: x.label, button: 'X', ok: x.ok };
  else p.prompt = { text: x.label, progress: -1, button: 'X' };
}
