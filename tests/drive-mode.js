/* Drives the Drive page (drive.html) in headless Chromium, the way
 * tests/drive.js drives the list. The page talks to two live services,
 * OSRM for routes and detour times and Nominatim for addresses, so both are
 * answered here instead: CI must not fail because a public server is slow,
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

async function fakeServices(ctx, counts) {
  await ctx.route(/tile\.openstreetmap\.org|upload\.wikimedia\.org/, (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
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

  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
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
    await fakeServices(ctx, counts);
    // Speech is what the page is for, and a headless browser has no voice:
    // record what would have been said instead.
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
    await page.click('#quiz .quiz-choice:has(strong:text-is("Rarely"))');
    await page.click('#quiz-next');
    await page.click('#quiz .quiz-choice:has(strong:text-is("Right"))');
    ok('last page says Done', (await page.textContent('#quiz-next')).trim() === 'Done');
    await page.click('#quiz-next');
    ok('and closes', !(await page.isVisible('#quiz')));

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('proximi.drive.v1')));
    ok('answers are saved', saved.onboarded && saved.levels.history === 'love'
      && saved.levels.gardens === 'skip' && saved.maxDetour === 15 && saved.cooldown === 20
      && saved.mapSide === 'right', JSON.stringify(saved.levels));
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

  // ── A simulated drive: the deck, the turned map, photos, voice ──
  {
    const { ctx, page, errors, counts } = await newPage();
    await page.goto(base + '/drive.html', { waitUntil: 'networkidle' });
    const status = await page.textContent('#drive-status');
    ok('places load', /\d[\d,]* places worth a stop/.test(status), status);

    await page.click('#open-settings');
    ok('settings open', await page.isVisible('#drive-settings'));
    await page.fill('#sim-from', 'Beacon, NY');
    await page.fill('#sim-to', 'Garrison, NY');
    await page.click('#sim-form button[type=submit]');
    ok('settings close on simulate', !(await page.isVisible('#drive-settings')));

    // Two or three at once is the point of the deck.
    await page.waitForFunction(() => document.querySelectorAll('.deck-card:not(.is-leaving)').length >= 2,
      null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);   // let the slide settle
    const deck = await page.evaluate(() => {
      const list = document.getElementById('deck-list').getBoundingClientRect();
      return [...document.querySelectorAll('.deck-card:not(.is-leaving)')].map((c) => {
        const r = c.getBoundingClientRect();
        const miles = parseFloat(c.querySelector('.deck-facts').textContent.split('·')[1]);
        return {
          name: c.querySelector('.deck-name').textContent, n: Number(c.querySelector('.deck-num').textContent),
          top: r.top, whole: r.top >= list.top - 1 && r.bottom <= list.bottom + 1, miles,
          photo: c.querySelector('.deck-photo img')?.src || '', glyph: c.querySelector('.deck-photo.is-glyph') != null,
          go: c.querySelector('.deck-go').href
        };
      }).sort((a, b) => b.top - a.top);   // bottom of the screen first
    });
    ok('several places on screen at once', deck.filter((d) => d.whole).length >= 2,
      deck.map((d) => `${d.n} ${d.name} ${d.miles}mi`).join(' / '));
    ok('nearest at the bottom, further up', deck.every((d, i) => i === 0 || d.miles >= deck[i - 1].miles));
    ok('numbered from the bottom', deck.every((d, i) => d.n === i + 1));
    ok('pins on the map match the cards',
      await page.locator('.deck-pin-n').count() === deck.length);
    ok('go keeps the destination', deck.length > 0 && deck.every((d) => d.go.includes('waypoints=')
      && d.go.includes(encodeURIComponent(`${GARRISON.lat},${GARRISON.lon}`))));

    await page.waitForFunction(() => document.querySelector('.deck-photo img'), null, { timeout: 15000 }).catch(() => {});
    const pics = await page.evaluate(() => [...document.querySelectorAll('.deck-card')].map((c) => ({
      name: c.querySelector('.deck-name').textContent,
      img: c.querySelector('.deck-photo img')?.src || '', glyph: !!c.querySelector('.deck-photo.is-glyph')
    })));
    ok('a place with an article gets its photo', pics.some((p) => p.img.includes('upload.wikimedia.org')),
      pics.map((p) => `${p.name}:${p.img ? 'photo' : p.glyph ? 'glyph' : '?'}`).join(' / '));
    ok('every card has a picture or a glyph', pics.every((p) => p.img || p.glyph));
    ok('Wikipedia asked once per place', counts.wiki <= new Set(pics.map((p) => p.name)).size + 6, `${counts.wiki} calls`);

    // Heading up: the map turns against the heading, the car with it, and
    // the two cancel so the car points up the screen. Beacon to Garrison is
    // a touch east of due south: about 172 degrees.
    const turn = await page.evaluate(() => {
      const deg = (t) => Number((t.match(/rotate\((-?[\d.]+)deg\)/) || [])[1]);
      return {
        map: deg(document.getElementById('drive-map').style.transform),
        car: deg(document.querySelector('.car-marker svg').style.transform),
        heading: window.__drive.state.heading
      };
    });
    const norm = (d) => ((d % 360) + 360) % 360;
    ok('map turned so the road is up', Math.abs(norm(-turn.map) - 172) < 12, JSON.stringify(turn));
    ok('car points straight up', Math.abs(norm(turn.map + turn.car)) < 0.5 || Math.abs(norm(turn.map + turn.car) - 360) < 0.5);

    const spoken = await page.evaluate(() => window.__spoken.slice());
    ok('first words unlock the voice', /^Driving buddy on\. Heading to Garrison, New York\./.test(spoken[0] || ''), spoken[0]);
    const said = await page.evaluate(() => document.querySelector('.deck-card.is-said .deck-name')?.textContent || '');
    ok('the one said aloud is marked', said && spoken.some((t) => t.startsWith(said + '.')), said);
    ok('detours asked of the router', counts.table > 0, `${counts.table} table calls`);

    // The deck moves with the car.
    const nearest = deck[0];
    await page.waitForTimeout(2500);
    const later = await page.evaluate((name) => {
      const c = [...document.querySelectorAll('.deck-card:not(.is-leaving)')]
        .find((x) => x.querySelector('.deck-name').textContent === name);
      return c ? parseFloat(c.querySelector('.deck-facts').textContent.split('·')[1]) : 'passed';
    }, nearest && nearest.name);
    ok('distances count down', later === 'passed' || later < nearest.miles, `${nearest && nearest.miles} → ${later}`);

    // "Not for me" is the same mute the Places tab uses.
    const target = page.locator('.deck-card:not(.is-leaving)').first();
    if (await target.count()) {
      const name = await target.locator('.deck-name').textContent();
      await target.locator('.deck-no').click();
      const muted = await page.evaluate(() => JSON.parse(localStorage.getItem('proximi.hiddenVenues.v1') || '[]'));
      ok('not for me mutes the place', muted.includes(name), name);
      await page.waitForTimeout(900);
      const still = await page.evaluate((n) => [...document.querySelectorAll('.deck-card')]
        .some((c) => c.querySelector('.deck-name').textContent === n), name);
      ok('and takes its card away', !still);
    } else {
      ok('a card to mute', false);
    }

    const stored = await page.evaluate(() => localStorage.getItem('proximi.drive.announced.v1'));
    ok('simulated drive leaves no memory', !stored || stored === '{}', stored);

    await page.click('#stop-btn');
    ok('end drive returns to setup', await page.isVisible('#setup-panel'));
    ok('and clears the deck', await page.locator('.deck-card:not(.is-leaving):not(.is-fading)').count() === 0);
    ok('no page errors (sim)', errors.length === 0, errors.slice(0, 3).join(' | '));
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
