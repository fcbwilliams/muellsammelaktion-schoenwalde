import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { loadScene } from './scene-loader.js';
import { createComposite, fullscreenPass } from './outline.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { buildTrees } from './trees.js';
import { createAgents } from './agents.js';

const DEG = Math.PI / 180;

/** Groups that cast shadows; everything else only receives them. */
const CASTERS = new Set(['wall', 'roof', 'schoolWall', 'schoolRoof', 'treeTrunk', 'treeLeaf']);

/** Picks a rendering tier once, from what the device actually reports. */
function detectTier() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 8;
  const mem = navigator.deviceMemory || 8;
  const low = cores <= 4 || mem <= 4;
  return {
    coarse,
    low,
    maxDpr: low ? 1.2 : coarse ? 1.5 : 1.75,
    maxPixels: low ? 0.9e6 : coarse ? 1.5e6 : 2.6e6,
    shadows: !low,
    shadowSize: coarse ? 2048 : 3072,
  };
}

export class Diorama {
  constructor(canvas) {
    this.canvas = canvas;
    this.tier = detectTier();
    this.clock = new THREE.Clock();
    this.azimuth = -34 * DEG;
    this.spin = 0;               // drag velocity, in rad/s
    this.dragging = false;
    this.running = false;
    this.needsRender = true;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.autoSpeed = (2 * Math.PI) / 95;   // one revolution every ~95 s

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.info.autoReset = false;   // accumulate across all three passes
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (this.tier.shadows) {
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = THREE.PCFShadowMap;
      // The model never moves and the sun is fixed, so the shadow map is valid
      // for the whole session: render it once instead of every frame.
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.shadowMap.needsUpdate = true;
    }

    this.scene = new THREE.Scene();
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.camera = new THREE.PerspectiveCamera(30, 1, 40, 1400);

    this.normalMaterial = new THREE.MeshNormalMaterial();
    this.gradientMap = makeToonRamp();

    this.rtColor = null;
    this.rtNormal = null;
    this.rtPost = null;
    this.composite = createComposite();
    // The ink outlines are drawn per-pixel by the composite, so multisampling
    // the scene cannot smooth them - they only exist after that pass. FXAA
    // runs on the finished image instead, so geometry edges and outlines are
    // both anti-aliased for the cost of one extra full-screen pass.
    this.fxaa = fullscreenPass(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms),
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: FXAAShader.fragmentShader,
      depthTest: false, depthWrite: false,
    }));

    this.#lights();
    this.#bindEvents();
  }

  #lights() {
    const sun = new THREE.DirectionalLight(0xfff4de, 2.6);
    sun.position.set(-150, 260, 130);
    if (this.tier.shadows) {
      sun.castShadow = true;
      const s = sun.shadow;
      s.mapSize.set(this.tier.shadowSize, this.tier.shadowSize);
      // Tight frustum: every wasted metre of coverage is lost shadow texels,
      // and coarse texels on a large flat wall are exactly what reads as
      // blocky dark squares.
      s.camera.left = -215; s.camera.right = 215;
      s.camera.top = 215; s.camera.bottom = -215;
      s.camera.near = 60; s.camera.far = 640;
      s.bias = -0.0004;
      s.normalBias = 0.22;
    }
    this.scene.add(sun, sun.target);
    this.scene.add(new THREE.HemisphereLight(0xdaf0ff, 0x6f8a55, 1.05));
    this.sun = sun;
  }

  async load(manifestUrl, binUrl) {
    const { manifest, geometries } = await loadScene(manifestUrl, binUrl);
    this.manifest = manifest;
    this.root.scale.setScalar(manifest.posScale);   // quantised units -> metres

    for (const [name, geo] of Object.entries(geometries)) {
      const colour = PALETTE[name];
      if (colour === undefined) continue;
      const material = new THREE.MeshToonMaterial({ color: colour, gradientMap: this.gradientMap });
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = this.tier.shadows && CASTERS.has(name);
      mesh.receiveShadow = this.tier.shadows && name !== 'baseSide';
      mesh.frustumCulled = false;   // one merged mesh per group; always on screen
      this.root.add(mesh);
    }

    // Trees are authored in metres and live outside `root`, which carries the
    // quantised-units-to-metres scale for the merged geometry.
    if (manifest.trees?.length) {
      this.trees = buildTrees(manifest.trees, this.gradientMap, this.tier.shadows);
      for (const m of this.trees) this.scene.add(m);
    }

    this.agents = createAgents(manifest, this.gradientMap);
    for (const m of this.agents.meshes) this.scene.add(m);

    this.radius = manifest.radius;
    this.resize();
    return this;
  }

  /** Frames the diorama for the current viewport and biases it upward on phones. */
  #frame() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    const portrait = h > w;
    this.camera.aspect = w / h;

    const vFov = this.camera.fov * DEG;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const fit = (this.radius * 1.06) / Math.sin(Math.min(vFov, hFov) / 2);
    // Portrait is width-starved: fitting the whole disc would leave a thin
    // sliver, so we pull in and let the plinth bleed off both sides.
    const distance = fit * (portrait ? 0.70 : 0.86);

    this.distance = distance;
    this.elevation = portrait ? 36 * DEG : 30 * DEG;
    this.targetY = portrait ? 0 : this.radius * 0.05;
    this.#place();

    // Shifting the frustum window is how the model is lifted clear of the copy
    // on phones: unlike aiming the camera off-centre it moves the image without
    // skewing the perspective.
    // Portrait: sit the model at roughly the vertical centre, between the
    // headline above and the actions below.
    if (portrait) this.camera.setViewOffset(w, h, 0, Math.round(h * 0.02), w, h);
    else this.camera.clearViewOffset();

    // Near/far track the framing. A tight range is what gives the depth-based
    // outline pass enough precision to find edges on distant roofs.
    this.camera.near = Math.max(1, distance - this.radius * 2.4);
    this.camera.far = distance + this.radius * 2.6;
    this.camera.updateProjectionMatrix();
  }

  /** Positions the orbiting camera for the current azimuth. */
  #place() {
    const d = this.distance, e = this.elevation, a = this.azimuth;
    const horiz = Math.cos(e) * d;
    this.camera.position.set(Math.sin(a) * horiz, Math.sin(e) * d, Math.cos(a) * horiz);
    this.camera.lookAt(0, this.targetY, 0);
  }

  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    let dpr = Math.min(window.devicePixelRatio || 1, this.tier.maxDpr);
    // Hard pixel ceiling so a high-density phone cannot blow the fill budget.
    const scale = Math.sqrt(this.tier.maxPixels / (w * h * dpr * dpr));
    if (scale < 1) dpr *= scale;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);

    const pw = Math.max(2, Math.round(w * dpr));
    const ph = Math.max(2, Math.round(h * dpr));

    this.rtColor?.dispose();
    this.rtNormal?.dispose();
    this.rtPost?.dispose();
    const samples = (!this.tier.low && !this.tier.coarse && pw * ph <= 1.7e6) ? 4 : 0;
    this.rtColor = new THREE.WebGLRenderTarget(pw, ph, {
      samples, type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
    });
    const depth = new THREE.DepthTexture(pw, ph);
    depth.type = THREE.UnsignedIntType;
    this.rtNormal = new THREE.WebGLRenderTarget(pw, ph, {
      depthTexture: depth, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    this.rtPost = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
    });
    this.fxaa.material.uniforms.tDiffuse.value = this.rtPost.texture;
    this.fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);

    this.#frame();

    const u = this.composite.material.uniforms;
    u.tColor.value = this.rtColor.texture;
    u.tNormal.value = this.rtNormal.texture;
    u.tDepth.value = depth;
    u.texel.value.set(1 / pw, 1 / ph);
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;

    this.needsRender = true;
  }

  #bindEvents() {
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop(); else this.start();
    });

    // Drag-to-spin on pointing devices only: on touch the canvas is a
    // background and must never compete with page scrolling.
    if (!matchMedia('(pointer: coarse)').matches) {
      let lastX = 0;
      this.canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') return;
        this.dragging = true; lastX = e.clientX;
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = 'grabbing';
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (!this.dragging) return;
        const dx = e.clientX - lastX; lastX = e.clientX;
        this.azimuth += dx * 0.006;
        this.spin = dx * 0.12;
        this.needsRender = true;
      });
      const end = () => { this.dragging = false; this.canvas.style.cursor = 'grab'; };
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
      this.canvas.style.cursor = 'grab';
    }
  }

  #renderFrame() {
    const r = this.renderer;
    r.info.reset();
    r.setRenderTarget(this.rtNormal);
    r.setClearColor(0x7f7fff, 1);
    this.scene.overrideMaterial = this.normalMaterial;
    r.clear();
    r.render(this.scene, this.camera);

    this.scene.overrideMaterial = null;
    r.setRenderTarget(this.rtColor);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.camera);

    r.setRenderTarget(this.rtPost);
    r.render(this.composite.scene, this.composite.camera);

    r.setRenderTarget(null);
    r.render(this.fxaa.scene, this.fxaa.camera);
  }

  #tick = () => {
    if (!this.running) return;
    this.frameHandle = requestAnimationFrame(this.#tick);
    const dt = Math.min(this.clock.getDelta(), 0.1);

    if (!this.reduced) {
      // Traffic and volunteers keep moving even while the model is being
      // dragged; only the automatic turntable pauses.
      this.agents?.update(dt);
      this.needsRender = true;
    }
    if (!this.reduced && !this.dragging) {
      this.azimuth += (this.autoSpeed + this.spin) * dt;
      this.spin *= Math.exp(-3 * dt);        // let a flick decay smoothly
      if (Math.abs(this.spin) < 1e-4) this.spin = 0;
      this.needsRender = true;
    }
    if (this.needsRender || this.dragging) {
      this.#place();
      this.#renderFrame();
      this.needsRender = false;
      if (this.onFrame) this.onFrame(performance.now());
    }
  };

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.getDelta();
    this.needsRender = true;
    this.frameHandle = requestAnimationFrame(this.#tick);
  }

  stop() {
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
  }
}

/** Four-band ramp: the hard steps are what read as cel shading. */
function makeToonRamp() {
  const data = new Uint8Array([88, 150, 205, 255]);
  const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
