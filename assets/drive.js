/* Proximi Drive — a driving buddy.
 *
 * While you drive, it watches the road ahead for places worth a short detour
 * and says them out loud: what it is, how many minutes out of your way, how
 * far ahead. Nothing needs a tap once the drive has started.
 *
 * Where the answers come from:
 *   · places     data/places.json, the same directory the Places tab reads
 *   · on now     data/events.json, only one-off listings with a real time
 *   · routes     OSRM's public server (router.project-osrm.org), live
 *   · addresses  Nominatim, live, the same lookup the main page uses
 *
 * Two ways to drive, one code path. With a destination, "ahead" means further
 * along the real route and a detour rejoins that route. Without one, "ahead"
 * means a cone in the direction you are heading, and a detour rejoins a point
 * straight ahead — rougher, but it asks nothing of you.                     */

(() => {
  'use strict';

  /* ── Settings ─────────────────────────────────────────── */

  // Singular, the way it is said aloud: "A castle, about 6 minutes out of
  // your way." Order is the order the chips appear in.
  const KINDS = [
    ['castle', 'Castle'], ['historic house', 'Historic house'],
    ['museum', 'Museum'], ['historic site', 'Historic site'],
    ['landmark', 'Landmark'], ['lookout', 'Lookout'],
    ['garden', 'Garden'], ['zoo', 'Zoo or aquarium'],
    ['theme park', 'Theme park'], ['winery', 'Winery'],
    ['farm', 'Farm or orchard'], ['park', 'Park'],
    ['brewery', 'Brewery'], ['gallery', 'Gallery'],
    ['antique shop', 'Antique shop'], ['bookshop', 'Bookshop'],
    ['music venue', 'Music venue'], ['theatre', 'Theatre'],
    ['cinema', 'Cinema'], ['mall', 'Market'], ['shop', 'Shop'],
    ['library', 'Library']
  ];
  const KIND_LABEL = Object.fromEntries(KINDS);

  /* How much a kind is worth a detour, before anything about the particular
     place. A castle is a reason to leave the highway; a library usually is
     not, which is why it is off by default rather than absent. */
  const KIND_WEIGHT = {
    castle: 3, 'historic house': 2.5, lookout: 2.5, zoo: 2.5, garden: 2.5,
    'theme park': 2, museum: 2, 'historic site': 2, winery: 2,
    landmark: 1.5, farm: 1.5, park: 1.5, brewery: 1.5, gallery: 1.5,
    'antique shop': 1, bookshop: 1, 'music venue': 1, theatre: 1,
    cinema: 0.5, mall: 0.5, shop: 0.5, library: 0.5
  };

  /* Parks are off by default for a reason in the data: 773 of them, most a
     town green or a ball field. Libraries and shops likewise. */
  const DEFAULT_KINDS = ['castle', 'historic house', 'museum', 'historic site',
    'landmark', 'lookout', 'garden', 'zoo', 'theme park', 'winery', 'farm'];

  const DETOURS = [5, 10, 15, 20];          // minutes out of your way
  const COOLDOWNS = [2, 5, 10, 20];         // minutes between announcements
  const MAPS = [['google', 'Google Maps'], ['apple', 'Apple Maps']];

  const DEFAULTS = {
    kinds: DEFAULT_KINDS, maxDetour: 10, cooldown: 5,
    events: true, liked: true, km: false, maps: 'google', voice: true
  };

  const SETTINGS_KEY = 'proximi.drive.v1';
  const ANNOUNCED_KEY = 'proximi.drive.announced.v1';
  // Shared with the main page, so "Not for me" in the car is the same mute
  // as swiping a place left on the Places tab, and a liked place is liked
  // in both.
  const VENUES_KEY = 'proximi.hiddenVenues.v1';
  const SAVED_KEY = 'proximi.savedPlaces.v1';
  const DECISIONS_KEY = 'proximi.decisions.v1';

  // Every storage access is guarded: a private window can throw on read as
  // well as write, and a thrown call must not take the drive down with it.
  const readJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not fatal */ }
  };

  const settings = { ...DEFAULTS, ...readJSON(SETTINGS_KEY, {}) };
  settings.kinds = new Set(settings.kinds);
  const saveSettings = () => writeJSON(SETTINGS_KEY, { ...settings, kinds: [...settings.kinds] });

  /* ── Geometry ─────────────────────────────────────────────
     Everything here happens within a few dozen miles, where the earth is flat
     enough: a local projection (degrees scaled to miles, longitude shrunk by
     the cosine of the latitude) is accurate to well under 1% and turns every
     "how far off the road" question into plain 2-D vector arithmetic. */

  const MI_PER_DEG = 69.172;
  const RAD = Math.PI / 180;
  const MPS_TO_MPH = 2.23694;

  function haversineMiles(a, b) {
    const dLat = (b.lat - a.lat) * RAD;
    const dLon = (b.lon - a.lon) * RAD;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(h));
  }

  // Miles east (x) and north (y) of a reference point.
  function toXY(p, ref) {
    return {
      x: (p.lon - ref.lon) * Math.cos(ref.lat * RAD) * MI_PER_DEG,
      y: (p.lat - ref.lat) * MI_PER_DEG
    };
  }

  function fromXY(v, ref) {
    return {
      lat: ref.lat + v.y / MI_PER_DEG,
      lon: ref.lon + v.x / (Math.cos(ref.lat * RAD) * MI_PER_DEG)
    };
  }

  // Compass bearing from a to b, degrees clockwise from north.
  function bearing(a, b) {
    const v = toXY(b, a);
    return (Math.atan2(v.x, v.y) / RAD + 360) % 360;
  }

  // Unit vector for a compass heading, in the same x-east, y-north frame.
  const headingVector = (deg) => ({ x: Math.sin(deg * RAD), y: Math.cos(deg * RAD) });

  /* ── The route ────────────────────────────────────────────
     A route is a polyline plus the running mileage at each vertex. With that,
     any point can be described by two numbers: how far along the route its
     nearest point is ("along"), and how far off the route it sits ("off").
     "Ahead of me" is then just along > mine. */

  function buildRoute(lonLats, meta = {}) {
    const pts = [];
    for (const [lon, lat] of lonLats) {
      const p = { lat, lon };
      // Thin to roughly every tenth of a mile: plenty for a corridor a mile
      // or more wide, and it keeps the place pass below 100ms on a long drive.
      if (!pts.length || haversineMiles(pts[pts.length - 1], p) >= 0.1) pts.push(p);
    }
    const last = lonLats[lonLats.length - 1];
    if (last && pts.length > 1) pts[pts.length - 1] = { lat: last[1], lon: last[0] };
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineMiles(pts[i - 1], pts[i]));
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of pts) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    return {
      pts, cum, length: cum[cum.length - 1],
      bbox: { minLat, maxLat, minLon, maxLon },
      seconds: meta.duration || null, near: []
    };
  }

  /* Nearest point on the route. `hint` is where we last were: searching only
     a window around it stops a route that doubles back on itself (out along
     a peninsula and back) from teleporting you to the return leg. */
  function locate(route, p, hint) {
    const { pts, cum } = route;
    let best = { along: 0, off: Infinity };
    const scan = (lo, hi) => {
      for (let i = lo; i < hi; i++) {
        const a = toXY(pts[i], p), b = toXY(pts[i + 1], p);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy;
        // Parameter t of the closest point on segment a→b to the origin (p).
        const t = len2 ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2)) : 0;
        const cx = a.x + t * dx, cy = a.y + t * dy;
        const off = Math.hypot(cx, cy);
        if (off < best.off) best = { along: cum[i] + t * (cum[i + 1] - cum[i]), off };
      }
    };
    if (hint != null) {
      let lo = 0, hi = pts.length - 1;
      while (lo < hi && cum[lo + 1] < hint - 3) lo++;
      while (hi > lo && cum[hi - 1] > hint + 15) hi--;
      scan(lo, hi);
      if (best.off <= 1) return best;
    }
    scan(0, pts.length - 1);
    return best;
  }

  // The point a given number of miles along the route.
  function pointAt(route, along) {
    const { pts, cum } = route;
    if (along <= 0) return pts[0];
    if (along >= route.length) return pts[pts.length - 1];
    let i = 1;
    while (cum[i] < along) i++;
    const t = (along - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    const a = pts[i - 1], b = pts[i];
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
  }

  /* Pre-place every candidate on the route once, when the route arrives, so
     each GPS fix afterwards is a cheap filter on two numbers per place. */
  const CORRIDOR_MI = 6;
  function indexRoute(route, pool) {
    const pad = CORRIDOR_MI / MI_PER_DEG;
    const padLon = pad / Math.cos(((route.bbox.minLat + route.bbox.maxLat) / 2) * RAD);
    const b = route.bbox;
    route.near = [];
    for (const c of pool) {
      if (c.lat < b.minLat - pad || c.lat > b.maxLat + pad
        || c.lon < b.minLon - padLon || c.lon > b.maxLon + padLon) continue;
      const at = locate(route, c);
      if (at.off <= CORRIDOR_MI) route.near.push({ c, along: at.along, off: at.off });
    }
  }

  /* ── State ────────────────────────────────────────────── */

  const state = {
    phase: 'setup',            // 'setup' | 'driving'
    places: [], events: [],
    pool: [],                  // everything that could ever be suggested
    placesReady: false,
    liked: new Set(readJSON(SAVED_KEY, [])),
    muted: new Set(readJSON(VENUES_KEY, [])),
    decisions: readJSON(DECISIONS_KEY, {}),
    announced: new Map(Object.entries(readJSON(ANNOUNCED_KEY, {}))),

    pos: null, heading: null, speedMph: 0, lastFix: null, headingFrom: null,
    dest: null, destName: '', route: null, progress: null, offCount: 0, lastReroute: 0,
    watchId: null, sim: null, wakeLock: null,

    detours: new Map(),        // candidate id → { min, toMin, at }
    checking: false, lastCheck: 0, routerDownUntil: 0,
    lastSpoken: -Infinity, current: null, ahead: []
  };

  // The drive's clock. A simulated drive runs faster than real time, and the
  // cooldown and "on now" windows should run with it rather than with the wall.
  const now = () => (state.sim ? state.sim.clock() : Date.now());

  /* ── What is worth a stop ─────────────────────────────── */

  function interest(c) {
    if (state.muted.has(c.name)) return 0;
    const liked = state.liked.has(c.name);
    let s = 0;
    if (c.kind === 'event') s = settings.events ? 3 : 0;
    else if (settings.kinds.has(c.kind)) s = KIND_WEIGHT[c.kind] ?? 1;
    else if (liked && settings.liked) s = 1;
    if (!s) return 0;
    if (liked) s += 3;
    if (c.description) s += 0.5;
    if (c.url) s += 0.3;
    if (c.onNow) s += 2;
    return s;
  }

  /* What is on right now, from the event file. Deliberately narrow: only
     one-off listings with a real start time. A repeating series' dates
     describe when it runs, not when it is on, and a midnight start with no
     end is a feed saying "some time that day". Telling a driver something is
     happening when it is not costs them a detour, so anything uncertain is
     left out rather than guessed at. */
  function eventsOnNow(t) {
    const out = [];
    for (const e of state.events) {
      if (e.repeats || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
      if (e.audience === 'kids' || state.decisions[e.id] === 'hidden') continue;
      if (typeof e.start !== 'string') continue;
      const start = Date.parse(e.start);
      if (e.start.slice(11, 16) === '00:00' && !e.end) continue;
      const end = e.end ? Date.parse(e.end) : start + (e.durationMin || 120) * 60000;
      const span = end - start;
      if (!(span > 0)) continue;
      if (span <= 12 * 3600000) {
        // Starting within the hour, or with at least a quarter hour left.
        if (start <= t + 3600000 && end >= t + 900000) out.push(e);
      } else if (span <= 4 * 86400000) {
        // A multi-day festival: only during the day, which is when it is on.
        const hour = new Date(t).getHours();
        if (start <= t && end >= t && hour >= 10 && hour < 18) out.push(e);
      }
    }
    return out;
  }

  // Rebuilt when settings change, and every few minutes of drive time so
  // "on now" stays true.
  function buildPool() {
    const t = now();
    const byName = new Map(state.places.map((p) => [p.name.toLowerCase(), p]));
    const onNow = new Map();
    const eventOnly = [];
    for (const e of eventsOnNow(t)) {
      const host = byName.get((e.venue || '').toLowerCase());
      if (host) {
        if (!onNow.has(host.id)) onNow.set(host.id, e);
      } else {
        eventOnly.push({
          id: 'ev-' + e.id, name: e.venue || e.title, kind: 'event',
          lat: e.lat, lon: e.lon, city: e.city, url: e.url, onNow: e
        });
      }
    }
    state.pool = [];
    for (const p of state.places) {
      const c = onNow.has(p.id) ? { ...p, onNow: onNow.get(p.id) } : p;
      c._score = interest(c);
      if (c._score > 0) state.pool.push(c);
    }
    for (const c of eventOnly) {
      c._score = interest(c);
      if (c._score > 0) state.pool.push(c);
    }
    state.poolBuiltAt = t;
    if (state.route) indexRoute(state.route, state.pool);
  }

  /* ── Choosing what is ahead ───────────────────────────────
     Cheap first, expensive last. Straight-line geometry throws out almost
     everything; only the few best survivors are sent to the router for a real
     detour time, because the public router allows about one request a second
     and a phone on a highway does not have a second to waste. */

  // A generous straight-line limit for a given detour: out and back at local
  // road speed, with roads assumed about 30% longer than a straight line.
  const offLimit = () => Math.min(CORRIDOR_MI, settings.maxDetour * 0.35);

  // How far ahead to look: fifteen minutes at the current speed, within reason.
  const lookahead = () => Math.max(4, Math.min(25, (state.speedMph || 30) * 0.25));

  const MIN_AHEAD = 0.5;   // an exit you are about to pass is not a suggestion

  function candidatesAhead() {
    const out = [];
    const lim = offLimit(), far = lookahead();
    if (state.route && state.progress != null) {
      for (const n of state.route.near) {
        const ahead = n.along - state.progress;
        if (ahead < MIN_AHEAD || ahead > far || n.off > lim) continue;
        out.push({ c: n.c, ahead, off: n.off, along: n.along });
      }
    } else if (state.pos && state.heading != null) {
      const h = headingVector(state.heading);
      const box = far / MI_PER_DEG * 1.2;
      for (const c of state.pool) {
        if (Math.abs(c.lat - state.pos.lat) > box || Math.abs(c.lon - state.pos.lon) > box * 1.6) continue;
        const v = toXY(c, state.pos);
        const ahead = v.x * h.x + v.y * h.y;
        const off = Math.abs(v.x * h.y - v.y * h.x);
        // Roads bend, so the corridor widens a little with distance: a cone.
        if (ahead < MIN_AHEAD || ahead > far || off > lim + ahead * 0.15) continue;
        out.push({ c, ahead, off });
      }
    }
    for (const o of out) {
      // Straight-line guess at the detour, in minutes, until the router says.
      o.guess = (o.off * 2 * 1.3) / 35 * 60;
      o.rank = o.c._score - o.guess * 0.15;
    }
    return out.sort((a, b) => b.rank - a.rank);
  }

  /* Where you would get back on the road after the stop: a mile and a half
     past the place, measured along the route when there is one. */
  function rejoinPoint(o) {
    if (state.route && o.along != null) return pointAt(state.route, o.along + 1.5);
    const h = headingVector(state.heading);
    return fromXY({ x: h.x * (o.ahead + 1.5), y: h.y * (o.ahead + 1.5) }, state.pos);
  }

  const OSRM = 'https://router.project-osrm.org';
  const ll = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;

  /* Detour = (you → place → back on the road) − (you → back on the road).
     One "table" request answers all three legs: it returns drive times from
     each source to each destination, so asking from [you, place] to
     [place, rejoin] gives you→place, you→rejoin and place→rejoin at once. */
  async function checkDetour(o) {
    const here = state.pos, rejoin = rejoinPoint(o);
    const url = `${OSRM}/table/v1/driving/${ll(here)};${ll(o.c)};${ll(rejoin)}`
      + '?sources=0;1&destinations=1;2';
    const res = await fetch(url);
    if (!res.ok) throw new Error('router ' + res.status);
    const data = await res.json();
    const d = data.durations;
    if (data.code !== 'Ok' || !d) throw new Error('router ' + data.code);
    const toPlace = d[0][0], direct = d[0][1], onward = d[1][1];
    if (toPlace == null || direct == null || onward == null) return { min: Infinity, toMin: Infinity };
    return {
      min: Math.max(0, (toPlace + onward - direct) / 60),
      toMin: toPlace / 60
    };
  }

  const DETOUR_TTL = 4 * 60000;   // a detour from five miles back is stale

  async function checkNext(list) {
    const t = Date.now();
    if (state.checking || t - state.lastCheck < 1200 || t < state.routerDownUntil) return;
    const next = list.slice(0, 6).find((o) => {
      const d = state.detours.get(o.c.id);
      return !d || now() - d.at > DETOUR_TTL;
    });
    if (!next) return;
    state.checking = true;
    state.lastCheck = t;
    try {
      const d = await checkDetour(next);
      state.detours.set(next.c.id, { ...d, at: now() });
    } catch {
      // Back off rather than hammer a router that is down or refusing us;
      // a straight-line guess is not good enough to say aloud.
      state.routerDownUntil = Date.now() + 15000;
      setStatus('Cannot reach the routing service. Retrying shortly.');
    } finally {
      state.checking = false;
    }
    evaluate();
  }

  /* ── Deciding to speak ────────────────────────────────── */

  const ANNOUNCE_MEMORY = 12 * 3600000;   // do not repeat a place within a day's drive

  function wasAnnounced(id) {
    const at = state.announced.get(id);
    return at != null && now() - at < ANNOUNCE_MEMORY;
  }

  function evaluate() {
    if (state.phase !== 'driving' || !state.pos) return;
    if (now() - (state.poolBuiltAt || 0) > 5 * 60000) buildPool();

    refreshSuggestion();
    const list = candidatesAhead().filter((o) => !wasAnnounced(o.c.id));
    state.ahead = list;
    drawAhead(list);

    const eligible = [];
    for (const o of list) {
      const d = state.detours.get(o.c.id);
      if (!d || now() - d.at > DETOUR_TTL || d.min > settings.maxDetour) continue;
      eligible.push({ ...o, detour: d.min, toMin: d.toMin, score: o.c._score - d.min * 0.15 });
    }
    eligible.sort((a, b) => b.score - a.score);

    const coolMs = settings.cooldown * 60000;
    if (eligible.length && now() - state.lastSpoken >= coolMs) announce(eligible[0]);
    else checkNext(list);

    statusForDrive(list.length);
  }

  function statusForDrive(n) {
    if (Date.now() < state.routerDownUntil) return;
    if (!state.placesReady) { setStatus('Loading places…'); return; }
    if (!state.route && state.heading == null) {
      setStatus('Waiting for you to get moving…');
      return;
    }
    if (!coveredNear(state.pos)) {
      setStatus('No Proximi places around here yet');
      return;
    }
    const where = state.route ? `to ${state.destName}` : 'following your heading';
    setStatus(n ? `${n} worth a look ahead · ${where}` : `Watching the road · ${where}`);
  }

  // Coverage is a chain of circles; outside them the directory is empty, and
  // silence should read as "not covered" rather than "nothing here".
  function coveredNear(p) {
    const regions = state.regions || [];
    if (!regions.length) return true;
    return regions.some((r) => haversineMiles(p, r) <= (r.radiusMiles || 40) + 15);
  }

  /* ── Saying it ────────────────────────────────────────── */

  const distUnit = () => (settings.km ? 'kilometres' : 'miles');
  const distValue = (mi) => (settings.km ? mi * 1.609344 : mi);

  function spokenDistance(mi) {
    const d = distValue(mi);
    const n = d < 10 ? Math.round(d * 2) / 2 : Math.round(d);   // halves read well aloud
    return `${n} ${n === 1 ? distUnit().replace(/s$/, '') : distUnit()}`;
  }

  function shortDistance(mi) {
    const d = distValue(mi);
    return `${d < 10 ? d.toFixed(1) : Math.round(d)} ${settings.km ? 'km' : 'mi'}`;
  }

  function kindPhrase(c) {
    if (c.kind === 'event') return 'Happening now';
    const label = (KIND_LABEL[c.kind] || 'Place').toLowerCase();
    return (/^[aeiou]/.test(label) ? 'An ' : 'A ') + label;
  }

  function detourPhrase(min) {
    const m = Math.round(min);
    if (m < 1) return 'barely out of your way';
    return `about ${m} minute${m === 1 ? '' : 's'} out of your way`;
  }

  function sentence(o) {
    const c = o.c;
    const liked = state.liked.has(c.name) ? ', one you liked' : '';
    let s = `${c.name}. ${kindPhrase(c)}${liked}, ${detourPhrase(o.detour)}, `
      + `${spokenDistance(o.ahead)} ahead.`;
    if (c.onNow && c.kind !== 'event') s += ` On there now: ${c.onNow.title}.`;
    if (c.kind === 'event') s += ` ${c.onNow.title}.`;
    return s;
  }

  function speak(text) {
    if (!settings.voice || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1;
      speechSynthesis.speak(u);
    } catch { /* a silent card is still a card */ }
  }

  function announce(o) {
    state.current = o;
    state.lastSpoken = now();
    state.announced.set(o.c.id, now());
    pruneAnnounced();
    // A desk rehearsal must not use up the real drive's announcements.
    if (!state.sim) writeJSON(ANNOUNCED_KEY, Object.fromEntries(state.announced));
    showSuggestion(o);
    speak(sentence(o));
  }

  function pruneAnnounced() {
    for (const [id, at] of state.announced) {
      if (now() - at > ANNOUNCE_MEMORY) state.announced.delete(id);
    }
  }

  /* ── The page ─────────────────────────────────────────── */

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('drive-status'), map: $('drive-map'), recenter: $('recenter'),
    setup: $('setup-panel'), destForm: $('dest-form'), destInput: $('dest-input'),
    card: $('suggestion'), kind: $('sug-kind'), name: $('sug-name'), facts: $('sug-facts'),
    on: $('sug-on'), go: $('sug-go'), repeat: $('sug-repeat'), mute: $('sug-mute'),
    close: $('sug-close'), dock: $('dock'), voice: $('voice-btn'), stop: $('stop-btn'),
    openSettings: $('open-settings'), sheet: $('drive-settings'),
    scrim: $('settings-backdrop'), closeSettings: $('close-settings'),
    kindChips: $('kind-chips'), detourChips: $('detour-chips'),
    cooldownChips: $('cooldown-chips'), mapsChips: $('maps-chips'),
    optEvents: $('opt-events'), optLiked: $('opt-liked'), optKm: $('opt-km'),
    simForm: $('sim-form'), simFrom: $('sim-from'), simTo: $('sim-to')
  };

  const setStatus = (text) => { el.status.textContent = text; };

  function mapsUrl(c) {
    const there = `${c.lat},${c.lon}`;
    if (settings.maps === 'apple') {
      return `https://maps.apple.com/?daddr=${encodeURIComponent(there)}&dirflg=d`;
    }
    // With a destination, the stop becomes a waypoint on the way there, so
    // the navigation app carries on to where you were going afterwards.
    let url = 'https://www.google.com/maps/dir/?api=1&travelmode=driving';
    if (state.dest) {
      url += `&destination=${encodeURIComponent(`${state.dest.lat},${state.dest.lon}`)}`
        + `&waypoints=${encodeURIComponent(there)}`;
    } else {
      url += `&destination=${encodeURIComponent(there)}`;
    }
    return url;
  }

  /* How far ahead the suggested place is now. The card is announced once but
     read many times, so it counts down with the drive, and it clears itself
     once the place is behind you: an offer you can no longer take is noise. */
  function aheadNow(o) {
    if (state.route && o.along != null && state.progress != null) return o.along - state.progress;
    if (state.pos && state.heading != null) {
      const v = toXY(o.c, state.pos), h = headingVector(state.heading);
      return v.x * h.x + v.y * h.y;
    }
    return o.ahead;
  }

  function refreshSuggestion() {
    const o = state.current;
    if (!o || el.card.hidden) return;
    const ahead = aheadNow(o);
    if (ahead < 0.2) { hideSuggestion(); return; }
    o.ahead = ahead;
    el.facts.textContent = factsLine(o);
  }

  function factsLine(o) {
    const m = Math.round(o.detour);
    return [
      m < 1 ? 'Barely a detour' : `${m} min detour`,
      `${shortDistance(o.ahead)} ahead`,
      o.c.city || ''
    ].filter(Boolean).join(' · ');
  }

  function showSuggestion(o) {
    const c = o.c;
    const liked = state.liked.has(c.name);
    el.kind.textContent = (c.kind === 'event' ? 'Happening now' : (KIND_LABEL[c.kind] || 'Place'))
      + (liked ? ' · liked' : '');
    el.name.textContent = c.name;
    el.facts.textContent = factsLine(o);
    const ev = c.onNow;
    el.on.hidden = !ev;
    if (ev) el.on.textContent = (c.kind === 'event' ? '' : 'On now: ') + ev.title;
    el.go.href = mapsUrl(c);
    el.card.hidden = false;
    highlight(c);
  }

  function hideSuggestion() {
    el.card.hidden = true;
    state.current = null;
    highlight(null);
  }

  /* ── The map ──────────────────────────────────────────── */

  let map = null, carMarker = null, routeLine = null, aheadLayer = null, pickMarker = null;
  let following = true, followTimer = null;

  const CAR_SVG = '<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true">'
    + '<circle cx="20" cy="20" r="17" class="car-halo"/>'
    + '<path d="M20 7 L30 31 L20 25 L10 31 Z" class="car-arrow"/></svg>';

  function initMap() {
    if (!window.L) { setStatus('The map failed to load.'); return; }
    map = L.map(el.map, { zoomControl: false, attributionControl: true })
      .setView([41.5048, -73.9696], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    aheadLayer = L.layerGroup().addTo(map);
    // A hand on the map means "let me look": stop following for a while.
    map.on('dragstart', () => {
      if (state.phase !== 'driving') return;
      following = false;
      el.recenter.hidden = false;
      clearTimeout(followTimer);
      followTimer = setTimeout(recenter, 30000);
    });
  }

  function recenter() {
    following = true;
    el.recenter.hidden = true;
    clearTimeout(followTimer);
    if (state.pos) follow();
  }

  function follow() {
    if (!map || !following) return;
    // Closer in when slow, further out on the highway where the next exit is
    // a few miles off.
    const z = state.speedMph > 45 ? 12 : state.speedMph > 20 ? 13 : 14;
    map.setView([state.pos.lat, state.pos.lon], z, { animate: !state.sim });
  }

  function drawCar() {
    if (!map || !state.pos) return;
    const icon = L.divIcon({ className: 'car-marker', html: CAR_SVG, iconSize: [40, 40] });
    if (!carMarker) carMarker = L.marker([state.pos.lat, state.pos.lon], { icon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    else carMarker.setLatLng([state.pos.lat, state.pos.lon]);
    const svg = carMarker.getElement()?.querySelector('svg');
    if (svg) {
      svg.style.transform = `rotate(${state.heading ?? 0}deg)`;
      svg.classList.toggle('no-heading', state.heading == null);
    }
  }

  function drawRoute() {
    if (!map) return;
    if (routeLine) routeLine.remove();
    routeLine = null;
    if (!state.route) return;
    routeLine = L.polyline(state.route.pts.map((p) => [p.lat, p.lon]), { className: 'route-line' }).addTo(map);
  }

  function drawAhead(list) {
    if (!aheadLayer) return;
    aheadLayer.clearLayers();
    for (const o of list.slice(0, 25)) {
      L.circleMarker([o.c.lat, o.c.lon], { radius: 6, className: 'ahead-dot' })
        .bindTooltip(o.c.name).addTo(aheadLayer);
    }
  }

  function highlight(c) {
    if (pickMarker) { pickMarker.remove(); pickMarker = null; }
    if (!c || !map) return;
    pickMarker = L.circleMarker([c.lat, c.lon], { radius: 11, className: 'pick-dot' }).addTo(map);
  }

  /* ── Position ─────────────────────────────────────────── */

  function onFix(p, heading, speedMps) {
    const prev = state.lastFix;
    state.pos = p;
    state.speedMph = speedMps != null && speedMps >= 0 ? speedMps * MPS_TO_MPH : state.speedMph;

    /* Heading: the GPS's own when moving (it is meaningless when parked),
       otherwise the bearing from a fix far enough back that jitter does not
       spin the car around at a red light. */
    if (heading != null && Number.isFinite(heading) && state.speedMph > 5) {
      state.heading = heading;
      state.headingFrom = p;
    } else if (state.headingFrom && haversineMiles(state.headingFrom, p) > 0.02) {
      state.heading = bearing(state.headingFrom, p);
      state.headingFrom = p;
    }
    if (!state.headingFrom) state.headingFrom = p;
    if ((speedMps == null) && prev) {
      const dt = (now() - prev.t) / 3600000;
      if (dt > 0) state.speedMph = haversineMiles(prev.p, p) / dt;
    }
    state.lastFix = { p, t: now() };

    if (state.route) trackRoute(p);
    drawCar();
    follow();

    if (state.dest && !state.route && !state.routing) routeTo(state.dest, state.destName);
    evaluate();
  }

  function trackRoute(p) {
    const at = locate(state.route, p, state.progress);
    state.progress = at.along;
    if (state.progress >= state.route.length - 0.2) {
      speak(`You have arrived at ${state.destName}.`);
      setStatus(`Arrived at ${state.destName}`);
      if (state.sim) stopSim();
      state.route = null; state.dest = null; state.progress = null;
      drawRoute();
      return;
    }
    // Off the route for three fixes running: you took a turn, so the route
    // is rebuilt from here. Not more than once a minute.
    state.offCount = at.off > 0.4 ? state.offCount + 1 : 0;
    if (state.offCount >= 3 && !state.sim && Date.now() - state.lastReroute > 60000) {
      state.offCount = 0;
      state.lastReroute = Date.now();
      routeTo(state.dest, state.destName, { quiet: true });
    }
  }

  function startWatching() {
    if (!('geolocation' in navigator)) {
      setStatus('This browser cannot share your location.');
      return;
    }
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (state.sim) return;
        const c = pos.coords;
        onFix({ lat: c.latitude, lon: c.longitude }, c.heading, c.speed);
      },
      (err) => {
        setStatus(err.code === 1
          ? 'Drive needs your location. Allow it in the browser, or try a simulated drive in settings.'
          : 'Waiting for a GPS fix…');
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
    );
  }

  /* ── Addresses and routes ─────────────────────────────── */

  async function geocode(q) {
    const res = await fetch('https://nominatim.openstreetmap.org/search'
      + `?format=json&limit=1&addressdetails=1&countrycodes=us&q=${encodeURIComponent(q)}`,
      { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('geocoder ' + res.status);
    const hits = await res.json();
    if (!hits.length) return null;
    const h = hits[0], a = h.address || {};
    /* Said aloud, so it has to sound like a place: "Hartford, Connecticut".
       The second part of display_name is often a county or a planning
       region, which nobody says. */
    const primary = h.name || a.city || a.town || a.village || h.display_name.split(',')[0];
    return {
      lat: Number(h.lat), lon: Number(h.lon),
      name: [primary, a.state].filter(Boolean).join(', ')
    };
  }

  async function fetchRoute(from, to) {
    const res = await fetch(`${OSRM}/route/v1/driving/${ll(from)};${ll(to)}`
      + '?overview=full&geometries=geojson');
    if (!res.ok) throw new Error('router ' + res.status);
    const data = await res.json();
    const r = data.routes?.[0];
    if (data.code !== 'Ok' || !r) throw new Error('router ' + data.code);
    return buildRoute(r.geometry.coordinates, { duration: r.duration });
  }

  async function routeTo(dest, name, { quiet = false, from = state.pos } = {}) {
    if (!from) return;
    state.routing = true;
    if (!quiet) setStatus(`Finding the way to ${name}…`);
    try {
      state.route = await fetchRoute(from, dest);
      state.progress = locate(state.route, from).along;
      indexRoute(state.route, state.pool);
      drawRoute();
      if (!quiet && map) map.fitBounds(L.latLngBounds(state.route.pts.map((p) => [p.lat, p.lon])), { padding: [30, 30] });
    } catch {
      setStatus('Could not find a route. Following your heading instead.');
      state.route = null;
    } finally {
      state.routing = false;
    }
  }

  /* ── A drive you can take from your desk ──────────────────
     Replays a real route at twelve times speed with the same code the car
     uses: fixes go through onFix, the clock runs fast so cooldowns and "on
     now" behave as they would, and only the source of the positions differs. */

  const SIM_MPH = 55, SIM_SPEEDUP = 12, SIM_TICK = 1000;

  function startSim(route) {
    stopSim();
    const t0 = Date.now(), c0 = Date.now();
    let along = 0;
    state.sim = {
      clock: () => c0 + (Date.now() - t0) * SIM_SPEEDUP,
      timer: setInterval(() => {
        along += SIM_MPH / 3600 * SIM_SPEEDUP * (SIM_TICK / 1000);
        const p = pointAt(route, along);
        const ahead = pointAt(route, along + 0.05);
        onFix(p, bearing(p, ahead), SIM_MPH / MPS_TO_MPH);
      }, SIM_TICK)
    };
    // A rehearsal starts from a clean slate and forgets itself afterwards:
    // neither earlier rehearsals nor real drives should silence it.
    state.lastSpoken = -Infinity;
    state.announced = new Map();
    state.detours.clear();
  }

  function stopSim() {
    if (!state.sim) return;
    clearInterval(state.sim.timer);
    state.sim = null;
    state.announced = new Map(Object.entries(readJSON(ANNOUNCED_KEY, {})));
    state.detours.clear();
    state.lastSpoken = -Infinity;
  }

  /* ── Starting and stopping ────────────────────────────── */

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* battery saver or an unsupported browser: the drive still works */ }
  }

  function beginDrive() {
    state.phase = 'driving';
    el.setup.hidden = true;
    el.dock.hidden = false;
    // Speech must start inside the tap on iOS, or every later utterance is
    // silently dropped. This first sentence is what unlocks it.
    speak(state.dest ? `Driving buddy on. Heading to ${state.destName}.` : 'Driving buddy on.');
    keepAwake();
    buildPool();
  }

  function endDrive() {
    stopSim();
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    try { state.wakeLock?.release(); } catch { /* already gone */ }
    state.wakeLock = null;
    try { speechSynthesis.cancel(); } catch { /* nothing speaking */ }
    Object.assign(state, {
      phase: 'setup', route: null, dest: null, progress: null, heading: null,
      headingFrom: null, lastFix: null, ahead: []
    });
    drawRoute();
    drawAhead([]);
    hideSuggestion();
    el.dock.hidden = true;
    el.setup.hidden = false;
    setStatus('Drive ended');
  }

  el.destForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = el.destInput.value.trim();
    state.dest = null;
    state.destName = '';
    beginDrive();
    startWatching();
    if (!q) return;
    try {
      const hit = await geocode(q);
      if (!hit) { setStatus(`No place found for “${q}”. Following your heading.`); return; }
      state.dest = hit;
      state.destName = hit.name;
      if (state.pos) routeTo(hit, hit.name);
    } catch {
      setStatus('Address lookup is unavailable. Following your heading.');
    }
  });

  el.simForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fromQ = el.simFrom.value.trim() || el.simFrom.placeholder;
    const toQ = el.simTo.value.trim() || el.simTo.placeholder;
    closeSettings();
    if (state.phase === 'driving') endDrive();
    setStatus(`Looking up ${fromQ} and ${toQ}…`);
    try {
      const [from, to] = await Promise.all([geocode(fromQ), geocode(toQ)]);
      if (!from || !to) { setStatus('Could not find one of those places.'); return; }
      state.dest = to;
      state.destName = to.name;
      state.sim = { clock: Date.now };   // so beginDrive's clock is sane
      beginDrive();
      await routeTo(to, to.name, { from });
      if (!state.route) return;
      startSim(state.route);
    } catch {
      setStatus('Could not reach the address or routing service.');
      state.sim = null;
    }
  });

  el.stop.addEventListener('click', endDrive);
  el.recenter.addEventListener('click', recenter);

  el.voice.addEventListener('click', () => {
    settings.voice = !settings.voice;
    saveSettings();
    syncVoice();
    if (!settings.voice) try { speechSynthesis.cancel(); } catch { /* ok */ }
  });
  const syncVoice = () => {
    el.voice.setAttribute('aria-pressed', String(settings.voice));
    el.voice.textContent = settings.voice ? 'Voice on' : 'Voice off';
  };

  el.repeat.addEventListener('click', () => { if (state.current) speak(sentence(state.current)); });
  el.close.addEventListener('click', hideSuggestion);
  el.mute.addEventListener('click', () => {
    const c = state.current?.c;
    if (!c) return;
    // The same mute the Places tab uses, keyed by name the way it is there.
    state.muted = new Set(readJSON(VENUES_KEY, []));
    state.muted.add(c.name);
    writeJSON(VENUES_KEY, [...state.muted]);
    hideSuggestion();
    buildPool();
    // A "no" should not cost the next suggestion its turn.
    state.lastSpoken = -Infinity;
  });

  // The phone locks, the lock is lost; coming back should take it again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.phase === 'driving') keepAwake();
  });

  /* ── Settings sheet ───────────────────────────────────── */

  function chip(label, pressed, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', onClick);
    return b;
  }

  function renderSettings() {
    el.kindChips.replaceChildren(...KINDS.map(([k, label]) =>
      chip(label, settings.kinds.has(k), () => {
        if (settings.kinds.has(k)) settings.kinds.delete(k); else settings.kinds.add(k);
        changed();
      })));
    el.detourChips.replaceChildren(...DETOURS.map((m) =>
      chip(`${m} min`, settings.maxDetour === m, () => { settings.maxDetour = m; changed(); })));
    el.cooldownChips.replaceChildren(...COOLDOWNS.map((m) =>
      chip(`Every ${m} min`, settings.cooldown === m, () => { settings.cooldown = m; changed(); })));
    el.mapsChips.replaceChildren(...MAPS.map(([id, label]) =>
      chip(label, settings.maps === id, () => { settings.maps = id; changed(); })));
    el.optEvents.checked = settings.events;
    el.optLiked.checked = settings.liked;
    el.optKm.checked = settings.km;
    syncVoice();
  }

  function changed() {
    saveSettings();
    renderSettings();
    if (state.placesReady) buildPool();
    evaluate();
  }

  el.optEvents.addEventListener('change', () => { settings.events = el.optEvents.checked; changed(); });
  el.optLiked.addEventListener('change', () => { settings.liked = el.optLiked.checked; changed(); });
  el.optKm.addEventListener('change', () => { settings.km = el.optKm.checked; changed(); });

  function openSettings() {
    el.sheet.hidden = false;
    el.scrim.hidden = false;
    requestAnimationFrame(() => { el.sheet.classList.add('is-open'); el.scrim.classList.add('is-open'); });
    el.openSettings.setAttribute('aria-expanded', 'true');
    el.closeSettings.focus();
  }

  function closeSettings() {
    el.sheet.classList.remove('is-open');
    el.scrim.classList.remove('is-open');
    el.sheet.hidden = true;
    el.scrim.hidden = true;
    el.openSettings.setAttribute('aria-expanded', 'false');
  }

  el.openSettings.addEventListener('click', openSettings);
  el.closeSettings.addEventListener('click', closeSettings);
  el.scrim.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.sheet.hidden) closeSettings(); });

  /* ── Boot ─────────────────────────────────────────────── */

  initMap();
  renderSettings();
  setStatus('Loading places…');

  Promise.all([
    fetch('data/places.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
    fetch('data/events.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  ]).then(([places, events]) => {
    state.places = (places?.items || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.name);
    state.regions = places?.meta?.regions || [];
    state.events = events?.items || [];
    state.placesReady = true;
    buildPool();
    if (state.phase === 'setup') setStatus(`${state.pool.length.toLocaleString()} places worth a stop, in Proximi's coverage`);
    else evaluate();
  }).catch(() => setStatus('The places file failed to load.'));

  // For tests and for poking at it from the console.
  window.__drive = { state, settings, buildRoute, locate, pointAt, candidatesAhead, sentence };
})();
