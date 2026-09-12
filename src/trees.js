import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { flat, merge } from './geo-utils.js';

/**
 * Trees are instanced: one geometry per species, drawn once for every copy.
 * Trunk and canopy are merged and told apart by vertex colour, so a whole
 * species costs a single draw call rather than one per part.
 */

/** Broadleaf: short trunk under a faceted, slightly squashed crown. */
function broadleafGeometry() {
  const trunkH = 2.4;
  const trunk = flat(new THREE.CylinderGeometry(0.2, 0.32, trunkH, 5, 1, true));
  trunk.translate(0, trunkH / 2, 0);
  const crown = flat(new THREE.IcosahedronGeometry(2.7, 0));
  crown.scale(1, 0.88, 1);
  crown.translate(0, trunkH + 2.2, 0);
  return merge([[trunk, PALETTE.treeTrunk], [crown, PALETTE.treeLeaf]]);
}

/** Conifer: the bare-trunked pines that dominate this part of Brandenburg. */
function coniferGeometry() {
  const trunkH = 3.6;
  const trunk = flat(new THREE.CylinderGeometry(0.16, 0.28, trunkH, 5, 1, true));
  trunk.translate(0, trunkH / 2, 0);
  const parts = [[trunk, PALETTE.treeTrunk]];
  const tiers = [[2.3, 3.2, 0.0], [1.8, 2.8, 2.1], [1.2, 2.4, 4.0]];
  for (const [r, hh, y] of tiers) {
    const cone = flat(new THREE.ConeGeometry(r, hh, 6));
    cone.translate(0, trunkH + y + hh / 2, 0);
    parts.push([cone, PALETTE.treeLeaf]);
  }
  return merge(parts);
}

/**
 * Builds the instanced meshes. `trees` is [x, z, scale, rotY, isConifer].
 */
export function buildTrees(trees, gradientMap, castShadow) {
  const groups = [[], []];
  for (const t of trees) groups[t[4] ? 1 : 0].push(t);

  const meshes = [];
  const geoms = [broadleafGeometry(), coniferGeometry()];
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  for (let kind = 0; kind < 2; kind++) {
    const list = groups[kind];
    if (!list.length) continue;
    const material = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap });
    const mesh = new THREE.InstancedMesh(geoms[kind], material, list.length);
    for (let i = 0; i < list.length; i++) {
      const [x, z, scale, rot] = list[i];
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, rot, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // A little per-tree variation stops the wood reading as wallpaper.
      const h = (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      const v = 0.88 + Math.abs(h) * 0.26;
      tint.setRGB(v * 0.97, v, v * 0.93);
      mesh.setColorAt(i, tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }
  return meshes;
}
