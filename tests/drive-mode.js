/* Drives the Drive page (drive.html) in headless Chromium, the way
 * tests/drive.js drives the list. The page talks to live services (OSRM
 * for routes and detour times, Nominatim for addresses, Wikipedia for
 * pictures, OpenFreeMap for the map), so all of them are answered here: CI must not fail because a public server is slow,
 * and a fixed answer makes the assertions exact. The places and events are
 * the real data files.
 *
 *   node tests/drive-mode.js            # starts its own server on :8919
 *   BASE_URL=http://... node tests/drive-mode.js
 */

const fs = require('fs');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const exe = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

// Route 9D, Beacon to Garrison: nine miles of Hudson Valley with a garden,
// a historic house and a lookout or two just off it.
const BEACON = { lat: 41.5048, lon: -73.9696 };
const GARRISON = { lat: 41.3812, lon: -73.9457 };
const PLACES = { 'beacon, ny': BEACON, 'garrison, ny': GARRISON };

function miles(a, b) {
  const R = 3958.8, r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A road that is the straight line, in forty steps.
function line(a, b, n = 40) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    out.push([a.lon + (b.lon - a.lon) * i / n, a.lat + (b.lat - a.lat) * i / n]);
  }
  return out;
}

// Drive time on the fake roads: 30% longer than the crow flies, at 30 mph.
const seconds = (a, b) => miles(a, b) * 1.3 / 30 * 3600;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const CORS = { 'access-control-allow-origin': '*' };

// Wikipedia answers for every place by name, at the place's own coordinates,
// so photo matching is exercised end to end. Farms get no article, which is
// the common case in real life and the one the fallback card is for.
const PLACE_BY_NAME = new Map(JSON.parse(fs.readFileSync(__dirname + '/../data/places.json', 'utf8'))
  .items.map((p) => [p.name, p]));

// The smallest style MapLibre will draw: a background and nothing else. The
// camera, bearing and markers are what is under test, not the tiles.
const STYLE = { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#eee' } }] };

async function fakeServices(ctx, counts, base) {
  await ctx.route(/openfreemap\.org/, (r) => (/styles\//.test(r.request().url())
    ? r.fulfill({ json: STYLE, headers: CORS }) : r.fulfill({ status: 404, body: '' })));
  // Every picture from anywhere but this server: the places' own sites and
  // Wikipedia's image host alike.
  await ctx.route((u) => !u.href.startsWith(base) && /\.(jpe?g|png|webp|gif)(\?|$)|upload\.wikimedia/i.test(u.href),
    (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await ctx.route(/wikipedia\.org\/w\/api\.php/, (r) => {
    counts.wiki++;
    const name = new URL(r.request().url()).searchParams.get('gsrsearch');
    const p = PLACE_BY_NAME.get(name);
    if (!p || /farm|orchard/i.test(name)) { r.fulfill({ json: { batchcomplete: '' }, headers: CORS }); return; }
    r.fulfill({ json: { query: { pages: { 1: {
      pageid: 1, index: 1, title: name, description: 'A place in a test',
      coordinates: [{ lat: p.lat, lon: p.lon }],
      thumbnail: { source: 'https://upload.wikimedia.org/test/' + encodeURIComponent(name) + '.png' }
    } } } }, headers: CORS });
  });
  await ctx.route(/nominatim\.openstreetmap\.org/, (r) => {
    const q = new URL(r.request().url()).searchParams.get('q').toLowerCase();
    const p = PLACES[q];
    const body = p ? [{
      lat: String(p.lat), lon: String(p.lon), display_name: `${q}, somewhere`,
      name: q.split(',')[0].replace(/^./, (c) => c.toUpperCase()),
      address: { state: 'New York' }
    }] : [];
    r.fulfill({ json: body, headers: CORS });
  });
  await ctx.route(/router\.project-osrm\.org/, (r) => {
    const u = new URL(r.request().url());
    const [, service, , , coordStr] = u.pathname.split('/');   // /route/v1/driving/…
    const pts = coordStr.split(';').map((s) => {
      const [lon, lat] = s.split(',').map(Number);
      return { lat, lon };
    });
    if (service === 'route') {
      counts.route++;
      const [a, b] = pts;
      r.fulfill({ json: { code: 'Ok', routes: [{ duration: seconds(a, b), geometry: { coordinates: line(a, b) } }] }, headers: CORS });
      return;
    }
    counts.table++;
    const src = u.searchParams.get('sources').split(';').map(Number);
    const dst = u.searchParams.get('destinations').split(';').map(Number);
    const durations = src.map((i) => dst.map((j) => seconds(pts[i], pts[j])));
    r.fulfill({ json: { code: 'Ok', durations }, headers: CORS });
  });
}

(async () => {
  let server = null;
  let base = process.env.BASE_URL;
  if (!base) {
    server = spawn('python3', ['-m', 'http.server', '8919'],
      { cwd: __dirname + '/..', stdio: 'ignore' });
    base = 'http://localhost:8919';
    await new Promise((r) => setTimeout(r, 800));
  }

  // MapLibre draws with WebGL; headless Chromium has it only in software.
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--enable-unsafe-swiftshader'] });
  const fail = [];
  const ok = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
    if (!cond) fail.push(name);
  };

  async function newPage({ onboarded = true, ...opts } = {}) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...opts
    });
    const counts = { route: 0, table: 0, wiki: 0 };
    // Most scenarios are about the drive, not the first-run questionnaire,
    // so they start as somebody who has already answered it.
    if (onboarded) {
      await ctx.addInitScript(() => {
        if (!localStorage.getItem('proximi.drive.v1')) {
          localStorage.setItem('proximi.drive.v1', JSON.stringify({ onboarded: true }));
        }
      });
    }
    await fakeServices(ctx, counts, base);
    // There is no voice any more; record any attempt so a test can say so.
    await ctx.addInitScript(() => {
      window.__spoken = [];
      window.speechSynthesis.speak = (u) => window.__spoken.push(u.text);
      window.speechSynthesis.cancel = () => {};
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    return { ctx, page, errors, counts };
  }

  // ── The way in, from the main page ─────────────────────
  {
    const { ctx, page } = await newPage();
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    const href = await page.getAttribute('a.drive-link', 'href');
    ok('main page links to Drive', href === 'drive.html', href);
    await ctx.close();
  }

  // ── Geometry, straight from the page's own functions ───
  {
    const { ctx, page } = await newPage();
    await page.goto(base + '/drive.html', { waitUntil: 'domcontentloaded' });
    const g = await page.evaluate(() => {
      const D = window.__drive;
      // Due north, ten miles, from 41N 74W.
      const r = D.buildRoute([[-74, 41], [-74, 41 + 10 / 69.172]]);
      const at = D.locate(r, { lat: 41 + 5 / 69.172, lon: -74 + 1 / (Math.cos(41 * Math.PI / 180) * 69.172) });
      const mid = D.pointAt(r, 2.5);
      return { len: r.length, along: at.along, off: at.off, midLat: mid.lat };
    });
    ok('route length', Math.abs(g.len - 10) < 0.05, g.len.toFixed(3));
    ok('along the route', Math.abs(g.along - 5) < 0.05, g.along.toFixed(3));
    ok('off the route', Math.abs(g.off - 1) < 0.02, g.off.toFixed(3));
    ok('point at a mileage', Math.abs(g.midLat - (41 + 2.5 / 69.172)) < 1e-4);
    await ctx.close();
  }

  // ── First run: the questionnaire decides the interest score ──
  {
    const { ctx, page, errors } = await newPage({ onboarded: false });
    await page.goto(base + '/drive.html', { waitUntil: 'networkidle' });
    ok('questionnaire opens on first visit', await page.isVisible('#quiz'));
    const rows = await page.locator('#quiz .level-row').count();
    ok('it asks about every interest', rows === 10, `${rows} rows`);
    await page.click('#quiz .level-row[data-interest="history"] [data-level="love"]');
    await page.click('#quiz .level-row[data-interest="browsing"] [data-level="love"]');
    await page.click('#quiz .level-row[data-interest="gardens"] [data-level="skip"]');
    await page.click('#quiz-next');
    await page.click('#quiz .quiz-choice:has(strong:text-is("15 minutes"))');
    await page.click('#quiz-next');
    await page.click('#quiz .quiz-choice:has(strong:text-is("Right"))');
    ok('last page says Done', (await page.textContent('#quiz-next')).trim() === 'Done');
    await page.click('#quiz-next');
    ok('and closes', !(await page.isVisible('#quiz')));

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('proximi.drive.v1')));
    ok('answers are saved', saved.onboarded && saved.levels.history === 'love'
      && saved.levels.gardens === 'skip' && saved.maxDetour === 15
      && saved.mapSide === 'right' && !('voice' in saved) && !('cooldown' in saved), JSON.stringify(saved.levels));
    const w = await page.evaluate(() => {
      const k = window.__drive.kindWeight;
      return { castle: k('castle'), garden: k('garden'), park: k('park'), library: k('library') };
    });
    // Love is 3; a park counts half of its interest; a library under a loved
    // "browsing" still counts for less than a castle.
    ok('answers become weights', w.castle === 3 && w.garden === 0 && w.park === 0.75
      && w.library > 0 && w.library < 1, JSON.stringify(w));
    ok('map moves to the side asked for', await page.getAttribute('#drive-main', 'data-side') === 'right');
    const sides = await page.evaluate(() => [
      document.getElementById('map-slice').getBoundingClientRect().left,
      document.getElementById('deck').getBoundingClientRect().left]);
    ok('and is drawn there', sides[0] > sides[1], JSON.stringify(sides));

    await page.reload({ waitUntil: 'networkidle' });
    ok('not asked twice', !(await page.isVisible('#quiz')));
    await page.click('#open-settings');
    const setRow = await page.getAttribute('#interest-levels .level-row[data-interest="history"] [data-level="love"]', 'aria-checked');
    ok('settings show the same answers', setRow === 'true');
    await page.click('#retake-quiz');
    ok('and can ask again', await page.isVisible('#quiz'));
    ok('no page errors (questionnaire)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ── A simulated drive: the deck, the map, pictures, smoothness ──
  {
    const { ctx, page, errors, counts } = await newPage();
    await page.goto(base + '/drive.html', { waitUntil: 'networkidle' });
    const status = await page.textContent('#drive-status');
    ok('places load', /\d[\d,]* places worth a stop/.test(status), status);
    ok('no voice control', await page.locator('#voice-btn').count() === 0);

    await page.click('#open-settings');
    await page.fill('#sim-from', 'Beacon, NY');
    await page.fill('#sim-to', 'Garrison, NY');
    await page.click('#sim-form button[type=submit]');
    ok('settings close on simulate', !(await page.isVisible('#drive-settings')));
    await page.waitForSelector('#sim-ctl:not([hidden])', { timeout: 20000 }).catch(() => {});
    ok('speed control shows while simulating', await page.isVisible('#sim-ctl'));

    await page.waitForFunction(() => window.__drive.entries.size >= 2, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const deck = await page.evaluate(() => {
      const list = document.getElementById('deck-list').getBoundingClientRect();
      return [...window.__drive.entries.values()].map((e) => {
        const r = e.li.getBoundingClientRect();
        return {
          name: e.c.name, letter: e.letter, ahead: e.ahead, mid: (r.top + r.bottom) / 2 - list.top,
          inView: r.bottom > list.top && r.top < list.bottom, go: e.li.querySelector('.deck-go').href
        };
      });
    });
    const listH = await page.evaluate(() => document.getElementById('deck-list').clientHeight);
    const shown = deck.filter((d) => d.inView);
    ok('two or three places on screen', shown.length >= 2 && shown.length <= 4,
      shown.map((d) => `${d.letter} ${d.name} ${d.ahead.toFixed(1)}mi`).join(' / '));
    const byAhead = deck.slice().sort((a, b) => b.ahead - a.ahead);
    ok('further ahead is higher up', byAhead.every((d, i) => i === 0 || d.mid > byAhead[i - 1].mid));
    const lineY = await page.evaluate(() => {
      const l = document.getElementById('deck-list').getBoundingClientRect();
      return document.getElementById('deck-now').getBoundingClientRect().top - l.top;
    });
    ok('the line is across the middle', Math.abs(lineY - listH / 2) < 3, `${lineY.toFixed(0)} of ${listH}`);
    ok('letters on the map match the cards', await page.evaluate(() =>
      [...document.querySelectorAll('.deck-pin')].map((n) => n.textContent).sort().join('')
      === [...window.__drive.entries.values()].map((e) => e.letter).sort().join('')));
    ok('go keeps the destination', deck.every((d) => d.go.includes('waypoints=')
      && d.go.includes(encodeURIComponent(`${GARRISON.lat},${GARRISON.lon}`))));

    // Pictures: the site's own first, Wikipedia's otherwise, a drawing last.
    await page.waitForTimeout(2500);
    const pics = await page.evaluate(() => [...window.__drive.entries.values()].map((e) => ({
      name: e.c.name, image: e.c.image || null,
      img: e.li.querySelector('.deck-photo img')?.getAttribute('src') || '',
      credit: e.li.querySelector('.deck-credit')?.textContent || '',
      glyph: !!e.li.querySelector('.deck-photo.is-glyph')
    })));
    ok('every card has a picture or a drawing', pics.every((p) => p.img || p.glyph),
      pics.map((p) => `${p.name}:${p.image ? 'site' : p.img ? 'wiki' : 'glyph'}`).join(' / '));
    ok('a place with its own picture shows it', pics.filter((p) => p.image).every((p) => p.img === p.image && p.credit === 'Their site'));
    ok('otherwise Wikipedia\'s', pics.some((p) => p.credit === 'Wikipedia'));

    // Heading up: the map's bearing is the heading, so the road is up.
    // Beacon to Garrison is a touch east of due south, about 172 degrees.
    const turn = await page.evaluate(() => ({ bearing: window.__drive.map.getBearing(), heading: window.__drive.state.heading }));
    const norm = (d) => ((d % 360) + 360) % 360;
    ok('map turned so the road is up', Math.abs(norm(turn.bearing) - 172) < 10, JSON.stringify(turn));
    const carY = await page.evaluate(() => {
      const s = document.getElementById('map-slice').getBoundingClientRect();
      const c = document.getElementById('map-car').getBoundingClientRect();
      return ((c.top + c.bottom) / 2 - s.top) / s.height;
    });
    ok('car sits low in the strip', Math.abs(carY - 0.78) < 0.02, carY.toFixed(3));

    // Smooth: a card moves by steady small steps every frame, never a jump.
    const track = await page.evaluate(() => new Promise((done) => {
      const e = [...window.__drive.entries.values()].sort((a, b) => Math.abs(a.ahead) - Math.abs(b.ahead))[0];
      const ys = [];
      const tick = () => {
        ys.push(e.y);
        if (ys.length < 90) requestAnimationFrame(tick); else done(ys);
      };
      requestAnimationFrame(tick);
    }));
    const steps = track.slice(1).map((y, i) => y - track[i]).filter((d) => Number.isFinite(d));
    const sorted = steps.map(Math.abs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const worst = sorted[sorted.length - 1] || 0;
    ok('cards move every frame', steps.filter((d) => d !== 0).length > steps.length * 0.8,
      `${steps.filter((d) => d !== 0).length}/${steps.length} frames moved`);
    // A jump is a big step, or a sudden change of speed: a card that lurches
    // from still to fast in one frame reads as a jump even if it then glides.
    const jerk = steps.slice(1).reduce((m, d, i) => Math.max(m, Math.abs(d - steps[i])), 0);
    ok('and never jump', worst <= 10 && jerk <= 3,
      `median ${median.toFixed(2)}px, worst ${worst.toFixed(2)}px, sharpest change ${jerk.toFixed(2)}px`);

    // And the map glides the same way: the car's position is interpolated
    // between fixes, so the centre moves by even steps rather than clicking
    // from one fix to the next four times a second.
    const glide = await page.evaluate(() => new Promise((done) => {
      const m = window.__drive.map, out = [];
      let last = m.getCenter();
      const tick = () => {
        const c = m.getCenter();
        out.push(Math.hypot(c.lng - last.lng, c.lat - last.lat) * 1e6);
        last = c;
        if (out.length < 90) requestAnimationFrame(tick); else done(out);
      };
      requestAnimationFrame(tick);
    }));
    const moved = glide.filter((d) => d > 0);
    const gs = moved.slice().sort((a, b) => a - b);
    const gMed = gs[Math.floor(gs.length / 2)] || 0, gMax = gs[gs.length - 1] || 0;
    ok('map moves every frame', moved.length > glide.length * 0.8, `${moved.length}/${glide.length}`);
    ok('by even steps', gMax <= gMed * 3, `median ${gMed.toFixed(1)}, worst ${gMax.toFixed(1)} (µdeg)`);

    // Speed: faster without the clock jumping.
    const before = await page.evaluate(() => ({ t: window.__drive.state.sim.clock(), v: window.__drive.state.sim.speed }));
    await page.click('#sim-faster');
    const after = await page.evaluate(() => ({ t: window.__drive.state.sim.clock(), v: window.__drive.state.sim.speed }));
    ok('faster', after.v > before.v && (await page.textContent('#sim-speed')).trim() === `${after.v}×`, `${before.v} → ${after.v}`);
    ok('the clock keeps its place', after.t >= before.t && after.t - before.t < 5000, `${after.t - before.t}ms`);
    await page.click('#sim-slower');
    await page.click('#sim-slower');
    ok('and slower', await page.evaluate(() => window.__drive.state.sim.speed) < before.v);
    await page.click('#sim-faster');

    // What is passed goes below the line and keeps going.
    await page.waitForFunction(() => [...window.__drive.entries.values()].some((e) => e.ahead < -0.3), null, { timeout: 30000 }).catch(() => {});
    const past = await page.evaluate(() => {
      const l = document.getElementById('deck-list').getBoundingClientRect();
      const e = [...window.__drive.entries.values()].find((x) => x.ahead < -0.3);
      if (!e) return null;
      const r = e.li.getBoundingClientRect();
      return { below: (r.top + r.bottom) / 2 - l.top > l.height / 2, dim: e.li.classList.contains('is-past'), facts: e.li.querySelector('.deck-facts').textContent };
    });
    ok('passed places go below the line', past && past.below && past.dim, JSON.stringify(past));

    // "Not for me" is the same mute the Places tab uses.
    const target = await page.evaluate(() => [...window.__drive.entries.values()].find((e) => e.ahead > 0)?.c.name);
    if (target) {
      await page.evaluate((n) => [...window.__drive.entries.values()].find((e) => e.c.name === n).li.querySelector('.deck-no').click(), target);
      const muted = await page.evaluate(() => JSON.parse(localStorage.getItem('proximi.hiddenVenues.v1') || '[]'));
      ok('not for me mutes the place', muted.includes(target), target);
      ok('and takes its card away', !(await page.evaluate((n) => [...window.__drive.entries.values()].some((e) => e.c.name === n), target)));
    } else {
      ok('a card ahead to mute', false);
    }

    ok('nothing was said aloud', (await page.evaluate(() => window.__spoken.length)) === 0);
    ok('detours asked of the router', counts.table > 0, `${counts.table} table calls`);

    await page.click('#stop-btn');
    ok('end drive returns to setup', await page.isVisible('#setup-panel'));
    ok('and clears the deck', await page.evaluate(() => window.__drive.entries.size === 0));
    ok('speed control goes with it', !(await page.isVisible('#sim-ctl')));
    ok('no page errors (sim)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  // ── Upright only ───────────────────────────────────────
  {
    const { ctx, page } = await newPage({ viewport: { width: 844, height: 390 } });
    await page.goto(base + '/drive.html', { waitUntil: 'domcontentloaded' });
    const hit = await page.evaluate(() => document.elementFromPoint(422, 195)?.className || '');
    ok('turned sideways, it asks to be upright', hit.includes('turn-upright'), hit);
    await ctx.close();
  }

  // ── No destination: follow the heading from real GPS fixes ──
  {
    const { ctx, page, errors } = await newPage({
      geolocation: { latitude: GARRISON.lat, longitude: GARRISON.lon },
      permissions: ['geolocation']
    });
    await page.goto(base + '/drive.html', { waitUntil: 'networkidle' });
    await page.click('#start-btn');
    ok('drive starts without a destination', await page.isVisible('#dock'));

    // Drive north up 9D towards Beacon, one fix at a time.
    for (let i = 1; i <= 12; i++) {
      const t = i / 40;
      await ctx.setGeolocation({
        latitude: GARRISON.lat + (BEACON.lat - GARRISON.lat) * t,
        longitude: GARRISON.lon + (BEACON.lon - GARRISON.lon) * t
      });
      await page.waitForTimeout(400);
    }
    const s = await page.evaluate(() => ({
      heading: window.__drive.state.heading,
      status: document.getElementById('drive-status').textContent,
      ahead: window.__drive.state.ahead.length
    }));
    // Northbound and a touch east of north: about 352 degrees on this line.
    ok('heading from GPS fixes', s.heading != null && (s.heading > 330 || s.heading < 20), String(s.heading && s.heading.toFixed(0)));
    ok('finds places ahead', s.ahead > 0, `${s.ahead} ahead · ${s.status}`);
    ok('no page errors (gps)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
  }

  await browser.close();
  if (server) server.kill();
  console.log(fail.length ? `\n${fail.length} FAILED` : '\nall passed');
  process.exit(fail.length ? 1 : 0);
})();
