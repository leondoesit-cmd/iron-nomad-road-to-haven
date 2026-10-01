import { vehicleDef, type VehicleDef } from './index';

/** Raider vehicles reuse the data-driven raycast controller with their own parameters. */
export function raiderBuggyDef(): VehicleDef {
  const base = structuredClone(vehicleDef(3));
  return {
    ...base,
    tier: 2,
    id: 'raider_buggy',
    name: 'Dune buggy',
    width: 1.7,
    length: 3.0,
    topSpeedKmh: 98,
    hp: 160,
    armor: 0.15,
    seats: 2,
    weapon: 'mg',
    signature: { idle: 40, moving: 60 },
    tank: 99,
    burn: 0,
    camera: { dist: 7, height: 3 },
    physics: {
      ...base.physics,
      mass: 520,
      wheelCount: 4,
      maxSteerDeg: 30,
      suspension: { stiffness: 26, travel: 0.28, rest: 0.32 },
      frictionSlip: 3.1,
      engineForce: 5400,
      brake: 9,
      wheelRadius: 0.38,
      halfExtents: [0.85, 0.35, 1.5],
      hardY: -0.08,
      wheelsZ: [1.1, -1.0],
      wheelsX: [0.8, -0.8],
      uprightGain: 0,
      lean: false,
    },
  };
}

export function wagonDef(): VehicleDef {
  const base = structuredClone(vehicleDef(3));
  return {
    ...base,
    tier: 3,
    id: 'battle_wagon',
    name: 'Spiked battle-wagon',
    width: 2.6,
    length: 5.0,
    topSpeedKmh: 62,
    hp: 650,
    armor: 0.45,
    seats: 2,
    weapon: 'mg',
    signature: { idle: 70, moving: 85 },
    tank: 99,
    burn: 0,
    camera: { dist: 9, height: 4 },
    physics: {
      ...base.physics,
      mass: 2600,
      wheelCount: 4,
      maxSteerDeg: 24,
      suspension: { stiffness: 34, travel: 0.32, rest: 0.4 },
      frictionSlip: 3.4,
      engineForce: 15500,
      brake: 8,
      wheelRadius: 0.5,
      halfExtents: [1.25, 0.6, 2.4],
      hardY: -0.1,
      wheelsZ: [1.6, -1.5],
      wheelsX: [1.2, -1.2],
      uprightGain: 0,
      lean: false,
    },
  };
}
