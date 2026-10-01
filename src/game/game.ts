import { GameRenderer, QUALITY, type QualityPreset } from '../render/renderer';
import { InputManager } from '../input/input';
import { Btn, isHeld, wasPressed } from '../input/intents';
import { AudioEngine } from '../audio/audio';
import { Hud } from '../ui/hud';
import { FocusUI } from '../ui/focus';
import { Campaign } from './campaign';
import { LegScene } from './legScene';
import { Scene, type SceneResult, type SceneServices } from './scene';
import { initPhysics, FIXED_STEP } from '../physics/physics';
import { LEGS, legById, t, validateData } from '../data';
import { Overlays } from '../ui/overlays';
import { CampScene } from './campScene';
import { applyEncounterEffects } from './encounterFx';
import { saveCampaign, loadCampaign } from '../save/save';

export type Phase =
  | 'boot'
  | 'title'
  | 'leg'
  | 'vote'
  | 'camp'
  | 'report'
  | 'ledger'
  | 'fail'
  | 'end';

const MAX_STEPS = 5;

/** Owns the loop, the scene, input and every overlay. One instance per page. */
export class Game {
  R: GameRenderer;
  audio = new AudioEngine();
  input: InputManager;
  hud: Hud;
  focus = new FocusUI();
  overlays: Overlays;
  campaign = new Campaign();
  scene: Scene | null = null;
  phase: Phase = 'boot';
  paused = false;
  pausedBy = -1;
  private acc = 0;
  private last = 0;
  private time = 0;
  private hudAcc = 0;
  debug = false;
  fps = 0;
  private fpsEma = 60;
  private frameMs = 16;
  private wheelHold: [number, number] = [0, 0];
  /** Test and tooling hook. */
  hooks: { onTick?: (g: Game) => void } = {};
  slowMo = 1;
  /** Seconds during which Start is ignored, so the press that began a scene doesn't also pause it. */
  private startLock = 0;
  /** True while the title screen is showing a live autopilot convoy behind the menu. */
  private attract = false;

  constructor() {
    this.debug = new URLSearchParams(location.search).has('debug');
    const canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.R = new GameRenderer(canvas);
    this.input = new InputManager(window);
    const halves = [document.getElementById('half0')!, document.getElementById('half1')!];
    this.hud = new Hud(halves);
    this.hud.setLayout(this.R.layout);
    this.overlays = new Overlays(this);
    this.input.onEscape = () => this.togglePause(-1);
    this.input.onDisconnect = (p) => {
      this.hud.disconnected[p] = true;
      if (this.phase === 'leg' || this.phase === 'camp') this.setPause(true, p);
    };
    this.input.onReconnect = (p) => {
      this.hud.disconnected[p] = false;
    };
    // Browsers need a gesture before audio can start.
    const wake = () => this.audio.init();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('gamepadconnected', wake);
    this.R.onContextRestored = () => {
      /* geometry lives in the scene graph; three rebuilds GPU buffers lazily */
    };
    window.addEventListener('resize', () => this.layout());
    this.applySettings();
  }

  async start() {
    await initPhysics();
    if (this.debug) {
      const errs = validateData();
      if (errs.length) console.error('Data validation failed:', errs);
    }
    this.phase = 'title';
    this.hud.setVisible(false);
    this.overlays.showTitle();
    this.layout();
    this.startAttract();
    this.last = performance.now();
    requestAnimationFrame((n) => this.frame(n));
  }

  layout() {
    this.R.resize();
    const div = document.getElementById('divider')!;
    div.className = this.R.layout === 'horizontal' ? 'h' : 'v';
    this.hud.setLayout(this.R.layout);
  }

  applySettings() {
    try {
      const raw = localStorage.getItem('ironnomad.settings');
      if (!raw) return;
      const s = JSON.parse(raw) as { quality?: QualityPreset; ui?: number; layout?: 'horizontal' | 'vertical'; vol?: number; music?: number };
      if (s.quality && QUALITY[s.quality]) this.R.setQuality(s.quality);
      if (s.ui) this.hud.setScale(s.ui);
      if (s.layout) this.R.setLayout(s.layout);
      if (s.vol !== undefined) this.audio.setVolume(s.vol);
      if (s.music !== undefined) this.audio.setMusicVolume(s.music);
    } catch {
      /* private mode or corrupt settings */
    }
  }

  saveSettings() {
    try {
      localStorage.setItem(
        'ironnomad.settings',
        JSON.stringify({ quality: this.R.quality, ui: this.hud.uiScale, layout: this.R.layout, vol: this.audio.volume, music: this.audio.musicVolume }),
      );
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ services for scenes

  services(): SceneServices {
    return {
      R: this.R,
      audio: this.audio,
      input: this.input,
      campaign: this.campaign,
      onRadio: (text) => this.hud.showSub(text, Math.max(4, Math.min(9, text.length / 14))),
      onTip: (id) => this.hud.showTip(t(`tip.${id}`), 10),
      onBanner: (title, sub) => this.hud.showBanner(title, sub, 4),
    };
  }

  // ------------------------------------------------------------------ flow

  newCampaign() {
    this.campaign = new Campaign([this.overlays.callsign(0), this.overlays.callsign(1)]);
    this.campaign.seed = (Math.random() * 1e6) | 0;
  }

  startNewGame() {
    this.input.autoJoinKeyboard();
    this.newCampaign();
    this.beginLeg(this.campaign.legId);
  }

  continueGame() {
    const c = loadCampaign();
    if (!c) return this.startNewGame();
    this.input.autoJoinKeyboard();
    this.campaign = c;
    // Resume at the Ledger that was saved at dawn.
    this.beginLedger();
  }

  disposeScene() {
    this.attract = false;
    if (this.scene) {
      this.scene.dispose();
      this.scene = null;
    }
  }

  beginLeg(legId: string) {
    this.disposeScene();
    this.overlays.hideAll();
    this.campaign.legId = legId;
    const leg = legById(legId);
    const sc = new LegScene(this.services(), leg);
    sc.onResult = (r) => this.onSceneResult(r);
    this.scene = sc;
    this.phase = 'leg';
    this.paused = false;
    this.hud.setVisible(true);
    this.focus.active = false;
    this.hud.showBanner(leg.name.toUpperCase(), leg.subtitle, 5);
    this.audio.setMusic('travel');
    this.startLock = 0.5;
  }

  private onSceneResult(r: SceneResult) {
    if (r.type === 'fail') return this.fail(r.reason);
    if (r.type === 'encounter' && this.scene instanceof LegScene) {
      this.phase = 'vote';
      this.scene.paused = true;
      this.overlays.showEncounter(r.id, (effects, overridden) => {
        const sc = this.scene as LegScene;
        applyEncounterEffects(sc, effects, overridden);
        sc.paused = false;
        sc.resumeAfterEncounter();
        this.phase = 'leg';
        this.overlays.hideAll();
      });
      return;
    }
    if (r.type === 'dusk' && this.scene instanceof LegScene) {
      this.phase = 'vote';
      this.scene.paused = true;
      this.overlays.showCampDecision(this.scene.leg, (siteId, hot) => this.beginCamp(siteId, hot));
      return;
    }
    if (r.type === 'campDone') this.afterCamp();
  }

  beginCamp(siteId: string, hot: boolean) {
    const leg = this.scene instanceof LegScene ? this.scene.leg : legById(this.campaign.legId);
    // Carry over vehicle HP before the leg is torn down.
    this.snapshotVehicles();
    this.disposeScene();
    this.overlays.hideAll();
    this.campaign.hotCamp = hot;
    const camp = new CampScene(this.services(), leg, siteId, hot);
    camp.onResult = (r) => this.onSceneResult(r);
    this.scene = camp;
    this.phase = 'camp';
    this.paused = false;
    this.startLock = 0.5;
    this.hud.showBanner('CAMP', camp.siteName, 5);
  }

  private snapshotVehicles() {
    const sc = this.scene;
    if (!sc) return;
    for (let i = 0; i < 2; i++) {
      const own = sc.players[i]?.ownVehicle;
      if (own && !own.wreck) this.campaign.players[i].hpFrac = own.hpFrac;
    }
  }

  private afterCamp() {
    const camp = this.scene as CampScene;
    this.phase = 'report';
    camp.paused = true;
    this.overlays.showReport(camp, () => this.afterReport());
  }

  private afterReport() {
    this.beginLedger();
  }

  beginLedger() {
    this.phase = 'ledger';
    // The Ledger sits on top of the dawn camp so the convoy stays on screen.
    let camp = this.scene instanceof CampScene ? this.scene : null;
    if (!camp) {
      this.disposeScene();
      const leg = legById(this.campaign.legId);
      camp = new CampScene(this.services(), leg, leg.campSites[0], true, true);
      camp.onResult = (r) => this.onSceneResult(r);
      this.scene = camp;
    }
    camp.enterLedgerMode();
    this.hud.setVisible(false);
    saveCampaign(this.campaign);
    this.overlays.showLedger(camp, (nextLegId) => {
      this.campaign.history.push(this.campaign.legId);
      this.campaign.legId = nextLegId;
      this.campaign.day++;
      this.hud.setVisible(true);
      this.beginLeg(nextLegId);
    });
  }

  fail(reason: string) {
    if (this.phase === 'fail') return;
    this.phase = 'fail';
    this.overlays.showFail(reason, () => this.continueGame(), () => this.toTitle());
  }

  toTitle() {
    this.disposeScene();
    this.phase = 'title';
    this.hud.setVisible(false);
    this.overlays.showTitle();
    this.audio.setMusic('none');
    this.startAttract();
  }

  /** A looping demo behind the title: two autopilot convoys on the first road. */
  private startAttract() {
    this.disposeScene();
    const c = new Campaign(['Ash', 'Rook']);
    c.players[0].tier = 3;
    c.players[1].tier = 2;
    c.seed = (Math.random() * 1e6) | 0;
    this.campaign = c;
    const svc = this.services();
    svc.onRadio = () => {};
    svc.onTip = () => {};
    const sc = new LegScene(svc, legById('L1'));
    sc.onResult = () => {};
    sc.pendingResult = true; // no encounters or camp decisions in the demo
    sc.players[0].autopilot = { speed: 17 };
    sc.players[1].autopilot = { speed: 15 };
    this.scene = sc;
    this.attract = true;
  }

  // ------------------------------------------------------------------ pause

  togglePause(by: number) {
    if (this.phase !== 'leg' && this.phase !== 'camp') return;
    this.setPause(!this.paused, by);
  }

  setPause(on: boolean, by: number) {
    if (on === this.paused) return;
    this.paused = on;
    this.pausedBy = by;
    if (on) this.overlays.showPause(by);
    else this.overlays.hidePause();
  }

  // ------------------------------------------------------------------ loop

  private frame(now: number) {
    const raw = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    this.frameMs = raw * 1000;
    this.fpsEma += (1 / Math.max(raw, 1e-4) - this.fpsEma) * 0.05;
    this.fps = this.fpsEma;
    let dt = raw * this.slowMo;
    // The fixed-step accumulator is clamped to 5 steps so a slow frame cannot spiral.
    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_STEP && steps < MAX_STEPS) {
      this.fixed(FIXED_STEP);
      this.acc -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;
    this.render(this.acc / FIXED_STEP, raw);
    requestAnimationFrame((n) => this.frame(n));
  }

  private fixed(step: number) {
    this.input.sample(step);
    this.time += step;
    // Menus and overlays run on the same tick so cursors feel identical to the sim.
    if (this.phase === 'title') {
      this.input.pollJoin();
      this.overlays.tickTitle(step);
    }
    if (this.paused) {
      this.overlays.tickPause(step);
      return;
    }
    if (this.focus.active) this.focus.update(this.input);
    this.overlays.tick(step);
    const sc = this.scene;
    if (!sc) return;
    if (this.attract) {
      if (this.phase === 'title') {
        sc.tick(step);
        // Restart the demo when it runs long, or when the convoy has crashed out.
        const dead = sc.players.every((p) => !p.vehicle || p.vehicle.wreck);
        if (sc.time > 80 || dead) this.startAttract();
      }
      return;
    }
    if (this.phase === 'leg' || this.phase === 'camp') {
      // Pause with Start from either pad.
      this.startLock = Math.max(0, this.startLock - step);
      if (this.startLock <= 0) for (let p = 0; p < 2; p++) if (wasPressed(this.input.intents[p], Btn.Start)) this.togglePause(p);
      if (!sc.paused) {
        this.handleCommandWheel(sc);
        sc.tick(step);
      }
    } else if (sc instanceof CampScene && this.phase === 'ledger') {
      sc.tickIdle(step);
    }
    this.hooks.onTick?.(this);
  }

  /** D-pad: tap = ping, hold = command wheel (Ping, Hold, Follow, Spread, Regroup). */
  private handleCommandWheel(sc: Scene) {
    for (let p = 0; p < 2; p++) {
      const it = this.input.intents[p];
      const pl = sc.players[p];
      if (!pl || pl.state === 'dead') continue;
      if (isHeld(it, Btn.Up)) {
        this.wheelHold[p] += FIXED_STEP;
        if (this.wheelHold[p] > 0.25) {
          // Select a slice with the right stick (or move keys for keyboard).
          const sx = it.device === 'keyboard' ? it.move[0] : it.look[0];
          const sy = it.device === 'keyboard' ? it.move[1] : it.look[1];
          if (Math.hypot(sx, sy) > 0.45) {
            const a = Math.atan2(sx, sy); // 0 = up, + = right
            const deg = (a * 180) / Math.PI;
            this.hud.wheelSel[p] = deg > -36 && deg <= 36 ? 0 : deg > 36 && deg <= 108 ? 1 : deg > 108 || deg <= -144 ? 2 : deg > -144 && deg <= -72 ? 3 : 4;
            if (deg > 108 && deg <= 180) this.hud.wheelSel[p] = 2;
          }
        }
      } else if (this.wheelHold[p] > 0) {
        const held = this.wheelHold[p];
        this.wheelHold[p] = 0;
        const sel = this.hud.wheelSel[p];
        this.hud.wheelSel[p] = -1;
        if (held <= 0.25 || sel === 0) this.doPing(sc, p);
        else {
          const cmd = (['ping', 'follow', 'regroup', 'spread', 'hold'] as const)[sel] ?? 'follow';
          sc.crew.command(cmd, p);
        }
      }
    }
  }

  private doPing(sc: Scene, p: number) {
    const pl = sc.players[p];
    const a = pl.computeAim(pl.vehicle ?? undefined);
    void a;
    const pt = pl.aimPoint;
    // Classify what the ping landed on.
    let vehicle = null as import('./vehicle').Vehicle | null;
    for (const v of sc.vehicles) {
      if (Math.hypot(v.position.x - pt.x, v.position.z - pt.z) < v.def.length * 0.6 + 1.2 && v.faction === 'convoy') vehicle = v;
    }
    sc.crew.command('ping', p, { x: pt.x, z: pt.z, vehicle });
    if (sc instanceof LegScene) sc.addPing(pt.x, pt.z, p);
  }

  /**
   * Run the simulation for `seconds` of game time without waiting on requestAnimationFrame, then draw one frame.
   * Used by tests and tooling (and anywhere the tab is hidden and the browser throttles rAF).
   */
  advance(seconds: number, drawEvery = 0) {
    const n = Math.round(seconds / FIXED_STEP);
    for (let i = 0; i < n; i++) {
      this.fixed(FIXED_STEP);
      if (drawEvery && i % drawEvery === 0) this.render(0, FIXED_STEP * drawEvery);
    }
    this.render(0, FIXED_STEP);
  }

  private render(alpha: number, dt: number) {
    const sc = this.scene;
    if (sc && (this.phase === 'leg' || this.phase === 'camp' || this.phase === 'ledger' || this.phase === 'vote' || this.phase === 'report' || (this.phase === 'title' && this.attract))) {
      sc.renderFrame(this.paused ? 0 : alpha, dt);
      if (!this.attract) sc.updateAudio(dt);
      this.R.adapt(this.frameMs);
      // Particles scale with the viewport.
      for (let i = 0; i < 2; i++) {
        const v = this.R.views[i];
        this.R.onBeforeView[0] = (idx, cam) => {
          const rect = this.R.views[idx].rect;
          sc.fx.setViewScale(rect.h * this.R.gl.getPixelRatio(), cam.fov);
        };
        void v;
      }
      this.R.render(this.time);
      if (!this.attract) this.hud.update(sc, dt, this.input.slots, { legProgress: () => null });
    } else {
      // Title: slow orbit around an empty ground plane is not needed; clear to the sky colour.
      this.R.gl.setScissorTest(false);
      this.R.gl.setClearColor(0x0b0907, 1);
      this.R.gl.clear();
    }
    if (this.debug) this.overlays.debugLine(`${this.fps.toFixed(0)} fps · ${this.R.gl.info.render.calls} calls · ${(this.R.gl.info.render.triangles / 1000).toFixed(0)}k tris · scale ${this.R.renderScale.toFixed(2)}${sc ? ` · zombies ${sc.zombies.aliveCount} · veh ${sc.vehicles.length}` : ''}`);
  }
}

void LEGS;
