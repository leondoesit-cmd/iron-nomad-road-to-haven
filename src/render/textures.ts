import * as THREE from 'three';

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export interface FacadeTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

/** One 4x4-window tile of a ruined facade: shared "trim sheet" for every city module. */
export function makeFacade(): FacadeTextures {
  const S = 256;
  const c = canvas(S, S);
  const e = canvas(S, S);
  const g = c.getContext('2d')!;
  const ge = e.getContext('2d')!;
  const rnd = seeded(77);
  g.fillStyle = '#b5b7b2';
  g.fillRect(0, 0, S, S);
  // grime and panel seams
  for (let i = 0; i < 380; i++) {
    g.fillStyle = `rgba(${40 + rnd() * 40},${40 + rnd() * 40},${40 + rnd() * 40},${0.04 + rnd() * 0.08})`;
    g.fillRect(rnd() * S, rnd() * S, 4 + rnd() * 24, 2 + rnd() * 40);
  }
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  const cell = S / 4;
  for (let r = 0; r < 4; r++) {
    for (let k = 0; k < 4; k++) {
      const x = k * cell + cell * 0.16;
      const y = r * cell + cell * 0.2;
      const w = cell * 0.68;
      const h = cell * 0.56;
      g.fillStyle = '#2a2d2f';
      g.fillRect(x - 3, y - 3, w + 6, h + 6);
      const broken = rnd() < 0.3;
      g.fillStyle = broken ? '#0c0e10' : '#273745';
      g.fillRect(x, y, w, h);
      if (!broken) {
        g.fillStyle = 'rgba(200,220,235,0.18)';
        g.fillRect(x, y, w * 0.45, h);
      }
      if (rnd() < 0.2) {
        g.fillStyle = '#5a5248';
        g.fillRect(x, y, w, h * (0.3 + rnd() * 0.4));
      }
      // lit windows glow sodium orange at night
      if (!broken && rnd() < 0.1) {
        ge.fillStyle = rnd() < 0.7 ? '#ffb45a' : '#bde8ff';
        ge.fillRect(x, y, w, h);
      }
      g.fillStyle = '#7d8080';
      g.fillRect(x - 4, y + h + 3, w + 8, 3);
    }
  }
  const map = new THREE.CanvasTexture(c);
  const emissive = new THREE.CanvasTexture(e);
  for (const t of [map, emissive]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
  }
  return { map, emissive };
}

/** Road strip: asphalt with edge lines and a dashed centre line. U runs across, V along (one repeat per 16 m). */
export function makeRoad(kind: 'wasteland' | 'city'): THREE.CanvasTexture {
  const W = 128;
  const H = 128;
  const c = canvas(W, H);
  const g = c.getContext('2d')!;
  const rnd = seeded(kind === 'city' ? 5 : 9);
  g.fillStyle = kind === 'city' ? '#2c2e30' : '#303133';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 500; i++) {
    const v = 30 + rnd() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 2},${0.15 + rnd() * 0.25})`;
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 3, 1 + rnd() * 5);
  }
  // cracks and patches
  g.strokeStyle = 'rgba(10,10,10,0.5)';
  g.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    let x = rnd() * W;
    let y = rnd() * H;
    g.moveTo(x, y);
    for (let k = 0; k < 5; k++) {
      x += (rnd() - 0.5) * 24;
      y += rnd() * 14;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const line = (u0: number, u1: number, color: string, dash?: [number, number]) => {
    g.fillStyle = color;
    if (!dash) g.fillRect(W * u0, 0, W * (u1 - u0), H);
    else for (let y = 0; y < H; y += dash[0] + dash[1]) g.fillRect(W * u0, y, W * (u1 - u0), dash[0]);
  };
  if (kind === 'wasteland') {
    line(0.045, 0.06, 'rgba(210,205,190,0.8)');
    line(0.94, 0.955, 'rgba(210,205,190,0.8)');
    line(0.488, 0.512, 'rgba(235,200,70,0.85)', [34, 30]);
  } else {
    line(0.02, 0.032, 'rgba(210,205,190,0.8)');
    line(0.968, 0.98, 'rgba(210,205,190,0.8)');
    line(0.488, 0.497, 'rgba(235,200,70,0.9)');
    line(0.503, 0.512, 'rgba(235,200,70,0.9)');
    line(0.245, 0.255, 'rgba(210,205,190,0.7)', [30, 34]);
    line(0.745, 0.755, 'rgba(210,205,190,0.7)', [30, 34]);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
