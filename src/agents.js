import * as THREE from 'three';
import { flat, merge, routeMetrics, sampleRoute } from './geo-utils.js';

/**
 * The living layer: cars on the through roads, volunteers working the paths
 * and stooping to pick litter, and children milling about the schoolyard.
 *
 * Everything is instanced and shares three geometries, so the whole crowd adds
 * three draw calls. Bodies carry a white vertex colour so per-instance colour
 * sets the clothing; heads are a separate mesh so they keep their own skin
 * tone instead of being tinted along with the jacket.
 */

const SKIN = 0xe8b48c;
const COAT = [0xe24b3a, 0x3f7fd4, 0xf2b23a, 0x4aa564, 0xd25b9c, 0x6b53c7, 0xef7f3d];
const CAR_PAINT = [0xdc4b3c, 0x3d6fc4, 0xf0f0ec, 0x2f3a44, 0xc8ced4, 0x4c9c5e];

/**
 * Figures and vehicles are deliberately oversized. At true scale a 1.7 m
 * person covers about three pixels of a 400 m diorama and simply disappears;
 * model scenes have always cheated character scale upward for exactly this
 * reason. Roughly 2.2x reads clearly without looking like a giant.
 */
function bodyGeometry() {
  const g = flat(new THREE.CylinderGeometry(0.46, 0.60, 2.55, 6, 1, true));
  g.translate(0, 1.28, 0);
  return merge([[g, 0xffffff]]);
}
function headGeometry() {
  const g = flat(new THREE.IcosahedronGeometry(0.58, 0));
  g.translate(0, 3.02, 0);
  // A flat disc grounds the figure: agents are excluded from the baked shadow
  // map, so without it they look pasted on. It lives on the untinted mesh so
  // the clothing colour cannot bleed into it.
  const pad = flat(new THREE.CircleGeometry(0.95, 10));
  pad.rotateX(-Math.PI / 2);
  pad.translate(0, 0.03, 0);
  return merge([[g, SKIN], [pad, 0x5c6b57]]);
}

/** Car with its forward axis along +X. */
function carGeometry() {
  const parts = [];
  const body = flat(new THREE.BoxGeometry(8.2, 1.30, 3.40)); body.translate(0, 1.35, 0);
  const cabin = flat(new THREE.BoxGeometry(4.20, 1.05, 3.00)); cabin.translate(-0.35, 2.55, 0);
  parts.push([body, 0xffffff], [cabin, 0xdfe7ee]);
  for (const [dx, dz] of [[2.55, 1.78], [2.55, -1.78], [-2.55, 1.78], [-2.55, -1.78]]) {
    const wh = flat(new THREE.BoxGeometry(1.45, 1.00, 0.52));
    wh.translate(dx, 0.50, dz);
    parts.push([wh, 0x24282c]);        // near-black, so the paint tint barely moves it
  }
  return merge(parts);
}

const rand = (r, a, b) => a + r() * (b - a);
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createAgents(manifest, gradientMap) {
  const carRoutes = (manifest.carRoutes || []).map((r) => ({ ...r, ...routeMetrics(r.pts) }));
  const walkRoutes = (manifest.walkRoutes || []).map((r) => ({ ...r, ...routeMetrics(r.pts) }));
  const playSpots = manifest.playSpots || [];
  const r = rng(90210);

  /**
   * Every car runs at the same speed, so once a gap exists it is preserved for
   * the whole length of the road - no car can ever close on the one ahead.
   * Traffic therefore only needs policing at the entry: a car waits off-model
   * until the stretch behind the last one to set off is clear. Opposing
   * traffic is in the other lane, so it is checked per direction.
   */
  const CAR_SPEED = 9;      // m/s for all cars
  const CAR_GAP = 30;       // metres of clear road required before entering

  const cars = [];
  for (let i = 0; i < 6 && carRoutes.length; i++) {
    cars.push({
      route: carRoutes[i % carRoutes.length],
      colour: CAR_PAINT[Math.floor(r() * CAR_PAINT.length)],
      active: false, dir: r() < 0.5 ? 1 : -1, s: 0, wait: rand(r, 0.3, 14),
    });
  }
  // No mid-road seeding: a car may only ever appear at one end of the road and
  // drive off the other, so none is seen popping into existence in view.

  function entryClear(c) {
    for (const o of cars) {
      if (o === c || !o.active || o.route !== c.route || o.dir !== c.dir) continue;
      const travelled = c.dir === 1 ? o.s : c.route.length - o.s;
      if (travelled < CAR_GAP) return false;
    }
    return true;
  }

  const people = [];
  for (let i = 0; i < 10 && walkRoutes.length; i++) {
    const route = walkRoutes[i % walkRoutes.length];
    people.push({
      kind: 'walker', route, s: rand(r, 0, route.length), dir: r() < 0.5 ? 1 : -1,
      speed: rand(r, 1.0, 1.5), mode: 'walk', timer: rand(r, 3, 14), lean: 0,
      scale: rand(r, 0.95, 1.08), colour: COAT[Math.floor(r() * COAT.length)],
      yaw: 0, x: 0, z: 0,
    });
  }
  for (let i = 0; i < 8 && playSpots.length; i++) {
    const [ax, az] = playSpots[i % playSpots.length];
    people.push({
      kind: 'child', ax, az, x: ax, z: az, tx: ax, tz: az,
      speed: rand(r, 1.4, 2.1), pause: rand(r, 0, 1.5), hop: rand(r, 0, 6.28),
      scale: rand(r, 0.58, 0.68), colour: COAT[Math.floor(r() * COAT.length)],
      yaw: 0, lean: 0,
    });
  }

  const mkMesh = (geo, count, tinted) => {
    const m = new THREE.InstancedMesh(geo, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap }), count);
    m.frustumCulled = false;
    m.castShadow = false;          // the shadow map is baked once and never re-rendered
    if (!tinted) m.instanceColor = null;
    return m;
  };

  const bodyMesh = mkMesh(bodyGeometry(), people.length, true);
  const headMesh = mkMesh(headGeometry(), people.length, false);
  const carMesh = mkMesh(carGeometry(), cars.length, true);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  people.forEach((p, i) => { col.set(p.colour); bodyMesh.setColorAt(i, col); });
  cars.forEach((c, i) => { col.set(c.colour); carMesh.setColorAt(i, col); });
  if (bodyMesh.instanceColor) bodyMesh.instanceColor.needsUpdate = true;
  if (carMesh.instanceColor) carMesh.instanceColor.needsUpdate = true;

  const YARD = (manifest.yardY ?? 0.14) + 0.02;
  const LANE = 2.6;          // half a carriageway on a ~10 m secondary road

  function update(dt) {
    // ---- cars -------------------------------------------------------------
    cars.forEach((c, i) => {
      const park = () => {
        dummy.position.set(0, -999, 0); dummy.scale.setScalar(0.001);
        dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
        carMesh.setMatrixAt(i, dummy.matrix);
      };
      if (!c.active) {
        c.wait -= dt;
        if (c.wait <= 0 && entryClear(c)) {
          c.active = true;
          c.s = c.dir === 1 ? 0 : c.route.length;
        }
        park();
        return;
      }
      c.s += CAR_SPEED * c.dir * dt;
      if (c.s > c.route.length || c.s < 0) {
        c.active = false;
        c.dir = r() < 0.5 ? 1 : -1;
        c.wait = rand(r, 1.5, 8);
        park();
        return;
      }
      const p = sampleRoute(c.route.pts, c.route.cum, c.s);
      // Germany drives on the right. Facing (fx,fz) with y up, the right-hand
      // side is (-fz, fx), so offset the car half a carriageway that way
      // instead of straddling the centreline.
      const fx = p.dx * c.dir, fz = p.dz * c.dir;
      dummy.position.set(p.x - fz * LANE, c.route.y, p.z + fx * LANE);
      dummy.rotation.set(0, Math.atan2(-fz, fx), 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      carMesh.setMatrixAt(i, dummy.matrix);
    });
    carMesh.instanceMatrix.needsUpdate = true;

    // ---- people -----------------------------------------------------------
    people.forEach((p, i) => {
      let y = 0;
      if (p.kind === 'walker') {
        p.timer -= dt;
        if (p.mode === 'walk') {
          p.s += p.speed * p.dir * dt;
          if (p.s > p.route.length || p.s < 0) {
            p.dir *= -1;
            p.s = Math.min(Math.max(p.s, 0), p.route.length);
          }
          if (p.timer <= 0) { p.mode = 'pick'; p.timer = rand(r, 2.4, 4.2); p.dur = p.timer; }
        } else {
          // Stoop: ease down, hold, ease back up.
          const t = 1 - p.timer / p.dur;
          p.lean = Math.sin(Math.min(1, Math.max(0, t)) * Math.PI) ** 0.7;
          if (p.timer <= 0) { p.mode = 'walk'; p.timer = rand(r, 6, 16); p.lean = 0; }
        }
        const sp = sampleRoute(p.route.pts, p.route.cum, p.s);
        p.x = sp.x; p.z = sp.z;
        p.yaw = Math.atan2(-sp.dz * p.dir, sp.dx * p.dir);
        y = p.route.y;
      } else {
        // Children: wander to a nearby spot, pause, pick another, hop along.
        const dx = p.tx - p.x, dz = p.tz - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.6) {
          p.pause -= dt;
          if (p.pause <= 0) {
            const a = r() * Math.PI * 2, rad = rand(r, 2, 7);
            p.tx = p.ax + Math.cos(a) * rad; p.tz = p.az + Math.sin(a) * rad;
            p.pause = rand(r, 0.3, 2.2);
          }
        } else {
          p.x += (dx / d) * p.speed * dt;
          p.z += (dz / d) * p.speed * dt;
          p.yaw = Math.atan2(-dz / d, dx / d);
          p.hop += dt * 9;
        }
        y = YARD + Math.abs(Math.sin(p.hop)) * 0.14;
      }

      dummy.position.set(p.x, y, p.z);
      // Euler XYZ applies the roll in local space first, so this leans the
      // body forward along its own facing before the yaw turns it.
      dummy.rotation.set(0, p.yaw, -(p.lean || 0) * 1.05);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      bodyMesh.setMatrixAt(i, dummy.matrix);
      headMesh.setMatrixAt(i, dummy.matrix);
    });
    bodyMesh.instanceMatrix.needsUpdate = true;
    headMesh.instanceMatrix.needsUpdate = true;
  }

  update(0);
  return {
    meshes: [bodyMesh, headMesh, carMesh],
    update,
    // Telemetry for the ?diag overlay: lets the traffic rules be verified
    // without trying to spot 20-pixel cars in a screenshot.
    stats: () => ({
      speed: CAR_SPEED, gap: CAR_GAP, routeLen: +(cars[0]?.route.length ?? 0).toFixed(1),
      cars: cars.map((c) => ({ a: c.active ? 1 : 0, s: +c.s.toFixed(1), d: c.dir })),
    }),
  };
}
