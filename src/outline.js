import * as THREE from 'three';
import { SKY_TOP, SKY_BOTTOM, INK } from './palette.js';

/**
 * Full-screen composite: paints the sky gradient behind the render, then lays
 * ink outlines on top wherever depth or view-space normals break. Doing the
 * outline in screen space costs one quad instead of a duplicated hull mesh per
 * building, which is what keeps the draw-call count in single digits.
 */
export function createComposite() {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tColor:   { value: null },
      tNormal:  { value: null },
      tDepth:   { value: null },
      texel:    { value: new THREE.Vector2() },
      cameraNear: { value: 1 },
      cameraFar:  { value: 1000 },
      skyTop:    { value: new THREE.Vector3(...SKY_TOP) },
      skyBottom: { value: new THREE.Vector3(...SKY_BOTTOM) },
      ink:       { value: new THREE.Vector3(...INK) },
      edgeStrength:    { value: 0.85 },
      depthSensitivity:  { value: 12.0 },
      normalSensitivity: { value: 1.1 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      #include <packing>
      varying vec2 vUv;
      uniform sampler2D tColor, tNormal, tDepth;
      uniform vec2 texel;
      uniform float cameraNear, cameraFar;
      uniform vec3 skyTop, skyBottom, ink;
      uniform float edgeStrength, depthSensitivity, normalSensitivity;

      float linearDepth(vec2 uv) {
        float z = texture2D(tDepth, uv).x;
        float viewZ = perspectiveDepthToViewZ(z, cameraNear, cameraFar);
        return viewZToOrthographicDepth(viewZ, cameraNear, cameraFar);
      }

      void main() {
        vec2 o = texel;
        float d0 = linearDepth(vUv);
        float dL = linearDepth(vUv - vec2(o.x, 0.0));
        float dR = linearDepth(vUv + vec2(o.x, 0.0));
        float dD = linearDepth(vUv - vec2(0.0, o.y));
        float dU = linearDepth(vUv + vec2(0.0, o.y));

        // Scale the depth threshold with distance so far-off roofs keep their
        // outline without the near ground turning into noise.
        float span = max(max(abs(d0 - dL), abs(d0 - dR)), max(abs(d0 - dD), abs(d0 - dU)));
        float depthEdge = smoothstep(0.0, 1.0, span * depthSensitivity / max(d0, 0.02));

        vec3 n0 = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
        vec3 nL = texture2D(tNormal, vUv - vec2(o.x, 0.0)).xyz * 2.0 - 1.0;
        vec3 nR = texture2D(tNormal, vUv + vec2(o.x, 0.0)).xyz * 2.0 - 1.0;
        vec3 nD = texture2D(tNormal, vUv - vec2(0.0, o.y)).xyz * 2.0 - 1.0;
        vec3 nU = texture2D(tNormal, vUv + vec2(0.0, o.y)).xyz * 2.0 - 1.0;
        float nd = max(max(1.0 - dot(n0, nL), 1.0 - dot(n0, nR)),
                       max(1.0 - dot(n0, nD), 1.0 - dot(n0, nU)));
        // Creases only count where the surface is actually there.
        float normalEdge = smoothstep(0.25, 0.9, nd * normalSensitivity) * step(d0, 0.999);

        float edge = clamp(max(depthEdge, normalEdge), 0.0, 1.0) * edgeStrength;

        vec4 scene = texture2D(tColor, vUv);
        vec3 sky = mix(skyBottom, skyTop, smoothstep(0.0, 1.0, vUv.y));
        vec3 base = mix(sky, scene.rgb, scene.a);
        gl_FragColor = vec4(mix(base, ink, edge), 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

  // Single full-screen triangle: cheaper than a quad and avoids the diagonal seam.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));

  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return { scene, camera, material };
}
