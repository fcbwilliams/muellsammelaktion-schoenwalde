// Generates the QR code for the live site, then decodes its own output to
// prove the image actually scans rather than merely looking like a QR code.
import QRCode from 'qrcode';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

const URL_TARGET = 'https://fcbwilliams.github.io/muellsammelaktion-schoenwalde/';
const out = fileURLToPath(new URL('../qr/', import.meta.url));

// Level Q survives a fair amount of print wear and still scans off a poster.
const opts = { errorCorrectionLevel: 'Q', margin: 2, color: { dark: '#1b2820ff', light: '#ffffffff' } };

await QRCode.toFile(join(out, 'website.png'), URL_TARGET, { ...opts, type: 'png', width: 1600 });
writeFileSync(join(out, 'website.svg'), await QRCode.toString(URL_TARGET, { ...opts, type: 'svg' }));

// Round-trip check.
const png = PNG.sync.read(readFileSync(join(out, 'website.png')));
const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
if (!decoded) throw new Error('generated QR code could not be decoded');
if (decoded.data !== URL_TARGET) throw new Error(`decoded to ${decoded.data}`);
console.log(`qr/website.png  ${png.width}x${png.height}`);
console.log(`qr/website.svg`);
console.log(`decoded back to: ${decoded.data}  ✓`);
