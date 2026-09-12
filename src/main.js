import { Diorama } from './diorama.js';

const canvas = document.getElementById('scene');

/** WebGL2 is required for the depth-texture outline pass. */
function webglSupported() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch { return false; }
}

async function boot() {
  if (!webglSupported()) return;          // the CSS fallback stays visible

  const diorama = new Diorama(canvas);
  try {
    // Vite copies public/ to the site root; BASE_URL keeps this correct on a
    // GitHub Pages project subpath.
    const base = import.meta.env.BASE_URL;
    await diorama.load(base + 'scene.json', base + 'scene.bin');
  } catch (err) {
    console.warn('Diorama konnte nicht geladen werden:', err);
    return;
  }

  document.body.classList.add('scene-ready');
  diorama.start();

  // Once the content sheet has covered the viewport there is nothing to see,
  // so stop rendering entirely rather than spinning the GPU behind opaque copy.
  const hero = document.querySelector('.hero');
  if (hero && 'IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) diorama.start(); else diorama.stop();
    }, { threshold: 0 }).observe(hero);
  }

  if (new URLSearchParams(location.search).has('diag')) diagnose(diorama);

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); diorama.stop(); });
  canvas.addEventListener('webglcontextrestored', () => diorama.start());
}

boot();


/**
 * ?diag - measures real frame times and reports the GPU string. Useful because
 * a browser silently falling back to software rendering looks exactly like a
 * badly written renderer from the outside.
 */
function diagnose(diorama) {
  const gl = diorama.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const info = {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    dpr: window.devicePixelRatio,
    drawing: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
    viewport: `${innerWidth}x${innerHeight}`,
    tier: JSON.stringify(diorama.tier),
  };

  const times = [];
  let last = 0;
  diorama.onFrame = (t) => {
    if (last) times.push(t - last);
    last = t;
    if (times.length !== 160) return;
    diorama.onFrame = null;
    const sorted = times.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const r = diorama.renderer.info.render;
    const result = { ...info, calls: r.calls, tris: r.triangles, medianMs: +median.toFixed(2), p95Ms: +p95.toFixed(2), fps: +(1000 / median).toFixed(1) };

    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;z-index:99;top:0;left:0;margin:0;padding:8px 10px;background:#111;color:#0f0;font:11px/1.5 monospace;max-width:100vw;white-space:pre-wrap';
    box.textContent = Object.entries(result).map(([k, v]) => `${k}: ${v}`).join('\n');
    document.body.appendChild(box);

    // Watch the traffic for a while, then report what the rules produced.
    const seen = { spawns: [], minGap: Infinity, maxS: 0, everActive: 0 };
    const prev = new Map();
    const tick = setInterval(() => {
      const st = diorama.agents.stats();
      seen.routeLen = st.routeLen; seen.speed = st.speed; seen.gap = st.gap;
      let active = 0;
      st.cars.forEach((c, i) => {
        const was = prev.get(i);
        if (c.a && (!was || !was.a)) seen.spawns.push(c.s);      // where it appeared
        if (c.a) { active++; seen.maxS = Math.max(seen.maxS, c.s); }
        prev.set(i, { ...c });
      });
      seen.everActive = Math.max(seen.everActive, active);
      for (let i = 0; i < st.cars.length; i++) {
        for (let j = i + 1; j < st.cars.length; j++) {
          const A = st.cars[i], B = st.cars[j];
          if (!A.a || !B.a || A.d !== B.d) continue;            // opposing traffic is in the other lane
          seen.minGap = Math.min(seen.minGap, Math.abs(A.s - B.s));
        }
      }
    }, 250);
    setTimeout(() => {
      clearInterval(tick);
      const payload = { ...result, traffic: JSON.stringify({
        routeLen: seen.routeLen, speed: seen.speed, requiredGap: seen.gap,
        spawnPositions: seen.spawns.slice(0, 12),
        minSameDirGap: seen.minGap === Infinity ? null : +seen.minGap.toFixed(1),
        maxActiveAtOnce: seen.everActive,
      })};
      fetch('http://localhost:8900/report?d=' + encodeURIComponent(JSON.stringify(payload)), { mode: 'no-cors' }).catch(() => {});
    }, 32000);
  };
}
