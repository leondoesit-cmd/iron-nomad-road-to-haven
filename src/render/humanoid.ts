import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { C } from './palette';
import { shared } from './dispose';

const mat = shared(new THREE.MeshLambertMaterial({ vertexColors: true }));
const basicLight = shared(new THREE.MeshBasicMaterial({ color: 0xfff6d0 }));

export type PoseKind = 'stand' | 'ride' | 'seat' | 'downed' | 'gun';

interface Palette {
  jacket: number;
  trim: number;
  pants?: number;
  skin?: number;
  helmet?: number;
}

function part(fn: (b: MeshBuilder) => void): THREE.BufferGeometry {
  const b = new MeshBuilder();
  b.jitter = 0.03;
  fn(b);
  return b.build();
}

/** A blocky survivor. Origin at the feet, facing +Z. */
export class Humanoid {
  root = new THREE.Group();
  hips = new THREE.Group();
  torso = new THREE.Group();
  head = new THREE.Group();
  armL = new THREE.Group();
  armR = new THREE.Group();
  legL = new THREE.Group();
  legR = new THREE.Group();
  kneeL = new THREE.Group();
  kneeR = new THREE.Group();
  hand = new THREE.Group();
  flash = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd36a }));
  private weapon: THREE.Group | null = null;
  private walkT = 0;
  meshes: THREE.Mesh[] = [];

  constructor(pal: Palette) {
    const pants = pal.pants ?? 0x3a3d3f;
    const skin = pal.skin ?? C.skin;
    const mk = (g: THREE.BufferGeometry, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      parent.add(m);
      this.meshes.push(m);
      return m;
    };
    this.root.add(this.hips);
    this.hips.position.y = 0.92;
    // torso (pivot at waist)
    this.hips.add(this.torso);
    mk(
      part((b) => {
        b.box(0, 0.3, 0, 0.46, 0.6, 0.26, pal.jacket);
        b.box(0, 0.3, 0.135, 0.46, 0.14, 0.02, pal.trim); // chest band
        b.box(0, 0.05, 0, 0.44, 0.1, 0.25, 0x2b2b2b); // belt
        b.box(0, 0.35, -0.16, 0.3, 0.36, 0.1, 0x3d3a34); // pack
      }),
      this.torso,
    );
    this.torso.add(this.head);
    this.head.position.y = 0.66;
    mk(
      part((b) => {
        b.box(0, 0.13, 0, 0.24, 0.26, 0.25, skin);
        b.box(0, 0.24, 0, 0.28, 0.12, 0.29, pal.helmet ?? pal.trim); // helmet / hair cap
        b.box(0, 0.15, 0.13, 0.26, 0.07, 0.02, 0x111820); // goggles
      }),
      this.head,
    );
    // arms
    for (const [grp, sx] of [[this.armL, 1], [this.armR, -1]] as const) {
      this.torso.add(grp);
      grp.position.set(sx * 0.3, 0.56, 0);
      mk(
        part((b) => {
          b.box(0, -0.28, 0, 0.14, 0.56, 0.14, pal.jacket);
          b.box(0, -0.6, 0, 0.12, 0.1, 0.12, skin);
        }),
        grp,
      );
    }
    this.armR.add(this.hand);
    this.hand.position.set(0, -0.6, 0.05);
    // legs
    for (const [leg, knee, sx] of [[this.legL, this.kneeL, 1], [this.legR, this.kneeR, -1]] as const) {
      this.hips.add(leg);
      leg.position.set(sx * 0.12, 0, 0);
      mk(
        part((b) => {
          b.box(0, -0.22, 0, 0.17, 0.44, 0.19, pants);
        }),
        leg,
      );
      leg.add(knee);
      knee.position.y = -0.44;
      mk(
        part((b) => {
          b.box(0, -0.22, 0, 0.15, 0.44, 0.17, pants);
          b.box(0, -0.45, 0.04, 0.17, 0.1, 0.27, 0x1d1d1d);
        }),
        knee,
      );
    }
    this.flash.visible = false;
    this.hand.add(this.flash);
    this.flash.position.set(0, 0, 0.5);
  }

  /** Swap the item in the right hand. */
  setWeapon(kind: 'none' | 'pistol' | 'rifle' | 'wrench' | 'jerrycan' | 'crowbar' | 'flare') {
    if (this.weapon) {
      this.hand.remove(this.weapon);
      this.weapon = null;
    }
    if (kind === 'none') return;
    const g = new THREE.Group();
    const b = new MeshBuilder();
    b.jitter = 0.02;
    switch (kind) {
      case 'pistol':
        b.box(0, 0.02, 0.14, 0.05, 0.08, 0.26, 0x2b2b2e);
        b.box(0, -0.04, 0.05, 0.05, 0.12, 0.06, 0x1d1d1f);
        break;
      case 'rifle':
        b.box(0, 0.02, 0.28, 0.06, 0.09, 0.62, 0x2b2b2e);
        b.box(0, -0.02, -0.05, 0.06, 0.1, 0.22, 0x5a4a38);
        b.box(0, -0.08, 0.2, 0.05, 0.14, 0.08, 0x1d1d1f);
        break;
      case 'wrench':
        b.box(0, 0, 0.22, 0.04, 0.05, 0.5, C.steel);
        b.box(0, 0, 0.5, 0.12, 0.1, 0.06, C.steel);
        break;
      case 'jerrycan':
        b.box(0.05, -0.1, 0.1, 0.1, 0.34, 0.26, C.fuel);
        break;
      case 'crowbar':
        b.box(0, 0, 0.25, 0.04, 0.04, 0.6, 0x3a3f46);
        b.box(0, 0, 0.55, 0.04, 0.12, 0.04, 0x3a3f46, 0.6, 0, 0);
        break;
      case 'flare':
        b.box(0, 0, 0.15, 0.04, 0.04, 0.3, 0xd23a3a);
        break;
    }
    const m = new THREE.Mesh(b.build(), mat);
    g.add(m);
    this.hand.add(g);
    this.weapon = g;
  }

  /** Show the muzzle flash for one frame. */
  muzzle(on: boolean) {
    this.flash.visible = on;
  }

  /**
   * Pose the rig. `speed` is horizontal speed in m/s for walk cycles; `aim` raises the weapon arm;
   * `crouch` 0..1 lowers the stance.
   */
  update(dt: number, pose: PoseKind, speed: number, aim: number, crouch: number, lookPitch = 0) {
    this.walkT += dt * (1.5 + speed * 1.1);
    const sw = Math.sin(this.walkT * 2) * Math.min(1, speed / 3.5);
    const r = this.root;
    const h = this.hips;
    r.rotation.x = 0;
    r.position.y = 0;
    if (pose === 'stand' || pose === 'gun') {
      h.position.y = 0.92 - crouch * 0.32;
      const bend = crouch * 1.1;
      this.legL.rotation.x = sw * 0.75 - bend * 0.4;
      this.legR.rotation.x = -sw * 0.75 - bend * 0.4;
      this.kneeL.rotation.x = Math.max(0, -sw) * 0.7 + bend;
      this.kneeR.rotation.x = Math.max(0, sw) * 0.7 + bend;
      this.torso.rotation.x = crouch * 0.35 + (speed > 5 ? 0.15 : 0);
      this.armL.rotation.x = -sw * 0.7 * (1 - aim);
      this.armR.rotation.x = aim > 0.1 ? -1.35 * aim + lookPitch * 0.5 : sw * 0.7;
      if (aim > 0.1) this.armL.rotation.x = -1.15 * aim + lookPitch * 0.4;
      this.armL.rotation.z = aim > 0.1 ? -0.25 * aim : 0;
      this.armR.rotation.z = 0;
      this.head.rotation.x = lookPitch * 0.4;
    } else if (pose === 'ride') {
      // Seated astride a moped: hips down, knees bent, arms to the bars.
      h.position.y = 0.45;
      this.legL.rotation.x = -1.15;
      this.legR.rotation.x = -1.15;
      this.kneeL.rotation.x = 1.45;
      this.kneeR.rotation.x = 1.45;
      this.torso.rotation.x = 0.55;
      this.armL.rotation.x = -1.2;
      this.armR.rotation.x = -1.2;
      this.armL.rotation.z = 0.1;
      this.armR.rotation.z = -0.1;
      this.head.rotation.x = -0.35;
    } else if (pose === 'seat') {
      h.position.y = 0.4;
      this.legL.rotation.x = -1.4;
      this.legR.rotation.x = -1.4;
      this.kneeL.rotation.x = 1.5;
      this.kneeR.rotation.x = 1.5;
      this.torso.rotation.x = 0.1;
      this.armL.rotation.x = -1.0;
      this.armR.rotation.x = -1.0;
      this.head.rotation.x = 0;
    } else if (pose === 'downed') {
      r.rotation.x = -Math.PI / 2;
      r.position.y = 0.2;
      h.position.y = 0.92;
      this.legL.rotation.x = 0.2 + Math.sin(this.walkT) * 0.1;
      this.legR.rotation.x = -0.1;
      this.kneeL.rotation.x = 0.2;
      this.kneeR.rotation.x = 0.3;
      this.armL.rotation.x = -0.4;
      this.armR.rotation.x = 0.3;
      this.torso.rotation.x = 0;
    }
  }

  dispose() {
    for (const m of this.meshes) m.geometry.dispose();
  }
}

export { basicLight };
