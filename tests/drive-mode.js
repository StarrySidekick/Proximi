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

async function fakeServices(ctx, counts) {
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
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

  async function newPage(opts = {}) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...opts
    });
    const counts = { route: 0, table: 0 };
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

  // ── A simulated drive: route, suggestion, voice, handoff, mute ──
  {
    const { ctx, page, errors, counts } = await newPage();
    await page.goto(base + '/drive.html', { waitUntil: 'networkidle' });
    const status = await page.textContent('#drive-status');
    ok('places load', /\d[\d,]* places worth a stop/.test(status), status);

    // Only kinds with a real candidate on this stretch, so the assertion is
    // about the machinery rather than about this week's data.
    await page.click('#open-settings');
    ok('settings open', await page.isVisible('#drive-settings'));
    const kinds = await page.locator('#kind-chips .chip').count();
    ok('kind chips render', kinds > 10, `${kinds} chips`);
    await page.fill('#sim-from', 'Beacon, NY');
    await page.fill('#sim-to', 'Garrison, NY');
    await page.click('#sim-form button[type=submit]');
    ok('settings close on simulate', !(await page.isVisible('#drive-settings')));

    await page.waitForSelector('#suggestion:not([hidden])', { timeout: 30000 }).catch(() => {});
    const card = await page.evaluate(() => ({
      shown: !document.getElementById('suggestion').hidden,
      name: document.getElementById('sug-name').textContent,
      facts: document.getElementById('sug-facts').textContent,
      go: document.getElementById('sug-go').href,
      spoken: window.__spoken.slice()
    }));
    ok('a stop is suggested', card.shown, card.name);
    ok('with its detour and distance', /(\d+ min detour|Barely a detour) · [\d.]+ mi ahead/.test(card.facts), card.facts);
    ok('said out loud', card.spoken.some((s) => card.name && s.startsWith(card.name + '.')),
      card.spoken[card.spoken.length - 1]);
    ok('first words unlock the voice', /^Driving buddy on\. Heading to Garrison, New York\./.test(card.spoken[0] || ''), card.spoken[0]);
    ok('take me there keeps the destination',
      card.go.includes('google.com/maps/dir') && card.go.includes('waypoints=')
        && card.go.includes(encodeURIComponent(`${GARRISON.lat},${GARRISON.lon}`)));
    ok('detours asked of the router', counts.table > 0, `${counts.table} table calls`);

    // The card is announced once and read many times: it counts down.
    const before = await page.textContent('#sug-facts');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => {
      const c = document.getElementById('suggestion');
      return c.hidden ? '(passed)' : document.getElementById('sug-facts').textContent;
    });
    ok('distance counts down', after !== before, `${before} → ${after}`);

    // "Not for me" is the same mute the Places tab uses.
    await page.waitForSelector('#suggestion:not([hidden])', { timeout: 30000 }).catch(() => {});
    const name = await page.textContent('#sug-name');
    if (await page.isVisible('#suggestion')) {
      await page.click('#sug-mute');
      const muted = await page.evaluate(() => JSON.parse(localStorage.getItem('proximi.hiddenVenues.v1') || '[]'));
      ok('not for me mutes the place', muted.includes(name), name);
      ok('and clears the card', !(await page.isVisible('#suggestion')));
    } else {
      ok('a second suggestion to mute', false);
    }

    // A rehearsal must not use up the real drive's announcements.
    const stored = await page.evaluate(() => localStorage.getItem('proximi.drive.announced.v1'));
    ok('simulated drive leaves no memory', !stored || stored === '{}', stored);

    await page.click('#stop-btn');
    ok('end drive returns to setup', await page.isVisible('#setup-panel'));
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
