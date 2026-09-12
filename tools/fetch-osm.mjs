// Fetches raw OpenStreetMap data around the configured centre point via Overpass.
// Cached to data/osm-raw.json so the site build never hits the network.
import { readFileSync, writeFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const { lat, lon, radiusMetres: r } = cfg;

const around = `(around:${r},${lat},${lon})`;
const query = `
[out:json][timeout:90];
(
  way["building"]${around};
  relation["building"]${around};
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path|cycleway|track)$"]${around};
  way["natural"="water"]${around};
  relation["natural"="water"]${around};
  way["waterway"~"^(river|stream|canal)$"]${around};
  way["leisure"~"^(park|pitch|garden|playground|recreation_ground|sports_centre|track)$"]${around};
  way["landuse"~"^(grass|forest|meadow|recreation_ground|allotments|cemetery|village_green|farmland)$"]${around};
  way["natural"~"^(wood|scrub|grassland|heath)$"]${around};
  way["amenity"="school"]${around};
  node["natural"="tree"]${around};
);
out body geom;
`;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

let data = null;
for (const url of ENDPOINTS) {
  try {
    process.stdout.write(`Querying ${url} ... `);
    const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'litter-pick-site/1.0 (static site build script)',
        'Accept': 'application/json',
      } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    console.log(`ok (${data.elements.length} elements)`);
    break;
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
}
if (!data) { console.error('All Overpass endpoints failed.'); process.exit(1); }

writeFileSync(new URL('../data/osm-raw.json', import.meta.url), JSON.stringify(data));
const counts = {};
for (const el of data.elements) {
  const t = el.tags || {};
  const k = t.building ? 'building' : t.highway ? 'highway' : (t.natural === 'water' || t.waterway) ? 'water'
    : (t.leisure || t.landuse || t.natural) ? 'green' : t.amenity === 'school' ? 'school' : 'other';
  counts[k] = (counts[k] || 0) + 1;
}
console.log('Breakdown:', counts);
