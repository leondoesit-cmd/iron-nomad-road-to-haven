import * as THREE from 'three';

type ColorIn = number | THREE.Color;
const _c = new THREE.Color();
const toLinear = (c: ColorIn) => (typeof c === 'number' ? _c.set(c) : _c.copy(c));

/** Shared primitive templates. Everything the builder emits is a transformed copy of one of these. */
const tpl = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl6: new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1),
  cyl10: new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1),
  cyl14: new THREE.CylinderGeometry(0.5, 0.5, 1, 14, 1),
  cone6: new THREE.ConeGeometry(0.5, 1, 6, 1),
  ico: new THREE.IcosahedronGeometry(0.5, 0),
  sphere: new THREE.SphereGeometry(0.5, 8, 6),
};
export type Prim = keyof typeof tpl;

/**
 * Accumulates transformed primitives into one BufferGeometry with per-vertex colour.
 * Used for chunk props, buildings and vehicle bodies so each becomes a single draw call.
 */
export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  private m = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  /** Per-vertex colour jitter, makes flat shaded boxes look weathered. */
  jitter = 0.04;
  private rnd = 1;

  seed(n: number) {
    this.rnd = (n | 0) || 1;
  }
  private rand() {
    this.rnd = (Math.imul(this.rnd, 1664525) + 1013904223) | 0;
    return ((this.rnd >>> 0) / 4294967296) * 2 - 1;
  }

  /** Adds a primitive with position, size, euler rotation (radians) and colour. */
  add(prim: Prim, px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: ColorIn, rx = 0, ry = 0, rz = 0, uvOverride?: (u: number, v: number, nx: number, ny: number, nz: number, vx: number, vy: number, vz: number) => [number, number]) {
    const g = tpl[prim];
    this.p.set(px, py, pz);
    this.s.set(sx, sy, sz);
    this.e.set(rx, ry, rz, 'YXZ');
    this.q.setFromEuler(this.e);
    this.m.compose(this.p, this.q, this.s);
    this.nm.getNormalMatrix(this.m);
    const base = this.pos.length / 3;
    const pa = g.attributes.position;
    const na = g.attributes.normal;
    const ua = g.attributes.uv;
    const c = toLinear(color);
    const cr = c.r;
    const cg = c.g;
    const cb = c.b;
    for (let i = 0; i < pa.count; i++) {
      this.v.fromBufferAttribute(pa, i).applyMatrix4(this.m);
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.v.fromBufferAttribute(na, i).applyMatrix3(this.nm).normalize();
      this.nor.push(this.v.x, this.v.y, this.v.z);
      const j = 1 + this.rand() * this.jitter;
      this.col.push(cr * j, cg * j, cb * j);
      if (uvOverride) {
        const r = uvOverride(ua.getX(i), ua.getY(i), this.v.x, this.v.y, this.v.z, this.pos[this.pos.length - 3], this.pos[this.pos.length - 2], this.pos[this.pos.length - 1]);
        this.uv.push(r[0], r[1]);
      } else this.uv.push(ua.getX(i), ua.getY(i));
    }
    const ia = g.index;
    if (ia) for (let i = 0; i < ia.count; i++) this.idx.push(base + ia.getX(i));
    else for (let i = 0; i < pa.count; i++) this.idx.push(base + i); // Icosahedron is non-indexed
    return this;
  }

  box(px: number, py: number, pz: number, sx: number, sy: number, sz: number, color: ColorIn, rx = 0, ry = 0, rz = 0) {
    return this.add('box', px, py, pz, sx, sy, sz, color, rx, ry, rz);
  }

  /** Cylinder along Y by default; pass rotations to lay it down. Diameter is sx/sz. */
  cyl(px: number, py: number, pz: number, dx: number, h: number, dz: number, color: ColorIn, rx = 0, ry = 0, rz = 0, seg: 6 | 10 | 14 = 10) {
    return this.add(seg === 6 ? 'cyl6' : seg === 10 ? 'cyl10' : 'cyl14', px, py, pz, dx, h, dz, color, rx, ry, rz);
  }

  /** A tube between two points. */
  tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number, color: ColorIn) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    const mz = (az + bz) / 2;
    // Orient +Y of the template along the segment.
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const eu = new THREE.Euler().setFromQuaternion(qq, 'YXZ');
    return this.add('cyl6', mx, my, mz, thick, len, thick, color, eu.x, eu.y, eu.z);
  }

  /** Append another builder, applying an extra yaw and offset. */
  append(other: MeshBuilder, ox = 0, oy = 0, oz = 0, yaw = 0, scale = 1) {
    const base = this.pos.length / 3;
    const cs = Math.cos(yaw);
    const sn = Math.sin(yaw);
    for (let i = 0; i < other.pos.length; i += 3) {
      const x = other.pos[i] * scale;
      const y = other.pos[i + 1] * scale;
      const z = other.pos[i + 2] * scale;
      this.pos.push(x * cs + z * sn + ox, y + oy, -x * sn + z * cs + oz);
      const nx = other.nor[i];
      const nz = other.nor[i + 2];
      this.nor.push(nx * cs + nz * sn, other.nor[i + 1], -nx * sn + nz * cs);
      this.col.push(other.col[i], other.col[i + 1], other.col[i + 2]);
    }
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.idx.length; i++) this.idx.push(base + other.idx[i]);
    return this;
  }

  /** Raw quad (counter-clockwise seen from the normal side) with a flat normal. */
  quad(a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number], color: ColorIn, uv: [number, number, number, number] = [0, 0, 1, 1]) {
    const base = this.pos.length / 3;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const m = Math.hypot(nx, ny, nz) || 1;
    nx /= m;
    ny /= m;
    nz /= m;
    const cc = toLinear(color);
    for (const p of [a, b, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(cc.r, cc.g, cc.b);
    }
    this.uv.push(uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[3]);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return this;
  }

  get empty() {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

export const lin = (hex: number) => new THREE.Color(hex);
