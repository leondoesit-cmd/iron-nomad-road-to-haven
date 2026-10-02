import * as THREE from 'three';
import { clamp, damp, dampAngle, lerp } from '../core/math';

export type CamMode = 'vehicle' | 'foot' | 'gunner' | 'downed' | 'camp';

export interface CamTarget {
  x: number;
  y: number;
  z: number;
  /** Heading of the thing being followed. */
  yaw: number;
  /** Forward speed (m/s) for pull-back and FOV. */
  speed: number;
  topSpeed: number;
}

export interface CamParams {
  dist: number;
  height: number;
  /** Aim yaw/pitch driven by the right stick on foot and in turrets. */
  aimYaw: number;
  aimPitch: number;
  /** Free-look offset while driving (right stick). */
  lookYaw: number;
  lookPitch: number;
  shoulder: number;
  lookBack: boolean;
  zoom: number;
  /** Mouse aiming: follow the aim with almost no smoothing so the view tracks the hand. */
  crisp?: boolean;
  /**
   * First person: the world position of the player's eyes. The camera sits exactly there and looks along the aim
   * (on foot and at the gun) or along the vehicle's heading plus `lookYaw` / `lookPitch` (driving).
   */
  eye?: THREE.Vector3 | null;
}

/**
 * Chase camera tuned for the short, wide strip each player gets: it sits far back and high,
 * pulls back with speed, and uses a shoulder offset on foot.
 */
export class ChaseCamera {
  pos = new THREE.Vector3();
  look = new THREE.Vector3();
  yaw = 0;
  private shake = 0;
  private shakeT = 0;
  private dist = 5;
  private height = 2;
  private initialized = false;
  mode: CamMode = 'vehicle';
  /** Horizontal forward of the camera (for on-foot movement and aiming). */
  fwd = new THREE.Vector3(0, 0, 1);
  /** Occlusion test: returns distance along the ray before something solid, or Infinity. */
  occlude: (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => number = () => Infinity;
  groundAt: (x: number, z: number) => number = () => 0;
  fovKick = 0;

  addShake(a: number) {
    this.shake = Math.min(1.2, this.shake + a);
  }

  snap() {
    this.initialized = false;
  }

  update(dt: number, t: CamTarget, mode: CamMode, p: CamParams) {
    this.mode = mode;
    if (p.eye) {
      this.updateFirst(dt, t, mode, p, p.eye);
      return;
    }
    const speedFrac = clamp(t.speed / Math.max(1, t.topSpeed), 0, 1);
    const targetDist = p.dist * (1 + 0.25 * speedFrac);
    const targetHeight = p.height;
    const k = this.initialized ? 1 : 100;
    this.dist = damp(this.dist, targetDist, 3.5 * k, dt);
    this.height = damp(this.height, targetHeight, 3.5 * k, dt);
    let camYaw: number;
    let pitch = 0;
    const desired = new THREE.Vector3();
    const lookAt = new THREE.Vector3();
    if (mode === 'vehicle' || mode === 'camp') {
      // Chase the heading with a little lag so corners read; the right stick looks around.
      const base = t.yaw + (p.lookBack ? Math.PI : 0) + p.lookYaw;
      const follow = lerp(3.0, 6.5, speedFrac);
      this.yaw = dampAngle(this.yaw, base, follow * k, dt);
      camYaw = this.yaw;
      pitch = p.lookPitch * 0.25;
      desired.set(t.x - Math.sin(camYaw) * this.dist, t.y + this.height + pitch * this.dist, t.z - Math.cos(camYaw) * this.dist);
      lookAt.set(t.x + Math.sin(camYaw) * (2 + speedFrac * 6), t.y + this.height * 0.28, t.z + Math.cos(camYaw) * (2 + speedFrac * 6));
    } else if (mode === 'foot' || mode === 'gunner') {
      // Orbit the head along the aim direction: pitch up drops the camera so the reticle stays honest.
      camYaw = p.aimYaw;
      this.yaw = camYaw;
      pitch = p.aimPitch;
      const sh = p.shoulder;
      const rx = -Math.cos(camYaw) * sh;
      const rz = Math.sin(camYaw) * sh;
      const dist = mode === 'gunner' ? this.dist : this.dist * (1 - 0.35 * p.zoom);
      const dx = Math.sin(camYaw) * Math.cos(pitch);
      const dy = Math.sin(pitch);
      const dz = Math.cos(camYaw) * Math.cos(pitch);
      const hy = t.y + this.height * 0.95;
      desired.set(t.x - dx * dist + rx, hy - dy * dist + 0.25, t.z - dz * dist + rz);
      lookAt.set(t.x + dx * 25 + rx, hy + dy * 25, t.z + dz * 25 + rz);
    } else {
      // Downed: low and close.
      camYaw = this.yaw;
      desired.set(t.x - Math.sin(camYaw) * 3.2, t.y + 1.3, t.z - Math.cos(camYaw) * 3.2);
      lookAt.set(t.x, t.y + 0.2, t.z);
    }

    // Keep out of walls: pull the camera in along the ray from the target.
    const from = new THREE.Vector3(t.x, t.y + Math.min(this.height, 1.6), t.z);
    const dir = desired.clone().sub(from);
    const len = dir.length();
    if (len > 0.01) {
      dir.divideScalar(len);
      const hit = this.occlude(from, dir, len);
      if (hit < len) desired.copy(from).addScaledVector(dir, Math.max(1.0, hit - 0.35));
    }
    const gy = this.groundAt(desired.x, desired.z) + 0.7;
    if (desired.y < gy) desired.y = gy;

    const posK = mode === 'foot' || mode === 'gunner' ? (p.crisp ? 45 : 22) : 14;
    const lookK = p.crisp ? 90 : 18;
    if (!this.initialized) {
      this.pos.copy(desired);
      this.look.copy(lookAt);
      this.initialized = true;
    } else {
      this.pos.x = damp(this.pos.x, desired.x, posK, dt);
      this.pos.y = damp(this.pos.y, desired.y, posK, dt);
      this.pos.z = damp(this.pos.z, desired.z, posK, dt);
      this.look.x = damp(this.look.x, lookAt.x, lookK, dt);
      this.look.y = damp(this.look.y, lookAt.y, lookK, dt);
      this.look.z = damp(this.look.z, lookAt.z, lookK, dt);
    }
    this.fwd.set(this.look.x - this.pos.x, 0, this.look.z - this.pos.z).normalize();

    // Shake
    this.shakeT += dt * 38;
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  /** First person: no orbit, no occlusion, no smoothing on foot. The eye is inside the capsule, clear of walls. */
  private updateFirst(dt: number, t: CamTarget, mode: CamMode, p: CamParams, eye: THREE.Vector3) {
    let yaw: number;
    let pitch: number;
    if (mode === 'vehicle' || mode === 'camp') {
      // Chassis heading, with a little filtering so suspension judder does not shake the view; the stick or mouse looks around.
      const base = t.yaw + (p.lookBack ? Math.PI : 0) + p.lookYaw;
      this.yaw = this.initialized ? dampAngle(this.yaw, base, 30, dt) : base;
      yaw = this.yaw;
      pitch = p.lookPitch;
    } else {
      yaw = this.yaw = p.aimYaw;
      pitch = p.aimPitch;
    }
    const cp = Math.cos(pitch);
    this.pos.copy(eye);
    this.look.set(eye.x + Math.sin(yaw) * cp * 25, eye.y + Math.sin(pitch) * 25, eye.z + Math.cos(yaw) * cp * 25);
    this.initialized = true;
    this.fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    // Keep the orbit distances warm so leaving first person eases out instead of jumping.
    this.dist = damp(this.dist, p.dist, 3.5, dt);
    this.height = damp(this.height, p.height, 3.5, dt);
    this.shakeT += dt * 38;
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  apply(cam: THREE.PerspectiveCamera) {
    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      cam.position.x += Math.sin(this.shakeT * 1.7) * this.shake * 0.12;
      cam.position.y += Math.cos(this.shakeT * 2.3) * this.shake * 0.1;
    }
    cam.lookAt(this.look);
  }
}
