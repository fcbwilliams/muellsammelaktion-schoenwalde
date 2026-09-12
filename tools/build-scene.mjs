// Compiles the cached OSM extract into a compact, quantised binary the browser
// can upload straight to the GPU. Run: npm run osm:build
import { readFileSync, writeFileSync } from 'node:fs';
import earcut from 'earcut';
import { signedArea, makeCCW, cleanRing, clipToConvex, clipLineToCircle, pointInRing, mulberry32 } from './geom.mjs';
import { MeshBuilder, minAreaRect, ringArea } from './mesh.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const osm = JSON.parse(readFileSync(new URL('../data/osm-raw.json', import.meta.url), 'utf8'));
const R = cfg.radiusMetres;

/* ---------------------------------------------------------------- projection */
const D2R = Math.PI / 180;
const M_PER_LAT = 111320;
const M_PER_LON = 111320 * Math.cos(cfg.lat * D2R);
/** lat/lon -> local metres, north = -z (so the default camera looks north). */
const project = (lat, lon) => [(lon - cfg.lon) * M_PER_LON, -(lat - cfg.lat) * M_PER_LAT];

/* ------------------------------------------------------------------ settings */
const BASE_SIDES = 72;                 // plinth is a regular n-gon
const BASE_DEPTH = 14;                 // how far the plinth drops below ground
const WATER_Y = 0.02, GREEN_Y = 0.06, YARD_Y = 0.14, PITCH_Y = 0.19;
/**
 * Road classes get their own bands so a through road always wins against the
 * side roads that tee into it: footpaths lowest, then minor roads, with the
 * main road on top so it reads as continuous through every junction.
 */
const PATH_Y = 0.24, ROAD_MINOR_Y = 0.31, ROAD_MAJOR_Y = 0.39;
/**
 * Separate features at the same nominal height are still coplanar where they
 * overlap (two roads at a junction, a park inside a landuse patch), which
 * z-fights just as badly. A deterministic per-feature nudge breaks the tie
 * and is far too small to see at this scale.
 */
const layerNudge = (i) => (i % 11) * 0.004;

const ROAD_WIDTH = {
  motorway: 14, trunk: 12, primary: 11, secondary: 10, tertiary: 8.5,
  unclassified: 6.5, residential: 6.5, living_street: 5.5, service: 4,
  pedestrian: 4, track: 3, footway: 2, path: 1.8, cycleway: 2.2,
};
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const SOFT = new Set(['footway', 'path', 'cycleway', 'track', 'pedestrian']);

// No building in this extract carries height tags, so heights are inferred.
const HEIGHT = {
  school: 8.5, kindergarten: 7, sports_hall: 9, gymnasium: 9, civic: 8.5,
  apartments: 11, residential: 7.5, house: 6.8, detached: 6.8, semidetached_house: 6.8,
  bungalow: 4.2, terrace: 7, commercial: 7, retail: 6.5, industrial: 8,
  garage: 2.6, garages: 2.6, shed: 2.4, hut: 2.4, carport: 2.4, roof: 2.6,
  greenhouse: 2.6, service: 3, church: 12, chapel: 9,
};
const DEFAULT_HEIGHT = 6.5;
// Flat-roofed types: the school itself, its sports hall, and utilitarian sheds.
const FLAT_ROOF = new Set(['school', 'sports_hall', 'gymnasium', 'kindergarten', 'civic',
  'industrial', 'commercial', 'retail', 'garages', 'roof', 'carport', 'greenhouse', 'apartments']);

/* --------------------------------------------------------------- OSM indexing */
const ways = new Map();
const nodes = [];
for (const el of osm.elements) {
  if (el.type === 'way' && el.geometry) ways.set(el.id, el);
  else if (el.type === 'node') nodes.push(el);
  else if (el.type === 'relation' && el.members) ways.set('r' + el.id, el);
}
const tagsOf = (el) => el.tags || {};
const ringOf = (el) => cleanRing((el.geometry || []).map((g) => project(g.lat, g.lon)));

/** Outer rings of a relation (multipolygon), or the single ring of a way. */
function ringsOf(el) {
  if (el.type === 'way') { const r = ringOf(el); return r.length >= 3 ? [r] : []; }
  const out = [];
  for (const m of el.members || []) {
    if (m.role !== 'outer' && m.role !== '') continue;
    const r = cleanRing((m.geometry || []).map((g) => project(g.lat, g.lon)));
    if (r.length >= 3) out.push(r);
  }
  return out;
}

/* --------------------------------------------------------- the clipping n-gon */
const baseRing = [];
for (let i = 0; i < BASE_SIDES; i++) {
  const t = (i / BASE_SIDES) * Math.PI * 2;
  baseRing.push([Math.cos(t) * R, -Math.sin(t) * R]);   // CCW seen from above
}

/* --------------------------------------------------------------- mesh groups */
const G = {
  baseTop: new MeshBuilder(), baseSide: new MeshBuilder(),
  green: new MeshBuilder(), water: new MeshBuilder(), yard: new MeshBuilder(), pitch: new MeshBuilder(),
  roadMajor: new MeshBuilder(), roadMinor: new MeshBuilder(), roadPath: new MeshBuilder(),
  wall: new MeshBuilder(), roof: new MeshBuilder(),
  schoolWall: new MeshBuilder(), schoolRoof: new MeshBuilder(),
  hallRoof: new MeshBuilder(),
};
const UP = [0, 1, 0], DOWN = [0, -1, 0];

/** Triangulate a flat ring at height y into the given builder. */
function fillRing(mb, ring, y) {
  if (ring.length < 3) return;
  const ccw = makeCCW(ring);
  const flat = [];
  for (const p of ccw) flat.push(p[0], -p[1]);            // earcut in (u,v)=(x,-z)
  const idx = earcut(flat);
  for (let i = 0; i < idx.length; i += 3) {
    const a = ccw[idx[i]], b = ccw[idx[i + 1]], c = ccw[idx[i + 2]];
    mb.tri([a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]], UP);
  }
}

/* ------------------------------------------------------------------ 1. plinth */
{
  fillRing(G.baseTop, baseRing, 0);
  for (let i = 0; i < BASE_SIDES; i++) {
    const a = baseRing[i], b = baseRing[(i + 1) % BASE_SIDES];
    const nx = a[0] + b[0], nz = a[1] + b[1];
    const l = Math.hypot(nx, nz) || 1;
    G.baseSide.quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], -BASE_DEPTH, b[1]], [a[0], -BASE_DEPTH, a[1]],
      [nx / l, 0, nz / l]);
  }
}

/* ------------------------------------------- 2. ground cover (green / water / school yard) */
let groundIndex = 0;
const schoolGroundRings = [];
const buildingRings = [];   // for tree rejection
const roadSegments = [];    // for tree rejection

for (const el of ways.values()) {
  const t = tagsOf(el);
  if (t.building) continue;
  let target = null, y = GREEN_Y;
  if (t.natural === 'water' || t.waterway) { target = G.water; y = WATER_Y; }
  else if (t.amenity === 'school') { target = G.yard; y = YARD_Y; }
  else if (t.leisure === 'pitch' || t.leisure === 'track' || t.leisure === 'playground') { target = G.pitch; y = PITCH_Y; }
  else if (t.leisure || t.landuse || (t.natural && t.natural !== 'tree')) { target = G.green; y = GREEN_Y; }
  if (!target) continue;
  y += layerNudge(groundIndex++);

  for (const ring of ringsOf(el)) {
    const clipped = clipToConvex(makeCCW(ring), baseRing);
    if (clipped.length < 3) continue;
    fillRing(target, clipped, y);
    if (t.amenity === 'school') schoolGroundRings.push(clipped);
  }
}

/* ------------------------------------------------------------------ 3. roads */
/**
 * Road ribbon with mitred joins. An earlier version stamped a disc at each
 * joint, overlapping the segment quads at exactly the same height; two
 * coplanar surfaces z-fight into stipple, which is what showed up wherever
 * paths met roads. Mitring makes consecutive quads share an edge instead, so
 * nothing overlaps -- and the triangle count drops as a bonus.
 */
function ribbon(mb, pts, width, y) {
  const h = width / 2;
  const n = pts.length;
  if (n < 2) return;

  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) { segN.push(segN[segN.length - 1] || [0, 1]); continue; }
    segN.push([-dz / l, dx / l]);
  }

  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)];
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = b[0]; mz = b[1]; } else { mx /= ml; mz /= ml; }
    // Clamped miter: a hairpin would otherwise throw a spike off to infinity.
    const scale = 1 / Math.max(0.4, mx * b[0] + mz * b[1]);
    left.push([pts[i][0] + mx * h * scale, pts[i][1] + mz * h * scale]);
    right.push([pts[i][0] - mx * h * scale, pts[i][1] - mz * h * scale]);
  }

  for (let i = 0; i < n - 1; i++) {
    mb.quad([left[i][0], y, left[i][1]], [left[i + 1][0], y, left[i + 1][1]],
            [right[i + 1][0], y, right[i + 1][1]], [right[i][0], y, right[i][1]], UP);
  }
}

const carRoutes = [], walkRoutes = [];
let roadIndex = 0;
for (const el of ways.values()) {
  const t = tagsOf(el);
  if (!t.highway || el.type !== 'way') continue;
  const w = ROAD_WIDTH[t.highway] ?? 5;
  const soft = SOFT.has(t.highway);
  const major = MAJOR.has(t.highway);
  const mb = major ? G.roadMajor : soft ? G.roadPath : G.roadMinor;
  const roadY = (soft ? PATH_Y : major ? ROAD_MAJOR_Y : ROAD_MINOR_Y) + layerNudge(roadIndex++);
  const line = (el.geometry || []).map((g) => project(g.lat, g.lon));
  for (const piece of clipLineToCircle(line, R - 0.5)) {
    if (piece.length < 2) continue;
    ribbon(mb, piece, w, roadY);
    for (let i = 0; i < piece.length - 1; i++) roadSegments.push([piece[i], piece[i + 1], w / 2 + 2]);

    // Centrelines for the animated cars and pedestrians. Only routes with
    // enough length are worth driving or walking along.
    const length = piece.reduce((a, p, i) => i ? a + Math.hypot(p[0] - piece[i-1][0], p[1] - piece[i-1][1]) : 0, 0);
    if (length > 45) {
      const flat = [];
      for (const [px, pz] of piece) flat.push(+px.toFixed(1), +pz.toFixed(1));
      const route = { y: +(roadY + 0.05).toFixed(2), pts: flat };
      // Cars run on the through road only; side streets stay quiet.
      if (major) carRoutes.push(route);
      else if (soft) walkRoutes.push(route);
    }
  }
}

/* -------------------------------------------------------------- 4. buildings */
function buildingHeight(t) {
  if (t.height) { const h = parseFloat(t.height); if (isFinite(h)) return h; }
  if (t['building:levels']) { const l = parseFloat(t['building:levels']); if (isFinite(l)) return l * 3.1 + 1.1; }
  return HEIGHT[t.building] ?? HEIGHT[t.amenity] ?? DEFAULT_HEIGHT;
}

/** Vertical band between two heights, outward normals from CCW ring order. */
function wallsBetween(mb, ring, y0, y1) {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = [a[1] - b[1], 0, b[0] - a[0]];
    const l = Math.hypot(n[0], n[2]) || 1;
    n[0] /= l; n[2] /= l;
    mb.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], n);
  }
}

/** Walls from ground to `h`. */
const walls = (mb, ring, h) => wallsBetween(mb, ring, 0, h);

/** Gabled roof over a footprint that is close enough to rectangular. */
function gableRoof(mb, rect, h, rise) {
  const { centre: c, long: L, short: S, halfLong: hl, halfShort: hs } = rect;
  const P = (dl, ds, y) => [c[0] + L[0] * dl + S[0] * ds, y, c[1] + L[1] * dl + S[1] * ds];
  const top = h + rise;
  const eaveA = [P(-hl, -hs, h), P(hl, -hs, h)];
  const eaveB = [P(-hl, hs, h), P(hl, hs, h)];
  const ridge = [P(-hl, 0, top), P(hl, 0, top)];
  // slope normals
  const slope = (sign) => {
    const nx = S[0] * sign * rise, nz = S[1] * sign * rise;
    const ny = hs;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
  mb.quad(eaveA[0], eaveA[1], ridge[1], ridge[0], slope(-1));
  mb.quad(eaveB[1], eaveB[0], ridge[0], ridge[1], slope(1));
  // gable ends
  const endN = (sign) => [L[0] * sign, 0, L[1] * sign];
  mb.tri(eaveA[0], eaveB[0], ridge[0], endN(-1));
  mb.tri(eaveA[1], eaveB[1], ridge[1], endN(1));
}

const OVERRIDES = cfg.buildingOverrides || {};

/** Replace a footprint with a regular n-gon of equal area, for genuinely round buildings. */
function roundFootprint(ring, sides = 20) {
  const area = ringArea(ring);
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p[0] / ring.length; cz += p[1] / ring.length; }
  const r = Math.sqrt(area / Math.PI);
  const out = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * Math.PI * 2;
    out.push([cx + Math.cos(t) * r, cz - Math.sin(t) * r]);
  }
  return out;
}

/**
 * Hip/fan roof: every footprint edge rises as its own segment to a single
 * shallow apex over the centroid. Curved walls mapped as a run of short
 * segments therefore get a fanned, faceted roof rather than a flat lid.
 */
function apexRoof(mb, ring, h, rise) {
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p[0] / ring.length; cz += p[1] / ring.length; }
  const apex = [cx, h + rise, cz];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const A = [a[0], h, a[1]], B = [b[0], h, b[1]];
    const ux = B[0] - A[0], uy = 0, uz = B[2] - A[2];
    const vx = apex[0] - A[0], vy = apex[1] - A[1], vz = apex[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }   // roofs always face upward
    const l = Math.hypot(nx, ny, nz) || 1;
    mb.tri(A, B, apex, [nx / l, ny / l, nz / l]);
  }
}

let stats = { buildings: 0, school: 0, gabled: 0, flat: 0, apex: 0, round: 0, trees: 0 };
for (const el of ways.values()) {
  const t = tagsOf(el);
  if (!t.building) continue;
  const ovr = OVERRIDES[String(el.id)] || null;
  for (let raw of ringsOf(el)) {
    if (ovr && ovr.roof === 'round') raw = roundFootprint(raw, ovr.sides || 20);
    const ring = clipToConvex(makeCCW(raw), baseRing);
    if (ring.length < 3 || ringArea(ring) < 4) continue;

    const centroid = ring.reduce((a, p) => [a[0] + p[0] / ring.length, a[1] + p[1] / ring.length], [0, 0]);
    const isSchool = t.building === 'school' || t.amenity === 'school' ||
      schoolGroundRings.some((sr) => pointInRing(centroid, sr));
    const school = ovr && ovr.school !== undefined ? ovr.school : isSchool;
    const wallMb = G[(ovr && ovr.wallGroup) || (school ? 'schoolWall' : 'wall')];
    const roofMb = G[(ovr && ovr.roofGroup) || (school ? 'schoolRoof' : 'roof')];

    const h = (ovr && isFinite(ovr.height)) ? ovr.height : buildingHeight(t);
    walls(wallMb, ring, h);
    buildingRings.push(ring);
    stats.buildings++; if (school) stats.school++;

    const roofKind = ovr && ovr.roof ? ovr.roof : null;
    const flat = roofKind ? (roofKind !== 'gable' && roofKind !== 'apex')
      : (isSchool || FLAT_ROOF.has(t.building) || t['roof:shape'] === 'flat');
    if (roofKind === 'round') stats.round++;
    const rect = minAreaRect(ring);
    const rectLike = rect && ringArea(ring) / rect.area > 0.82 && rect.halfShort > 1.6;

    if (roofKind === 'apex') {
      const ov = 0.4;
      let cx = 0, cz = 0;
      for (const p of ring) { cx += p[0] / ring.length; cz += p[1] / ring.length; }
      const grown = ring.map(([x, z]) => {
        const dx = x - cx, dz = z - cz, l = Math.hypot(dx, dz) || 1;
        return [x + (dx / l) * ov, z + (dz / l) * ov];
      });
      apexRoof(roofMb, grown, h, ovr.rise ?? 1.8);
      // thin fascia so the eaves read as a solid edge
      wallsBetween(roofMb, grown, h - 0.3, h);
      stats.apex++;
    } else if (!flat && rectLike) {
      // Slight overhang reads as eaves once cel-shaded.
      const ov = 0.45;
      const over = { ...rect, halfLong: rect.halfLong + ov, halfShort: rect.halfShort + ov };
      gableRoof(roofMb, over, h, Math.min(rect.halfShort * 0.85, 3.6));
      stats.gabled++;
    } else {
      fillRing(roofMb, ring, h + 0.35);
      // parapet band only, from the wall top upward
      wallsBetween(roofMb, ring, h, h + 0.35);
      stats.flat++;
    }
  }
}

/* ------------------------------------------------------------------ 5. trees */
/**
 * Tree positions come from the aerial photograph: vegetation is segmented by
 * G-R (immune to the screenshot's colour cast), then rejected against OSM
 * buildings, roads and the school grounds. They ship as instance transforms
 * rather than merged triangles, so 800+ trees cost a handful of draw calls and
 * a few KB instead of a megabyte of vertices.
 */
let treeInstances = [];
try {
  const tj = JSON.parse(readFileSync(new URL('../data/trees.json', import.meta.url), 'utf8'));
  const rng = mulberry32(7731);
  for (const [east, north, crown] of tj.trees) {
    const x = east, z = -north;
    if (Math.hypot(x, z) > R - 3) continue;
    const r = rng();
    const conifer = r < 0.26 ? 1 : 0;           // the area is mixed, broadleaf-dominant
    const scale = (0.78 + crown * 0.55 + rng() * 0.3) * (conifer ? 1.15 : 1);
    treeInstances.push([
      +x.toFixed(2), +z.toFixed(2), +scale.toFixed(3),
      +(rng() * Math.PI * 2).toFixed(3), conifer,
    ]);
  }
  stats.trees = treeInstances.length;
} catch (err) {
  console.warn('No data/trees.json - continuing without trees:', err.message);
}

/**
 * OSM splits a road wherever a tag changes, and clipping to the disc splits it
 * again, so the through road arrives as several stubs. Stitching pieces that
 * share an endpoint back together lets a car drive the full length instead of
 * vanishing every few seconds.
 */
function joinRoutes(routes, tol = 1.5) {
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
  const asPairs = (flat) => {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  };
  const items = routes.map((r) => ({ y: r.y, pts: asPairs(r.pts) }));
  let merged = true;
  while (merged) {
    merged = false;
    outer:
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i].pts, B = items[j].pts;
        let joined = null;
        if (near(A[A.length - 1], B[0])) joined = A.concat(B.slice(1));
        else if (near(A[A.length - 1], B[B.length - 1])) joined = A.concat(B.slice().reverse().slice(1));
        else if (near(A[0], B[B.length - 1])) joined = B.concat(A.slice(1));
        else if (near(A[0], B[0])) joined = B.slice().reverse().concat(A.slice(1));
        if (joined) {
          items[i] = { y: Math.min(items[i].y, items[j].y), pts: joined };
          items.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return items.map((it) => ({ y: it.y, pts: it.pts.flat() }));
}

/* -------------------------------------------------- 5b. children's play spots */
const playSpots = [];
{
  const rng = mulberry32(4242);
  for (let i = 0; i < 6000 && playSpots.length < 14; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * (R - 10);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!schoolGroundRings.some((ring) => pointInRing([x, z], ring))) continue;
    if (buildingRings.some((ring) => pointInRing([x, z], ring))) continue;
    if (roadSegments.some(([p, q, w]) => {
      const dx = q[0] - p[0], dz = q[1] - p[1], l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) return false;
      const t2 = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / l2));
      return Math.hypot(x - (p[0] + t2 * dx), z - (p[1] + t2 * dz)) < w;
    })) continue;
    if (playSpots.some(([px, pz]) => (px - x) ** 2 + (pz - z) ** 2 < 100)) continue;
    playSpots.push([+x.toFixed(1), +z.toFixed(1)]);
  }
}

/* ------------------------------------------------------- 6. quantise + write */
const POS_SCALE = 0.02;                 // metres per integer unit (Int16 -> +-655 m)
const chunks = [];
const groups = [];
let byteOffset = 0;

for (const [name, mb] of Object.entries(G)) {
  const n = mb.pos.length / 3;
  if (!n) continue;
  const p = new Int16Array(mb.pos.length);
  for (let i = 0; i < mb.pos.length; i++) {
    const v = Math.round(mb.pos[i] / POS_SCALE);
    p[i] = Math.max(-32768, Math.min(32767, v));
  }
  const nr = new Int8Array(mb.nrm.length);
  for (let i = 0; i < mb.nrm.length; i++) nr[i] = Math.max(-127, Math.min(127, Math.round(mb.nrm[i] * 127)));

  const pBuf = Buffer.from(p.buffer);
  let pad = (4 - (pBuf.length % 4)) % 4;
  chunks.push(pBuf); if (pad) chunks.push(Buffer.alloc(pad));
  const posOffset = byteOffset; byteOffset += pBuf.length + pad;

  const nBuf = Buffer.from(nr.buffer);
  pad = (4 - (nBuf.length % 4)) % 4;
  chunks.push(nBuf); if (pad) chunks.push(Buffer.alloc(pad));
  const nrmOffset = byteOffset; byteOffset += nBuf.length + pad;

  groups.push({ name, vertexCount: n, posOffset, nrmOffset });
}

const routeLen = (pts) => {
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i-2], pts[i+1] - pts[i-1]);
  return L;
};
const joinedCarRoutes = joinRoutes(carRoutes).filter((r) => routeLen(r.pts) > 60);
const joinedWalkRoutes = joinRoutes(walkRoutes).filter((r) => routeLen(r.pts) > 45);

const bin = Buffer.concat(chunks);
writeFileSync(new URL('../public/scene.bin', import.meta.url), bin);
writeFileSync(new URL('../public/scene.json', import.meta.url), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  place: cfg.placeName, centre: { lat: cfg.lat, lon: cfg.lon }, radius: R,
  posScale: POS_SCALE, baseDepth: BASE_DEPTH, groups,
  trees: treeInstances,
  carRoutes: joinedCarRoutes, walkRoutes: joinedWalkRoutes, playSpots,
  yardY: YARD_Y,
}, null, 1));

const tris = Object.values(G).reduce((a, m) => a + m.triangleCount, 0);
console.log(`Groups: ${groups.length}  merged triangles: ${tris.toLocaleString()}  scene.bin: ${(bin.length / 1024).toFixed(1)} KB`);
console.log(`Tree instances: ${treeInstances.length}`);
console.log(`Routes: ${joinedCarRoutes.length} car (from ${carRoutes.length}), `
  + `${joinedWalkRoutes.length} walking (from ${walkRoutes.length}); ${playSpots.length} play spots`);
console.log('Buildings:', stats);
