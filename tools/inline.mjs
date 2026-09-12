// Bundles the built site into one self-contained .html file: no server, no
// sidecar assets, works from a file:// URL or any static host.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname: the project path contains a space, which stays
// percent-encoded in a URL and breaks every fs call.
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const assets = join(dist, 'assets');
const files = readdirSync(assets);
const js = files.find((f) => f.endsWith('.js'));
const css = files.find((f) => f.endsWith('.css'));

let html = readFileSync(join(dist, 'index.html'), 'utf8');
const script = readFileSync(join(assets, js), 'utf8');
const style = readFileSync(join(assets, css), 'utf8');
const manifest = readFileSync(join(dist, 'scene.json'), 'utf8');
const bin = readFileSync(join(dist, 'scene.bin')).toString('base64');

// Function replacers, not string ones: `$&` and `$'` inside a bundle are
// treated as substitution patterns by String.replace and would splice the rest
// of the document back into the output.
html = html.replace(/<link rel="stylesheet"[^>]*>/, () => `<style>\n${style}\n</style>`);
html = html.replace(/<script type="module"[^>]*><\/script>/, () =>
  `<script>window.__DIORAMA__={manifest:${manifest},bin:"${bin}"};</script>\n`
  + `<script type="module">\n${script}\n</script>`);
if (/<script[^>]*\ssrc=/.test(html)) throw new Error('an external script survived inlining');

const out = join(dist, 'muellsammelaktion.html');
writeFileSync(out, html);
console.log(`Single file: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB -> dist/muellsammelaktion.html`);
