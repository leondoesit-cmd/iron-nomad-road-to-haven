import { angleDiff, clamp, damp } from '../core/math';
import type { DriveInput } from '../physics/vehicle';
import type { Vehicle } from './vehicle';
import type { ObstacleIndex } from './obstacles';

export interface SteerState {
  steer: number;
  stuckT: number;
  reverseT: number;
  reverseDir: number;
}
export const newSteerState = (): SteerState => ({ steer: 0, stuckT: 0, reverseT: 0, reverseDir: 1 });

/** Pure-pursuit steering toward a point with a speed governor, whisker avoidance and stuck recovery. */
export function steerTo(v: Vehicle, tx: number, tz: number, wantSpeed: number, st: SteerState, obs: ObstacleIndex, dt: number): DriveInput {
  const p = v.position;
  if (st.reverseT > 0) {
    st.reverseT -= dt;
    return { steer: st.reverseDir, throttle: 0, brake: 1, handbrake: false };
  }
  let avoid = 0;
  const look = 10 + Math.abs(v.speed) * 0.6;
  for (const off of [-0.5, 0, 0.5]) {
    const a = v.yaw + off;
    if (obs.segmentBlocked(p.x, p.z, p.x + Math.sin(a) * look, p.z + Math.cos(a) * look, 1)) avoid += off === 0 ? 0.8 : -off * 1.6;
  }
  const desired = Math.atan2(tx - p.x, tz - p.z);
  const err = angleDiff(v.yaw, desired) + avoid;
  st.steer = damp(st.steer, clamp(-err * 1.6, -1, 1), 10, dt);
  const want = wantSpeed * (Math.abs(err) > 1.1 ? 0.45 : 1);
  if (Math.abs(v.speed) < 1 && wantSpeed > 3) {
    st.stuckT += dt;
    if (st.stuckT > 1.5) {
      st.stuckT = 0;
      st.reverseT = 1.1;
      st.reverseDir = Math.random() < 0.5 ? 1 : -1;
    }
  } else st.stuckT = Math.max(0, st.stuckT - dt);
  return {
    steer: st.steer,
    throttle: clamp((want - v.speed) * 0.5, 0, 1),
    brake: clamp((v.speed - want) * 0.25, 0, 1),
    handbrake: wantSpeed < 0.5 && Math.abs(v.speed) < 2,
  };
}
