import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { C } from './palette';
import { Humanoid } from './humanoid';
import type { VehicleDef } from '../data';
import { shared } from './dispose';

const bodyMat = shared(new THREE.MeshLambertMaterial({ vertexColors: true }));
const lightMat = shared(new THREE.MeshBasicMaterial({ color: 0xfff1bf }));
const lightOffMat = shared(new THREE.MeshLambertMaterial({ color: 0x8a8678 }));
const brakeMat = shared(new THREE.MeshBasicMaterial({ color: 0xff2a1a }));

export interface WheelVisual {
  /** Positioned at the wheel centre, yawed by steering. */
  pivot: THREE.Group;
  spin: THREE.Group;
  steered: boolean;
  radius: number;
}

export interface VehicleVisual {
  root: THREE.Group;
  /** Roll pivot used to lean two-wheelers. */
  lean: THREE.Group;
  inner: THREE.Group;
  body: THREE.Mesh;
  wheels: WheelVisual[];
  driver: Humanoid | null;
  passenger: Humanoid | null;
  /** Pivot for a rotating gun (T3 bed MG). */
  gun: THREE.Group | null;
  /** World-space-ish anchor for muzzle flashes (child of gun or body). */
  muzzle: THREE.Object3D;
  headlights: THREE.Mesh[];
  smoke: THREE.Object3D;
  /** Ground offset (distance from the chassis origin to the ground) for lean pivoting. */
  groundY: number;
  setHeadlights(on: boolean): void;
  damageTint(frac: number): void;
  dispose(): void;
}

const wheelGeoCache = new Map<string, THREE.BufferGeometry>();
function wheelGeometry(radius: number, width: number, knobby: boolean): THREE.BufferGeometry {
  const key = `${radius}:${width}:${knobby}`;
  let g = wheelGeoCache.get(key);
  if (g) return g;
  const b = new MeshBuilder();
  b.jitter = 0.03;
  // Tyre (rotated to lie along X), hub caps and a stripe so spin reads.
  b.cyl(0, 0, 0, radius * 2, width, radius * 2, C.tire, 0, 0, Math.PI / 2, 14);
  b.cyl(0, 0, 0, radius * 1.1, width + 0.02, radius * 1.1, C.hub, 0, 0, Math.PI / 2, 10);
  b.box(0, 0, 0, width + 0.03, radius * 0.18, radius * 1.6, 0x4a4a4a);
  if (knobby) for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.box(0, Math.sin(a) * radius * 0.98, Math.cos(a) * radius * 0.98, width * 1.05, radius * 0.18, radius * 0.18, 0x141414, a, 0, 0);
  }
  g = shared(b.build());
  wheelGeoCache.set(key, g);
  return g;
}

function addWheels(v: VehicleVisual, parent: THREE.Object3D, def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], width: number, knobby: boolean) {
  const geo = wheelGeometry(def.physics.wheelRadius, width, knobby);
  wheelLocal.forEach(([x, y, z], i) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y - def.physics.suspension.rest, z);
    const spin = new THREE.Group();
    const m = new THREE.Mesh(geo, bodyMat);
    m.castShadow = true;
    spin.add(m);
    pivot.add(spin);
    parent.add(pivot);
    v.wheels.push({ pivot, spin, steered: steered[i], radius: def.physics.wheelRadius });
  });
}

function finish(v: VehicleVisual, bodyGeo: THREE.BufferGeometry): VehicleVisual {
  v.body = new THREE.Mesh(bodyGeo, bodyMat);
  v.body.castShadow = true;
  v.inner.add(v.body);
  v.setHeadlights = (on: boolean) => {
    for (const h of v.headlights) h.material = on ? lightMat : lightOffMat;
  };
  v.damageTint = () => {};
  v.dispose = () => {
    bodyGeo.dispose();
  };
  return v;
}

function blank(def: VehicleDef): VehicleVisual {
  const p = def.physics;
  const groundY = Math.abs(p.hardY) + p.suspension.rest + p.wheelRadius;
  const root = new THREE.Group();
  const lean = new THREE.Group();
  const inner = new THREE.Group();
  lean.position.y = -groundY;
  inner.position.y = groundY;
  root.add(lean);
  lean.add(inner);
  return {
    root,
    lean,
    inner,
    body: null as unknown as THREE.Mesh,
    wheels: [],
    driver: null,
    passenger: null,
    gun: null,
    muzzle: new THREE.Object3D(),
    headlights: [],
    smoke: new THREE.Object3D(),
    groundY,
    setHeadlights: () => {},
    damageTint: () => {},
    dispose: () => {},
  };
}

function lamp(v: VehicleVisual, x: number, y: number, z: number, s = 0.16) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, 0.06), lightOffMat);
  m.position.set(x, y, z);
  v.inner.add(m);
  v.headlights.push(m);
}
function tail(v: VehicleVisual, x: number, y: number, z: number) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.05), brakeMat);
  m.position.set(x, y, z);
  v.inner.add(m);
}

// ----------------------------------------------------------------------------- tier 1

export function buildMoped(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], color: number): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(11);
  b.box(0, -0.02, -0.05, 0.28, 0.24, 1.15, C.rust); // frame
  b.box(0, -0.12, -0.15, 0.34, 0.1, 0.7, C.darkMetal); // engine
  b.box(0, 0.22, 0.2, 0.34, 0.2, 0.52, color); // tank in player colour
  b.box(0, 0.2, -0.38, 0.32, 0.1, 0.6, C.seat); // seat
  b.box(0, 0.3, -0.8, 0.44, 0.06, 0.5, C.metal); // rack
  b.box(-0.1, 0.42, -0.82, 0.22, 0.2, 0.22, C.wood); // cargo crate
  b.box(0.12, 0.38, -0.82, 0.16, 0.14, 0.3, color); // jerrycan in player colour
  b.tube(0, 0.18, 0.62, 0, -0.18, 0.76, 0.08, C.steel); // fork
  b.box(0, 0.42, 0.62, 0.8, 0.05, 0.06, C.darkMetal); // handlebar
  b.box(0.36, 0.42, 0.62, 0.1, 0.05, 0.1, C.rubber);
  b.box(-0.36, 0.42, 0.62, 0.1, 0.05, 0.1, C.rubber);
  b.box(0, -0.12, 0.88, 0.22, 0.06, 0.5, color); // front fender
  b.box(0, 0.1, -0.88, 0.24, 0.06, 0.4, color); // rear fender
  b.cyl(0.2, -0.2, -0.55, 0.1, 0.55, 0.1, C.darkMetal, Math.PI / 2, 0, 0, 6); // exhaust
  b.box(0, 0.12, 0.74, 0.2, 0.16, 0.16, C.metal); // headlight housing
  const bodyGeo = b.build();
  addWheels(v, v.inner, def, wheelLocal, steered, 0.12, false);
  lamp(v, 0, 0.14, 0.84, 0.15);
  tail(v, 0, 0.12, -1.1);
  const rider = new Humanoid({ jacket: color, trim: 0x2d2d2d, helmet: color });
  rider.root.position.set(0, -0.28, -0.32);
  v.inner.add(rider.root);
  v.driver = rider;
  v.muzzle.position.set(0, 0.5, 0.9);
  v.inner.add(v.muzzle);
  v.smoke.position.set(0, 0.3, -0.5);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

// ----------------------------------------------------------------------------- tier 2

export function buildQuad(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], color: number): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(22);
  b.box(0, -0.12, 0, 0.95, 0.2, 1.75, C.darkMetal); // tray
  b.box(0, 0.08, 0.5, 0.76, 0.36, 0.75, C.rust); // engine cowl
  b.box(0, 0.1, 0.95, 1.15, 0.38, 0.12, C.steel); // armour plate (front)
  b.box(0, 0.4, 0.95, 1.1, 0.08, 0.12, color); // painted top edge
  b.box(0.42, 0.05, 0.4, 0.1, 0.28, 0.8, C.signYellow); // road-sign side plate
  b.box(-0.42, 0.05, 0.4, 0.1, 0.28, 0.8, C.signYellow);
  b.box(0, 0.26, -0.1, 0.5, 0.12, 0.5, C.seat); // seat
  b.tube(0.35, 0.15, -0.1, 0.32, 1.1, -0.4, 0.07, C.metal); // roll bar
  b.tube(-0.35, 0.15, -0.1, -0.32, 1.1, -0.4, 0.07, C.metal);
  b.tube(0.32, 1.1, -0.4, -0.32, 1.1, -0.4, 0.07, C.metal);
  b.box(0, 0.4, 0.2, 0.7, 0.05, 0.05, C.darkMetal); // handlebar
  // rear rack with cargo
  b.box(0, 0.12, -0.72, 1.0, 0.06, 0.9, C.metal);
  b.box(-0.25, 0.32, -0.8, 0.4, 0.34, 0.4, C.wood);
  b.box(0.25, 0.3, -0.7, 0.36, 0.3, 0.4, C.woodDark);
  b.box(0.1, 0.55, -0.85, 0.3, 0.22, 0.3, color); // player colour cargo
  b.cyl(0, 0.35, -1.08, 0.5, 0.18, 0.5, C.tire, Math.PI / 2, 0, 0, 14); // spare tyre
  // fixed LMG
  b.box(0, 0.5, 0.78, 0.2, 0.2, 0.5, C.darkMetal);
  b.tube(0, 0.5, 1.0, 0, 0.5, 1.5, 0.06, C.steel);
  b.box(0, 0.62, 0.78, 0.1, 0.1, 0.3, 0x3a3a3a); // ammo box
  const bodyGeo = b.build();
  addWheels(v, v.inner, def, wheelLocal, steered, 0.28, true);
  lamp(v, 0.3, 0.2, 0.99, 0.2);
  lamp(v, -0.3, 0.2, 0.99, 0.2);
  tail(v, 0.3, 0.1, -1.2);
  tail(v, -0.3, 0.1, -1.2);
  const rider = new Humanoid({ jacket: color, trim: 0x2d2d2d, helmet: color });
  rider.root.position.set(0, -0.15, -0.12);
  v.inner.add(rider.root);
  v.driver = rider;
  v.muzzle.position.set(0, 0.5, 1.6);
  v.inner.add(v.muzzle);
  v.smoke.position.set(0, 0.5, 0.4);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

// ----------------------------------------------------------------------------- tier 3

export function buildBuggy(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], color: number): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.05;
  b.seed(33);
  b.box(0, -0.22, 0, 1.55, 0.22, 3.3, C.darkMetal); // chassis
  b.box(0, 0.05, 1.2, 1.5, 0.45, 1.2, C.rust); // hood
  b.box(0, 0.3, 1.2, 1.46, 0.06, 1.0, color); // hood stripe in player colour
  b.box(0.76, 0.1, 0.9, 0.08, 0.5, 1.2, C.signYellow, 0, 0, 0); // road-sign door plates
  b.box(-0.76, 0.1, 0.9, 0.08, 0.5, 1.2, C.signYellow);
  b.box(0.77, 0.1, 0.9, 0.04, 0.3, 0.7, 0xc2402e);
  b.box(-0.77, 0.1, 0.9, 0.04, 0.3, 0.7, 0xc2402e);
  // roll cage
  for (const sx of [1, -1]) {
    b.tube(0.72 * sx, 0.1, 0.55, 0.72 * sx, 1.35, 0.4, 0.08, C.metal);
    b.tube(0.72 * sx, 0.1, -0.5, 0.72 * sx, 1.35, -0.4, 0.08, C.metal);
    b.tube(0.72 * sx, 1.35, 0.4, 0.72 * sx, 1.35, -0.4, 0.08, C.metal);
    b.tube(0.72 * sx, 0.7, 0.5, 0.72 * sx, 0.7, -0.45, 0.06, C.metal);
  }
  b.tube(0.72, 1.35, 0.4, -0.72, 1.35, 0.4, 0.08, C.metal);
  b.tube(0.72, 1.35, -0.4, -0.72, 1.35, -0.4, 0.08, C.metal);
  b.box(0, 1.38, 0, 1.5, 0.05, 0.95, C.rust2); // roof plate
  // seats
  b.box(0.38, 0.22, 0.2, 0.5, 0.12, 0.5, C.seat);
  b.box(0.38, 0.5, -0.05, 0.5, 0.5, 0.1, C.seat);
  b.box(-0.38, 0.22, 0.2, 0.5, 0.12, 0.5, C.seat);
  b.box(-0.38, 0.5, -0.05, 0.5, 0.5, 0.1, C.seat);
  b.box(0.38, 0.62, 0.62, 0.4, 0.04, 0.04, C.darkMetal); // steering wheel
  // bed
  b.box(0, -0.05, -1.25, 1.5, 0.1, 1.45, C.metal);
  b.box(0.76, 0.2, -1.25, 0.08, 0.5, 1.45, C.rust);
  b.box(-0.76, 0.2, -1.25, 0.08, 0.5, 1.45, C.rust);
  b.box(0, 0.2, -2.0, 1.5, 0.5, 0.08, C.rust);
  b.cyl(0.4, 0.3, -1.7, 0.9, 0.2, 0.9, C.tire, Math.PI / 2, 0, 0, 14); // spare tyre
  b.box(-0.42, 0.18, -1.55, 0.3, 0.32, 0.2, color); // jerrycans in player colour
  b.box(-0.42, 0.18, -1.2, 0.3, 0.32, 0.2, color);
  b.box(0.1, 0.12, -1.5, 0.5, 0.3, 0.5, C.wood);
  // bull bar / ram bumper (plow variant)
  b.box(0, -0.12, 1.95, 1.8, 0.34, 0.2, C.steel);
  b.box(0, 0.12, 1.95, 1.7, 0.1, 0.12, color);
  b.tube(0.7, -0.12, 1.95, 0.7, 0.5, 1.7, 0.08, C.steel);
  b.tube(-0.7, -0.12, 1.95, -0.7, 0.5, 1.7, 0.08, C.steel);
  // gun post
  b.box(0, 0.4, -0.95, 0.12, 0.8, 0.12, C.darkMetal);
  const bodyGeo = b.build();
  addWheels(v, v.inner, def, wheelLocal, steered, 0.36, true);
  lamp(v, 0.55, 0.25, 1.82, 0.22);
  lamp(v, -0.55, 0.25, 1.82, 0.22);
  tail(v, 0.55, 0.1, -2.04);
  tail(v, -0.55, 0.1, -2.04);
  const driver = new Humanoid({ jacket: color, trim: 0x2d2d2d, helmet: color });
  driver.root.position.set(0.38, -0.12, 0.05);
  v.inner.add(driver.root);
  v.driver = driver;
  // The partner rides in the bed behind the gun.
  const pass = new Humanoid({ jacket: color, trim: 0x2d2d2d, helmet: color });
  pass.root.position.set(0, 0.05, -1.0);
  v.passenger = pass;
  // Rotating gun pivot
  const gun = new THREE.Group();
  gun.position.set(0, 0.85, -0.95);
  const gb = new MeshBuilder();
  gb.box(0, 0, 0, 0.22, 0.22, 0.6, C.darkMetal);
  gb.tube(0, 0, 0.3, 0, 0, 1.1, 0.07, C.steel);
  gb.box(0, 0.12, -0.05, 0.16, 0.12, 0.3, 0x3a3a3a);
  gb.box(0, 0.0, -0.45, 0.3, 0.3, 0.04, C.steel); // shield
  const gm = new THREE.Mesh(gb.build(), bodyMat);
  gm.castShadow = true;
  gun.add(gm);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 1.15);
  gun.add(muzzle);
  v.inner.add(gun);
  v.gun = gun;
  v.muzzle = muzzle;
  v.smoke.position.set(0, 0.6, 1.2);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

// ----------------------------------------------------------------------------- raiders

export function buildRaiderBuggy(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[]): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.06;
  b.seed(44);
  b.box(0, -0.2, 0, 1.3, 0.2, 2.8, C.darkMetal);
  b.box(0, 0.05, 1.0, 1.2, 0.4, 1.0, C.raiderRed);
  b.box(0, 0.3, 1.0, 1.0, 0.05, 0.8, 0x1a1a1a);
  for (const sx of [1, -1]) {
    b.tube(0.6 * sx, 0.1, 0.4, 0.6 * sx, 1.2, 0.2, 0.07, C.rust2);
    b.tube(0.6 * sx, 0.1, -0.7, 0.6 * sx, 1.2, -0.5, 0.07, C.rust2);
    b.tube(0.6 * sx, 1.2, 0.2, 0.6 * sx, 1.2, -0.5, 0.07, C.rust2);
  }
  b.tube(0.6, 1.2, 0.2, -0.6, 1.2, 0.2, 0.07, C.rust2);
  b.box(0, 0.2, 0.0, 0.5, 0.12, 0.5, C.seat);
  b.box(0, 0.22, -0.9, 1.2, 0.1, 1.0, C.metal);
  b.box(0, 0.6, -1.1, 0.12, 0.7, 0.12, C.darkMetal);
  b.box(0, 1.6, -1.1, 0.04, 1.8, 0.04, C.darkMetal);
  b.box(0.35, 2.2, -1.1, 0.7, 0.5, 0.03, C.raiderFlag); // red-orange flag: raiders read at a glance
  b.box(0, -0.1, 1.55, 1.5, 0.3, 0.14, C.rust);
  const bodyGeo = b.build();
  addWheels(v, v.inner, def, wheelLocal, steered, 0.3, true);
  lamp(v, 0.4, 0.22, 1.5, 0.18);
  lamp(v, -0.4, 0.22, 1.5, 0.18);
  const driver = new Humanoid({ jacket: C.raiderRed, trim: 0x1a1a1a, helmet: 0x111111 });
  driver.root.position.set(0, -0.15, 0.05);
  v.inner.add(driver.root);
  v.driver = driver;
  v.muzzle.position.set(0, 0.7, 1.4);
  v.inner.add(v.muzzle);
  v.smoke.position.set(0, 0.5, 1.0);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

export function buildWagon(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[]): VehicleVisual {
  const v = blank(def);
  const b = new MeshBuilder();
  b.jitter = 0.06;
  b.seed(55);
  b.box(0, -0.2, 0, 2.3, 0.4, 4.6, C.darkMetal);
  b.box(0, 0.4, 0.2, 2.2, 0.9, 3.2, C.rust);
  b.box(0, 1.05, -0.2, 2.0, 0.5, 2.2, C.rust2);
  b.box(0, 0.8, 1.9, 2.1, 0.8, 0.3, C.steel);
  // Spiked side armour and ram: the Battle-wagon rams from the side with spikes.
  for (let i = 0; i < 6; i++) {
    for (const sx of [1, -1]) b.add('cone6', 1.35 * sx, 0.5, -1.6 + i * 0.7, 0.3, 0.7, 0.3, C.steel, 0, 0, -Math.PI / 2 * sx);
  }
  for (let i = 0; i < 5; i++) b.add('cone6', -1.0 + i * 0.5, 0.35, 2.3, 0.28, 0.8, 0.28, C.steel, Math.PI / 2, 0, 0);
  b.box(0, 1.5, -0.4, 0.04, 2.2, 0.04, C.darkMetal);
  b.box(0.45, 2.6, -0.4, 0.9, 0.6, 0.03, C.raiderFlag);
  b.box(0, 1.55, 1.0, 1.4, 0.3, 0.9, 0x1a1a1a);
  const bodyGeo = b.build();
  addWheels(v, v.inner, def, wheelLocal, steered, 0.5, true);
  lamp(v, 0.8, 0.8, 2.08, 0.28);
  lamp(v, -0.8, 0.8, 2.08, 0.28);
  v.muzzle.position.set(0, 1.5, 1.6);
  v.inner.add(v.muzzle);
  v.smoke.position.set(0, 1.0, 1.4);
  v.inner.add(v.smoke);
  return finish(v, bodyGeo);
}

export function buildVehicleVisual(def: VehicleDef, wheelLocal: [number, number, number][], steered: boolean[], color: number): VehicleVisual {
  switch (def.tier) {
    case 1:
      return buildMoped(def, wheelLocal, steered, color);
    case 2:
      return buildQuad(def, wheelLocal, steered, color);
    default:
      return buildBuggy(def, wheelLocal, steered, color);
  }
}
