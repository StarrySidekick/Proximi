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

  /* ── What you like ───────────────────────────────────────
     Two levels of it. The questionnaire asks about eleven interests, because
     nobody has an opinion about "landmark" versus "historic site". Settings
     then go one finer, to types of place, because within an interest people
     do: someone who loves history may not want every war memorial on the
     way, and does want the 1740s house beside it.

     A type is a kind from the directory, narrowed by the place's name where
     the name says what it is. The directory's kinds come from OpenStreetMap
     tags, and "historic site" holds memorials, lighthouses, historic
     districts, churches and forts alongside actual buildings; "park" holds
     state parks, wildlife management areas and town greens. The names
     separate them well: 105 "memorial" and 55 "monument" among the historic
     sites, 201 "wildlife" among the parks. First matching type wins, so the
     narrow ones come before their kind's catch-all.

     A type's weight is its interest's level times its factor: how often a
     place of that type is worth leaving the road for. */
  const INTERESTS = [
    { id: 'history', label: 'History', hint: 'Castles, historic houses, forts, lighthouses, memorials' },
    { id: 'museums', label: 'Museums and art', hint: 'Museums, galleries, historical societies' },
    { id: 'gardens', label: 'Gardens', hint: 'Arboretums, botanical and formal gardens' },
    { id: 'views', label: 'Views and nature', hint: 'Lookouts, fire towers, state parks' },
    { id: 'animals', label: 'Animals', hint: 'Zoos, aquariums, wildlife centres' },
    { id: 'tasting', label: 'Wineries, breweries and farms', hint: 'Tastings, orchards, farm stands' },
    { id: 'eating', label: 'Places to eat', hint: 'Restaurants and cafés' },
    { id: 'thrills', label: 'Rides and thrills', hint: 'Theme parks and water parks' },
    { id: 'browsing', label: 'Browsing', hint: 'Antique shops, bookshops, thrift shops, markets' },
    { id: 'shows', label: 'Shows', hint: 'Music venues, theatres, cinemas' },
    { id: 'events', label: 'Things on right now', hint: 'A fair or festival happening as you pass' }
  ];

  const TYPES = [
    // History
    { id: 'castle', label: 'Castles', one: 'Castle', interest: 'history', kinds: ['castle'] },
    { id: 'memorial', label: 'Memorials and monuments', one: 'Memorial', interest: 'history', factor: 0.6,
      kinds: ['historic site', 'landmark', 'park'],
      name: /\b(memorial|monument|statue|veterans?|soldiers?|sailors|war|obelisk|cenotaph|plaque|marker|tablet|honor roll)\b/i },
    { id: 'lighthouse', label: 'Lighthouses', one: 'Lighthouse', interest: 'history',
      kinds: ['historic site', 'landmark', 'lookout'], name: /\b(light(house)?|lights)\b/i },
    { id: 'fort', label: 'Forts and battlefields', one: 'Fort or battlefield', interest: 'history',
      kinds: ['historic site', 'landmark', 'park'], name: /\b(fort|battle(field)?|redoubt|encampment|garrison)\b/i },
    { id: 'district', label: 'Historic districts', one: 'Historic district', interest: 'history', factor: 0.5,
      kinds: ['historic site'], name: /\bdistrict\b/i },
    { id: 'church', label: 'Old churches and meeting houses', one: 'Old church', interest: 'history', factor: 0.7,
      kinds: ['historic site', 'landmark'], name: /\b(church|chapel|meeting ?house|synagogue|cathedral|parish)\b/i },
    { id: 'building', label: 'Historic houses and buildings', one: 'Historic building', interest: 'history',
      kinds: ['historic house', 'historic site'] },
    { id: 'landmark', label: 'Landmarks and curiosities', one: 'Landmark', interest: 'history', factor: 0.8,
      kinds: ['landmark'] },
    // Museums and art
    { id: 'society', label: 'Historical societies', one: 'Historical society', interest: 'museums', factor: 0.7,
      kinds: ['museum'], name: /histor(ical|ic) (society|association)|heritage (society|association)/i },
    { id: 'kids-museum', label: "Children's museums", one: "Children's museum", interest: 'museums', factor: 0.5,
      kinds: ['museum'], name: /\b(children'?s|kids)\b|discovery (center|museum)/i },
    { id: 'museum', label: 'Museums', one: 'Museum', interest: 'museums', kinds: ['museum'] },
    { id: 'gallery', label: 'Galleries', one: 'Gallery', interest: 'museums', kinds: ['gallery'] },
    // Gardens
    { id: 'garden', label: 'Gardens', one: 'Garden', interest: 'gardens', kinds: ['garden'] },
    // Views and nature
    { id: 'lookout', label: 'Lookouts and fire towers', one: 'Lookout', interest: 'views', kinds: ['lookout'] },
    { id: 'wild', label: 'Wildlife areas and forests', one: 'Wildlife area', interest: 'views', factor: 0.5,
      kinds: ['park'], name: /wildlife|management area|sanctuary|refuge|forest|preserve|reservation|woods/i },
    { id: 'big-park', label: 'State and national parks', one: 'State park', interest: 'views',
      kinds: ['park'], name: /\b(state|national)\b/i },
    { id: 'park', label: 'Local parks', one: 'Park', interest: 'views', factor: 0.35, kinds: ['park'] },
    // Animals
    { id: 'zoo', label: 'Zoos and aquariums', one: 'Zoo or aquarium', interest: 'animals', kinds: ['zoo'] },
    // Wineries, breweries and farms
    { id: 'winery', label: 'Wineries', one: 'Winery', interest: 'tasting', kinds: ['winery'] },
    { id: 'brewery', label: 'Breweries and distilleries', one: 'Brewery', interest: 'tasting', kinds: ['brewery'] },
    { id: 'farm', label: 'Farms and orchards', one: 'Farm or orchard', interest: 'tasting', kinds: ['farm'] },
    // Places to eat
    { id: 'restaurant', label: 'Restaurants', one: 'Restaurant', interest: 'eating', factor: 0.6, kinds: ['restaurant'] },
    { id: 'cafe', label: 'Cafés', one: 'Café', interest: 'eating', factor: 0.5, kinds: ['cafe'] },
    // Rides and thrills
    { id: 'theme-park', label: 'Theme and water parks', one: 'Theme park', interest: 'thrills', kinds: ['theme park'] },
    // Browsing
    { id: 'antiques', label: 'Antique shops', one: 'Antique shop', interest: 'browsing', kinds: ['antique shop'] },
    { id: 'books', label: 'Bookshops', one: 'Bookshop', interest: 'browsing', kinds: ['bookshop'] },
    { id: 'thrift', label: 'Thrift shops', one: 'Thrift shop', interest: 'browsing', factor: 0.5,
      kinds: ['shop'], name: /goodwill|thrift|salvation army|savers|consign|second.?hand|vintage/i },
    { id: 'garden-centre', label: 'Garden centres', one: 'Garden centre', interest: 'browsing', factor: 0.5,
      kinds: ['shop'], name: /garden (center|centre)|nursery|greenhouse/i },
    { id: 'market', label: 'Markets', one: 'Market', interest: 'browsing', factor: 0.5, kinds: ['mall'] },
    { id: 'shop', label: 'Other shops', one: 'Shop', interest: 'browsing', factor: 0.4, kinds: ['shop'] },
    { id: 'library', label: 'Libraries', one: 'Library', interest: 'browsing', factor: 0.3, kinds: ['library'] },
    // Shows
    { id: 'music', label: 'Music venues', one: 'Music venue', interest: 'shows', kinds: ['music venue'] },
    { id: 'theatre', label: 'Theatres', one: 'Theatre', interest: 'shows', kinds: ['theatre'] },
    { id: 'cinema', label: 'Cinemas', one: 'Cinema', interest: 'shows', factor: 0.5, kinds: ['cinema'] },
    // Things on right now
    { id: 'event', label: 'Things on right now', one: 'Happening now', interest: 'events', kinds: ['event'] }
  ];
  const TYPE = Object.fromEntries(TYPES.map((t) => [t.id, t]));

  // The first type that claims this place, or null for kinds Drive never
  // suggests (stadiums, schools, halls).
  function typeOf(p) {
    for (const t of TYPES) {
      if (t.kinds.includes(p.kind) && (!t.name || t.name.test(p.name))) return t.id;
    }
    return null;
  }

  const LEVELS = [['love', 'Love it', 3], ['some', 'Sometimes', 1.5], ['skip', 'Skip', 0]];
  const LEVEL_VALUE = Object.fromEntries(LEVELS.map(([id, , v]) => [id, v]));

  const DEFAULT_LEVELS = {
    history: 'some', museums: 'some', gardens: 'some', views: 'some', animals: 'some',
    tasting: 'some', eating: 'some', thrills: 'skip', browsing: 'skip', shows: 'skip', events: 'some'
  };

  const DETOURS = [5, 10, 15, 20, 30];      // minutes a stop may add to the trip
  const MAPS = [['google', 'Google Maps'], ['apple', 'Apple Maps']];
  const SIDES = [['left', 'Left'], ['right', 'Right']];

  const DEFAULTS = {
    levels: DEFAULT_LEVELS, maxDetour: 10, onboarded: false,
    liked: true, km: false, maps: 'google', mapSide: 'left', simSpeed: 10,
    // Per type: true switches it on even if its interest is skipped, false
    // switches it off even if its interest is loved. Absent follows the
    // interest.
    types: {},
    // Chains are hidden unless asked for; chainsOff lists the ones turned
    // off individually once they are shown.
    showChains: false, chainsOff: [],
    towns: true, showMap: true, zoomBias: 0,
    mapStyle: 'fantasy',
    // Per cuisine: 'love' ranks it up, 'off' hides it; absent is on.
    cuisines: {}
  };

  const SETTINGS_KEY = 'proximi.drive.v1';
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
  settings.types = { ...settings.types };
  settings.chainsOff = [...(settings.chainsOff || [])];
  settings.cuisines = { ...settings.cuisines };
  // Gone: the first version's per-kind list, and the voice and its cooldown.
  for (const k of ['kinds', 'events', 'voice', 'cooldown']) delete settings[k];
  const saveSettings = () => writeJSON(SETTINGS_KEY, settings);

  // The interest score's starting point: how much you like this type of place.
  function typeWeight(id) {
    const t = TYPE[id];
    if (!t) return 0;
    const factor = t.factor ?? 1;
    const base = (LEVEL_VALUE[settings.levels[t.interest]] || 0) * factor;
    const own = settings.types[id];
    if (own === false) return 0;
    if (own === true && !base) return LEVEL_VALUE.some * factor;
    return base;
  }

  /* A chain is a place OpenStreetMap tags with a brand, or one whose name is
     exactly a brand seen elsewhere: "Honey Dew Donuts" untagged is still
     Honey Dew. Repeated names alone are not enough: fifteen unrelated "Great
     Wall" restaurants are not a chain. Filled in when the data loads. */
  const brands = new Map();   // lower-cased name → brand
  const chainOf = (p) => p.brand || brands.get(p.name.toLowerCase()) || null;
  const chainAllowed = (chain) => !chain || (settings.showChains && !settings.chainsOff.includes(chain));

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
  // Wide, because a trip-level detour can make a place ten miles off this
  // road cheap if it sits on another good road to the destination.
  const CORRIDOR_MI = 10;
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
    ahead: [], odo: 0, eats: [], cuisineLabels: {},
    towns: { samples: new Map(), queue: [], busy: false, here: null, dismissed: new Set() }
  };

  // The drive's clock. A simulated drive runs faster than real time, and the
  // detour cache and "on now" windows should run with it rather than the wall.
  const now = () => (state.sim ? state.sim.clock() : Date.now());

  /* ── What is worth a stop ─────────────────────────────── */

  function interest(c) {
    if (state.muted.has(c.name)) return 0;
    if (!chainAllowed(c._chain)) return 0;
    const liked = state.liked.has(c.name);
    let s = typeWeight(c._type);
    /* Kinds of food: a place is out only if every cuisine it serves is off
       (a pizza-and-pasta place stays for someone who has only turned pizza
       off), and a favourite anywhere on its menu ranks it up. */
    let loved = false;
    if (c.kind === 'restaurant' || c.kind === 'cafe') {
      const menu = c.cuisine && c.cuisine.length ? c.cuisine : ['none'];
      const says = menu.map((x) => settings.cuisines[x] || 'on');
      if (says.every((x) => x === 'off')) return 0;
      loved = says.includes('love');
    }
    if (!s && liked && settings.liked) s = 1;
    if (!s) return 0;
    if (liked) s += 3;
    if (loved) s += 2;
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
          id: 'ev-' + e.id, name: e.venue || e.title, kind: 'event', _type: 'event', _chain: null,
          lat: e.lat, lon: e.lon, city: e.city, url: e.url, onNow: e
        });
      }
    }
    state.pool = [];
    for (const p of state.places.concat(state.eats)) {
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

  /* ── What a stop costs ────────────────────────────────────
     The question is not how far the place is from the road you are on; it
     is how much later you get where you are going. So, with a destination:

       detour = time(you → place → destination) − time(you → destination)

     That counts the road you would take after the stop, which need not be
     the road you left. On a long drive with several nearly-equal ways to go,
     a place ten minutes off this road can sit near another one, and cost the
     whole trip three. The first version measured against a point a mile and
     a half past the place on this road, which charged every such place for
     coming back to it.

     With no destination there is no "where you are going", so the end is a
     point six miles past the place along your heading: far enough that a
     different road back can count, near enough to be a road you are on.

     Both halves come out of one OSRM "table" request, for ten places at a
     time: drive times from [you, place 1 … place n] to [place 1 … place n,
     end], which holds you→place, place→end and you→end for every one.
     The detour is measured against the fastest way from here; if you are on
     a slower road by choice, a place on the faster one can cost nothing. */

  const OSRM = 'https://router.project-osrm.org';
  const ll = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
  const BATCH = 10;
  const END_BEYOND = 6;    // miles past the place, when there is no destination

  function endPoint(o) {
    if (state.dest) return state.dest;
    const h = headingVector(state.heading);
    const d = o.ahead + END_BEYOND;
    return fromXY({ x: h.x * d, y: h.y * d }, state.pos);
  }

  async function checkDetours(batch) {
    const here = state.pos, n = batch.length;
    const shared = !!state.dest;           // one end for all, or one each
    const ends = shared ? [state.dest] : batch.map(endPoint);
    const pts = [here, ...batch.map((o) => o.c), ...ends];
    const sources = [0, ...batch.map((_, i) => i + 1)];
    const dests = [...batch.map((_, i) => i + 1), ...ends.map((_, j) => n + 1 + j)];
    const url = `${OSRM}/table/v1/driving/${pts.map(ll).join(';')}`
      + `?sources=${sources.join(';')}&destinations=${dests.join(';')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('router ' + res.status);
    const data = await res.json();
    const d = data.durations;
    if (data.code !== 'Ok' || !d) throw new Error('router ' + data.code);
    return batch.map((o, i) => {
      const end = shared ? n : n + i;          // column of this place's end
      const toPlace = d[0][i], direct = d[0][end], onward = d[i + 1][end];
      if (toPlace == null || direct == null || onward == null) return { min: Infinity, toMin: Infinity };
      return { min: Math.max(0, (toPlace + onward - direct) / 60), toMin: toPlace / 60 };
    });
  }

  // A detour is measured against the road, not the car, so it holds while
  // you approach; fifteen minutes lets the deck show it without re-asking.
  const DETOUR_TTL = 15 * 60000;

  async function checkNext(list) {
    const t = Date.now();
    if (state.checking || t - state.lastCheck < 1200 || t < state.routerDownUntil) return;
    // Ten at a time from the forty most promising, so a wider net costs no
    // more requests than the old one-at-a-time did.
    const next = list.slice(0, 40).filter((o) => {
      const d = state.detours.get(o.c.id);
      return !d || now() - d.at > DETOUR_TTL;
    }).slice(0, BATCH);
    if (!next.length) return;
    state.checking = true;
    state.lastCheck = t;
    try {
      const got = await checkDetours(next);
      next.forEach((o, i) => state.detours.set(o.c.id, { ...got[i], at: now() }));
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

  const MAX_UPCOMING = 16;

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
    planTowns();
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
    const where = (state.towns.here ? `in ${state.towns.here.name} · ` : '')
      + (state.route ? `to ${state.destName}` : 'following your heading');
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
    toast: $('drive-toast'), toastMsg: $('drive-toast-msg'), toastUndo: $('drive-toast-undo'),
    simCtl: $('sim-ctl'), simSlower: $('sim-slower'), simFaster: $('sim-faster'), simSpeed: $('sim-speed'),
    openSettings: $('open-settings'), sheet: $('drive-settings'),
    scrim: $('settings-backdrop'), closeSettings: $('close-settings'),
    levels: $('interest-levels'), retake: $('retake-quiz'),
    detourChips: $('detour-chips'), sideChips: $('side-chips'), mapsChips: $('maps-chips'),
    optLiked: $('opt-liked'), optKm: $('opt-km'), optTowns: $('opt-towns'), optMap: $('opt-map'),
    mapBtn: $('map-btn'), zoomIn: $('zoom-in'), zoomOut: $('zoom-out'),
    kindGroups: $('kind-groups'), optChains: $('opt-chains'), chainPick: $('chain-pick'),
    cuisineChips: $('cuisine-chips'), cuisineNote: $('cuisine-note'), styleChips: $('style-chips'),
    compass: $('map-compass'),
    chainSearch: $('chain-search'), chainList: $('chain-list'), chainNote: $('chain-note'),
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

  const VIEW_MILES = 6;      // road shown between the line and the top of the deck
  // The line sits low: what is coming matters more than what has gone by.
  const LINE_AT = 0.72;
  const GAP = 8;

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
      y: null, dx: 0, dxTo: 0
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

  // "Mexican & Latin American" is the filter's name; on a card, "Mexican".
  function cuisineShort(id) {
    const label = state.cuisineLabels[id] || id.replace(/_/g, ' ');
    return label.split(/ & |, /)[0].replace(/^./, (x) => x.toUpperCase());
  }

  // What the card calls the place: its type, and for somewhere to eat, what
  // kind of food.
  function typeLine(c) {
    let s = TYPE[c._type]?.one || 'Place';
    // A restaurant's line is its food: the fork on the card already says
    // restaurant, and "Restaurant · American" does not fit a narrow card.
    const food = (c.cuisine || [])[0];
    if (food && c.kind === 'restaurant') s = cuisineShort(food);
    if (c._chain) s += ' · chain';
    if (state.liked.has(c.name)) s += ' · liked';
    if (c.rating) s += ` · ★ ${c.rating.stars.toFixed(1)}`;
    return s;
  }

  /* A card is the whole control: tap it for directions, swipe it either way
     to say "not for me". No buttons, so a card is small and more of the road
     fits on the screen. */
  function cardFor(e) {
    const li = document.createElement('li');
    li.className = 'deck-card';
    li.dataset.id = e.c.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'link');
    const r = e.c.rating;
    li.setAttribute('aria-label', `${e.c.name}`
      + (r ? `, rated ${r.stars.toFixed(1)} from ${r.count.toLocaleString()} reviews on ${r.from.join(' and ')}` : '')
      + ': directions. Swipe to hide.');
    li.innerHTML = `
      <div class="deck-photo"></div>
      <div class="deck-body">
        <p class="deck-kind"><span class="deck-letter"></span><span class="deck-kind-t"></span></p>
        <h3 class="deck-name"></h3>
        <p class="deck-facts"></p>
        <p class="deck-on" hidden></p>
      </div>`;
    const c = e.c;
    li.querySelector('.deck-letter').textContent = e.letter;
    li.querySelector('.deck-name').textContent = c.name;
    li.querySelector('.deck-kind-t').textContent = typeLine(c);
    if (c.onNow) {
      const on = li.querySelector('.deck-on');
      on.hidden = false;
      on.textContent = (c.kind === 'event' ? '' : 'On now: ') + c.onNow.title;
    }
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
    const line = h * LINE_AT;
    const cardH = cardHeight();
    const pxPerMile = line / VIEW_MILES;
    const behindLimit = -(h - line + cardH) / pxPerMile;
    const width = el.deckList.clientWidth;

    const live = [];
    for (const e of entries.values()) {
      const a = aheadOf(e);
      if (a < behindLimit) { drop(e, 'is-gone'); continue; }
      e.ahead = a;
      live.push(e);
    }
    // Top of the screen first.
    live.sort((a, b) => b.ahead - a.ahead);
    // Cards differ in height (a town line is a slim strip), so each card's
    // offset is the sum of the heights above it rather than a fixed step.
    const offsets = [];
    let acc = 0;
    for (const e of live) { e.h = e.isTown ? TOWN_H : cardH; offsets.push(acc); acc += e.h + GAP; }
    const want = live.map((e, i) => (line - e.ahead * pxPerMile - e.h / 2) - offsets[i]);
    const fit = isotonic(want);
    let nearest = null;
    /* The fit is continuous while the road is, but a card arriving or leaving
       re-pools its neighbours, and their targets move a whole card at once.
       So each card is pulled towards its target by a critically damped
       spring: the fastest settle that never overshoots, and one whose speed
       changes smoothly, so a card eases out and eases in rather than
       lurching off. On a steady road the spring just follows, a fraction of
       a second behind. */
    const w = 11, t = Math.min(dt, 50) / 1000;
    const slide = 1 - Math.exp(-dt / 70);
    live.forEach((e, i) => {
      const target = fit[i] + offsets[i];
      if (e.y == null) { e.y = target; e.vy = 0; }
      e.vy += (w * w * (target - e.y) - 2 * w * e.vy) * t;
      e.y += e.vy * t;
      // Sideways: under the finger while dragged, otherwise sliding home or away.
      if (!(drag && drag.e === e && drag.active)) e.dx += (e.dxTo - e.dx) * slide;
      e.li.style.height = `${e.h}px`;
      e.li.style.transform = `translate3d(${e.dx.toFixed(1)}px, ${e.y.toFixed(1)}px, 0)`;
      e.li.style.opacity = e.dx ? String(Math.max(0.2, 1 - Math.abs(e.dx) / width)) : '';
      e.li.classList.toggle('is-past', e.ahead < -0.15);
      e.li.querySelector('.deck-facts').textContent = e.isTown ? townFacts(e) : factsLine(e);
      if (e.isTown) return;
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

  // About six to a screen now the buttons are gone.
  const cardHeight = () => Math.max(96, Math.min(126, el.deckList.clientHeight / 6.2));

  // "+9 min" is what the stop adds to the trip; short, because the card is.
  function factsLine(e) {
    const m = Math.round(e.detour);
    const detour = m < 1 ? 'On the way' : `+${m} min`;
    if (e.ahead < -0.15) return `${detour} · ${shortDistance(e.ahead)} back`;
    if (e.ahead < 0.15) return `${detour} · beside you`;
    return `${detour} · ${shortDistance(e.ahead)}`;
  }

  /* ── Towns ────────────────────────────────────────────────
     Where the town lines are, and which town you are in. Nominatim, asked
     "what town is this point in", answers from the real municipal
     boundaries. With a route, points every half mile along the road ahead
     are asked about, and where two neighbours disagree there is a town line
     between them, to within a quarter mile; it goes on the deck as a slim
     card at that distance and scrolls with everything else. Without a route,
     the points are where you are and a mile apart along your heading.

     Nominatim allows one request a second and asks that nobody go faster,
     so the questions queue. The first half hour of a route is about fifty
     questions; after that it is one every half mile. Answers are kept for
     the drive, keyed to about a hundred metres. */

  const TOWN_STEP = 0.5;       // miles between points asked about along a route
  const TOWN_H = 48;           // a town line's card height, in px
  const townAnswers = new Map();   // "lat,lon" to 3 places → town or null

  const townKey = (p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

  function askTown(p, where) {
    const key = townKey(p);
    const T = state.towns;
    if (townAnswers.has(key)) { T.samples.set(where.id, { ...where, town: townAnswers.get(key) }); return; }
    if (!T.queue.some((q) => q.key === key)) T.queue.push({ key, p, where });
  }

  function planTowns() {
    if (!settings.towns || !state.pos) return;
    const T = state.towns;
    if (state.route && state.progress != null) {
      const far = Math.min(state.route.length, state.progress + lookahead());
      for (let a = Math.floor(state.progress / TOWN_STEP) * TOWN_STEP; a <= far; a += TOWN_STEP) {
        askTown(pointAt(state.route, a), { id: `r${a.toFixed(1)}`, along: a });
      }
    } else if (state.heading != null) {
      askTown(state.pos, { id: 'here', ahead: 0, odoAt: state.odo });
      const h = headingVector(state.heading);
      for (let d = 1; d <= 6; d++) {
        // Snapped to whole miles of odometer, so the same point is not asked
        // about afresh every second as the car creeps forward.
        const odo = Math.round(state.odo) + d;
        const ahead = odo - state.odo;
        askTown(fromXY({ x: h.x * ahead, y: h.y * ahead }, state.pos), { id: `o${odo}`, ahead, odoAt: state.odo });
      }
    }
    pumpTowns();
    placeTownLines();
  }

  async function pumpTowns() {
    const T = state.towns;
    if (T.busy || !T.queue.length || Date.now() < (T.pauseUntil || 0)) return;
    // Nearest first: the town line you will reach soonest matters most.
    T.queue.sort((a, b) => (a.where.along ?? a.where.ahead) - (b.where.along ?? b.where.ahead));
    const q = T.queue.shift();
    T.busy = true;
    try {
      const town = await reverseTown(q.p);
      townAnswers.set(q.key, town);
      T.samples.set(q.where.id, { ...q.where, town });
    } catch {
      T.queue.push(q);
      T.pauseUntil = Date.now() + 15000;
    } finally {
      // Nominatim's own rule: no more than one request a second.
      setTimeout(() => { T.busy = false; pumpTowns(); }, 1100);
    }
  }

  async function reverseTown(p) {
    const res = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&zoom=13&addressdetails=1'
      + `&lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('reverse ' + res.status);
    const a = (await res.json()).address || {};
    // The smallest thing with a sign at its edge: a village inside a town
    // is what the sign on the road says.
    const raw = a.village || a.town || a.city || a.municipality || a.hamlet;
    if (!raw) return null;
    // "City of Beacon" is the charter's name; the sign on the road says Beacon.
    const name = raw.replace(/^(city|town|village|borough|township) of /i, '');
    const st = (a['ISO3166-2-lvl4'] || '').replace(/^US-/, '') || a.state || '';
    return { name, state: st };
  }

  // Town lines between neighbouring answers that disagree.
  function placeTownLines() {
    const T = state.towns;
    const pts = [...T.samples.values()].filter((s) => s.town)
      .map((s) => ({ ...s, at: s.along ?? (s.odoAt + s.ahead) }))
      .sort((a, b) => a.at - b.at);
    const here = state.route ? state.progress : state.odo;
    let current = null;
    for (const s of pts) if (s.at <= here + 0.05) current = s.town;
    T.here = current || T.here;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (a.town.name === b.town.name || b.at - a.at > 2) continue;
      const at = (a.at + b.at) / 2;
      const id = `town:${b.town.name}:${at.toFixed(1)}`;
      if (entries.has(id) || T.dismissed.has(id) || at < here - 0.2) continue;
      admitTown(id, a.town, b.town, at);
    }
  }

  function admitTown(id, from, to, at) {
    const e = {
      c: { id, name: to.name }, isTown: true, from, to, score: 0, detour: 0,
      along: state.route ? at : null, aheadAt: at - disp.odo, odoAt: disp.odo,
      y: null, dx: 0, dxTo: 0
    };
    const li = document.createElement('li');
    li.className = 'deck-card is-town';
    li.dataset.id = id;
    li.tabIndex = 0;
    li.setAttribute('aria-label', `Town line: entering ${to.name}${to.state ? ', ' + to.state : ''}`);
    li.innerHTML = '<p class="town-line"><span class="town-verb"></span> <strong class="town-name"></strong>'
      + '<span class="town-st"></span></p><p class="deck-facts town-from"></p>';
    li.querySelector('.town-name').textContent = to.name;
    li.querySelector('.town-st').textContent = to.state ? ` ${to.state}` : '';
    e.li = li;
    el.deckList.appendChild(li);
    entries.set(id, e);
  }

  function townFacts(e) {
    e.li.querySelector('.town-verb').textContent = e.ahead < 0.1 ? 'Now in' : 'Entering';
    const left = e.from && e.from.name !== e.to.name ? `leaving ${e.from.name}` : '';
    const when = e.ahead < -0.1 ? '' : e.ahead < 0.1 ? 'town line now' : `in ${shortDistance(e.ahead)}`;
    return [when, left].filter(Boolean).join(' · ');
  }

  /* ── Tap and swipe ────────────────────────────────────────
     Tracked on the window, not by capturing the pointer: a touch pointer is
     already captured by whatever it went down on, and asking again transfers
     it and fires lostpointercapture, which is the bug that once made the main
     page's swipes work with a mouse and never with a finger. A drag only
     becomes a swipe once it is clearly sideways, so a finger resting on the
     deck while the car moves is not a swipe. */

  let drag = null, lastSwipeAt = 0;
  const SWIPE_AWAY = 0.3;      // of the card's width
  const FLICK = 0.6;           // px per ms

  el.deckList.addEventListener('pointerdown', (ev) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const li = ev.target.closest('.deck-card');
    const e = li && entries.get(li.dataset.id);
    if (!e) return;
    drag = { e, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, t0: performance.now(), active: false };
  });

  window.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x0, dy = ev.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) < 10 || Math.abs(dx) <= Math.abs(dy)) return;
      drag.active = true;
      drag.e.li.classList.add('is-dragging');
    }
    drag.e.dx = dx;
    ev.preventDefault();
  }, { passive: false });

  function endDrag(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    const { e, active, t0 } = drag;
    drag = null;
    if (!active) return;
    e.li.classList.remove('is-dragging');
    lastSwipeAt = Date.now();
    const width = el.deckList.clientWidth;
    const speed = Math.abs(e.dx) / Math.max(1, performance.now() - t0);
    if (Math.abs(e.dx) > width * SWIPE_AWAY || speed > FLICK) dismiss(e, Math.sign(e.dx) || 1);
    else e.dxTo = 0;
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  el.deckList.addEventListener('click', (ev) => {
    if (ev.target.closest('a')) return;             // the picture's credit link
    if (Date.now() - lastSwipeAt < 400) return;     // the end of a swipe is not a tap
    const li = ev.target.closest('.deck-card');
    const e = li && entries.get(li.dataset.id);
    if (e && !e.isTown) openDirections(e);
  });

  el.deckList.addEventListener('keydown', (ev) => {
    const li = ev.target.closest('.deck-card');
    const e = li && entries.get(li.dataset.id);
    if (!e) return;
    if (ev.key === 'Enter' && !e.isTown) openDirections(e);
    if (ev.key === 'Delete' || ev.key === 'Backspace') dismiss(e, 1);
  });

  function openDirections(e) {
    window.open(mapsUrl(e.c), '_blank', 'noopener');
  }

  /* "Not for me": the same mute the Places tab uses, keyed by name the way it
     is there. The card slides off the way it was pushed, and an Undo stays
     up for a few seconds, because a swipe on a moving car's dash is easy to
     make by accident and should never be a one-way door. */
  let undoTimer = null;

  function dismiss(e, dir) {
    e.dxTo = dir * (el.deckList.clientWidth + 40);
    if (e.isTown) {
      state.towns.dismissed.add(e.c.id);
      setTimeout(() => { if (entries.get(e.c.id) === e) drop(e, 'is-gone'); }, 260);
      return;
    }
    state.muted = new Set(readJSON(VENUES_KEY, []));
    state.muted.add(e.c.name);
    writeJSON(VENUES_KEY, [...state.muted]);
    setTimeout(() => { if (entries.get(e.c.id) === e) drop(e, 'is-gone'); }, 260);
    buildPool();
    toast(`Hid “${e.c.name}”`, () => {
      state.muted = new Set(readJSON(VENUES_KEY, []));
      state.muted.delete(e.c.name);
      writeJSON(VENUES_KEY, [...state.muted]);
      buildPool();
      evaluate();
    });
  }

  function toast(text, undo) {
    el.toastMsg.textContent = text;
    el.toast.hidden = false;
    el.toastUndo.onclick = () => { undo(); el.toast.hidden = true; };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { el.toast.hidden = true; }, 5000);
  }

  /* ── Pictures ─────────────────────────────────────────────
     All found at build time and shipped with the places, so a card has its
     picture before it is on screen and in a dead zone: the place's own
     website's (scripts/images.py) and its Wikipedia article's
     (scripts/wikipics.py). The first version asked Wikipedia live, per card,
     from the phone; a sweep in advance covers every place instead of the
     few that were ever on screen, and costs the phone nothing.

     Which comes first depends on what the place is. A restaurant's own
     picture is usually its food, which is the point; an attraction's is
     often a banner with words on it, where Wikipedia's is a photograph of
     the thing. Each is prefetched on admission, so it is decoded before it
     scrolls into view. */

  const FOOD = new Set(['restaurant', 'cafe']);

  function picturesFor(c) {
    const site = c.image ? { src: c.image, text: 'Their site', href: c.url } : null;
    // Wikidata's photograph, credited to its Commons page, where its author
    // and licence are.
    const wiki = c.wikiImage ? { src: c.wikiImage, text: 'Wikimedia', href: c.wikiLink } : null;
    return (FOOD.has(c.kind) ? [site, wiki] : [wiki, site]).filter(Boolean);
  }

  function wantPhoto(c) {
    for (const p of picturesFor(c)) { const img = new Image(); img.src = p.src; }
  }

  // Simple outline glyphs for a card with no photo, by interest.
  const GLYPHS = {
    history: '<path d="M6 30V14l6-4 6 4v16M18 30V10l6-5 6 5v20M3 30h30" />',
    museums: '<path d="M4 13 18 5l14 8M6 13v14M12 13v14M24 13v14M30 13v14M3 29h30" />',
    gardens: '<path d="M18 30V16M18 16c-6 0-9-4-9-9 5 0 9 3 9 9Zm0 0c6 0 9-4 9-9-5 0-9 3-9 9ZM10 30h16" />',
    views: '<path d="M3 29 13 13l6 9 4-5 10 12ZM24 9a3 3 0 1 0 0 .1" />',
    animals: '<path d="M10 14a3 3 0 1 0 0 .1M26 14a3 3 0 1 0 0 .1M14 9a3 3 0 1 0 0 .1M22 9a3 3 0 1 0 0 .1M18 17c-5 0-8 6-8 9s3 3 8 3 8 0 8-3-3-9-8-9Z" />',
    tasting: '<path d="M12 5h12l-1 9a5 5 0 0 1-10 0ZM18 19v10M12 30h12" />',
    eating: '<path d="M11 5v9a3 3 0 0 0 6 0V5M14 5v25M24 30V5c-3 2-4 6-4 10h4" />',
    thrills: '<path d="M4 30C8 10 14 6 18 6s10 4 14 24M9 30V18M18 30V6M27 30V18" />',
    browsing: '<path d="M6 8h24v22H6ZM6 14h24M13 8v6M23 8v6" />',
    shows: '<path d="M6 7h24v14c0 5-5 9-12 9S6 26 6 21ZM12 14h3M21 14h3M13 21c3 2 7 2 10 0" />',
    events: '<path d="M6 30 12 6h12l6 24M9 18h18M18 6V3" />'
  };

  function fillPhoto(li, c, skip = 0) {
    const box = li.querySelector('.deck-photo');
    const pic = picturesFor(c)[skip];
    if (!pic) { glyph(box, c); return; }
    box.classList.remove('is-glyph');
    const img = new Image();
    img.alt = '';
    img.decoding = 'async';
    img.src = pic.src;
    // A site's picture can move or refuse strangers: try the next source,
    // then a drawing, and never show a broken image.
    img.onerror = () => fillPhoto(li, c, skip + 1);
    const a = document.createElement('a');
    a.className = 'deck-credit';
    a.href = pic.href || '#';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = pic.text;
    box.replaceChildren(img, a);
  }

  function glyph(box, c) {
    if (box.classList.contains('is-glyph')) return;
    box.classList.add('is-glyph');
    const interest = TYPE[c._type]?.interest || 'history';
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

  /* ── The fantasy map ───────────────────────────────────────
     A vector map is data plus a style: one entry per layer (water, woods,
     roads, labels…), each with its colours, widths and dashes. So the look
     is ours to write. This takes OpenFreeMap's style and rewrites it, layer
     by layer, into an old explorer's chart: parchment land with a paper
     grain, water washed blue-grey with little wave marks and an inked
     coast, woods stamped with trees, roads in sepia ink with the highways in
     claret, hills shaded in sepia from free elevation tiles, labels in ink
     on parchment, and the route as a dashed red line.

     The textures are drawn here, on a canvas, from a seeded random number
     generator, so they are the same on every load and need no files. The
     one thing not rewritten is the lettering: labels need fonts cut into a
     special glyph format, and OpenFreeMap serves sans-serifs only. A true
     storybook face is possible, but means making and hosting those files. */

  const INK = '#3b2a1a', SEPIA = '#6b4f2c', PARCH = '#ead9b0', CLARET = '#8e3b2c';
  const TERRAIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const STYLES = [['fantasy', 'Fantasy'], ['standard', 'Standard']];

  function fantasize(base) {
    const style = JSON.parse(JSON.stringify(base));
    style.sources.terrain = {
      type: 'raster-dem', tiles: [TERRAIN], encoding: 'terrarium', tileSize: 256, maxzoom: 13,
      attribution: 'Terrain tiles: Mapzen, via AWS Open Data'
    };
    const road = (id) => /motorway|trunk/.test(id) ? CLARET : /primary|secondary|tertiary/.test(id) ? '#7a5230' : '#9c7b52';
    const out = [];
    for (const l of style.layers) {
      const id = l.id, sl = l['source-layer'] || '';
      // What a chart would not show: 3-D buildings, casings (the darker
      // edge under each road), hatching, arrows, shop and bus-stop icons,
      // runways, sports pitches and the coarse world raster.
      if (l.type === 'fill-extrusion' || l.type === 'raster') continue;
      if (/casing|hatching|one_way|road_area_pattern/.test(id)) continue;
      if (sl === 'poi' || sl === 'aeroway' || sl === 'aerodrome_label') continue;
      if (/^landuse_(pitch|track|school|hospital)$/.test(id)) continue;
      l.paint = l.paint || {};
      l.layout = l.layout || {};
      if (l.type === 'background') {
        l.paint = { 'background-color': PARCH, 'background-pattern': 'fx-parchment' };
      } else if (id === 'water') {
        l.paint = { 'fill-pattern': 'fx-waves' };
        out.push(l);
        // An inked shoreline, drawn from the same shapes.
        out.push({ id: 'fx-coast', type: 'line', source: l.source, 'source-layer': 'water',
          paint: { 'line-color': '#2f4f5a', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 1.6], 'line-opacity': 0.8 } });
        continue;
      } else if (id === 'landcover_wood') {
        l.paint = { 'fill-pattern': 'fx-trees', 'fill-opacity': 0.9 };
        // Hills go in under the woods, so the trees sit on the slopes.
        out.push({ id: 'fx-hills', type: 'hillshade', source: 'terrain', paint: {
          'hillshade-shadow-color': '#5a3e1e', 'hillshade-highlight-color': '#fff4d6',
          'hillshade-accent-color': SEPIA, 'hillshade-exaggeration': 0.45,
          // Lit from the northwest of the map, so relief reads right as it turns.
          'hillshade-illumination-anchor': 'map' } });
      } else if (l.type === 'fill' && sl === 'park') {
        l.paint = { 'fill-color': '#c3c98e', 'fill-opacity': 0.45 };
      } else if (l.type === 'fill' && sl === 'landcover') {
        l.paint = { 'fill-color': /wetland/.test(id) ? '#b3bf98' : /sand/.test(id) ? '#e3cc92' : /ice/.test(id) ? '#f4efe0' : '#cfd09b',
          'fill-opacity': 0.45 };
      } else if (l.type === 'fill' && sl === 'landuse') {
        l.paint = { 'fill-color': id === 'landuse_cemetery' ? '#c2bb95' : '#d8c08e', 'fill-opacity': 0.35 };
      } else if (l.type === 'fill' && sl === 'building') {
        l.paint = { 'fill-color': '#c9b186', 'fill-opacity': 0.35, 'fill-outline-color': SEPIA };
      } else if (l.type === 'line' && sl === 'waterway') {
        l.paint = { ...l.paint, 'line-color': '#4f7482' };
      } else if (l.type === 'line' && sl === 'park') {
        l.paint = { 'line-color': '#7d8a52', 'line-width': 1, 'line-dasharray': [3, 2], 'line-opacity': 0.6 };
      } else if (l.type === 'line' && sl === 'transportation') {
        const rail = /rail/.test(id);
        l.paint = { ...l.paint, 'line-color': rail ? '#5a4633' : road(id),
          'line-opacity': /tunnel/.test(id) ? 0.35 : 0.95 };
        if (rail || /path|service|track/.test(id)) l.paint['line-dasharray'] = [2, 1.5];
      } else if (l.type === 'line' && sl === 'boundary') {
        l.paint = { ...l.paint, 'line-color': CLARET, 'line-dasharray': [4, 2, 1, 2], 'line-opacity': 0.55 };
      } else if (l.type === 'symbol') {
        const water = sl === 'water_name' || sl === 'waterway';
        l.paint = { ...l.paint, 'text-color': water ? '#2f5563' : INK,
          'text-halo-color': 'rgba(234,217,176,0.9)', 'text-halo-width': 1.6, 'text-halo-blur': 0.5 };
        if (sl === 'place' && /town|city|village|state/.test(id)) {
          l.layout['text-transform'] = 'uppercase';
          l.layout['text-letter-spacing'] = 0.18;
          delete l.layout['icon-image'];
        }
      }
      out.push(l);
    }
    style.layers = out;
    return style;
  }

  // A small seeded generator: the same paper grain on every load.
  function seeded(seed) {
    return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  }

  /* The textures, drawn on demand the first time the map asks for one, at
     twice the size and half the pixel ratio so they stay crisp. */
  const PATTERNS = {
    'fx-parchment': (g, n, r) => {
      g.fillStyle = PARCH; g.fillRect(0, 0, n, n);
      for (let i = 0; i < 900; i++) {           // grain
        const d = r() < 0.5;
        g.fillStyle = d ? `rgba(120,86,40,${0.05 + r() * 0.08})` : `rgba(255,248,225,${0.1 + r() * 0.15})`;
        g.fillRect(r() * n, r() * n, 1 + r() * 2, 1 + r() * 2);
      }
      g.strokeStyle = 'rgba(140,105,55,0.08)';  // fibres
      for (let i = 0; i < 14; i++) {
        const x = r() * n, y = r() * n, a = r() * Math.PI;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 18, y + Math.sin(a) * 18); g.stroke();
      }
    },
    'fx-waves': (g, n, r) => {
      g.fillStyle = '#a9c1b8'; g.fillRect(0, 0, n, n);
      g.strokeStyle = 'rgba(47,79,90,0.45)'; g.lineWidth = 1.4; g.lineCap = 'round';
      for (let i = 0; i < 5; i++) {
        const x = (i % 3) * (n / 3) + r() * 10 + 4, y = Math.floor(i / 3) * (n / 2) + (i % 2) * 14 + r() * 8 + 8;
        g.beginPath(); g.arc(x, y, 5, Math.PI * 1.1, Math.PI * 1.9); g.arc(x + 9, y, 5, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      }
    },
    'fx-trees': (g, n, r) => {
      g.fillStyle = 'rgba(160,172,112,0.55)'; g.fillRect(0, 0, n, n);
      for (const [x, y] of [[n * 0.25, n * 0.3], [n * 0.72, n * 0.22], [n * 0.5, n * 0.72], [n * 0.1, n * 0.85], [n * 0.9, n * 0.7]]) {
        const s = 7 + r() * 3;
        g.fillStyle = '#5d6b37'; g.strokeStyle = '#3f4a24'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.7, y + s * 0.5); g.lineTo(x - s * 0.7, y + s * 0.5); g.closePath();
        g.fill(); g.stroke();
        g.strokeStyle = '#4a3520'; g.beginPath(); g.moveTo(x, y + s * 0.5); g.lineTo(x, y + s * 0.9); g.stroke();
      }
    }
  };

  function paintPattern(id) {
    const draw = PATTERNS[id];
    if (!draw || !map || map.hasImage(id)) return;
    const n = id === 'fx-parchment' ? 128 : 48;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    draw(g, n, seeded(id.length * 7919));
    map.addImage(id, g.getImageData(0, 0, n, n), { pixelRatio: 2 });
  }

  let baseStyle = null;
  async function styleFor(kind) {
    if (kind !== 'fantasy') return STYLE_URL;
    if (!baseStyle) {
      try { baseStyle = await (await fetch(STYLE_URL)).json(); } catch { return STYLE_URL; }
    }
    try { return fantasize(baseStyle); } catch { return baseStyle; }
  }

  async function applyMapStyle() {
    if (!map) return;
    const s = await styleFor(settings.mapStyle);
    mapReady = false;
    map.setStyle(s);
    el.slice.classList.toggle('is-fantasy', settings.mapStyle === 'fantasy');
  }

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
    // Textures are drawn the first time a layer asks for one.
    map.on('styleimagemissing', (e) => paintPattern(e.id));
    // Our own layers go back on whenever a style is (re)loaded: the route is
    // not part of either look, it is laid over both.
    map.on('style.load', () => {
      mapReady = true;
      const fantasy = settings.mapStyle === 'fantasy';
      if (!fantasy) {
        // The Victorian desk's parchment under the roads, where the style allows.
        try { map.setPaintProperty('background', 'background-color', '#EFEADA'); } catch { /* style without one */ }
      }
      if (!map.getSource('route')) map.addSource('route', { type: 'geojson', data: emptyLine() });
      if (!map.getLayer('route')) {
        map.addLayer({
          id: 'route', type: 'line', source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          // A treasure-map dash in red ink on the chart; plain blue otherwise.
          paint: fantasy
            ? { 'line-color': '#9b2d20', 'line-width': 4, 'line-dasharray': [2, 1.4], 'line-opacity': 0.9 }
            : { 'line-color': '#2F5F9E', 'line-width': 7, 'line-opacity': 0.85 }
        });
      }
      if (pendingRoute) setRouteLine(pendingRoute);
      // The credit starts as its small "i", not a box over the road. MapLibre
      // opens it again as each source's credit arrives, so close it once the
      // new style has finished loading.
      map.once('idle', () => el.map.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));
    });
    map.on('error', () => { /* a missing tile is not worth a word */ });
    new ResizeObserver(() => { map?.resize(); placeCar(); }).observe(el.slice);
    placeCar();
    if (settings.mapStyle === 'fantasy') applyMapStyle();
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
    // The compass turns against the map, so its needle always points north.
    if (el.compass) el.compass.style.transform = `rotate(${-(disp.heading ?? 0)}deg)`;
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
    const zTarget = (state.speedMph > 45 ? 12.3 : state.speedMph > 20 ? 13.2 : 14) + (settings.zoomBias || 0);
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
      // Town answers along the old route are at the old route's mileages.
      for (const id of [...state.towns.samples.keys()]) if (id.startsWith('r')) state.towns.samples.delete(id);
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
    state.towns = { samples: new Map(), queue: [], busy: false, here: null, dismissed: new Set() };
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
    el.optTowns.checked = settings.towns;
    el.optMap.checked = settings.showMap;
    el.mapBtn.setAttribute('aria-pressed', String(settings.showMap));
    el.main.dataset.side = settings.mapSide;
    el.main.classList.toggle('no-map-view', !settings.showMap);
    renderKinds();
    renderChains();
    renderCuisines();
    el.styleChips.replaceChildren(...STYLES.map(([id, label]) =>
      chip(label, settings.mapStyle === id, () => {
        if (settings.mapStyle === id) return;
        settings.mapStyle = id;
        changed();
        applyMapStyle();
      })));
    syncSimSpeed();
  }

  /* Kinds of place, by group. A chip is on when its type counts for
     anything; tapping records an explicit choice that outlives changing the
     group's level. Counts are how many there are in the whole directory, so
     a switch that governs three places reads as small. */
  function renderKinds() {
    const counts = {};
    for (const p of state.places.concat(state.eats)) counts[p._type] = (counts[p._type] || 0) + 1;
    el.kindGroups.replaceChildren(...INTERESTS.map((it) => {
      const box = document.createElement('div');
      box.className = 'kind-group';
      box.dataset.interest = it.id;
      const h = document.createElement('p');
      h.className = 'kind-group-h';
      h.textContent = `${it.label} · ${LEVELS.find(([id]) => id === settings.levels[it.id])?.[1] || ''}`;
      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const t of TYPES.filter((x) => x.interest === it.id)) {
        const on = typeWeight(t.id) > 0;
        const b = chip(t.label, on, () => {
          settings.types[t.id] = !on;
          // Back to following the group when the choice matches it anyway.
          const base = (LEVEL_VALUE[settings.levels[t.interest]] || 0) > 0;
          if (settings.types[t.id] === base) delete settings.types[t.id];
          changed();
        });
        b.dataset.type = t.id;
        if (counts[t.id]) {
          const n = document.createElement('span');
          n.className = 'chip-n';
          n.textContent = counts[t.id].toLocaleString();
          b.appendChild(n);
        }
        chips.appendChild(b);
      }
      box.append(h, chips);
      return box;
    }));
  }

  /* Chains: hidden unless asked for, and then one by one. Listed by how many
     locations the directory has, with a search, because there are nearly
     three hundred and only the big ones are worth scrolling past. */
  function renderChains() {
    const counts = new Map();
    for (const p of state.places.concat(state.eats)) {
      if (p._chain) counts.set(p._chain, (counts.get(p._chain) || 0) + 1);
    }
    el.optChains.checked = settings.showChains;
    el.chainPick.classList.toggle('is-off', !settings.showChains);
    const q = el.chainSearch.value.trim().toLowerCase();
    const all = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const match = all.filter(([name]) => !q || name.toLowerCase().includes(q));
    const shown = match.slice(0, 40);
    el.chainList.replaceChildren(...shown.map(([name, n]) => {
      const off = settings.chainsOff.includes(name);
      const b = chip(name, settings.showChains && !off, () => {
        if (!settings.showChains) return;
        settings.chainsOff = off ? settings.chainsOff.filter((x) => x !== name) : settings.chainsOff.concat(name);
        changed();
      });
      b.dataset.chain = name;
      b.disabled = !settings.showChains;
      const c = document.createElement('span');
      c.className = 'chip-n';
      c.textContent = n;
      b.appendChild(c);
      return b;
    }));
    el.chainNote.textContent = !all.length ? 'Loading chains…'
      : match.length > shown.length ? `${shown.length} of ${match.length} shown. Search for the rest.`
      : `${all.length} chains in the directory.`;
  }

  /* Kinds of food. Each chip cycles on → favourite → off, because there are
     two things worth saying about a cuisine: "never" and "yes, especially".
     Ordered by how many places serve it, with "Not listed" last for the
     restaurants OpenStreetMap does not describe. */
  const CUISINE_CYCLE = { on: 'love', love: 'off', off: 'on' };

  function renderCuisines() {
    const counts = new Map();
    for (const p of state.eats) {
      const menu = p.cuisine && p.cuisine.length ? p.cuisine : ['none'];
      for (const x of menu) counts.set(x, (counts.get(x) || 0) + 1);
    }
    const ids = [...counts.keys()].filter((x) => x !== 'none').sort((a, b) => counts.get(b) - counts.get(a));
    if (counts.has('none')) ids.push('none');
    el.cuisineChips.replaceChildren(...ids.map((id) => {
      const st = settings.cuisines[id] || 'on';
      const label = id === 'none' ? 'Not listed' : (state.cuisineLabels[id] || id);
      const b = chip((st === 'love' ? '★ ' : '') + label, st !== 'off', () => {
        const next = CUISINE_CYCLE[st];
        if (next === 'on') delete settings.cuisines[id]; else settings.cuisines[id] = next;
        changed();
      });
      b.dataset.cuisine = id;
      b.dataset.state = st;
      const n = document.createElement('span');
      n.className = 'chip-n';
      n.textContent = counts.get(id).toLocaleString();
      b.appendChild(n);
      return b;
    }));
    el.cuisineNote.textContent = state.eats.length ? '' : 'Loading places to eat…';
  }

  el.optChains.addEventListener('change', () => { settings.showChains = el.optChains.checked; changed(); });
  el.chainSearch.addEventListener('input', renderChains);

  function changed() {
    saveSettings();
    renderSettings();
    if (state.placesReady) buildPool();
    // A narrower taste should take away what no longer qualifies.
    for (const e of [...entries.values()]) if (!(interest(e.c) > 0)) drop(e);
  }

  el.optLiked.addEventListener('change', () => { settings.liked = el.optLiked.checked; changed(); });
  el.optKm.addEventListener('change', () => { settings.km = el.optKm.checked; changed(); });
  el.optTowns.addEventListener('change', () => {
    settings.towns = el.optTowns.checked;
    if (!settings.towns) for (const e of [...entries.values()]) if (e.isTown) drop(e);
    changed();
  });

  /* The map can go altogether, leaving the whole width to the deck, from
     settings or from the dock mid-drive; and it zooms, as a nudge on top of
     the zoom the speed chooses, so it still pulls out on the highway. */
  function setMap(on) {
    settings.showMap = on;
    changed();
    requestAnimationFrame(() => map?.resize());
  }
  el.optMap.addEventListener('change', () => setMap(el.optMap.checked));
  el.mapBtn.addEventListener('click', () => setMap(!settings.showMap));
  const ZOOM_BIAS = [-3, 3];
  function nudgeZoom(d) {
    settings.zoomBias = Math.max(ZOOM_BIAS[0], Math.min(ZOOM_BIAS[1], (settings.zoomBias || 0) + d));
    saveSettings();
    el.zoomIn.disabled = settings.zoomBias >= ZOOM_BIAS[1];
    el.zoomOut.disabled = settings.zoomBias <= ZOOM_BIAS[0];
  }
  el.zoomIn.addEventListener('click', () => nudgeZoom(1));
  el.zoomOut.addEventListener('click', () => nudgeZoom(-1));

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
      lede: 'The most time a stop may add to the whole trip, not counting the time you spend there.',
      body: () => DETOURS.map((m) => choice(`${m} minutes`,
        { 5: 'Right off the exit', 10: 'A short hop', 15: 'Worth a little effort', 20: 'I have time',
          30: 'Make a day of it' }[m],
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

  // Each row's type and chain, worked out once when it arrives.
  function prepare(rows) {
    const out = [];
    for (const p of rows || []) {
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !p.name) continue;
      p._type = typeOf(p);
      if (!p._type) continue;
      out.push(p);
    }
    return out;
  }

  function learnBrands(rows) {
    for (const p of rows) if (p.brand) brands.set(p.brand.toLowerCase(), p.brand);
  }

  function markChains(rows) {
    for (const p of rows) p._chain = chainOf(p);
  }

  Promise.all([
    fetch('data/places.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
    fetch('data/events.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  ]).then(([places, events]) => {
    state.places = prepare(places?.items);
    learnBrands(state.places);
    markChains(state.places);
    state.regions = places?.meta?.regions || [];
    state.events = events?.items || [];
    state.placesReady = true;
    buildPool();
    renderKinds();
    if (state.phase === 'setup') setStatus(`${state.pool.length.toLocaleString()} places worth a stop, in Proximi's coverage`);
    /* Somewhere to eat is its own file, five times the size of the rest and
       not needed for the first screen, so it follows in the background. The
       first version of this page never loaded it at all, which is why no
       restaurant ever turned up on a drive. */
    return fetch('data/eats.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((eats) => {
      state.eats = prepare(eats?.items);
      state.cuisineLabels = eats?.meta?.cuisineLabels || {};
      learnBrands(state.eats);
      markChains(state.places);
      markChains(state.eats);
      buildPool();
      renderKinds();
      renderChains();
      renderCuisines();
      if (state.phase === 'setup') setStatus(`${state.pool.length.toLocaleString()} places worth a stop, in Proximi's coverage`);
    }).catch(() => { /* the drive works without somewhere to eat */ });
  }).catch(() => setStatus('The places file failed to load.'));

  // For tests and for poking at it from the console.
  window.__drive = {
    state, settings, disp, entries, buildRoute, locate, pointAt, candidatesAhead,
    typeWeight, typeOf, chainOf, types: TYPES, picturesFor, typeLine, isotonic, get map() { return map; }
  };
})();
