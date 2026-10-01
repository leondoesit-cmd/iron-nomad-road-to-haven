import { Btn, NAV, newIntent, type PlayerIntent } from './intents';
import { radialDeadzone, clamp } from '../core/math';

export type Slot = { kind: 'pad'; index: number } | { kind: 'kb'; set: 1 | 2 };

export interface Settings {
  /** Per-player options, per the pause menu. */
  rumble: [boolean, boolean];
  aimAssist: [number, number];
  invertLookY: [boolean, boolean];
  /** Hold (false) or toggle (true) for crouch / headlights. */
  toggleCrouch: [boolean, boolean];
  deadzone: number;
}

export const defaultSettings = (): Settings => ({
  rumble: [true, true],
  aimAssist: [1, 1],
  invertLookY: [false, false],
  toggleCrouch: [true, true],
  deadzone: 0.15,
});

interface KbMap {
  up: string;
  down: string;
  left: string;
  right: string;
  aimL: string;
  aimR: string;
  fire: string;
  interact: string;
  vehicle: string;
  alt: string; // crouch / lights
  sprint: string; // sprint / handbrake
  wheel: string;
  reload: string;
  horn: string;
  swap: string;
  craftUp: string;
  craftDown: string;
}

const KB: Record<1 | 2, KbMap> = {
  1: {
    up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
    aimL: 'KeyQ', aimR: 'KeyE', fire: 'KeyF', interact: 'KeyG', vehicle: 'KeyR', alt: 'KeyC',
    sprint: 'ShiftLeft', wheel: 'Tab', reload: 'KeyT', horn: 'KeyH', swap: 'KeyV', craftUp: 'KeyZ', craftDown: 'KeyX',
  },
  2: {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    aimL: 'BracketLeft', aimR: 'BracketRight', fire: 'ShiftRight', interact: 'Slash', vehicle: 'Enter', alt: 'Period',
    sprint: 'ControlRight', wheel: 'Backspace', reload: 'Comma', horn: 'KeyM', swap: 'KeyN', craftUp: 'Semicolon', craftDown: 'Quote',
  },
};

/** Keys that must not scroll or trigger browser behaviour. */
const BLOCK = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Backspace', 'Slash', 'Space', 'BracketLeft', 'BracketRight', 'Quote', 'Backslash',
]);

/** Samples both gamepads and the shared keyboard and writes one PlayerIntent per player each fixed tick. */
export class InputManager {
  slots: [Slot | null, Slot | null] = [null, null];
  intents: [PlayerIntent, PlayerIntent] = [newIntent(), newIntent()];
  settings: Settings = defaultSettings();
  /** Set when an assigned pad disconnects; the game pauses and shows a reconnect overlay. */
  disconnected: [boolean, boolean] = [false, false];
  nonStandard = new Set<number>();
  onDisconnect: (player: number) => void = () => {};
  onReconnect: (player: number) => void = () => {};
  onEscape: () => void = () => {};
  /** Last raw key edge events (consumed by menus). */
  private keys = new Set<string>();
  private keyPressedThisTick = new Set<string>();
  private kbSmooth: [[number, number], [number, number]] = [[0, 0], [0, 0]];
  private prevHeld: [number, number] = [0, 0];
  private holdTime: [Float32Array, Float32Array] = [new Float32Array(16), new Float32Array(16)];
  private stickAngle: [number, number] = [0, 0];
  private stickAccum: [number, number] = [0, 0];
  private navPrev: [number, number] = [0, 0];
  private navTimer: [number, number] = [0, 0];
  /** Test hook: when set, returned instead of navigator.getGamepads(). */
  mockPads: (Gamepad | null)[] | null = null;
  private joinPrev = new Map<number, boolean>();

  constructor(private target: Window) {
    target.addEventListener('keydown', (e) => {
      if (BLOCK.has(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.keyPressedThisTick.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Escape' && !e.repeat) this.onEscape();
    });
    target.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    target.addEventListener('blur', () => this.keys.clear());
    target.addEventListener('gamepaddisconnected', (e) => {
      const pad = (e as GamepadEvent).gamepad;
      for (let p = 0; p < 2; p++) {
        const s = this.slots[p];
        if (s && s.kind === 'pad' && s.index === pad.index) {
          this.disconnected[p] = true;
          this.onDisconnect(p);
        }
      }
    });
    target.addEventListener('gamepadconnected', (e) => {
      const pad = (e as GamepadEvent).gamepad;
      for (let p = 0; p < 2; p++) {
        const s = this.slots[p];
        if (s && s.kind === 'pad' && s.index === pad.index && this.disconnected[p]) {
          this.disconnected[p] = false;
          this.onReconnect(p);
        }
      }
    });
  }

  pads(): (Gamepad | null)[] {
    if (this.mockPads) return this.mockPads;
    try {
      return Array.from(navigator.getGamepads?.() ?? []);
    } catch {
      return [];
    }
  }

  isKeyDown(code: string) {
    return this.keys.has(code);
  }
  wasKeyPressed(code: string) {
    return this.keyPressedThisTick.has(code);
  }

  /**
   * Lobby: "Press A to join". First pad pressed becomes Player 1, second Player 2.
   * Keyboard fallback joins with F (P1) and Right Shift (P2).
   */
  pollJoin(): void {
    for (const pad of this.pads()) {
      if (!pad || !pad.connected) continue;
      if (pad.mapping !== 'standard') this.nonStandard.add(pad.index);
      if (this.slots.some((s) => s && s.kind === 'pad' && s.index === pad.index)) continue;
      const pressed = !!pad.buttons[Btn.A]?.pressed;
      const was = this.joinPrev.get(pad.index) ?? false;
      this.joinPrev.set(pad.index, pressed);
      if (pressed && !was) {
        const free = this.slots.findIndex((s) => s === null);
        if (free >= 0) this.slots[free] = { kind: 'pad', index: pad.index };
      }
    }
    if (this.keys.has(KB[1].fire) && !this.slots.some((s) => s?.kind === 'kb' && s.set === 1)) this.assignKb(1);
    if (this.keys.has(KB[2].fire) && !this.slots.some((s) => s?.kind === 'kb' && s.set === 2)) this.assignKb(2);
  }

  private assignKb(set: 1 | 2) {
    // The keyboard sets fill a preferred seat: set 1 prefers P1, set 2 prefers P2.
    const pref = set === 1 ? 0 : 1;
    const idx = this.slots[pref] === null ? pref : this.slots.findIndex((s) => s === null);
    if (idx >= 0) this.slots[idx] = { kind: 'kb', set };
  }

  swapSeats() {
    this.slots = [this.slots[1], this.slots[0]];
  }

  get joined() {
    return this.slots.filter(Boolean).length;
  }

  /** Fill empty seats with keyboard sets (used for quick-play and automated tests). */
  autoJoinKeyboard() {
    if (!this.slots[0]) this.slots[0] = { kind: 'kb', set: 1 };
    if (!this.slots[1]) this.slots[1] = { kind: 'kb', set: 2 };
  }

  /** Sample devices into intents. Call once per fixed tick. */
  sample(dt: number): void {
    const pads = this.pads();
    for (let p = 0; p < 2; p++) {
      const slot = this.slots[p];
      const it = this.intents[p];
      let held = 0;
      let mx = 0;
      let my = 0;
      let lx = 0;
      let ly = 0;
      let lt = 0;
      let rt = 0;
      let handbrake = false;
      let sprint = false;
      it.aimAssist = this.settings.aimAssist[p];

      if (slot?.kind === 'pad') {
        it.device = 'pad';
        const pad = pads[slot.index];
        if (pad && pad.connected) {
          const dz = this.settings.deadzone;
          [mx, my] = radialDeadzone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0), dz, 1);
          // Response curve: steeper for steering, linear for aim.
          mx = Math.sign(mx) * Math.abs(mx) ** 1.35;
          [lx, ly] = radialDeadzone(pad.axes[2] ?? 0, -(pad.axes[3] ?? 0), dz, 1);
          if (this.settings.invertLookY[p]) ly = -ly;
          for (let b = 0; b < 16; b++) if (pad.buttons[b]?.pressed) held |= 1 << b;
          // Triggers are analog values, not buttons.
          lt = pad.buttons[Btn.LT]?.value ?? 0;
          rt = pad.buttons[Btn.RT]?.value ?? 0;
          held = lt > 0.12 ? held | (1 << Btn.LT) : held & ~(1 << Btn.LT);
          held = rt > 0.12 ? held | (1 << Btn.RT) : held & ~(1 << Btn.RT);
          handbrake = !!pad.buttons[Btn.A]?.pressed;
          sprint = !!pad.buttons[Btn.L3]?.pressed;
        }
      } else if (slot?.kind === 'kb') {
        it.device = 'keyboard';
        it.aimAssist = this.settings.aimAssist[p] * 1.5; // 50% stronger aim assist without analog sticks
        const k = KB[slot.set];
        const tx = (this.keys.has(k.right) ? 1 : 0) - (this.keys.has(k.left) ? 1 : 0);
        const ty = (this.keys.has(k.up) ? 1 : 0) - (this.keys.has(k.down) ? 1 : 0);
        const sm = this.kbSmooth[p];
        // Digital keys ramp so steering is analog-ish.
        sm[0] = approach(sm[0], tx, (tx !== 0 ? 7 : 11) * dt);
        sm[1] = approach(sm[1], ty, (ty !== 0 ? 7 : 11) * dt);
        mx = sm[0];
        my = sm[1];
        lx = (this.keys.has(k.aimR) ? 1 : 0) - (this.keys.has(k.aimL) ? 1 : 0);
        const set = (code: string, b: number) => {
          if (this.keys.has(code)) held |= 1 << b;
        };
        if (this.keys.has(k.fire)) {
          held |= (1 << Btn.RB) | (1 << Btn.RT);
          rt = 1;
        }
        set(k.interact, Btn.A);
        set(k.vehicle, Btn.Y);
        set(k.alt, Btn.B);
        set(k.reload, Btn.X);
        set(k.horn, Btn.X);
        set(k.swap, Btn.LB);
        set(k.wheel, Btn.Up);
        set(k.craftUp, Btn.Left);
        set(k.craftDown, Btn.Right);
        sprint = this.keys.has(k.sprint);
        handbrake = sprint;
        if (sprint) held |= 1 << Btn.L3;
        // Convoy sheet (Back): hold Space for Player 1, Backslash for Player 2. Escape pauses for both.
        if ((slot.set === 1 && this.keys.has('Space')) || (slot.set === 2 && this.keys.has('Backslash'))) held |= 1 << Btn.Back;
      } else {
        it.device = 'none';
      }

      it.move[0] = mx;
      it.move[1] = my;
      it.look[0] = lx;
      it.look[1] = ly;
      it.lt = lt;
      it.rt = rt;
      it.handbrake = handbrake;
      it.sprint = sprint;
      const prev = this.prevHeld[p];
      it.pressed = held & ~prev;
      it.released = prev & ~held;
      it.held = held;
      for (let b = 0; b < 16; b++) {
        if (held & (1 << b)) this.holdTime[p][b] += dt;
        else this.holdTime[p][b] = 0;
      }
      it.heldTime = this.holdTime[p];
      this.prevHeld[p] = held;

      // Menu navigation edges with key repeat, from the left stick / move keys and the pad D-pad.
      let dirs = 0;
      if (my > 0.6 || (held & (1 << Btn.Up) && it.device === 'pad')) dirs |= NAV.up;
      if (my < -0.6 || (held & (1 << Btn.Down) && it.device === 'pad')) dirs |= NAV.down;
      if (mx < -0.6 || (held & (1 << Btn.Left) && it.device === 'pad')) dirs |= NAV.left;
      if (mx > 0.6 || (held & (1 << Btn.Right) && it.device === 'pad')) dirs |= NAV.right;
      it.nav = 0;
      if (dirs !== this.navPrev[p]) {
        it.nav = dirs & ~this.navPrev[p];
        this.navTimer[p] = 0.38;
      } else if (dirs) {
        this.navTimer[p] -= dt;
        if (this.navTimer[p] <= 0) {
          it.nav = dirs;
          this.navTimer[p] = 0.12;
        }
      }
      this.navPrev[p] = dirs;

      // Left-stick rotation counter (pin break): counts completed full turns.
      it.stickLoops = 0;
      const mag = Math.hypot(mx, my);
      if (mag > 0.6) {
        const ang = Math.atan2(my, mx);
        let d = ang - this.stickAngle[p];
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.stickAccum[p] += Math.abs(d);
        this.stickAngle[p] = ang;
        while (this.stickAccum[p] >= Math.PI * 2) {
          this.stickAccum[p] -= Math.PI * 2;
          it.stickLoops++;
        }
      } else {
        this.stickAccum[p] = Math.max(0, this.stickAccum[p] - dt * 2);
      }
    }
    this.keyPressedThisTick.clear();
  }

  /** Rumble where the browser supports it (Chrome and Edge). Silently ignored elsewhere. */
  rumble(player: number, strong: number, weak: number, ms: number) {
    if (!this.settings.rumble[player]) return;
    const slot = this.slots[player];
    if (slot?.kind !== 'pad') return;
    const pad = this.pads()[slot.index] as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }) | null;
    try {
      pad?.vibrationActuator?.playEffect?.('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: clamp(strong, 0, 1), weakMagnitude: clamp(weak, 0, 1) });
    } catch {
      /* feature-detected, ignore failures */
    }
  }

  /** Any joined device pressed this button this tick (for shared menus). */
  anyPressed(b: number): number {
    for (let p = 0; p < 2; p++) if (this.intents[p].pressed & (1 << b)) return p;
    return -1;
  }
}

function approach(c: number, t: number, step: number) {
  if (c < t) return Math.min(t, c + step);
  if (c > t) return Math.max(t, c - step);
  return c;
}
