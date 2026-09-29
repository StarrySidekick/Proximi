/* Cut the fantasy map's lettering into MapLibre glyph files.
 *
 * Map labels are drawn on the GPU, so they do not use the browser's fonts.
 * Each character is pre-rendered as a signed distance field (every pixel
 * holds its distance from the letter's edge, which is what keeps text crisp
 * at any size and angle, and what the label halo is drawn from), and the
 * fields are packed into one protobuf file per block of 256 characters.
 * This writes those files for IM Fell English (OFL), a revival of type cut
 * in the 1670s: small capitals for towns, italic for water, roman for roads.
 *
 *   npm install --no-save fontnik@0.7.7
 *   node scripts/fonts.js path/to/IMFeENsc28P.ttf path/to/IMFeENit28P.ttf path/to/IMFeENrm28P.ttf
 *
 * Blocks 0 to 8447 cover Latin with its accents, Greek, and typographic
 * punctuation (curly quotes, dashes); that is every place name in the data.
 */

const fs = require('fs');
const path = require('path');
const fontnik = require('fontnik');

const OUT = path.join(__dirname, '..', 'assets', 'fonts');
const NAMES = { sc: 'FellSC', it: 'FellItalic', rm: 'FellRoman' };
const LAST = 8447;

(async () => {
  for (const file of process.argv.slice(2)) {
    const key = (file.match(/IMFeEN(sc|it|rm)/) || [])[1];
    if (!key) { console.error(`not an IM Fell English file: ${file}`); process.exit(1); }
    const dir = path.join(OUT, NAMES[key]);
    fs.mkdirSync(dir, { recursive: true });
    const font = fs.readFileSync(file);
    for (let start = 0; start <= LAST; start += 256) {
      const end = start + 255;
      const pbf = await new Promise((ok, no) =>
        fontnik.range({ font, start, end }, (err, data) => (err ? no(err) : ok(data))));
      fs.writeFileSync(path.join(dir, `${start}-${end}.pbf`), pbf);
    }
    console.log(`${NAMES[key]}: ${(LAST + 1) / 256} blocks`);
  }
})();
