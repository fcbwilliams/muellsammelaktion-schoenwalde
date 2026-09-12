import * as THREE from 'three';

/** Non-indexed with face normals: flat facets are what make cel shading read. */
export function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

/**
 * Concatenates geometries, baking a flat colour into each as a vertex
 * attribute. One merged geometry per species means one draw call per species,
 * however many parts it is built from.
 */
export function merge(parts) {
  let n = 0;
  for (const [g] of parts) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  const c = new THREE.Color();
  let o = 0;
  for (const [g, hex] of parts) {
    // Color.set() already converts sRGB -> working space; do not convert again.
    c.set(hex);
    const p = g.attributes.position.array, m = g.attributes.normal.array;
    for (let i = 0; i < g.attributes.position.count; i++) {
      const a = (o + i) * 3, b = i * 3;
      pos[a] = p[b]; pos[a+1] = p[b+1]; pos[a+2] = p[b+2];
      nrm[a] = m[b]; nrm[a+1] = m[b+1]; nrm[a+2] = m[b+2];
      col[a] = c.r; col[a+1] = c.g; col[a+2] = c.b;
    }
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/** Cumulative arc lengths for a flat [x,z,x,z,...] polyline. */
export function routeMetrics(pts) {
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) {
    cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i-2], pts[i+1] - pts[i-1]));
  }
  return { cum, length: cum[cum.length - 1] };
}

/** Position and unit tangent at arc length `s` along a polyline. */
export function sampleRoute(pts, cum, s) {
  let lo = 0, hi = cum.length - 1;
  if (s <= 0) s = 0;
  if (s >= cum[hi]) s = cum[hi];
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = cum[lo + 1] - cum[lo] || 1;
  const t = (s - cum[lo]) / seg;
  const i = lo * 2, j = i + 2;
  const x = pts[i] + (pts[j] - pts[i]) * t;
  const z = pts[i+1] + (pts[j+1] - pts[i+1]) * t;
  let dx = pts[j] - pts[i], dz = pts[j+1] - pts[i+1];
  const l = Math.hypot(dx, dz) || 1;
  return { x, z, dx: dx / l, dz: dz / l };
}
