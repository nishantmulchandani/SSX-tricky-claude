import * as THREE from 'three';
import { heightAt, normalInto } from './terrain.js';
import { createSnowMaterial } from './snowMaterial.js';

/**
 * Continuous radial terrain mesh centred on the camera.
 *
 * Vertices are laid out on a polar grid whose ring radii grow geometrically,
 * so triangle density is roughly constant in *screen* space: centimetre detail
 * underfoot, kilometres of visible range, one draw call.
 *
 * Why not a geometry clipmap: nested clipmap rings each snap to their own grid
 * spacing, so level L and level L+1 disagree about where their shared boundary
 * is and tear open. A single mesh cannot crack, because there is no seam.
 *
 * The mesh is rebuilt in-place every frame from the camera position. Cost is
 * RINGS*SEGMENTS height samples per frame, which is why heightAt is kept cheap.
 */
export class Mountain {
  constructor({ rings = 176, segments = 208, innerRadius = 1.6, outerRadius = 9000 } = {}) {
    this.rings = rings;
    this.segments = segments;

    // Geometric progression from innerRadius to outerRadius.
    this.radii = new Float32Array(rings);
    const growth = Math.pow(outerRadius / innerRadius, 1 / (rings - 1));
    for (let i = 0; i < rings; i++) this.radii[i] = innerRadius * Math.pow(growth, i);

    // Per-ring sample spacing, used as the LOD hint for heightAt. Tangential
    // pitch is 2*pi*R/segments; radial pitch is the gap to the next ring.
    this.ringLod = new Float32Array(rings);
    // How far the camera must travel before this ring is worth re-sampling.
    this.ringThreshold = new Float32Array(rings);
    // Where each ring was last built (they drift apart by design).
    this.ringX = new Float32Array(rings).fill(NaN);
    this.ringZ = new Float32Array(rings).fill(NaN);
    for (let i = 0; i < rings; i++) {
      const tangential = (2 * Math.PI * this.radii[i]) / segments;
      const radial = i + 1 < rings ? this.radii[i + 1] - this.radii[i] : tangential;
      this.ringLod[i] = Math.max(tangential, radial);
      // Half a vertex pitch: re-sampling sooner cannot change the surface by
      // more than the ring's own linear-interpolation error already allows.
      this.ringThreshold[i] = Math.min(300, Math.max(0.5, this.ringLod[i] * 0.5));
    }
    // Vertices re-sampled per update() call. ~1.6us each, so this bounds the
    // terrain to roughly 4ms of a frame no matter how fast the rider moves.
    this.vertexBudget = 2600;

    const count = rings * segments + 1; // +1 for the centre vertex
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(count * 3);
    this.normals = new Float32Array(count * 3);
    this.uvs = new Float32Array(count * 2);

    // Unit-circle direction per segment, precomputed.
    this.dirX = new Float32Array(segments);
    this.dirZ = new Float32Array(segments);
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      this.dirX[s] = Math.cos(a);
      this.dirZ[s] = Math.sin(a);
    }

    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(this._buildIndex());
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    this.geometry = geo;
    this.material = createSnowMaterial();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false; // the terrain shadows itself via the sun-space pass
    this.mesh.name = 'terrain';

    this.group = new THREE.Group();
    this.group.add(this.mesh);

    this._n = new THREE.Vector3();
    this._center = new THREE.Vector3(NaN, 0, NaN);
  }

  _buildIndex() {
    const { rings, segments } = this;
    const idx = [];
    // Centre fan.
    for (let s = 0; s < segments; s++) {
      const a = 1 + s;
      const b = 1 + ((s + 1) % segments);
      idx.push(0, b, a);
    }
    // Quad bands between consecutive rings.
    for (let r = 0; r < rings - 1; r++) {
      const base = 1 + r * segments;
      const next = base + segments;
      for (let s = 0; s < segments; s++) {
        const s2 = (s + 1) % segments;
        const a = base + s, b = base + s2, c = next + s, d = next + s2;
        idx.push(a, d, c, a, b, d);
      }
    }
    const arr = idx.length > 65535 ? new Uint32Array(idx) : new Uint16Array(idx);
    return new THREE.BufferAttribute(arr, 1);
  }

  /**
   * Rebuild around `center`. Snapped to a small grid so the mesh does not
   * visibly swim under the rider at low speed.
   */
  update(center) {
    const SNAP = 0.5;
    const cx = Math.round(center.x / SNAP) * SNAP;
    const cz = Math.round(center.z / SNAP) * SNAP;

    const { rings, segments, radii, dirX, dirZ, positions, normals, uvs } = this;
    const n = this._n;

    // --- decide which rings actually need re-sampling ------------------------
    //
    // Rebuilding every ring whenever the camera twitches is what made this
    // cost 327ms a frame. A ring whose vertices sit 200m apart gains nothing
    // from being re-sampled after 0.5m of travel: its surface barely changes,
    // and it is kilometres away. Each ring therefore re-samples only once the
    // camera has moved a meaningful fraction of that ring's own vertex pitch.
    //
    // Work is additionally capped per call, so a frame can never be swamped;
    // the stalest rings are served first and the rest wait a frame or two.
    let budget = this.vertexBudget;
    let touched = false;
    let dirtyLo = rings, dirtyHi = -1;

    for (let r = 0; r < rings; r++) {
      const threshold = this.ringThreshold[r];
      const dx = cx - this.ringX[r];
      const dz = cz - this.ringZ[r];
      if (dx * dx + dz * dz < threshold * threshold) continue;
      if (budget <= 0) break;
      budget -= segments;
      touched = true;
      if (r < dirtyLo) dirtyLo = r;
      if (r > dirtyHi) dirtyHi = r;

      this.ringX[r] = cx;
      this.ringZ[r] = cz;

      const rad = radii[r];
      // Sample spacing for this ring: the larger of its radial and tangential
      // vertex pitch. Detail finer than this cannot be represented here, so
      // heightAt is told to skip those bands entirely.
      const lod = this.ringLod[r];
      let v = 1 + r * segments;
      for (let s = 0; s < segments; s++, v++) {
        const x = cx + dirX[s] * rad;
        const z = cz + dirZ[s] * rad;
        const i3 = v * 3, i2 = v * 2;
        positions[i3] = x;
        positions[i3 + 1] = heightAt(x, z, lod);
        positions[i3 + 2] = z;
        uvs[i2] = x * 0.05; uvs[i2 + 1] = z * 0.05;
      }
    }

    if (!touched) return;
    this._center.set(cx, 0, cz);
    this._dirtyLo = Math.max(0, dirtyLo - 1);
    this._dirtyHi = Math.min(rings - 1, dirtyHi + 1);

    positions[0] = cx; positions[1] = heightAt(cx, cz); positions[2] = cz;
    uvs[0] = cx * 0.05; uvs[1] = cz * 0.05;

    // --- pass 2: normals from the polar neighbourhood ------------------------
    // Cross the radial and tangential edge vectors. This automatically widens
    // the sampling footprint with distance, which is exactly the filtering the
    // far field needs to stop the noise aliasing into sparkle.
    normalInto(n, cx, cz, 0.6);
    normals[0] = n.x; normals[1] = n.y; normals[2] = n.z;

    // Only rings that moved need new normals — plus their immediate
    // neighbours, since a normal is the cross product of edges reaching into
    // the adjacent rings.
    for (let r = this._dirtyLo; r <= this._dirtyHi; r++) {
      const inner = r > 0 ? 1 + (r - 1) * segments : 0;
      const outer = 1 + Math.min(r + 1, rings - 1) * segments;
      let v = 1 + r * segments;
      for (let s = 0; s < segments; s++, v++) {
        const sPrev = (s - 1 + segments) % segments;
        const sNext = (s + 1) % segments;

        const iIn = (r > 0 ? inner + s : 0) * 3;
        const iOut = (outer + s) * 3;
        const iPrev = (1 + r * segments + sPrev) * 3;
        const iNext = (1 + r * segments + sNext) * 3;

        // Radial edge (inner -> outer) and tangential edge (prev -> next).
        const rx = positions[iOut] - positions[iIn];
        const ry = positions[iOut + 1] - positions[iIn + 1];
        const rz = positions[iOut + 2] - positions[iIn + 2];
        const tx = positions[iNext] - positions[iPrev];
        const ty = positions[iNext + 1] - positions[iPrev + 1];
        const tz = positions[iNext + 2] - positions[iPrev + 2];

        let nx = ty * rz - tz * ry;
        let ny = tz * rx - tx * rz;
        let nz = tx * ry - ty * rx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // keep normals up-facing

        const i3 = v * 3;
        normals[i3] = nx; normals[i3 + 1] = ny; normals[i3 + 2] = nz;
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
