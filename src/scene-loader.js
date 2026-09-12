import * as THREE from 'three';

/**
 * Loads the compiled diorama. Positions are Int16 in units of `posScale` metres
 * and normals are Int8; both go to the GPU without any CPU-side conversion,
 * which is why the payload stays small and parsing is effectively free.
 */
export async function loadScene(manifestUrl, binUrl) {
  let manifest, buffer;
  const embedded = globalThis.__DIORAMA__;
  if (embedded) {
    // Single-file build: the scene travels inside the HTML, so the page works
    // straight off the filesystem where fetch() would be blocked.
    manifest = embedded.manifest;
    const raw = atob(embedded.bin);
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    buffer = u8.buffer;
  } else {
    [manifest, buffer] = await Promise.all([
      fetch(manifestUrl).then((r) => { if (!r.ok) throw new Error(`scene.json: ${r.status}`); return r.json(); }),
      fetch(binUrl).then((r) => { if (!r.ok) throw new Error(`scene.bin: ${r.status}`); return r.arrayBuffer(); }),
    ]);
  }

  const geometries = {};
  for (const g of manifest.groups) {
    const pos = new Int16Array(buffer, g.posOffset, g.vertexCount * 3);
    const nrm = new Int8Array(buffer, g.nrmOffset, g.vertexCount * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3, false));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
    geometries[g.name] = geo;
  }
  return { manifest, geometries };
}
