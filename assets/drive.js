/* Proximi Drive — a driving buddy.
 *
 * While you drive, it watches the road ahead for places worth a short detour
 * and lays them out beside a heading-up map: a deck of cards that scrolls
 * with the road, what is coming above a line that marks where you are, and
 * what you have passed below it. Nothing needs a tap once the drive starts.
 *
 * Where the answers come from:
 *   · places     data/places.json, the same directory the Places tab reads,
 *                with each place's own website picture (scripts/images.py)
 *   · on now     data/events.json, only one-off listings with a real time
 *   · routes     OSRM's public server (router.project-osrm.org), live
 *   · addresses  Nominatim, live, the same lookup the main page uses
 *   · the map    OpenFreeMap vector tiles, drawn by MapLibre GL
 *   · pictures   Wikipedia, live, for places whose site has none
 *
 * Two ways to drive, one code path. With a destination, "ahead" means further
 * along the real route and a detour rejoins that route. Without one, "ahead"
 * means a cone in the direction you are heading, and a detour rejoins a point
 * straight ahead — rougher, but it asks nothing of you.                     */

(() => {
  'use strict';

  // Singular, the way it reads on a card. Order is only for reading.
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

  /* ── What you like ───────────────────────────────────────
     The questionnaire asks about ten interests rather than twenty-two kinds
     of place, because nobody has an opinion about "landmark" versus
     "historic site". Each answer is a level, and a kind's weight is its
     interest's level times a factor for how often that kind is actually
     worth leaving the road for: 773 parks are mostly town greens, so a love
     of views counts a lookout in full and a park at half. */
  const INTERESTS = [
    { id: 'history', label: 'History', hint: 'Castles, historic houses, battlefields, monuments',
      kinds: ['castle', 'historic house', 'historic site', 'landmark'] },
    { id: 'museums', label: 'Museums and art', hint: 'Museums, galleries, sculpture parks',
      kinds: ['museum', 'gallery'] },
    { id: 'gardens', label: 'Gardens', hint: 'Arboretums, botanical and formal gardens',
      kinds: ['garden'] },
    { id: 'views', label: 'Views and nature', hint: 'Lookouts, fire towers, state parks',
      kinds: ['lookout', 'park'] },
    { id: 'animals', label: 'Animals', hint: 'Zoos, aquariums, wildlife centres',
      kinds: ['zoo'] },
    { id: 'tasting', label: 'Food and drink', hint: 'Wineries, breweries, farms and orchards',
      kinds: ['winery', 'brewery', 'farm'] },
    { id: 'thrills', label: 'Rides and thrills', hint: 'Theme parks and water parks',
      kinds: ['theme park'] },
    { id: 'browsing', label: 'Browsing', hint: 'Antique shops, bookshops, markets',
      kinds: ['antique shop', 'bookshop', 'mall', 'shop', 'library'] },
    { id: 'shows', label: 'Shows', hint: 'Music venues, theatres, cinemas',
      kinds: ['music venue', 'theatre', 'cinema'] },
    { id: 'events', label: 'Things on right now', hint: 'A fair or festival happening as you pass',
      kinds: ['event'] }
  ];

  const LEVELS = [['love', 'Love it', 3], ['some', 'Sometimes', 1.5], ['skip', 'Skip', 0]];
  const LEVEL_VALUE = Object.fromEntries(LEVELS.map(([id, , v]) => [id, v]));

  // Kinds that are usually not worth the exit even when you like the thing.
  const KIND_FACTOR = { park: 0.5, shop: 0.5, mall: 0.5, library: 0.3, cinema: 0.5, landmark: 0.8 };

  const INTEREST_OF = {};
  for (const i of INTERESTS) for (const k of i.kinds) INTEREST_OF[k] = i.id;

  const DEFAULT_LEVELS = {
    history: 'some', museums: 'some', gardens: 'some', views: 'some', animals: 'some',
    tasting: 'some', thrills: 'skip', browsing: 'skip', shows: 'skip', events: 'some'
  };

  const DETOURS = [5, 10, 15, 20];          // minutes out of your way
  const MAPS = [['google', 'Google Maps'], ['apple', 'Apple Maps']];
  const SIDES = [['left', 'Left'], ['right', 'Right']];

  const DEFAULTS = {
    levels: DEFAULT_LEVELS, maxDetour: 10, onboarded: false,
    liked: true, km: false, maps: 'google', mapSide: 'left', simSpeed: 10
  };

  const SETTINGS_KEY = 'proximi.drive.v1';
  const PHOTOS_KEY = 'proximi.drive.photos.v1';
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
  settings.levels = { ...DEFAULT_LEVELS, ...settings.levels };
  // Gone: the first version's per-kind list, and the voice and its cooldown.
  for (const k of ['kinds', 'events', 'voice', 'cooldown']) delete settings[k];
  const saveSettings = () => writeJSON(SETTINGS_KEY, settings);

  // The interest score's starting point: how much you like this kind of place.
  function kindWeight(kind) {
    const level = settings.levels[INTEREST_OF[kind]];
    return (LEVEL_VALUE[level] || 0) * (KIND_FACTOR[kind] ?? 1);
  }

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

    pos: null, heading: null, speedMph: 0, lastFix: null, headingFrom: null,
    dest: null, destName: '', route: null, progress: null, offCount: 0, lastReroute: 0,
    watchId: null, sim: null, wakeLock: null,

    detours: new Map(),        // candidate id → { min, toMin, at }
    checking: false, lastCheck: 0, routerDownUntil: 0,
    ahead: [], odo: 0
  };

  // The drive's clock. A simulated drive runs faster than real time, and the
  // detour cache and "on now" windows should run with it rather than the wall.
  const now = () => (state.sim ? state.sim.clock() : Date.now());

  /* ── What is worth a stop ─────────────────────────────── */

  function interest(c) {
    if (state.muted.has(c.name)) return 0;
    const liked = state.liked.has(c.name);
    let s = kindWeight(c.kind);
    if (!s && liked && settings.liked) s = 1;
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

  // A detour is measured against the road, not the car, so it holds while
  // you approach; fifteen minutes lets the deck show it without re-asking.
  const DETOUR_TTL = 15 * 60000;

  async function checkNext(list) {
    const t = Date.now();
    if (state.checking || t - state.lastCheck < 1200 || t < state.routerDownUntil) return;
    const next = list.slice(0, 10).find((o) => {
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

  /* ── Deciding what goes on the deck ───────────────────────
     Once a second: find what is ahead, ask the router about the best of it,
     and admit whatever is worth the detour. Admission happens well before a
     place is on screen (the lookahead is fifteen minutes of driving and the
     deck shows four miles), so every card is built, measured and has its
     picture loading before it scrolls into view. */

  const MAX_UPCOMING = 10;

  function evaluate() {
    if (state.phase !== 'driving' || !state.pos) return;
    if (now() - (state.poolBuiltAt || 0) > 5 * 60000) buildPool();

    const list = candidatesAhead();
    state.ahead = list;

    const eligible = [];
    for (const o of list) {
      const d = state.detours.get(o.c.id);
      if (!d || now() - d.at > DETOUR_TTL || d.min > settings.maxDetour) continue;
      eligible.push({ ...o, detour: d.min, score: o.c._score - d.min * 0.15 });
    }
    eligible.sort((a, b) => b.score - a.score);
    for (const o of eligible) admit(o);

    checkNext(list);
    statusForDrive(eligible.length);
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
  // an empty deck should read as "not covered" rather than "nothing here".
  function coveredNear(p) {
    const regions = state.regions || [];
    if (!regions.length) return true;
    return regions.some((r) => haversineMiles(p, r) <= (r.radiusMiles || 40) + 15);
  }

  const distValue = (mi) => (settings.km ? mi * 1.609344 : mi);

  function shortDistance(mi) {
    const d = distValue(Math.abs(mi));
    return `${d < 10 ? d.toFixed(1) : Math.round(d)} ${settings.km ? 'km' : 'mi'}`;
  }

  /* ── The page ─────────────────────────────────────────── */

  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('drive-status'), main: $('drive-main'), slice: $('map-slice'), map: $('drive-map'),
    car: $('map-car'),
    setup: $('setup-panel'), destForm: $('dest-form'), destInput: $('dest-input'),
    deck: $('deck'), deckList: $('deck-list'), deckEmpty: $('deck-empty'), deckNow: $('deck-now'),
    dock: $('dock'), stop: $('stop-btn'),
    simCtl: $('sim-ctl'), simSlower: $('sim-slower'), simFaster: $('sim-faster'), simSpeed: $('sim-speed'),
    openSettings: $('open-settings'), sheet: $('drive-settings'),
    scrim: $('settings-backdrop'), closeSettings: $('close-settings'),
    levels: $('interest-levels'), retake: $('retake-quiz'),
    detourChips: $('detour-chips'), sideChips: $('side-chips'), mapsChips: $('maps-chips'),
    optLiked: $('opt-liked'), optKm: $('opt-km'),
    simForm: $('sim-form'), simFrom: $('sim-from'), simTo: $('sim-to'),
    quiz: $('quiz'), quizStep: $('quiz-step'), quizTitle: $('quiz-title'),
    quizLede: $('quiz-lede'), quizBody: $('quiz-body'), quizBack: $('quiz-back'), quizNext: $('quiz-next')
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

  /* ── The deck ─────────────────────────────────────────────
     A strip of road, drawn as cards. The line across the middle is where you
     are: a card's height above it is how far ahead its place is, so what is
     coming slides down towards the line, the place beside you sits on it,
     and what you have passed carries on below until it leaves the screen.
     Nothing jumps: positions are recomputed every frame from a distance that
     is itself interpolated between GPS fixes. An empty stretch of road is an
     empty stretch of deck. */

  const VIEW_MILES = 4;      // road shown between the line and the top of the deck
  const GAP = 10;

  const entries = new Map();   // id → deck entry
  let letterNext = 0;

  // Where an entry's place is now, relative to you, in miles along the road.
  function aheadOf(e) {
    if (e.along != null && state.route && disp.progress != null) return e.along - disp.progress;
    return e.aheadAt - (disp.odo - e.odoAt);
  }

  function admit(o) {
    if (entries.has(o.c.id)) return;
    const upcoming = [...entries.values()].filter((e) => aheadOf(e) > 0);
    if (upcoming.length >= MAX_UPCOMING) {
      // Full: a newcomer has to clearly beat the weakest card that is still
      // off the top of the screen. A card already in view is never swapped out.
      const offTop = upcoming.filter((e) => aheadOf(e) > VIEW_MILES + 1);
      const weakest = offTop.sort((a, b) => a.score - b.score)[0];
      if (!weakest || o.score <= weakest.score + 1) return;
      drop(weakest);
    }
    const e = {
      c: o.c, score: o.score, detour: o.detour,
      along: state.route && o.along != null ? o.along : null,
      aheadAt: o.ahead, odoAt: disp.odo,
      letter: String.fromCharCode(65 + (letterNext++ % 26)),
      y: null
    };
    e.li = cardFor(e);
    el.deckList.appendChild(e.li);
    e.pin = pinFor(e);
    entries.set(o.c.id, e);
    wantPhoto(o.c);
  }

  function drop(e, how = 'is-fading') {
    entries.delete(e.c.id);
    e.pin?.remove();
    e.li.classList.add(how);
    setTimeout(() => e.li.remove(), 600);
  }

  function clearDeck() {
    for (const e of [...entries.values()]) drop(e);
    letterNext = 0;
  }

  function cardFor(e) {
    const li = document.createElement('li');
    li.className = 'deck-card';
    li.dataset.id = e.c.id;
    li.innerHTML = `
      <div class="deck-photo"></div>
      <div class="deck-body">
        <p class="deck-kind"><span class="deck-letter"></span><span class="deck-kind-t"></span></p>
        <h3 class="deck-name"></h3>
        <p class="deck-facts"></p>
        <p class="deck-blurb"></p>
        <p class="deck-on" hidden></p>
        <div class="deck-actions">
          <a class="deck-go" target="_blank" rel="noopener">Go</a>
          <button type="button" class="deck-no">Not for me</button>
        </div>
      </div>`;
    const c = e.c;
    li.querySelector('.deck-letter').textContent = e.letter;
    li.querySelector('.deck-name').textContent = c.name;
    li.querySelector('.deck-kind-t').textContent =
      (c.kind === 'event' ? 'Happening now' : (KIND_LABEL[c.kind] || 'Place'))
      + (state.liked.has(c.name) ? ' · liked' : '');
    if (c.onNow) {
      const on = li.querySelector('.deck-on');
      on.hidden = false;
      on.textContent = (c.kind === 'event' ? '' : 'On now: ') + c.onNow.title;
    }
    li.querySelector('.deck-go').href = mapsUrl(c);
    fillPhoto(li, c);
    return li;
  }

  /* Card positions, every frame. Each card wants its centre at its distance
     up from the line; two places close together cannot both have that, so
     the positions are the closest ones that keep every card in order and a
     gap apart. That is isotonic regression (pool-adjacent-violators): cards
     that would overlap are pooled and share their average, which moves
     continuously as the distances do, so cards ease apart and together
     rather than snapping. */
  function layoutDeck(dt = 16) {
    const h = el.deckList.clientHeight;
    if (!h) return;
    const mid = h / 2;
    const cardH = cardHeight();
    const pxPerMile = mid / VIEW_MILES;
    const behindLimit = -(mid + cardH) / pxPerMile;

    const live = [];
    for (const e of entries.values()) {
      const a = aheadOf(e);
      if (a < behindLimit) { drop(e, 'is-gone'); continue; }
      e.ahead = a;
      live.push(e);
    }
    // Top of the screen first.
    live.sort((a, b) => b.ahead - a.ahead);
    const step = cardH + GAP;
    const want = live.map((e, i) => (mid - e.ahead * pxPerMile - cardH / 2) - i * step);
    const fit = isotonic(want);
    let nearest = null;
    /* The fit is continuous while the road is, but a card arriving or leaving
       re-pools its neighbours, and their targets move a whole card at once.
       So each card is pulled towards its target by a critically damped
       spring: the fastest settle that never overshoots, and one whose speed
       changes smoothly, so a card eases out and eases in rather than
       lurching off. On a steady road the spring just follows, a fraction of
       a second behind. */
    const w = 8, t = Math.min(dt, 50) / 1000;
    live.forEach((e, i) => {
      const target = fit[i] + i * step;
      if (e.y == null) { e.y = target; e.vy = 0; }
      e.vy += (w * w * (target - e.y) - 2 * w * e.vy) * t;
      e.y += e.vy * t;
      const y = e.y;
      e.li.style.height = `${cardH}px`;
      e.li.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0)`;
      e.li.classList.toggle('is-past', e.ahead < -0.15);
      e.li.querySelector('.deck-facts').textContent = factsLine(e);
      if (!nearest || Math.abs(e.ahead) < Math.abs(nearest.ahead)) nearest = e;
    });
    for (const e of live) e.li.classList.toggle('is-nearest', e === nearest && Math.abs(e.ahead) < VIEW_MILES);
    el.deckEmpty.hidden = state.phase !== 'driving' || live.some((e) => e.y > -cardH && e.y < h);
    if (!el.deckEmpty.hidden) {
      el.deckEmpty.textContent = state.placesReady
        ? 'Nothing worth a stop on this stretch. Watching the road.'
        : 'Loading places…';
    }
  }

  // Least-squares non-decreasing fit, by pooling adjacent violators.
  function isotonic(v) {
    const blocks = [];
    for (const x of v) {
      blocks.push({ sum: x, n: 1 });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
        if (a.sum / a.n <= b.sum / b.n) break;
        a.sum += b.sum; a.n += b.n;
        blocks.pop();
      }
    }
    const out = [];
    for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
    return out;
  }

  // Three cards to a screen, give or take: two clear and one arriving.
  const cardHeight = () => Math.max(170, Math.min(250, el.deckList.clientHeight / 3.1));

  function factsLine(e) {
    const m = Math.round(e.detour);
    const detour = m < 1 ? 'Barely a detour' : `${m} min detour`;
    if (e.ahead < -0.15) return `${detour} · passed ${shortDistance(e.ahead)} back`;
    if (e.ahead < 0.15) return `${detour} · beside you now`;
    return `${detour} · ${shortDistance(e.ahead)} ahead`;
  }

  el.deckList.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.deck-no');
    if (!btn) return;
    const e = entries.get(btn.closest('.deck-card').dataset.id);
    if (!e) return;
    // The same mute the Places tab uses, keyed by name the way it is there.
    state.muted = new Set(readJSON(VENUES_KEY, []));
    state.muted.add(e.c.name);
    writeJSON(VENUES_KEY, [...state.muted]);
    drop(e);
    buildPool();
  });

  /* ── Pictures ─────────────────────────────────────────────
     Two sources, best first. The place's own website's picture, found at
     build time by scripts/images.py and shipped in data/places.json, so it
     is there before the card is. Failing that, Wikipedia, live: a search by
     name, believed only if the article's coordinates are close ("Olana"
     three miles away is Olana; a same-named article two states over is
     not). Wikipedia is asked about every card anyway for its one-line
     description. Answers, including "no article", are kept on the phone. */

  const photos = new Map(Object.entries(readJSON(PHOTOS_KEY, {})));
  const photoQueue = [];
  let photoBusy = false, photoPauseUntil = 0;

  const GENERIC = new Set(['house', 'museum', 'park', 'state', 'historic', 'site', 'center',
    'centre', 'farm', 'farms', 'winery', 'garden', 'gardens', 'the', 'and', 'memorial',
    'national', 'historical', 'society', 'county', 'village', 'town', 'city', 'hill']);
  const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !GENERIC.has(w)));

  function wantPhoto(c) {
    // Fetch the site's own picture now, so it is decoded before it is seen.
    if (c.image) { const img = new Image(); img.src = c.image; }
    if (photos.has(c.id) || photoQueue.some((q) => q.id === c.id)) return;
    photoQueue.push(c);
    pumpPhotos();
  }

  async function pumpPhotos() {
    if (photoBusy || !photoQueue.length) return;
    const wait = photoPauseUntil - Date.now();
    if (wait > 0) { setTimeout(pumpPhotos, wait); return; }
    photoBusy = true;
    const c = photoQueue.shift();
    try {
      const p = await lookupPhoto(c);
      photos.set(c.id, p);
      while (photos.size > 500) photos.delete(photos.keys().next().value);
      writeJSON(PHOTOS_KEY, Object.fromEntries(photos));
      if (p.img && !c.image) { const img = new Image(); img.src = p.img; }
      const e = entries.get(c.id);
      if (e) fillPhoto(e.li, c);
      photoPauseUntil = Date.now() + 1000;
    } catch {
      // Throttled or offline: try this one again later, and back off.
      photoQueue.push(c);
      photoPauseUntil = Date.now() + 20000;
    } finally {
      photoBusy = false;
      if (photoQueue.length) setTimeout(pumpPhotos, 50);
    }
  }

  async function lookupPhoto(c) {
    const q = new URLSearchParams({
      action: 'query', generator: 'search', gsrsearch: c.name, gsrlimit: '4',
      prop: 'pageimages|coordinates|description', piprop: 'thumbnail', pithumbsize: '480',
      format: 'json', origin: '*'
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${q}`, {
      // Wikimedia asks browser clients to say who they are this way.
      headers: { 'Api-User-Agent': 'Proximi/1.0 (https://github.com/StarrySidekick/Proximi)' }
    });
    if (!res.ok) throw new Error('wikipedia ' + res.status);
    const data = await res.json();
    const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
    const mine = tokens(c.name);
    for (const pg of pages) {
      const at = pg.coordinates?.[0];
      if (!at) continue;
      const d = haversineMiles(c, { lat: at.lat, lon: at.lon });
      const shared = [...tokens(pg.title)].some((w) => mine.has(w));
      if (d <= 0.5 || (d <= 3 && shared)) {
        return { img: pg.thumbnail?.source || null, desc: pg.description || null, title: pg.title };
      }
    }
    return {};
  }

  // Simple outline glyphs for a card with no photo, by interest.
  const GLYPHS = {
    history: '<path d="M6 30V14l6-4 6 4v16M18 30V10l6-5 6 5v20M3 30h30" />',
    museums: '<path d="M4 13 18 5l14 8M6 13v14M12 13v14M24 13v14M30 13v14M3 29h30" />',
    gardens: '<path d="M18 30V16M18 16c-6 0-9-4-9-9 5 0 9 3 9 9Zm0 0c6 0 9-4 9-9-5 0-9 3-9 9ZM10 30h16" />',
    views: '<path d="M3 29 13 13l6 9 4-5 10 12ZM24 9a3 3 0 1 0 0 .1" />',
    animals: '<path d="M10 14a3 3 0 1 0 0 .1M26 14a3 3 0 1 0 0 .1M14 9a3 3 0 1 0 0 .1M22 9a3 3 0 1 0 0 .1M18 17c-5 0-8 6-8 9s3 3 8 3 8 0 8-3-3-9-8-9Z" />',
    tasting: '<path d="M12 5h12l-1 9a5 5 0 0 1-10 0ZM18 19v10M12 30h12" />',
    thrills: '<path d="M4 30C8 10 14 6 18 6s10 4 14 24M9 30V18M18 30V6M27 30V18" />',
    browsing: '<path d="M6 8h24v22H6ZM6 14h24M13 8v6M23 8v6" />',
    shows: '<path d="M6 7h24v14c0 5-5 9-12 9S6 26 6 21ZM12 14h3M21 14h3M13 21c3 2 7 2 10 0" />',
    events: '<path d="M6 30 12 6h12l6 24M9 18h18M18 6V3" />'
  };

  function fillPhoto(li, c) {
    const box = li.querySelector('.deck-photo');
    const wiki = photos.get(c.id);
    li.querySelector('.deck-blurb').textContent = wiki?.desc || c.description || c.city || '';
    const src = c.image || wiki?.img;
    const credit = c.image ? { text: 'Their site', href: c.url }
      : wiki?.img ? { text: 'Wikipedia', href: `https://en.wikipedia.org/wiki/${encodeURIComponent(wiki.title.replace(/ /g, '_'))}` }
      : null;
    if (src && box.dataset.src !== src && box.dataset.failed !== src) {
      box.dataset.src = src;
      box.classList.remove('is-glyph');
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.src = src;
      // A site's picture can move or refuse strangers; fall back, never show a
      // broken image.
      img.onerror = () => {
        box.dataset.failed = src;
        delete box.dataset.src;
        if (c.image === src) { c.image = null; fillPhoto(li, c); } else glyph(box, c);
      };
      const a = document.createElement('a');
      a.className = 'deck-credit';
      a.href = credit.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = credit.text;
      box.replaceChildren(img, a);
      return;
    }
    if (!src) glyph(box, c);
  }

  function glyph(box, c) {
    if (box.classList.contains('is-glyph')) return;
    box.classList.add('is-glyph');
    const interest = c.kind === 'event' ? 'events' : INTEREST_OF[c.kind] || 'history';
    box.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true">${GLYPHS[interest]}</svg>`;
  }

  /* ── The map ──────────────────────────────────────────────
     Vector tiles, drawn by MapLibre GL. The earlier map was raster tiles:
     pictures with the street names painted in, so turning the map turned
     the names upside down. Vector tiles arrive as shapes and words, and the
     words are laid out fresh for every frame, upright whatever the bearing.
     The bearing is the heading, so the road ahead is always up, and the
     camera's padding puts the car low in the strip to leave room for what
     is coming. Tiles from OpenFreeMap: free, no key. */

  const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  const PIVOT_Y = 0.78;    // where the car sits, as a fraction down the strip

  let map = null, mapReady = false, pendingRoute = null;

  function initMap() {
    if (!window.maplibregl) { setStatus('The map failed to load.'); return; }
    try {
      map = new maplibregl.Map({
        container: el.map, style: STYLE_URL,
        center: [-73.9696, 41.5048], zoom: 12, bearing: 0,
        interactive: false, fadeDuration: 0,
        attributionControl: { compact: true }
      });
    } catch {
      // No WebGL: the deck still works, the strip just stays blank.
      map = null;
      el.slice.classList.add('no-map');
      return;
    }
    map.on('load', () => {
      mapReady = true;
      // The Victorian desk's parchment under the roads, where the style allows.
      try { map.setPaintProperty('background', 'background-color', '#EFEADA'); } catch { /* style without one */ }
      map.addSource('route', { type: 'geojson', data: emptyLine() });
      map.addLayer({
        id: 'route', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2F5F9E', 'line-width': 7, 'line-opacity': 0.85 }
      });
      if (pendingRoute) setRouteLine(pendingRoute);
      // The credit starts as its small "i", not a box over the road.
      el.map.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    });
    map.on('error', () => { /* a missing tile is not worth a word */ });
    new ResizeObserver(() => { map?.resize(); placeCar(); }).observe(el.slice);
    placeCar();
  }

  const emptyLine = () => ({ type: 'FeatureCollection', features: [] });

  function setRouteLine(route) {
    pendingRoute = route;
    if (!mapReady) return;
    map.getSource('route').setData(route ? {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: route.pts.map((p) => [p.lon, p.lat]) }
    } : emptyLine());
  }

  // The car is not on the map: it is fixed in the strip, and the map moves
  // under it. That is what keeps it perfectly still while everything turns.
  function placeCar() {
    el.car.style.top = `${PIVOT_Y * 100}%`;
  }

  function camera() {
    if (!map || !disp.pos) return;
    const h = el.slice.clientHeight;
    map.jumpTo({
      center: [disp.pos.lon, disp.pos.lat],
      bearing: disp.heading ?? 0,
      zoom: disp.zoom,
      // Padding moves the focal point: top padding P puts the centre at
      // P + (h - P) / 2, so this puts it at PIVOT_Y of the way down.
      padding: { top: Math.max(0, (2 * PIVOT_Y - 1) * h), bottom: 0, left: 0, right: 0 }
    });
  }

  // The deck's letters on the map. MapLibre keeps HTML markers upright.
  function pinFor(e) {
    if (!map) return null;
    const node = document.createElement('div');
    node.className = 'deck-pin';
    node.textContent = e.letter;
    return new maplibregl.Marker({ element: node }).setLngLat([e.c.lon, e.c.lat]).addTo(map);
  }

  /* ── Motion ───────────────────────────────────────────────
     GPS arrives about once a second; the screen redraws sixty times a
     second. Drawing only on a fix is what made everything click from one
     position to the next. So a fix sets where things are going, and every
     frame draws where they are on the way: position, distance travelled
     and progress along the route slide linearly from the last drawn value
     to the new fix over the time the fix took to arrive, and the heading
     eases round. The picture runs about one fix behind the GPS, which is
     the price of never jumping. */

  const disp = { pos: null, heading: null, progress: null, odo: 0, zoom: 13 };
  const tween = { from: null, to: null, t0: 0, dur: 1000, lastAt: 0 };
  let frameId = null, lastFrame = 0, lastEval = 0;

  function retarget() {
    const t = performance.now();
    const gap = tween.lastAt ? t - tween.lastAt : 1000;
    tween.lastAt = t;
    const to = { pos: state.pos, progress: state.progress, odo: state.odo };
    if (!disp.pos) {
      Object.assign(disp, to, { heading: state.heading });
      tween.from = tween.to = to;
      return;
    }
    tween.from = { pos: disp.pos, progress: disp.progress, odo: disp.odo };
    tween.to = to;
    tween.t0 = t;
    tween.dur = Math.max(100, Math.min(2500, gap));
  }

  const lerp = (a, b, k) => a + (b - a) * k;

  function frame(t) {
    frameId = requestAnimationFrame(frame);
    const dt = lastFrame ? Math.min(100, t - lastFrame) : 16;
    lastFrame = t;
    if (state.sim) state.sim.step(dt);

    if (tween.to) {
      const k = Math.min(1, (t - tween.t0) / tween.dur);
      const f = tween.from, g = tween.to;
      disp.pos = { lat: lerp(f.pos.lat, g.pos.lat, k), lon: lerp(f.pos.lon, g.pos.lon, k) };
      disp.odo = lerp(f.odo, g.odo, k);
      disp.progress = f.progress != null && g.progress != null ? lerp(f.progress, g.progress, k) : g.progress;
    }
    if (state.heading != null) {
      if (disp.heading == null) disp.heading = state.heading;
      const diff = ((state.heading - disp.heading) % 360 + 540) % 360 - 180;
      disp.heading = (disp.heading + diff * (1 - Math.exp(-dt / 350)) + 360) % 360;
    }
    // Closer in when slow, further out on the highway; eased, never stepped.
    const zTarget = state.speedMph > 45 ? 12.3 : state.speedMph > 20 ? 13.2 : 14;
    disp.zoom += (zTarget - disp.zoom) * (1 - Math.exp(-dt / 1500));

    camera();
    layoutDeck(dt);
    if (t - lastEval > 1000) { lastEval = t; evaluate(); }
  }

  function startFrames() {
    if (frameId == null) { lastFrame = 0; frameId = requestAnimationFrame(frame); }
  }

  function stopFrames() {
    if (frameId != null) cancelAnimationFrame(frameId);
    frameId = null;
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
    if (prev) {
      const moved = haversineMiles(prev.p, p);
      state.odo += moved;
      if (speedMps == null) {
        const dt = (now() - prev.t) / 3600000;
        if (dt > 0) state.speedMph = moved / dt;
      }
    }
    state.lastFix = { p, t: now() };

    if (state.route) trackRoute(p);
    retarget();

    if (state.dest && !state.route && !state.routing) routeTo(state.dest, state.destName);
  }

  function trackRoute(p) {
    const at = locate(state.route, p, state.progress);
    state.progress = at.along;
    if (state.progress >= state.route.length - 0.2) {
      setStatus(`Arrived at ${state.destName}`);
      if (state.sim) stopSim();
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
      const route = await fetchRoute(from, dest);
      /* Cards already on the deck measured themselves in miles along the old
         route, which mean nothing on this one. Carry each over as a distance
         ahead right now, counted down by the odometer from here on. */
      for (const e of entries.values()) {
        e.aheadAt = aheadOf(e); e.odoAt = disp.odo; e.along = null;
      }
      state.route = route;
      state.progress = locate(state.route, from).along;
      disp.progress = state.progress;
      if (tween.to) { tween.from.progress = state.progress; tween.to.progress = state.progress; }
      indexRoute(state.route, state.pool);
      setRouteLine(state.route);
    } catch {
      setStatus('Could not find a route. Following your heading instead.');
      state.route = null;
    } finally {
      state.routing = false;
    }
  }

  /* ── A drive you can take from your desk ──────────────────
     Replays a real route through the same code the car uses: positions go
     through onFix, four times a second, and are smoothed like GPS. The
     clock runs as fast as the drive, so detours and "on now" behave as they
     would. The speed can change mid-drive: the clock keeps its place and
     only its rate changes. */

  const SIM_MPH = 55;
  const SIM_SPEEDS = [1, 2, 5, 10, 20, 40];
  const SIM_FIX_MS = 250;

  function startSim(route) {
    stopSim();
    let along = 0, sinceFix = SIM_FIX_MS, simT = Date.now(), realT = Date.now();
    const sim = {
      speed: SIM_SPEEDS.includes(settings.simSpeed) ? settings.simSpeed : 10,
      clock: () => simT + (Date.now() - realT) * sim.speed,
      setSpeed(v) { simT = sim.clock(); realT = Date.now(); sim.speed = v; },
      step(dt) {
        along += SIM_MPH / 3600 * sim.speed * (dt / 1000);
        sinceFix += dt;
        if (sinceFix < SIM_FIX_MS) return;
        sinceFix = 0;
        const p = pointAt(route, along);
        onFix(p, bearing(p, pointAt(route, along + 0.05)), SIM_MPH / MPS_TO_MPH);
      }
    };
    state.sim = sim;
    state.detours.clear();
    el.simCtl.hidden = false;
    syncSimSpeed();
  }

  function stopSim() {
    if (!state.sim) return;
    state.sim = null;
    state.detours.clear();
    el.simCtl.hidden = true;
  }

  function syncSimSpeed() {
    const v = state.sim?.speed ?? settings.simSpeed;
    el.simSpeed.textContent = `${v}×`;
    el.simSlower.disabled = v <= SIM_SPEEDS[0];
    el.simFaster.disabled = v >= SIM_SPEEDS[SIM_SPEEDS.length - 1];
  }

  function nudgeSpeed(dir) {
    if (!state.sim) return;
    const i = SIM_SPEEDS.indexOf(state.sim.speed);
    const next = SIM_SPEEDS[Math.max(0, Math.min(SIM_SPEEDS.length - 1, i + dir))];
    state.sim.setSpeed(next);
    settings.simSpeed = next;
    saveSettings();
    syncSimSpeed();
  }

  el.simSlower.addEventListener('click', () => nudgeSpeed(-1));
  el.simFaster.addEventListener('click', () => nudgeSpeed(1));

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
    el.main.classList.add('is-driving');
    keepAwake();
    buildPool();
    startFrames();
  }

  function endDrive() {
    stopSim();
    if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
    try { state.wakeLock?.release(); } catch { /* already gone */ }
    state.wakeLock = null;
    stopFrames();
    Object.assign(state, {
      phase: 'setup', route: null, dest: null, progress: null, heading: null,
      headingFrom: null, lastFix: null, ahead: [], odo: 0
    });
    Object.assign(disp, { pos: null, heading: null, progress: null, odo: 0 });
    tween.to = null; tween.lastAt = 0;
    setRouteLine(null);
    clearDeck();
    el.dock.hidden = true;
    el.setup.hidden = false;
    el.main.classList.remove('is-driving');
    el.deckEmpty.hidden = true;
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
      await routeTo(to, to.name, { from });
      if (!state.route) return;
      startSim(state.route);
      beginDrive();
    } catch {
      setStatus('Could not reach the address or routing service.');
    }
  });

  el.stop.addEventListener('click', endDrive);

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

  // A three-way switch per interest, used by the questionnaire and the
  // settings sheet alike, so the two can never disagree about what you said.
  function levelRows(onChange) {
    return INTERESTS.map((it) => {
      const row = document.createElement('div');
      row.className = 'level-row';
      row.innerHTML = `<p class="level-name">${it.label}<span>${it.hint}</span></p>`;
      const seg = document.createElement('div');
      seg.className = 'level-seg';
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', it.label);
      for (const [id, label] of LEVELS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.level = id;
        b.textContent = label;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(settings.levels[it.id] === id));
        b.addEventListener('click', () => {
          settings.levels[it.id] = id;
          for (const x of seg.children) x.setAttribute('aria-checked', String(x === b));
          onChange();
        });
        seg.appendChild(b);
      }
      row.dataset.interest = it.id;
      row.appendChild(seg);
      return row;
    });
  }

  function renderSettings() {
    el.levels.replaceChildren(...levelRows(changed));
    el.detourChips.replaceChildren(...DETOURS.map((m) =>
      chip(`${m} min`, settings.maxDetour === m, () => { settings.maxDetour = m; changed(); })));
    el.sideChips.replaceChildren(...SIDES.map(([id, label]) =>
      chip(label, settings.mapSide === id, () => { settings.mapSide = id; changed(); })));
    el.mapsChips.replaceChildren(...MAPS.map(([id, label]) =>
      chip(label, settings.maps === id, () => { settings.maps = id; changed(); })));
    el.optLiked.checked = settings.liked;
    el.optKm.checked = settings.km;
    el.main.dataset.side = settings.mapSide;
    syncSimSpeed();
  }

  function changed() {
    saveSettings();
    renderSettings();
    if (state.placesReady) buildPool();
    // A narrower taste should take away what no longer qualifies.
    for (const e of [...entries.values()]) if (!(interest(e.c) > 0)) drop(e);
  }

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

  /* ── The questionnaire ────────────────────────────────────
     Asked once, before the first drive, because a driving buddy that does
     not know what you like has two bad options: show everything, or guess.
     Three short pages, every answer a tap, and every one of them lives on in
     the settings sheet afterwards. */

  const QUIZ = [
    {
      title: 'What makes you pull over?',
      lede: 'Only places you like will show up. Love it counts for the most.',
      body: () => levelRows(() => {})
    },
    {
      title: 'How far out of your way?',
      lede: 'The longest detour worth showing, there and back to the road.',
      body: () => DETOURS.map((m) => choice(`${m} minutes`,
        { 5: 'Right off the exit', 10: 'A short hop', 15: 'Worth a little effort', 20: 'I have time' }[m],
        settings.maxDetour === m, () => { settings.maxDetour = m; }))
    },
    {
      title: 'Which side for the map?',
      lede: 'The map takes a narrow strip; the places take the rest. Put the map nearest the driver.',
      body: () => SIDES.map(([id, label]) => choice(label, id === 'left' ? 'Map on the left, places on the right' : 'Places on the left, map on the right',
        settings.mapSide === id, () => { settings.mapSide = id; }))
    }
  ];

  let quizAt = 0;

  // One big answer button; picking it marks it and clears its siblings.
  function choice(label, sub, on, pick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quiz-choice';
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = '<strong></strong><span></span>';
    b.firstChild.textContent = label;
    b.lastChild.textContent = sub;
    b.addEventListener('click', () => {
      pick();
      for (const x of b.parentNode.children) x.setAttribute('aria-pressed', String(x === b));
    });
    return b;
  }

  function showQuiz(at = 0) {
    quizAt = at;
    const page = QUIZ[at];
    el.quizStep.textContent = `${at + 1} of ${QUIZ.length}`;
    el.quizTitle.textContent = page.title;
    el.quizLede.textContent = page.lede;
    el.quizBody.replaceChildren(...page.body());
    el.quizBack.hidden = at === 0;
    el.quizNext.textContent = at === QUIZ.length - 1 ? 'Done' : 'Next';
    el.quiz.hidden = false;
    el.quizBody.scrollTop = 0;
  }

  el.quizBack.addEventListener('click', () => showQuiz(Math.max(0, quizAt - 1)));
  el.quizNext.addEventListener('click', () => {
    if (quizAt < QUIZ.length - 1) { showQuiz(quizAt + 1); return; }
    settings.onboarded = true;
    el.quiz.hidden = true;
    changed();
  });
  el.retake.addEventListener('click', () => { closeSettings(); showQuiz(0); });

  /* ── Boot ─────────────────────────────────────────────── */

  renderSettings();
  initMap();
  setStatus('Loading places…');
  if (!settings.onboarded) showQuiz(0);

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
  }).catch(() => setStatus('The places file failed to load.'));

  // For tests and for poking at it from the console.
  window.__drive = {
    state, settings, disp, entries, buildRoute, locate, pointAt, candidatesAhead,
    kindWeight, photos, isotonic, get map() { return map; }
  };
})();
