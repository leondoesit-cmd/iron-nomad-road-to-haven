import * as THREE from 'three';

const vert = `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
uniform float uScale;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uScale / max(0.1, -mv.z);
}`;
const frag = `
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.25, d) * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/** One pool of CPU-simulated sprites. Two instances exist: alpha for smoke and dust, additive for fire and flashes. */
export class ParticleLayer {
  points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private next = 0;
  private uniforms = { uScale: { value: 800 } };
  private geo: THREE.BufferGeometry;
  budget = 1;

  constructor(n: number, additive: boolean) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.s0 = new Float32Array(n);
    this.s1 = new Float32Array(n);
    this.a0 = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vert,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewScale(viewHeightPx: number, fovDeg: number) {
    // Size in world metres projected: pixels = size * scale / depth, scale = H / (2 tan(fov/2)).
    this.uniforms.uScale.value = viewHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, s1: number, r: number, g: number, b: number, a: number, gravity = 0, drag = 0.5) {
    if (this.budget < 1 && Math.random() > this.budget) return;
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = a;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.grav[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.col[i * 4 + 3] = this.a0[i] * (1 - t) * (t < 0.08 ? t / 0.08 : 1);
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class Particles {
  smoke = new ParticleLayer(3000, false);
  glow = new ParticleLayer(1500, true);

  setBudget(b: number) {
    this.smoke.budget = b;
    this.glow.budget = b;
  }

  update(dt: number) {
    this.smoke.update(dt);
    this.glow.update(dt);
  }

  setViewScale(h: number, fov: number) {
    this.smoke.setViewScale(h, fov);
    this.glow.setViewScale(h, fov);
  }

  // ---- ready-made effects ------------------------------------------------

  dust(x: number, y: number, z: number, vx: number, vz: number, strength = 1, tint: [number, number, number] = [0.72, 0.6, 0.42]) {
    this.smoke.emit(x + (Math.random() - 0.5) * 0.4, y + 0.1, z + (Math.random() - 0.5) * 0.4, vx * 0.15 + (Math.random() - 0.5) * 0.8, 0.8 + Math.random() * 0.8, vz * 0.15 + (Math.random() - 0.5) * 0.8, 1.2 + Math.random() * 1.2, 0.9 * strength, 3.4 * strength, tint[0], tint[1], tint[2], 0.42, -0.2, 1.4);
  }

  puff(x: number, y: number, z: number, r = 0.7, g = 0.7, b = 0.7, size = 1.5, life = 0.9) {
    this.smoke.emit(x, y, z, (Math.random() - 0.5) * 1.5, 0.8 + Math.random(), (Math.random() - 0.5) * 1.5, life, size * 0.5, size * 2, r, g, b, 0.5, -0.4, 1.2);
  }

  blackSmoke(x: number, y: number, z: number) {
    this.smoke.emit(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.6, 1.8 + Math.random(), (Math.random() - 0.5) * 0.6, 1.8, 0.4, 2.2, 0.08, 0.08, 0.08, 0.6, -0.5, 0.6);
  }

  fire(x: number, y: number, z: number, scale = 1) {
    this.glow.emit(x + (Math.random() - 0.5) * 0.4 * scale, y, z + (Math.random() - 0.5) * 0.4 * scale, (Math.random() - 0.5) * 0.8, 1.6 + Math.random() * 1.4, (Math.random() - 0.5) * 0.8, 0.55 + Math.random() * 0.3, 0.8 * scale, 0.1, 1.0, 0.55, 0.15, 0.9, -1, 1.0);
  }

  spark(x: number, y: number, z: number, n = 6, speed = 6) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const e = Math.random() * 1.2;
      this.glow.emit(x, y, z, Math.cos(a) * speed * Math.random(), Math.random() * speed * e, Math.sin(a) * speed * Math.random(), 0.35 + Math.random() * 0.3, 0.18, 0.03, 1, 0.8, 0.35, 1, 14, 0.8);
    }
  }

  blood(x: number, y: number, z: number, n = 6, color: [number, number, number] = [0.55, 0.06, 0.06]) {
    for (let i = 0; i < n; i++) {
      this.smoke.emit(x, y, z, (Math.random() - 0.5) * 4, Math.random() * 3.5, (Math.random() - 0.5) * 4, 0.5 + Math.random() * 0.4, 0.2, 0.1, color[0], color[1], color[2], 0.9, 16, 0.6);
    }
  }

  flash(x: number, y: number, z: number, size = 1.6) {
    this.glow.emit(x, y, z, 0, 0, 0, 0.07, size, size * 0.4, 1, 0.85, 0.4, 1, 0, 0);
  }

  explosion(x: number, y: number, z: number, size = 1) {
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (2 + Math.random() * 7) * size;
      this.glow.emit(x, y + 0.4, z, Math.cos(a) * s, 2 + Math.random() * 6 * size, Math.sin(a) * s, 0.5 + Math.random() * 0.5, 2.2 * size, 0.2, 1, 0.5 + Math.random() * 0.3, 0.1, 1, 6, 1.2);
    }
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (1 + Math.random() * 4) * size;
      this.smoke.emit(x, y + 0.5, z, Math.cos(a) * s, 1.5 + Math.random() * 4, Math.sin(a) * s, 1.4 + Math.random(), 1.2 * size, 5 * size, 0.18, 0.16, 0.15, 0.7, -0.5, 1.0);
    }
    this.flash(x, y + 0.6, z, 6 * size);
  }
}

/** Short-lived bullet tracers. */
export class Tracers {
  mesh: THREE.LineSegments;
  private pos: Float32Array;
  private col: Float32Array;
  private life: Float32Array;
  private n: number;
  private next = 0;
  private geo: THREE.BufferGeometry;

  constructor(n = 160) {
    this.n = n;
    this.pos = new Float32Array(n * 6);
    this.col = new Float32Array(n * 6);
    this.life = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.LineSegments(this.geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r = 1, g = 0.85, b = 0.45) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([ax, ay, az, bx, by, bz], i * 6);
    this.col.set([r, g, b, r * 0.3, g * 0.3, b * 0.3], i * 6);
    this.life[i] = 0.09;
  }

  update(dt: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] > 0) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) this.pos.fill(0, i * 6, i * 6 + 6);
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}
