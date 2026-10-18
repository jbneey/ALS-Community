/**
 * Three.js world adapter — the "engine bridge" for the ALS port.
 *
 * Implements the worldProbe contract expected by ALSMantleComponent / movement:
 *   groundHeight(pos), resolve(pos, radius), sphereTrace(), lineTraceDown(), lineTraceSimple()
 * using simple AABB math (the demo level is built from boxes).
 */

import * as THREE from 'three';

export class ALSWorld {
  constructor(scene) {
    this.scene = scene;
    this.boxes = []; // {min:{x,y,z}, max:{...}, mesh}
    this.materials = {
      floor: new THREE.MeshStandardMaterial({ color: 0x3d4450 }),
      box: new THREE.MeshStandardMaterial({ color: 0x8a6d4f }),
      wall: new THREE.MeshStandardMaterial({ color: 0x5b6170 }),
      accent: new THREE.MeshStandardMaterial({ color: 0x2e8fff }),
    };
  }

  addBox(cx, cy, cz, sx, sy, sz, matKey = 'box') {
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geo, this.materials[matKey] ?? this.materials.box);
    // world axes: X,Y horizontal, Z up. Three.js is Y-up → rotate -90° about X.
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, cz, -cy);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.boxes.push({
      min: { x: cx - sx / 2, y: cy - sy / 2, z: cz - sz / 2 },
      max: { x: cx + sx / 2, y: cy + sy / 2, z: cz + sz / 2 },
      mesh,
    });
    return mesh;
  }

  /** Build the parkour demo level. Returns spawn point. */
  buildLevel() {
    // main floor 4000x4000 at z=0
    this.addBox(0, 0, -50, 4000, 4000, 100, 'floor');

    // low mantle wall (height 100) with a long run
    this.addBox(300, 0, 50, 600, 60, 100);
    // high mantle crate stack (height 200)
    this.addBox(300, -400, 100, 200, 200, 200);
    // very tall wall (unmantlable — demonstrates rejection)
    this.addBox(-500, 300, 200, 500, 60, 400);
    // step blocks (walkable via step offset)
    this.addBox(-200, -500, 25, 200, 200, 50);
    this.addBox(-200, -750, 50, 200, 200, 100);
    // platform reachable by jump + mantle combo
    this.addBox(700, 300, 150, 300, 300, 300);
    // ledge to drop onto ragdoll demo area
    this.addBox(900, -300, 120, 250, 250, 240);
    // ramp-ish stairs
    for (let i = 0; i < 6; i++) this.addBox(-700, -200 + i * 90, 20 + i * 40, 150, 90, 40 + i * 80);
    // pillars for camera collision demo
    this.addBox(0, 500, 200, 60, 60, 400, 'wall');
    this.addBox(-400, -200, 200, 60, 60, 400, 'wall');

    return { x: 0, y: -150, z: 0 };
  }

  // ---------- probe API used by ALS components ----------

  groundHeight(pos) {
    // highest box top at or slightly below the point's feet level
    let best = 0;
    for (const b of this.boxes) {
      if (pos.x >= b.min.x && pos.x <= b.max.x && pos.y >= b.min.y && pos.y <= b.max.y) {
        if (b.max.z <= pos.z + 60 && b.max.z > best) best = b.max.z;
      }
    }
    return best;
  }

  /** Horizontal collision resolution for walking/falling; keeps previous axis on penetration. */
  resolve(next, radius) {
    const out = { x: next.x, y: next.y };
    for (const b of this.boxes) {
      if (b.max.z <= 1) continue;           // floor slab never blocks horizontally
      if (next.z + 10 > b.max.z) continue;  // standing on top of it → no block
      if (next.z < b.min.z) continue;
      // expanded AABB test
      const minX = b.min.x - radius, maxX = b.max.x + radius;
      const minY = b.min.y - radius, maxY = b.max.y + radius;
      if (out.x > minX && out.x < maxX && out.y > minY && out.y < maxY) {
        // push out along smallest penetration axis
        const dxMin = out.x - minX, dxMax = maxX - out.x;
        const dyMin = out.y - minY, dyMax = maxY - out.y;
        const m = Math.min(dxMin, dxMax, dyMin, dyMax);
        if (m === dxMin) out.x = minX; else if (m === dxMax) out.x = maxX;
        else if (m === dyMin) out.y = minY; else out.y = maxY;
      }
    }
    return out;
  }

  sphereTrace(from, dir, dist, radius) {
    // march ray, test sphere-vs-AABB overlap each step
    const steps = Math.ceil(dist / 10);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * dist;
      const p = { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z };
      for (const b of this.boxes) {
        if (sphereHitsAABB(p, radius, b)) {
          return { hit: true, point: p, normal: outwardNormal(dir, b), distance: t };
        }
      }
    }
    return { hit: false };
  }

  lineTraceDown(start, end, radius) {
    // downward-slanted trace: sample segment, first box top surface hit whose normal is up-ish
    const steps = 24;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const p = {
        x: start.x + (end.x - start.x) * k,
        y: start.y + (end.y - start.y) * k,
        z: start.z + (end.z - start.z) * k,
      };
      for (const b of this.boxes) {
        if (p.x > b.min.x - radius && p.x < b.max.x + radius &&
            p.y > b.min.y - radius && p.y < b.max.y + radius &&
            p.z <= b.max.z && p.z >= b.max.z - 45) {
          return { hit: true, point: { x: p.x, y: p.y, z: b.max.z }, normal: { x: 0, y: 0, z: 1 }, distance: k };
        }
      }
    }
    return { hit: false };
  }

  lineTraceSimple(from, to) {
    const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 1) return { hit: false };
    const dir = { x: d.x / len, y: d.y / len, z: d.z / len };
    const steps = Math.ceil(len / 15);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * len;
      const p = { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t };
      for (const b of this.boxes) {
        if (p.x > b.min.x && p.x < b.max.x && p.y > b.min.y && p.y < b.max.y &&
            p.z > b.min.z && p.z < b.max.z) {
          return { hit: true, distance: t };
        }
      }
    }
    return { hit: false };
  }
}

function sphereHitsAABB(p, r, b) {
  const cx = clampC(p.x, b.min.x, b.max.x);
  const cy = clampC(p.y, b.min.y, b.max.y);
  const cz = clampC(p.z, b.min.z, b.max.z);
  const dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

function clampC(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function outwardNormal(dir, b) {
  // approximate: face the dir came from
  const cxx = (b.min.x + b.max.x) / 2, cyy = (b.min.y + b.max.y) / 2;
  const nx = -(dir.x), ny = -(dir.y);
  void cxx; void cyy;
  return { x: nx, y: ny, z: 0 };
}

/** Convert ALS coords (Z-up) to Three.js (Y-up). */
export function toThree(p) {
  return new THREE.Vector3(p.x, p.z, -p.y);
}
