// Small geometry helpers shared by the scene compiler.

/** Signed area in the (u,v) = (x,-z) plane. Positive = counter-clockwise seen from above. */
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * -q[1] - q[0] * -p[1];
  }
  return a / 2;
}

/** Force a ring counter-clockwise seen from above. Mutates nothing; may return the input. */
export function makeCCW(ring) {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}

/** Drop a repeated closing vertex and any zero-length edges. */
export function cleanRing(ring) {
  const out = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6) out.push(p);
  }
  while (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) out.pop(); else break;
  }
  return out;
}

/**
 * Sutherland-Hodgman clip of a subject ring against a convex clip polygon
 * (here: the regular n-gon that forms the diorama base).
 */
export function clipToConvex(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    // Clip ring is CCW seen from above, i.e. clockwise in raw (x,z): inside is cross <= 0.
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) <= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j + input.length - 1) % input.length];
      const cin = inside(cur), pin = inside(prev);
      if (cin) {
        if (!pin) out.push(lineIntersect(prev, cur, a, b));
        out.push(cur);
      } else if (pin) {
        out.push(lineIntersect(prev, cur, a, b));
      }
    }
  }
  return out;
}

function lineIntersect(p1, p2, p3, p4) {
  const d = (p1[0] - p2[0]) * (p3[1] - p4[1]) - (p1[1] - p2[1]) * (p3[0] - p4[0]);
  if (Math.abs(d) < 1e-12) return p2.slice();
  const n1 = p1[0] * p2[1] - p1[1] * p2[0];
  const n2 = p3[0] * p4[1] - p3[1] * p4[0];
  return [(n1 * (p3[0] - p4[0]) - (p1[0] - p2[0]) * n2) / d,
          (n1 * (p3[1] - p4[1]) - (p1[1] - p2[1]) * n2) / d];
}

/** Clip a polyline to a circle of the given radius, returning the pieces that lie inside. */
export function clipLineToCircle(pts, radius) {
  const r2 = radius * radius;
  const inside = (p) => p[0] * p[0] + p[1] * p[1] <= r2;
  const pieces = [];
  let cur = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ai = inside(a), bi = inside(b);
    if (ai && bi) { if (!cur.length) cur.push(a); cur.push(b); }
    else if (ai && !bi) { if (!cur.length) cur.push(a); cur.push(circleHit(a, b, radius)); pieces.push(cur); cur = []; }
    else if (!ai && bi) { cur = [circleHit(b, a, radius), b]; }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

/** Point where segment inside->outside crosses the circle. */
function circleHit(inPt, outPt, radius) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    const x = inPt[0] + (outPt[0] - inPt[0]) * m, y = inPt[1] + (outPt[1] - inPt[1]) * m;
    if (x * x + y * y <= radius * radius) lo = m; else hi = m;
  }
  return [inPt[0] + (outPt[0] - inPt[0]) * lo, inPt[1] + (outPt[1] - inPt[1]) * lo];
}

/** True if point is inside ring (even-odd rule), both in (x,z). */
export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > pt[1]) !== (zj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Deterministic RNG so the generated scene is byte-identical between builds. */
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
