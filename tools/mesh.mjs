// A tiny triangle-soup builder. Every triangle is pushed with the normal it is
// *meant* to have; winding is corrected to match, so no polygon-orientation bug
// can ever flip a face the wrong way.
export class MeshBuilder {
  constructor() { this.pos = []; this.nrm = []; }
  get triangleCount() { return this.pos.length / 9; }

  tri(a, b, c, n) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-14) return;          // degenerate
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { const t = b; b = c; c = t; }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.nrm.push(n[0], n[1], n[2]);
  }

  /** Quad a-b-c-d as two triangles sharing the given normal. */
  quad(a, b, c, d, n) { this.tri(a, b, c, n); this.tri(a, c, d, n); }
}

/** Andrew's monotone chain convex hull on [x,z] points. */
export function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle (rotating calipers over hull edges).
 * Returns {centre,[ux,uz],[vx,vz],halfLong,halfShort,area,angle}.
 */
export function minAreaRect(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const len = Math.hypot(ex, ez);
    if (len < 1e-9) continue;
    const ux = ex / len, uz = ez / len;          // edge direction
    const vx = -uz, vz = ux;                     // perpendicular
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const du = p[0] * ux + p[1] * uz, dv = p[0] * vx + p[1] * vz;
      if (du < minU) minU = du; if (du > maxU) maxU = du;
      if (dv < minV) minV = dv; if (dv > maxV) maxV = dv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) best = { area, ux, uz, vx, vz, minU, maxU, minV, maxV };
  }
  if (!best) return null;
  const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
  const centre = [cu * best.ux + cv * best.vx, cu * best.uz + cv * best.vz];
  let hu = (best.maxU - best.minU) / 2, hv = (best.maxV - best.minV) / 2;
  let ax = [best.ux, best.uz], bx = [best.vx, best.vz];
  if (hv > hu) { [hu, hv] = [hv, hu]; [ax, bx] = [bx, ax]; }   // ax = long axis
  return { centre, long: ax, short: bx, halfLong: hu, halfShort: hv, area: best.area };
}

/** Shoelace area of a ring in the (x,z) plane, unsigned. */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}
