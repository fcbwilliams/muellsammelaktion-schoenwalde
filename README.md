# Müllsammelaktion Schönwalde

Static one-page site for a litter-picking event at the Grundschule
Menschenskinder, Sachsenweg 24, Schönwalde-Glien. The centrepiece is a
cel-shaded 3D diorama of the school and its surroundings, built from
OpenStreetMap data and rendered with three.js.

## Commands

    npm install
    npm run dev            # local dev server with hot reload
    npm run build          # static site  -> dist/
    npm run build:single   # ONE html file -> dist/muellsammelaktion.html
    npm run osm            # re-fetch OSM data and recompile the scene

`npm run build` output is plain static files: upload `dist/` to GitHub Pages.
`build:single` additionally produces a single self-contained HTML file that
also works when opened directly from disk.

## How the diorama is made

1. `tools/fetch-osm.mjs` pulls buildings, roads and land cover around the
   school from Overpass into `data/osm-raw.json`.
2. `tools/build-scene.mjs` projects to local metres, extrudes footprints
   (gabled, flat or fan roofs), builds road ribbons with mitred joins, and
   writes quantised Int16/Int8 geometry to `public/scene.bin` (~67 KB).
3. `tools/extract-trees.py` derives tree positions from aerial photographs:
   vegetation is segmented on G−R so a screenshot's colour cast does not
   matter, then rejected against buildings, roads and sports pitches.
4. The browser renders with toon materials plus a screen-space depth+normal
   outline pass. Trees and people are GPU-instanced.

Building heights are estimated — no building in this extract carries height
tags. Per-building corrections live in `config.json` under `buildingOverrides`.

Map data © OpenStreetMap contributors, ODbL.
