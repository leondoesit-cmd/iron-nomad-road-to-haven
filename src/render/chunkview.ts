import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { appendProp } from './props';
import { BIOME_GROUND, C } from './palette';
import { makeFacade, makeRoad } from './textures';
import { CELL, CELLS, CHUNK, heightAt, normalAt, roadX, surfaceAt, type TerrainDef } from '../world/terrain';
import type { ChunkData } from '../world/chunkgen';
import type { Aabb } from '../world/layout';
import { BOULEVARD_HALF } from '../world/layout';
import { GROUPS, type Collider, type PhysicsWorld } from '../physics/physics';
import { hash2 } from '../core/rng';

const GROUND_BASE = BIOME_GROUND;

export interface ChunkMaterials {
  terrain: THREE.MeshLambertMaterial;
  props: THREE.MeshLambertMaterial;
  walls: THREE.MeshLambertMaterial;
  roofs: THREE.MeshLambertMaterial;
  road: THREE.MeshLambertMaterial;
  facade: ReturnType<typeof makeFacade>;
}

export function makeChunkMaterials(biome: 'wasteland' | 'city'): ChunkMaterials {
  const facade = makeFacade();
  const road = makeRoad(biome);
  return {
    terrain: new THREE.MeshLambertMaterial({ vertexColors: true }),
    props: new THREE.MeshLambertMaterial({ vertexColors: true }),
    walls: new THREE.MeshLambertMaterial({ vertexColors: true, map: facade.map, emissiveMap: facade.emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0 }),
    roofs: new THREE.MeshLambertMaterial({ vertexColors: true }),
    road: (() => {
      const m = new THREE.MeshLambertMaterial({ map: road, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      return m;
    })(),
    facade,
  };
}

/** Meshes plus colliders for one 128 m chunk. Created and disposed by the streaming system. */
export class ChunkView {
  group = new THREE.Group();
  colliders: Collider[] = [];
  aabbColliders = new Map<number, Collider>();
  barricadeMeshes = new Map<number, THREE.Mesh>();
  private geos: THREE.BufferGeometry[] = [];

  constructor(
    public data: ChunkData,
    def: TerrainDef,
    mats: ChunkMaterials,
    private phys: PhysicsWorld,
  ) {
    const x0 = data.cx * CHUNK;
    const z0 = data.cz * CHUNK;
    this.buildTerrain(def, mats, x0, z0);
    this.buildRoad(def, mats, z0);
    this.buildBuildings(data, mats);
    this.buildProps(data, mats);
    this.buildColliders(def, x0, z0);
  }

  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material, cast: boolean, receive: boolean) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = receive;
    this.group.add(m);
    this.geos.push(geo);
    return m;
  }

  private buildTerrain(def: TerrainDef, mats: ChunkMaterials, x0: number, z0: number) {
    const n = CELLS;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const nor = new Float32Array((n + 1) * (n + 1) * 3);
    const col = new Float32Array((n + 1) * (n + 1) * 3);
    const palette = GROUND_BASE[def.biome];
    const tmp: [number, number, number] = [0, 1, 0];
    for (let r = 0; r <= n; r++) {
      for (let c = 0; c <= n; c++) {
        const i = r * (n + 1) + c;
        const x = x0 + c * CELL;
        const z = z0 + r * CELL;
        const h = this.data.heights[c * (n + 1) + r];
        pos[i * 3] = x - x0;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z - z0;
        normalAt(def, x, z, tmp);
        nor[i * 3] = tmp[0];
        nor[i * 3 + 1] = tmp[1];
        nor[i * 3 + 2] = tmp[2];
        const surf = surfaceAt(def, x, z);
        let base: readonly number[] = palette[surf];
        const steep = 1 - tmp[1];
        let k = 1 + (hash2(Math.round(x / CELL), Math.round(z / CELL), 5) - 0.5) * 0.14;
        if (steep > 0.35 || h > roadHeightGuess(def, z) + 14) {
          const t = Math.min(1, Math.max(0, (steep - 0.3) * 3));
          const band = Math.sin(h * 0.9 + x * 0.02) * 0.5 + 0.5;
          base = mixCol(palette.cliff, palette.cliff2, band);
          base = mixCol(palette[surf], base, Math.max(t, h > 14 ? 1 : 0));
          k *= 0.92 + band * 0.18;
        }
        col[i * 3] = srgb(base[0] * k);
        col[i * 3 + 1] = srgb(base[1] * k);
        col[i * 3 + 2] = srgb(base[2] * k);
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const a = r * (n + 1) + c;
        const b = a + 1;
        const d = a + (n + 1);
        const e = d + 1;
        // Winding so the front face looks up (+Y).
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const m = this.addMesh(g, mats.terrain, false, true);
    m.position.set(x0, 0, z0);
  }

  private buildRoad(def: TerrainDef, mats: ChunkMaterials, z0: number) {
    const half = def.biome === 'city' ? BOULEVARD_HALF : def.roadHalf;
    const step = 4;
    const verts: number[] = [];
    const nors: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    const nSeg = CHUNK / step;
    let any = false;
    const tmp: [number, number, number] = [0, 1, 0];
    for (let i = 0; i <= nSeg; i++) {
      const z = z0 + i * step;
      const cx = roadX(def, z);
      const ahead = roadX(def, z + 1) - roadX(def, z - 1);
      const len = Math.hypot(ahead / 2, 1);
      // Perpendicular to the road tangent in the XZ plane.
      const px = 1 / len;
      const pz = -(ahead / 2) / len;
      for (const side of [-1, 1]) {
        const x = cx + side * half * px;
        const z2 = z + side * half * pz;
        verts.push(x, heightAt(def, x, z2) + 0.04, z2);
        normalAt(def, x, z2, tmp);
        nors.push(tmp[0], tmp[1], tmp[2]);
        uvs.push(side < 0 ? 0 : 1, z / 16);
      }
      if (i < nSeg) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      if (Math.abs(cx) < 400 || true) any = true;
    }
    if (!any) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nors, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    this.addMesh(g, mats.road, false, true);
  }

  private buildBuildings(data: ChunkData, mats: ChunkMaterials) {
    if (!data.buildings.length) return;
    const walls = new MeshBuilder();
    const roofs = new MeshBuilder();
    walls.jitter = 0;
    for (const b of data.buildings) {
      const a = b.aabb;
      const tint = TINTS[(a.tint ?? 0) % TINTS.length];
      this.addBuildingBox(walls, roofs, a.minX, a.maxX, a.minZ, a.maxZ, 0, a.y1, tint, a.id);
      if (b.stepped) {
        const inset = 3;
        if (a.maxX - a.minX > inset * 3 && a.maxZ - a.minZ > inset * 3) {
          this.addBuildingBox(walls, roofs, a.minX + inset, a.maxX - inset, a.minZ + inset, a.maxZ - inset, a.y1, a.y1 + 6.6, tint, a.id + 5);
        }
      }
      // Rooftop clutter.
      const r = hash2(a.id, 3, 1);
      if (r > 0.6) {
        const cx = (a.minX + a.maxX) / 2 + (hash2(a.id, 7, 1) - 0.5) * 6;
        const cz = (a.minZ + a.maxZ) / 2 + (hash2(a.id, 8, 1) - 0.5) * 6;
        roofs.cyl(cx, a.y1 + 1.4, cz, 2.2, 2.8, 2.2, C.rust2, 0, 0, 0, 10);
        roofs.box(cx, a.y1 + 0.5, cz, 0.2, 1.0, 0.2, C.darkMetal);
      }
    }
    if (!walls.empty) this.addMesh(walls.build(), mats.walls, true, true);
    if (!roofs.empty) this.addMesh(roofs.build(), mats.roofs, true, true);
  }

  private addBuildingBox(walls: MeshBuilder, roofs: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, tint: number, id: number) {
    const col = new THREE.Color(tint);
    const w = x1 - x0;
    const d = z1 - z0;
    const h = y1 - y0;
    const u = (len: number, off: number): [number, number] => [off, off + len / 12];
    const vv: [number, number] = [0, h / 13.2];
    const ou = hash2(id, 1, 9);
    // +Z face
    walls.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, [u(w, ou)[0], vv[0], u(w, ou)[1], vv[1]]);
    // -Z face
    walls.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], col, [u(w, ou)[0], vv[0], u(w, ou)[1], vv[1]]);
    // +X face
    walls.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], col, [u(d, ou)[0], vv[0], u(d, ou)[1], vv[1]]);
    // -X face
    walls.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col, [u(d, ou)[0], vv[0], u(d, ou)[1], vv[1]]);
    // roof (counter-clockwise looking down)
    const rc = new THREE.Color(C.concreteDark);
    roofs.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], rc);
    // parapet lip
    roofs.box((x0 + x1) / 2, y1 + 0.25, z1 - 0.15, w, 0.5, 0.3, C.concrete);
    roofs.box((x0 + x1) / 2, y1 + 0.25, z0 + 0.15, w, 0.5, 0.3, C.concrete);
  }

  private buildProps(data: ChunkData, mats: ChunkMaterials) {
    const b = new MeshBuilder();
    for (const p of data.props) appendProp(b, p);
    for (const a of data.aabbs) {
      if (a.kind === 'wall') this.wallProp(b, a);
      else if (a.kind === 'barricade') {
        // Barricades are separate meshes so they can be rammed or blown apart.
        const bb = new MeshBuilder();
        this.barricadeProp(bb, a);
        this.barricadeMeshes.set(a.id, this.addMesh(bb.build(), mats.props, true, true));
      }
    }
    if (!b.empty) this.addMesh(b.build(), mats.props, true, true);
  }

  private wallProp(b: MeshBuilder, a: Aabb) {
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const h = a.y1;
    b.jitter = 0.05;
    b.box((a.minX + a.maxX) / 2, h / 2, (a.minZ + a.maxZ) / 2, w, h, d, C.concrete);
    // broken top edge
    const n = Math.max(2, Math.round(Math.max(w, d) / 2.5));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = w > d ? a.minX + t * w : (a.minX + a.maxX) / 2;
      const z = w > d ? (a.minZ + a.maxZ) / 2 : a.minZ + t * d;
      const k = hash2(a.id, i, 3);
      if (k > 0.5) b.box(x, h + 0.2 + k * 0.3, z, w > d ? 1.2 : w + 0.1, 0.5 + k * 0.5, w > d ? d + 0.1 : 1.2, C.concreteDark);
    }
  }

  private barricadeProp(b: MeshBuilder, a: Aabb) {
    const w = a.maxX - a.minX;
    const d = a.maxZ - a.minZ;
    const flimsy = a.breakable === 'flimsy';
    const cx = (a.minX + a.maxX) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    b.jitter = 0.07;
    if (flimsy) {
      // Planks, crates and a wrecked car.
      const n = Math.max(2, Math.round(w / 1.4));
      for (let i = 0; i < n; i++) {
        const x = a.minX + ((i + 0.5) / n) * w;
        const k = hash2(a.id, i, 11);
        b.box(x, 0.7 + k * 0.3, cz + (k - 0.5) * 0.4, w / n + 0.2, 1.3 + k * 0.7, 0.4, k > 0.5 ? C.wood : C.woodDark, 0, (k - 0.5) * 0.2, (k - 0.5) * 0.1);
        if (k > 0.55) b.box(x, 1.9 + k * 0.2, cz, 0.7, 0.7, 0.7, C.wood, 0, k, 0);
      }
    } else {
      // Welded steel and concrete.
      b.box(cx, 1.3, cz, w, 2.6, d * 0.7, C.concreteDark);
      const n = Math.max(2, Math.round(w / 2));
      for (let i = 0; i < n; i++) {
        const x = a.minX + ((i + 0.5) / n) * w;
        b.box(x, 3.0, cz, w / n - 0.1, 0.8, d * 0.5, C.rust2);
        b.tube(x - 0.5, 0.3, cz + d * 0.4, x + 0.5, 2.9, cz + d * 0.4, 0.12, C.steel);
      }
      b.box(cx, 2.6, cz + d * 0.38, w, 0.06, 0.2, C.signYellow);
    }
  }

  private buildColliders(def: TerrainDef, x0: number, z0: number) {
    // Heightfield for the ground.
    this.colliders.push(this.phys.addHeightfield(x0, z0, CHUNK, CELLS, this.data.heights));
    for (const a of this.data.aabbs) {
      const hy = (a.y1 - a.y0) / 2;
      const c = this.phys.addStaticBox(
        (a.minX + a.maxX) / 2,
        (a.y1 + a.y0) / 2 + (a.kind === 'rock' ? 0 : 0),
        (a.minZ + a.maxZ) / 2,
        (a.maxX - a.minX) / 2,
        hy,
        (a.maxZ - a.minZ) / 2,
        0,
        GROUPS.static,
      );
      this.colliders.push(c);
      this.aabbColliders.set(a.id, c);
    }
    void def;
  }

  removeAabb(id: number) {
    const bm = this.barricadeMeshes.get(id);
    if (bm) {
      bm.visible = false;
      this.barricadeMeshes.delete(id);
    }
    const c = this.aabbColliders.get(id);
    if (c) {
      this.phys.removeCollider(c);
      this.aabbColliders.delete(id);
      this.colliders = this.colliders.filter((q) => q !== c);
    }
  }

  dispose() {
    for (const c of this.colliders) this.phys.removeCollider(c);
    this.colliders = [];
    for (const g of this.geos) g.dispose();
    this.group.removeFromParent();
  }
}

const TINTS = [0xd9d6cf, 0xc2c6c4, 0xbfb6a4, 0xaab2b6];

function mixCol(a: readonly number[], b: readonly number[], t: number): number[] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
function srgb(v: number) {
  // Palette values are authored as display colours; convert to linear for the working colour space.
  return Math.pow(Math.max(0, Math.min(1, v)), 2.2);
}
function roadHeightGuess(def: TerrainDef, z: number) {
  // Rough local road elevation to tell valley floor from cliffs.
  return def.biome === 'city' ? 0 : 6 * Math.sin(z / 470 + def.phase[2]) + 1.8 * Math.sin(z / 173 + def.phase[3]);
}
