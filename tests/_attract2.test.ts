import { beforeAll, it } from 'vitest';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { fakeServices } from './helpers/sim';
beforeAll(async () => { await initPhysics(); });
it('attract demo runs a long time without hanging', () => {
  for (let round = 0; round < 3; round++) {
    const h = fakeServices();
    const sc = new LegScene(h.svc, legById('L1'));
    sc.pendingResult = true;
    sc.players[0].autopilot = { speed: 17 };
    sc.players[1].autopilot = { speed: 15 };
    const t0 = Date.now();
    for (let i = 0; i < 80 * 60; i++) {
      sc.tick(1 / 60);
      if (i % 1200 === 0) console.log('ROUND', round, 't', (i / 60).toFixed(0), 'wall', Date.now() - t0);
    }
    sc.dispose();
  }
}, 600000);
