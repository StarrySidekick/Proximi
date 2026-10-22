/* Draw the home-screen and tab icons from assets/icon.svg.
 *
 * An iPhone takes no SVG for its home screen: it reads the PNG named by
 * <link rel="apple-touch-icon">, and a page without one is saved with an
 * icon made up for it (a shrunken screenshot, or a letter). Android installs
 * most reliably from PNG manifest icons at 192 and 512 and a maskable one.
 * So the art stays one SVG, and this draws it, in headless Chromium, into
 * the PNGs that index.html, drive.html and manifest.webmanifest name:
 *
 *   icon-32.png            the browser tab
 *   icon-180.png           an iPhone's home screen. Square and opaque: iOS
 *                          rounds the corners itself and paints anything
 *                          transparent black, so the parchment fills them.
 *   icon-192.png, -512     Android and desktop installs, the art as drawn
 *   icon-maskable-512.png  Android's own shapes (circle, squircle and the
 *                          rest). The parchment runs to the edges and the
 *                          tile's rounded corners and frame are left out,
 *                          because there the phone's mask is the tile's edge;
 *                          a frame cut by a circle reads as a stray square.
 *
 * It refuses to write anything if the pin leaves the middle 80% circle,
 * which is all a maskable icon is promised to keep.
 *
 *   node scripts/icons.js       # again after any change to assets/icon.svg
 */

const fs = require('fs');
const path = require('path');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const exe = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const ASSETS = path.join(__dirname, '..', 'assets');
const ART = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8');

// plain: the art as drawn. opaque: on parchment to the corners. maskable:
// on parchment to the edges, without the tile's corners and frame.
const ICONS = [
  { file: 'icon-32.png', size: 32, mode: 'plain' },
  { file: 'icon-180.png', size: 180, mode: 'opaque' },
  { file: 'icon-192.png', size: 192, mode: 'plain' },
  { file: 'icon-512.png', size: 512, mode: 'plain' },
  { file: 'icon-maskable-512.png', size: 512, mode: 'maskable' },
];

// Drawn in the page. The tile is every rect spanning (nearly) the whole
// viewBox: the parchment square and its frame. Its fill is the parchment,
// read from the art so the two can never drift apart.
async function draw({ svg, size, mode }) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  const across = root.viewBox.baseVal.width;
  const tile = [...root.querySelectorAll('rect')]
    .filter((r) => r.width.baseVal.value >= 0.9 * across);
  const parchment = tile.map((r) => r.getAttribute('fill')).find((f) => f && f !== 'none');
  if (!parchment) throw new Error('no parchment tile found in the art');
  if (mode === 'maskable') tile.forEach((r) => r.remove());
  // Sized to the picture, so the vector is drawn at this size, not scaled.
  root.setAttribute('width', size);
  root.setAttribute('height', size);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,'
    + encodeURIComponent(new XMLSerializer().serializeToString(doc));
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  if (mode !== 'plain') { g.fillStyle = parchment; g.fillRect(0, 0, size, size); }
  g.drawImage(img, 0, 0, size, size);

  // How far from the middle anything not parchment reaches, as a share of
  // the width. Only the maskable one is measured: it has nothing else on it.
  let reach = null;
  if (mode === 'maskable') {
    const px = g.getImageData(0, 0, size, size).data;
    const bg = [1, 3, 5].map((i) => parseInt(parchment.slice(i, i + 2), 16));
    let far = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const off = Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
        if (off > 24) far = Math.max(far, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
      }
    }
    reach = far / size;
  }
  return { png: cv.toDataURL('image/png'), reach };
}

(async () => {
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage();
  const out = [];
  for (const icon of ICONS) {
    const { png, reach } = await page.evaluate(draw, { svg: ART, size: icon.size, mode: icon.mode });
    if (reach !== null) {
      const pct = (reach * 100).toFixed(1);
      if (reach > 0.4) {
        console.error(`${icon.file}: the pin reaches ${pct}% of the width from the middle; a maskable icon keeps only 40%. Nothing written.`);
        await browser.close();
        process.exit(1);
      }
      console.log(`${icon.file}: the pin reaches ${pct}% of the width from the middle (40% is kept by every mask)`);
    }
    out.push([icon.file, Buffer.from(png.split(',')[1], 'base64')]);
  }
  await browser.close();
  for (const [file, bytes] of out) {
    fs.writeFileSync(path.join(ASSETS, file), bytes);
    console.log(`assets/${file}  ${bytes.length} bytes`);
  }
})();
