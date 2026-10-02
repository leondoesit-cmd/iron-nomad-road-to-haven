import * as THREE from 'three';
import { CHUNK, corridorHalf, heightAt, roadX, type TerrainDef } from '../world/terrain';
import { hash2, noise2 } from '../core/rng';
import { smoothstep } from '../core/math';
import { cliffDetail } from './chunkview';
import { makeTerrainMaterial, type TerrainUniforms } from './terrainMaterial';
import { FacadeBuilder, facadeMaterial } from './facade';
import { MeshBuilder } from './builder';
import { kitMaterial } from './materials';
import { appendLandmark, LANDMARK_KINDS } from './landmarks';
import { BuildingView } from './buildingView';
import type { LegLayout } from '../world/layout';
import { shoreShade } from '../world/lakes';
import { buildLakeWater, type LakeWater } from './water';

/**
 * Scenery beyond the streamed chunks. In the wasteland, one coarse terrain mesh covers the whole leg out to
 * the mountains and punches a hole wherever a detailed chunk is loaded, so the view runs to the haze instead
 * of a fog wall. In the city, a skyline of towers stands behind the corridor using the facade shader.
 */
export class Landscape {
  group = new THREE.Group();
  private loadedTex: THREE.DataTexture | null = null;
  private loaded: Uint8Array | null = null;
  private cx0 = 0;
  private cz0 = 0;
  private cw = 0;
  private ch = 0;
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];
  private lakeWater: LakeWater[] = [];
  /** Every roadside building of the leg, each cut away on its own when someone steps inside. */
  buildings: BuildingView[] = [];

  constructor(
    private def: TerrainDef,
    layout?: Pick<LegLayout, 'rural' | 'props'>,
  ) {
    if (def.biome === 'wasteland') {
      this.buildFarTerrain();
      this.buildLakes();
      if (layout) this.buildSettlements(layout);
    } else this.buildSkyline();
  }

  /**
   * Every roadside building and landmark of the leg, merged into one mesh per 256 m cell. They are drawn from here
   * whether or not their chunk is streamed, so a gas station or a wind farm shows on the horizon minutes ahead.
   */
  private buildSettlements(layout: Pick<LegLayout, 'rural' | 'props'>) {
    const CELL_M = 256;
    const key = (x: number, z: number) => `${Math.floor(x / CELL_M)}:${Math.floor(z / CELL_M)}`;
    const cells = new Map<string, { det: MeshBuilder }>();
    const cell = (x: number, z: number) => {
      const k = key(x, z);
      let c = cells.get(k);
      if (!c) {
        c = { det: new MeshBuilder() };
        cells.set(k, c);
      }
      return c;
    };
    for (const b of layout.rural) {
      const v = new BuildingView(b);
      this.buildings.push(v);
      this.group.add(v.group);
    }
    for (const p of layout.props) {
      if (LANDMARK_KINDS.has(p.kind)) appendLandmark(cell(p.x, p.z).det, p);
    }
    const addMesh = (g: THREE.BufferGeometry, mat: THREE.Material) => {
      this.geos.push(g);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    };
    for (const c of cells.values()) {
      if (!c.det.empty) addMesh(c.det.build(), kitMaterial());
    }
  }

  private buildFarTerrain() {
    const def = this.def;
    // Chunk grid the hole mask covers.
    const halfW = 1500;
    const z0 = -600;
    const z1 = def.length + 900;
    this.cx0 = Math.floor((-halfW - 200) / CHUNK);
    this.cw = Math.ceil((halfW + 200) / CHUNK) - this.cx0 + 1;
    this.cz0 = Math.floor(z0 / CHUNK);
    this.ch = Math.ceil(z1 / CHUNK) - this.cz0 + 1;
    this.loaded = new Uint8Array(this.cw * this.ch * 4);
    this.loadedTex = new THREE.DataTexture(this.loaded, this.cw, this.ch, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.loadedTex.magFilter = THREE.NearestFilter;
    this.loadedTex.minFilter = THREE.NearestFilter;
    this.loadedTex.needsUpdate = true;
    const lod: TerrainUniforms = {
      tLoaded: { value: this.loadedTex },
      uLoadedRect: { value: new THREE.Vector4(this.cx0 * CHUNK, this.cz0 * CHUNK, this.cw * CHUNK, this.ch * CHUNK) },
    };
    const mat = makeTerrainMaterial('wasteland', lod, def.theme);
    this.mats.push(mat);
    // A grid in (offset from the road, z): dense near the canyon, coarse toward the mountains.
    const us: number[] = [];
    for (let u = -halfW; u <= halfW; ) {
      us.push(u);
      const a = Math.abs(u);
      u += a < 240 ? 10 : a < 600 ? 20 : 40;
    }
    const zs: number[] = [];
    for (let z = z0; z <= z1; z += 16) zs.push(z);
    const cols = us.length;
    const rows = zs.length;
    const pos = new Float32Array(cols * rows * 3);
    const col = new Float32Array(cols * rows * 3);
    const spl = new Float32Array(cols * rows * 4);
    const tda = new Float32Array(cols * rows * 4);
    for (let r = 0; r < rows; r++) {
      const z = zs[r];
      const rx = roadX(def, z);
      for (let c = 0; c < cols; c++) {
        const x = rx + us[c];
        // Slightly below the detailed chunks, so any seam hides under them.
        const h = heightAt(def, x, z) + cliffDetail(def, x, z) - 0.6;
        const i = r * cols + c;
        pos[i * 3] = x;
        pos[i * 3 + 1] = h;
        pos[i * 3 + 2] = z;
        const d = Math.abs(us[c]);
        const cliff = smoothstep(corridorHalf(def, z) + 1, corridorHalf(def, z) + 10, d);
        const sand = smoothstep(0.5, 0.78, noise2(x / 36 + 3, z / 36, def.seed + 72)) * (1 - cliff);
        const k = 0.93 + hash2(c, r, 5) * 0.14;
        // Lake beaches and floors read the same as in the detailed chunks.
        const shore = def.lakes.length ? shoreShade(def.lakes, x, z, h + 0.6) : null;
        const dk = shore && shore.depth > 0 ? Math.min(1, shore.depth / 3) : 0;
        col[i * 3] = k * (shore && shore.depth > 0 ? 0.62 - 0.3 * dk : 1);
        col[i * 3 + 1] = k * (shore && shore.depth > 0 ? 0.82 - 0.24 * dk : 1);
        col[i * 3 + 2] = k * (shore && shore.depth > 0 ? 0.78 - 0.18 * dk : 1);
        spl[i * 4] = shore ? Math.max(sand, shore.damp * 0.9) : sand;
        spl[i * 4 + 1] = (1 - cliff) * (1 - sand) * 0.8 * (shore ? 1 - shore.damp * 0.8 : 1);
        spl[i * 4 + 2] = shore ? cliff * (1 - shore.damp) : cliff;
        spl[i * 4 + 3] = shore && shore.depth > 0 ? 0.5 : (1 - cliff) * 0.2;
        tda[i * 4] = 1;
        tda[i * 4 + 1] = shore ? 0.35 + shore.damp * 0.5 : 0;
      }
    }
    const idx: number[] = [];
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        idx.push(a, d, e, a, e, b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    g.setAttribute('tdata', new THREE.BufferAttribute(tda, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.geos.push(g);
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.frustumCulled = false;
    this.group.add(m);
  }

  /**
   * Per view, before it renders: cut away the building the viewer's focus is in (roof and upper storeys), leave
   * every other one whole, and drop furniture for cameras too far away to see through a window.
   */
  updateView(focus: { x: number; y: number; z: number } | null, camX: number, camZ: number) {
    for (const b of this.buildings) b.setView(focus, camX, camZ);
  }

  /** One water sheet per lake, drawn for the whole leg. */
  private buildLakes() {
    for (const l of this.def.lakes) {
      const w = buildLakeWater(l);
      this.lakeWater.push(w);
      this.group.add(w.mesh);
    }
  }

  /** Mark a detailed chunk as loaded (the far mesh steps aside) or unloaded. */
  setLoaded(cx: number, cz: number, on: boolean) {
    if (!this.loaded || !this.loadedTex) return;
    const x = cx - this.cx0;
    const z = cz - this.cz0;
    if (x < 0 || z < 0 || x >= this.cw || z >= this.ch) return;
    this.loaded[(z * this.cw + x) * 4] = on ? 255 : 0;
    this.loadedTex.needsUpdate = true;
  }

  /** Towers behind the city corridor, standing on the rubble slopes. */
  private buildSkyline() {
    const def = this.def;
    const fb = new FacadeBuilder();
    const tints = [0xa8a8a2, 0x9a5a44, 0xc8b8a0, 0x5a6670, 0xb8b6ae, 0x8a4c3a];
    for (let z = -400; z < def.length + 600; z += 26) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          const k = hash2(Math.round(z), side * 7 + row, def.seed + 3);
          if (k < 0.35) continue;
          const cx = side * (175 + row * 95 + k * 50);
          const w = 18 + k * 22;
          const dz = 14 + hash2(Math.round(z), row, 9) * 16;
          const gz = z + (k - 0.5) * 10;
          const base = heightAt(def, cx, gz) - 2;
          const hgt = 25 + k * k * 110 + row * 15;
          const style = k > 0.8 ? 3 : Math.floor(k * 7) % 3;
          const tint = new THREE.Color(tints[Math.floor(k * 61) % tints.length]);
          const x0 = cx - w / 2;
          const x1 = cx + w / 2;
          const z0 = gz - dz / 2;
          const z1 = gz + dz / 2;
          const corners: [number, number][] = [[x0, z1], [x1, z1], [x1, z0], [x0, z0], [x0, z1]];
          for (let i = 0; i < 4; i++) {
            const [ax, az] = corners[i];
            const [bx, bz] = corners[i + 1];
            const len = Math.hypot(bx - ax, bz - az);
            fb.wall(ax, az, bx, bz, base, base + hgt, 0, tint, style, k * 97 + i, 3.3, len / Math.max(1, Math.round(len / 3)));
          }
          // Roof cap.
          const b = fb.pos.length / 3;
          fb.pos.push(x0, base + hgt, z0, x0, base + hgt, z1, x1, base + hgt, z1, x1, base + hgt, z0);
          for (let i = 0; i < 4; i++) {
            fb.nor.push(0, 1, 0);
            fb.col.push(0.3, 0.3, 0.3);
            fb.uv.push(0, -100);
            fb.fd.push(0, 0, 3.3, 3);
          }
          fb.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
      }
    }
    const g = fb.build();
    this.geos.push(g);
    const m = new THREE.Mesh(g, facadeMaterial());
    m.frustumCulled = false;
    m.receiveShadow = false;
    this.group.add(m);
  }

  dispose() {
    for (const w of this.lakeWater) w.dispose();
    for (const b of this.buildings) b.dispose();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.loadedTex?.dispose();
    this.group.removeFromParent();
  }
}
