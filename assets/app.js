/* Proximi — client.
 * Loads listings from data/events.json and filters/sorts them in the browser.
 * A weekly scheduled job regenerates that file; nothing here talks to a server. */

(() => {
  'use strict';

  const MI_PER_KM = 0.621371;
  const ANY_DISTANCE = 105;   // the radius slider's top stop means "no limit"

  // The single primary answer to "what kind of thing is this?". Anything not
  // listed still works — it just gets title-cased.
  // The vocabulary is written the way it reads on a card, so most labels are
  // just the name with its words capitalised; only the odd ones are listed.
  const TYPE_LABELS = {
    dj: 'DJ', 'q&a': 'Q&A', 'meet & greet': 'Meet & Greet',
    'open mic': 'Open Mic', 'art exhibit': 'Art Exhibit',
    'comedy show': 'Comedy Show', 'sporting event': 'Sporting Event',
    'scavenger hunt': 'Scavenger Hunt', 'open studio': 'Open Studio',
    'speed dating': 'Speed Dating', other: 'Other'
  };

  const TIME_OF_DAY = [
    { id: 'any',       label: 'Any time' },
    { id: 'daytime',   label: 'Daytime',   match: (t) => t === 'daytime' },
    { id: 'nighttime', label: 'Nighttime', match: (t) => t === 'nighttime' }
  ];


  // How far ahead to look. `days` is inclusive of today, so 0 means today only.
  // "This weekend" is a window, not a horizon — it has a near edge as well as a
  // far one, which is the whole point of asking for it on a Tuesday.
  const HORIZONS = [
    { id: 'today',   label: 'Today',        days: 0 },
    { id: '3',       label: 'Next 3 days',  days: 3 },
    { id: 'weekend', label: 'This weekend', weekend: true },
    { id: '7',       label: 'Next week',    days: 7 },
    { id: '14',      label: 'Next 2 weeks', days: 14 },
    { id: '30',      label: 'Next month',   days: 30 },
    { id: 'any',     label: 'Anytime',      days: Infinity }
  ];

  // "Repeating only" told a reader a thing came round again but never how
  // often, which is the part that decides whether they can catch it.
  const REPEAT_MODES = [
    { id: 'any',    label: 'All' },
    { id: 'once',   label: 'One-off' },
    { id: 'daily',  label: 'Daily',   match: (c) => c === 'daily' || c === 'weekday' },
    { id: 'weekly', label: 'Weekly',  match: (c) => c === 'weekly' || c === 'fortnightly' },
    { id: 'monthly', label: 'Monthly', match: (c) => c === 'monthly' }
  ];

  const PRESETS = [
    { name: 'Beacon, NY',       lat: 41.5048, lon: -73.9696 },
    { name: 'Poughkeepsie, NY', lat: 41.7004, lon: -73.9210 },
    { name: 'Newburgh, NY',     lat: 41.5034, lon: -74.0104 },
    { name: 'Cold Spring, NY',  lat: 41.4201, lon: -73.9548 },
    { name: 'Rhinebeck, NY',    lat: 41.9270, lon: -73.9124 },
    { name: 'New Paltz, NY',    lat: 41.7470, lon: -74.0870 },
    { name: 'Kingston, NY',     lat: 41.9270, lon: -73.9974 },
    { name: 'Peekskill, NY',    lat: 41.2901, lon: -73.9204 }
  ];

  // Everything the Reset button restores, and the baseline the "N filters
  // active" badge counts against.
  const DEFAULTS = {
    horizon: '7', radius: '75', sort: 'soonest',
    q: '', price: '100',
    freeOnly: false, signupOnly: false, unitsKm: false,
    repeatMode: 'any', timeOfDay: 'any',
    foodOnly: false, outdoorOnly: false,
    // Children-only and senior-focused listings are hidden by default; 21+
    // ones are not. An adult browsing wants the brewery tour, not a grades K-3
    // drop-off or a senior breakfast club.
    showKids: false, showSeniors: false, showAdults: true
  };

  /* ── Decisions ─────────────────────────────────────────
     Swipe left "not for me", swipe right "going". Kept per browser in
     localStorage: there is no backend, and a verdict is personal to the
     reader anyway. Every access is guarded — a private window can throw on
     read as well as write, and a thrown storage call must not take the
     feed down with it. */

  const DECISIONS_KEY = 'proximi.decisions.v1';

  function loadDecisions() {
    try {
      return JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}') || {};
    } catch { return {}; }
  }

  function saveDecisions(map) {
    try { localStorage.setItem(DECISIONS_KEY, JSON.stringify(map)); } catch { /* not fatal */ }
  }

  /* Venues the reader never wants to see again — a brewery whose trivia night
     fills the feed, a chain that lists the same class in nine towns. Stored
     next to the per-listing verdicts and read the same guarded way. */
  const VENUES_KEY = 'proximi.hiddenVenues.v1';

  function loadHiddenVenues() {
    try {
      return new Set(JSON.parse(localStorage.getItem(VENUES_KEY) || '[]'));
    } catch { return new Set(); }
  }

  function saveHiddenVenues(set) {
    try { localStorage.setItem(VENUES_KEY, JSON.stringify([...set])); } catch { /* not fatal */ }
  }

  /* Places the reader means to get to. The feed has a yes/no per listing; a
     directory needs the same gesture, or it is a read-only list of facts.
     Stored under the same guarded pattern — a browser with storage blocked
     loses the marks, never the page. */
  const SAVED_KEY = 'proximi.savedPlaces.v1';

  function loadSavedPlaces() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'));
    } catch { return new Set(); }
  }

  function saveSavedPlaces(set) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify([...set])); } catch { /* not fatal */ }
  }

  // "See listing" is what a card says when nothing named a place; it is not
  // itself a place, so it never becomes a row in Places or a filterable venue.
  const venueOf = (item) =>
    (item.venue && item.venue !== 'See listing') ? item.venue : null;

  const $ = (id) => document.getElementById(id);

  const el = {
    list: $('list'), empty: $('empty'), banner: $('data-banner'),
    types: $('types'), presets: $('presets'), horizon: $('horizon'),
    repeats: $('repeats'), showKids: $('show-kids'), showSeniors: $('show-seniors'),
    showAdults: $('show-adults'),
    tod: $('tod'), foodOnly: $('food-only'), outdoorOnly: $('outdoor-only'),
    q: $('q'), sort: $('sort'),
    radius: $('radius'), radiusOut: $('radius-out'),
    price: $('price'), priceOut: $('price-out'),
    freeOnly: $('free-only'), signupOnly: $('signup-only'), unitsKm: $('units-km'),
    toast: $('toast'), hiddenNote: $('hidden-note'), showHiddenBtn: $('show-hidden'),
    tabEvents: $('tab-events'), tabPlaces: $('tab-places'),
    tabEventsN: $('tab-events-n'), tabPlacesN: $('tab-places-n'),
    eventsView: $('events-view'), placesView: $('places-view'),
    placesList: $('places-list'), placesKinds: $('places-kinds'),
    placesSearch: $('places-search'), placesSort: $('places-sort'),
    placesLocal: $('places-local'), placesSaved: $('places-saved'),
    placesSummary: $('places-summary'),
    venueBanner: $('venue-banner'),
    buildStamp: $('build-stamp'),
    venueBannerName: $('venue-banner-name'), venueBannerClear: $('venue-banner-clear'),
    clearHiddenBtn: $('clear-hidden'),
    locStatus: $('loc-status'), useMyLocation: $('use-my-location'),
    placeForm: $('place-form'), placeInput: $('place-input'),
    contextPlace: $('context-place'), contextScope: $('context-scope'),
    openFilters: $('open-filters'), closeFilters: $('close-filters'),
    openLocation: $('open-location'), applyFilters: $('apply-filters'),
    resetFilters: $('reset-filters'),
    sheet: $('filter-sheet'), scrim: $('scrim'), filtersCount: $('filters-count')
  };

  const state = {
    items: [],
    origin: null,
    activeTypes: new Set(),
    excludedTypes: new Set(),
    decisions: loadDecisions(),
    showHidden: false,
    hiddenVenues: loadHiddenVenues(),
    venueFilter: null,          // showing one venue's listings only
    places: [],                 // the directory, loaded alongside the feed
    placeKind: null,            // Places narrowed to one sort of place
    placeSort: 'near',
    placesLocalOnly: false,
    savedPlaces: loadSavedPlaces(),
    placesSavedOnly: false,
    view: 'events',             // 'events' | 'places'
    horizon: DEFAULTS.horizon,
    repeatMode: DEFAULTS.repeatMode,
    timeOfDay: DEFAULTS.timeOfDay,
    staleCount: 0,
    tz: null
  };

  /* ── Geo ──────────────────────────────────────────────── */

  function haversineMiles(a, b) {
    const R = 3958.8;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const useKm = () => el.unitsKm.checked;
  const distanceUnit = () => useKm() ? 'km' : 'mi';
  const toDisplayDistance = (mi) => useKm() ? mi / MI_PER_KM : mi;

  function formatDistance(mi) {
    const d = toDisplayDistance(mi);
    if (d < 0.1) return 'Right here';
    return `${d < 10 ? d.toFixed(1) : Math.round(d)} ${distanceUnit()} away`;
  }

  /* ── Dates ────────────────────────────────────────────── */

  // Times render in the timezone the listings were published in, not the
  // viewer's, so a 7pm Beacon show reads as 7pm from anywhere.
  const zoneOpts = () => (state.tz ? { timeZone: state.tz } : {});

  // Whole-day index (days since epoch) as observed in the listing timezone, so
  // day grouping never straddles a UTC midnight.
  //
  // The formatter is built once per timezone and the results are memoised.
  // Constructing an Intl.DateTimeFormat is expensive, and this is the hottest
  // function in the app — the sort comparator alone reaches it O(n log n)
  // times. Built per call, it was 63% of a render, and a render took 2.9s.
  let dayFmt = null;
  let dayFmtTz;
  let dayCache = new Map();

  function dayNumber(d) {
    const ms = d.getTime();
    const hit = dayCache.get(ms);
    if (hit !== undefined) return hit;
    if (!dayFmt || dayFmtTz !== state.tz) {
      dayFmt = new Intl.DateTimeFormat('en-US', {
        ...zoneOpts(), year: 'numeric', month: '2-digit', day: '2-digit'
      });
      dayFmtTz = state.tz;
      dayCache = new Map();
    }
    const p = dayFmt.formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    const n = Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000;
    dayCache.set(ms, n);
    return n;
  }

  // Constant for the life of a render, and read on nearly every listing.
  let todayCache = null;
  const todayNumber = () => (todayCache ??= dayNumber(new Date()));

  // Turn a day index back into a Date at that civil day's UTC midnight, so it
  // can be formatted with timeZone:'UTC' without drifting.
  const dayToDate = (n) => new Date(n * 86400000);

  function resolveStart(item) {
    if (item.start) return new Date(item.start);
    const d = new Date();
    d.setDate(d.getDate() + (item.daysFromNow || 0));
    const [h, m] = (item.time || '00:00').split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d;
  }

  const resolveEnd = (item) => (item.end ? new Date(item.end) : null);

  const isOngoing = (item) =>
    item._end && dayNumber(item._start) < todayNumber() && dayNumber(item._end) >= todayNumber();

  // The day a listing sorts and groups under. A multi-day run that started
  // before today is still happening, so it belongs under Today.
  function effectiveDay(item) {
    return item._day ??= (isOngoing(item) ? todayNumber() : dayNumber(item._start));
  }

  function isExpired(item) {
    const now = new Date();
    if (item._end) return item._end < now;
    if (item.recurrence) return dayNumber(item._start) < todayNumber();
    return item._start < now;
  }

  function dayHeading(dayNum) {
    const diff = dayNum - todayNumber();
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    const d = dayToDate(dayNum);
    const opts = diff < 7
      ? { weekday: 'long' }
      : { weekday: 'long', month: 'short', day: 'numeric' };
    return d.toLocaleDateString([], { timeZone: 'UTC', ...opts });
  }

  const formatTime = (d) =>
    d.toLocaleTimeString([], { ...zoneOpts(), hour: 'numeric', minute: '2-digit' })
     .replace(':00', '');

  // What the card says about timing. The day heading already carries the day
  // when grouping is on, so this only adds it back when it does not.
  function formatWhen(item, grouped) {
    const parts = [];
    if (!grouped) {
      const diff = effectiveDay(item) - todayNumber();
      parts.push(diff === 0 ? 'Today'
               : diff === 1 ? 'Tomorrow'
               : dayToDate(effectiveDay(item)).toLocaleDateString([], {
                   timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'
                 }));
    }

    if (isOngoing(item)) {
      parts.push(`on now, through ${dayToDate(dayNumber(item._end))
        .toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric' })}`);
    } else if (item._end && dayNumber(item._end) > dayNumber(item._start)) {
      parts.push(`${formatTime(item._start)}, through ${dayToDate(dayNumber(item._end))
        .toLocaleDateString([], { timeZone: 'UTC', month: 'short', day: 'numeric' })}`);
    } else {
      parts.push(formatTime(item._start));
    }
    return parts.join(', ');
  }

  /* ── Price ────────────────────────────────────────────── */

  // A null price means the source published none — never silently a $0.
  const priceKnown = (item) => item.price != null && item.price.min != null;
  const priceMin = (item) => item.price?.min ?? 0;
  const priceMax = (item) => item.price?.max ?? priceMin(item);
  const isFree = (item) => priceKnown(item) && priceMax(item) === 0;

  function formatPrice(item) {
    if (!priceKnown(item)) return 'See listing';
    const lo = priceMin(item), hi = priceMax(item);
    if (hi === 0) return 'Free';
    if (lo === 0) return `Free – $${hi}`;
    if (lo === hi) return `$${lo}`;
    return `$${lo}–$${hi}`;
  }

  /* ── Filtering ────────────────────────────────────────── */

  const horizonDays = () =>
    (HORIZONS.find((h) => h.id === state.horizon) || HORIZONS[2]).days;

  const radiusMiles = () => {
    const v = Number(el.radius.value);
    if (v >= ANY_DISTANCE) return Infinity;
    return useKm() ? v * MI_PER_KM : v;
  };

  const maxPrice = () => {
    const v = Number(el.price.value);
    return v >= Number(el.price.max) ? Infinity : v;
  };

  // Day index 0 is 1970-01-01, a Thursday, so (n + 4) % 7 gives 0 = Sunday.
  const weekdayOf = (dayNum) => (((dayNum % 7) + 4) % 7 + 7) % 7;

  /* The coming Friday, Saturday and Sunday. Asked on one of those days it means
     the weekend already under way, not the next one — nobody wants "this
     weekend" on a Saturday to start showing them next Friday. */
  function weekendWindow() {
    const today = todayNumber();
    const dow = weekdayOf(today);                 // 0 Sun … 5 Fri, 6 Sat
    if (dow === 0) return [today, today];         // Sunday: today only
    if (dow === 5 || dow === 6) return [today, today + (6 - dow) + 1];
    return [today + (5 - dow), today + (7 - dow)];
  }

  function matchesHorizon(item) {
    const horizon = HORIZONS.find((h) => h.id === state.horizon) || HORIZONS[3];
    const day = effectiveDay(item);
    if (horizon.weekend) {
      const [from, to] = weekendWindow();
      // A run already under way counts if it covers any of the weekend.
      const end = item._end ? dayNumber(item._end) : day;
      return day <= to && end >= from;
    }
    if (horizon.days === Infinity) return true;
    const days = day - todayNumber();
    return days >= 0 && days <= horizon.days;
  }

  function matchesQuery(item) {
    const q = el.q.value.trim().toLowerCase();
    if (!q) return true;
    return [item.title, item.venue, item.city, item.address,
            item.description, ...(item.categories || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  // A listing is several kinds of thing at once — a paint-and-sip is a class,
  // and creative, and food & drink. `type` stays the primary one for the badge
  // and the sort; every filter reads the whole set.
  const typesOf = (item) => (item.types?.length ? item.types : [item.type || 'other']);

  const repeatsOf = (item) => item.repeats === true || !!item.recurrence;

  const CADENCE_LABELS = {
    daily: 'Every day', weekday: 'Weekdays', weekly: 'Every week',
    fortnightly: 'Every 2 weeks', monthly: 'Every month',
    bookable: 'Book any day', occasional: 'Repeats'
  };
  const cadenceLabel = (item) => CADENCE_LABELS[item.cadence] || 'Repeats';
  const audienceOf = (item) => item.audience || 'all';

  function filtered() {
    const rMax = radiusMiles();
    const pMax = maxPrice();

    return state.items.filter((item) => {
      const audience = audienceOf(item);
      // 'kids' is children-only, 'family' is aimed at families with young
      // children. One control hides both — an adult browsing for themselves
      // wants neither, and splitting them across two checkboxes only asks the
      // reader to understand a distinction the data draws for its own reasons.
      if (audience === 'family' && !el.showKids.checked) return false;
      if (audience === 'seniors' && !el.showSeniors.checked) return false;
      if (audience === 'adults' && !el.showAdults.checked) return false;
      if (state.repeatMode !== 'any') {
        const mode = REPEAT_MODES.find((m) => m.id === state.repeatMode);
        if (state.repeatMode === 'once') {
          if (repeatsOf(item)) return false;
        } else if (!mode?.match?.(item.cadence)) {
          return false;
        }
      }
      // A hidden listing is gone until the reader asks to see hidden ones —
      // this is the whole point of a left swipe, so it runs before anything
      // else and is not softened by the other filters.
      if (!state.showHidden && state.decisions[item.id] === 'hidden') return false;
      const venue = venueOf(item);
      if (state.venueFilter) {
        if (venue !== state.venueFilter) return false;
      } else if (venue && state.hiddenVenues.has(venue)) {
        return false;
      }
      const kinds = typesOf(item);
      // Excluding wins over including: hiding Games should hide a listing that
      // is also a Class, or the exclusion does not do what it says.
      if (kinds.some((t) => state.excludedTypes.has(t))) return false;
      if (state.activeTypes.size && !kinds.some((t) => state.activeTypes.has(t))) return false;
      if (el.foodOnly.checked && !item.hasFood) return false;
      if (el.outdoorOnly.checked && item.setting !== 'outdoor') return false;
      const tod = TIME_OF_DAY.find((t) => t.id === state.timeOfDay);
      if (tod && tod.match && !tod.match(item.timeOfDay)) return false;
      if (el.freeOnly.checked && !isFree(item)) return false;
      if (el.signupOnly.checked && !item.signupRequired) return false;
      // Only exclude what we know costs too much. A listing with no published
      // price stays in and shows "See listing" — the cap filters expensive
      // things, it does not filter unknowns.
      if (pMax !== Infinity && priceKnown(item) && priceMin(item) > pMax) return false;
      if (item._distance != null && item._distance > rMax) return false;
      if (!matchesHorizon(item)) return false;
      if (!matchesQuery(item)) return false;
      return true;
    });
  }

  const grouped = () => el.sort.value === 'soonest';

  function sorted(items) {
    const by = el.sort.value;
    const dist = (i) => (i._distance == null ? Infinity : i._distance);
    const copy = items.slice();

    if (by === 'nearest' && state.origin) {
      copy.sort((a, b) => dist(a) - dist(b) || a._start - b._start);
    } else if (by === 'cheapest') {
      const key = (i) => (priceKnown(i) ? priceMin(i) : Infinity);
      copy.sort((a, b) => key(a) - key(b) || a._start - b._start);
    } else {
      // Soonest: by day, then by start time, then by how close it is.
      copy.sort((a, b) =>
        effectiveDay(a) - effectiveDay(b) ||
        a._start - b._start ||
        dist(a) - dist(b));
    }
    return copy;
  }

  /* ── Rendering ────────────────────────────────────────── */

  const typeLabel = (t) => TYPE_LABELS[t]
    || (t ? t.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Other');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function formatDuration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h} hr`;
  }

  /* ── Calendar ──────────────────────────────────────────
     A swipe right has to leave something behind on the reader's own
     calendar, and there is no backend to invite them from — so build an
     iCalendar file in the page and hand it over. Every calendar app on
     every platform reads .ics; on iOS the download opens Calendar directly. */

  // RFC 5545: backslash, semicolon and comma are escaped, newlines become \n.
  const icsText = (v) => String(v ?? '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;')
    .replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  // Lines are limited to 75 octets, continued by CRLF + one space.
  function icsFold(line) {
    const out = [];
    let rest = line;
    while (rest.length > 74) {
      out.push(rest.slice(0, 74));
      rest = ' ' + rest.slice(74);
    }
    out.push(rest);
    return out.join('\r\n');
  }

  const icsStamp = (d) =>
    d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const HOUR = 3600 * 1000;

  /* A listing's start and end describe when it is *available*, which for a
     run — a daily tour, a self-guided trail — can be years wide. A calendar
     wants one sitting you could actually attend, so:
       · a run already under way is booked for today at its usual hour,
       · anything wider than a day becomes a two-hour visit,
       · the real span moves into the notes rather than being lost.        */
  function icsWindow(item) {
    const start = new Date(item.start);
    const end = item.end ? new Date(item.end) : null;
    const now = new Date();
    const ongoing = end && start < now && end > now;

    let from = start;
    if (ongoing) {
      from = new Date(now);
      from.setHours(start.getHours(), start.getMinutes(), 0, 0);
    }
    const span = end ? end - start : null;
    const isRun = span == null || span > 24 * HOUR;
    return {
      from,
      to: isRun ? new Date(from.getTime() + 2 * HOUR) : new Date(from.getTime() + span),
      estimated: isRun,
      runsUntil: (isRun && end) ? end : null,
    };
  }

  function icsFor(item) {
    const { from, to, estimated, runsUntil } = icsWindow(item);
    // venue, address and city overlap constantly — address often already
    // contains both — so fold them rather than repeating the venue twice.
    const where = [...new Set([item.venue, item.address, item.city].filter(Boolean))]
      .filter((part, i, all) => !all.some((other, j) => j !== i && other.includes(part)))
      .join(', ');
    const notes = [
      item.description,
      runsUntil && `Runs through ${runsUntil.toLocaleDateString()} — this is one visit.`,
      item.url && `Details: ${item.url}`,
      estimated && 'End time is an estimate — check the listing.',
    ].filter(Boolean).join('\n\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Proximi//EN', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${icsText(item.id)}@proximi`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART:${icsStamp(from)}`,
      `DTEND:${icsStamp(to)}`,
      `SUMMARY:${icsText(item.title)}`,
      where ? `LOCATION:${icsText(where)}` : null,
      notes ? `DESCRIPTION:${icsText(notes)}` : null,
      item.url ? `URL:${icsText(item.url)}` : null,
      (item.lat != null && item.lon != null) ? `GEO:${item.lat};${item.lon}` : null,
      'END:VEVENT', 'END:VCALENDAR',
    ].filter(Boolean);
    return lines.map(icsFold).join('\r\n') + '\r\n';
  }

  function addToCalendar(item) {
    const blob = new Blob([icsFor(item)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (item.title || 'event').replace(/[^\w -]+/g, '').slice(0, 60) + '.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  /* ── Verdicts ──────────────────────────────────────────── */

  function decide(item, verdict) {
    const previous = state.decisions[item.id];
    if (verdict) state.decisions[item.id] = verdict;
    else delete state.decisions[item.id];
    saveDecisions(state.decisions);
    if (verdict === 'going') addToCalendar(item);
    // Touch only the card that changed. A verdict cannot alter which other
    // listings match, so rebuilding the list to show one badge is work nobody
    // asked for — and it is what the swipe was waiting on.
    if (!patchCard(item)) render(); else { updateHiddenNote(); updateFilterCount(); }
    toast(verdict === 'going' ? `Added “${item.title}” to your calendar`
          : verdict === 'hidden' ? `Hid “${item.title}”`
          : `Restored “${item.title}”`,
          () => decide(item, previous || null));
  }

  /* Update one card in place. Returns false only when the list genuinely has
     to be rebuilt — the caller falls back to a full render then. */
  function patchCard(item) {
    const slot = el.list.querySelector(`.card-slot[data-id="${CSS.escape(item.id)}"]`);
    if (!slot) return false;
    const verdict = state.decisions[item.id];
    if (verdict === 'hidden' && !state.showHidden) return removeCard(item, slot);
    slot.classList.toggle('is-going', verdict === 'going');
    slot.classList.toggle('is-hidden', verdict === 'hidden');
    const tags = slot.querySelector('.tags');
    const badge = tags?.querySelector('.badge-going');
    if (verdict === 'going' && !badge) {
      const b = document.createElement('span');
      b.className = 'badge badge-going';
      b.textContent = 'Going';
      tags.prepend(b);
    } else if (verdict !== 'going') {
      badge?.remove();
    }
    return true;
  }

  /* Hiding takes a card out of the list. Everything that changes as a result —
     the day's count, the results line, the chip counts — is derivable from
     what is already on screen, so none of it needs the list rebuilt. */
  function removeCard(item, slot) {
    const divider = slot.previousElementSibling?.classList.contains('day-head')
      ? slot.previousElementSibling
      : [...el.list.children].slice(0, [...el.list.children].indexOf(slot))
          .reverse().find((n) => n.classList.contains('day-head'));
    slot.remove();
    if (divider) {
      const n = divider.querySelector('.day-count');
      const left = n ? Number(n.textContent) - 1 : 0;
      if (left > 0 && n) n.textContent = String(left);
      else divider.remove();          // that was the day's last listing
    }
    state.lastResults = (state.lastResults || []).filter((i) => i.id !== item.id);
    for (const t of typesOf(item)) {
      const chip = el.types.querySelector(`.chip[data-type="${CSS.escape(t)}"] .chip-n`);
      if (chip) chip.textContent = String(Math.max(0, Number(chip.textContent) - 1));
    }
    updateContextBar(el.list.querySelectorAll('.card-slot').length);
    return true;
  }

  let toastTimer = null;
  function toast(message, undo) {
    const box = el.toast;
    if (!box) return;
    box.querySelector('.toast-msg').textContent = message;
    const btn = box.querySelector('.toast-undo');
    btn.onclick = () => { clearTimeout(toastTimer); box.hidden = true; undo(); };
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }

  /* ── Swipe ─────────────────────────────────────────────
     Only claims the gesture once it is clearly horizontal, so a vertical
     drag still scrolls the page — the mistake that makes a swipe list
     unusable on a phone. The buttons underneath do the same two things for
     anyone on a keyboard, a mouse, or who never discovers the gesture. */

  const SWIPE_COMMIT = 90;   // px past which the verdict sticks

  function attachSwipe(li, surface, item) {
    let startX = 0, startY = 0, dx = 0, active = false, decided = false, frame = null;

    li.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('a, button')) return;   // links keep their taps
      startX = e.clientX; startY = e.clientY; dx = 0;
      active = false; decided = false;
    });

    li.addEventListener('pointermove', (e) => {
      if (!startX && !startY) return;
      if (e.buttons === 0) return;
      const mx = e.clientX - startX, my = e.clientY - startY;
      if (!active) {
        if (Math.abs(mx) < 12 || Math.abs(mx) <= Math.abs(my)) return;
        active = true;
        li.setPointerCapture?.(e.pointerId);
        li.classList.add('is-swiping');
        surface.classList.add('is-swiping');
      }
      dx = mx;
      // Pointer events can outpace the display; writing style on each one asks
      // for style recalculation the frame will never show. One write per frame.
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          surface.style.setProperty('--dx', `${dx}px`);
          const want = dx > SWIPE_COMMIT ? 'going' : dx < -SWIPE_COMMIT ? 'hidden' : 'none';
          if (li.dataset.swipe !== want) li.dataset.swipe = want;
        });
      }
      e.preventDefault();
    });

    const finish = () => {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (!active) { startX = startY = 0; return; }
      const verdict = dx > SWIPE_COMMIT ? 'going' : dx < -SWIPE_COMMIT ? 'hidden' : null;
      li.classList.remove('is-swiping');
      surface.classList.remove('is-swiping');
      surface.style.removeProperty('--dx');
      delete li.dataset.swipe;
      active = false; startX = startY = 0;
      if (verdict && !decided) { decided = true; decide(item, verdict); }
    };
    // pointerup and pointercancel are enough: capturing the pointer guarantees
    // both are delivered here. lostpointercapture must NOT end the gesture —
    // a touch pointer is implicitly captured by whatever element received the
    // pointerdown, so calling setPointerCapture above *transfers* it and fires
    // lostpointercapture on that descendant, which bubbles up to this listener.
    // Treating that as the end reset the drag a few pixels in, which is why
    // swiping worked with a mouse (no implicit capture) and never with a
    // finger.
    li.addEventListener('pointerup', finish);
    li.addEventListener('pointercancel', finish);
  }

  function card(item, isGrouped) {
    const li = document.createElement('li');
    const verdict = state.decisions[item.id];
    li.className = 'card-slot' + (verdict ? ` is-${verdict}` : '');
    li.dataset.id = item.id;
    const surface = document.createElement('article');
    surface.className = 'card';

    const meta = [`<span>${esc(item.venue)}${item.city ? ' · ' + esc(item.city) : ''}</span>`];
    if (item._distance != null) {
      meta.push(`<span class="dist">${esc(formatDistance(item._distance))}</span>`);
    }
    if (item.durationMin) meta.push(`<span>${formatDuration(item.durationMin)}</span>`);
    if (item.host && item.host !== item.venue) {
      meta.push(`<span class="host">by ${esc(item.host)}</span>`);
    }

    const links = [];
    if (item.signupRequired && item.signupUrl) {
      links.push(`<a class="link-btn is-signup" href="${esc(item.signupUrl)}"
                     target="_blank" rel="noopener noreferrer">Sign up ↗</a>`);
    }
    if (item.url) {
      links.push(`<a class="link-btn" href="${esc(item.url)}"
                     target="_blank" rel="noopener noreferrer">Details ↗</a>`);
    }

    surface.innerHTML = `
      <div class="card-top">
        <div class="card-lead">
          <h3 class="card-title">${esc(item.title)}</h3>
          <div class="card-when">
            ${esc(formatWhen(item, isGrouped))}
            ${item.recurrence ? `<span class="repeat">· ${esc(item.recurrence)}</span>` : ''}
          </div>
        </div>
        <div class="price-tag ${isFree(item) ? 'is-free' : ''} ${priceKnown(item) ? '' : 'is-unknown'}">
          ${esc(formatPrice(item))}
          ${item.price?.note ? `<span class="price-note">${esc(item.price.note)}</span>` : ''}
        </div>
      </div>
      <div class="card-meta">${meta.join('')}</div>
      ${item.description ? `<p class="card-desc">${esc(item.description)}</p>` : ''}
      <div class="card-bottom">
        <div class="tags">
          <span class="badge badge-type">${esc(typeLabel(item.type))}</span>
          ${typesOf(item).slice(1).map((t) =>
            `<span class="badge badge-type is-secondary">${esc(typeLabel(t))}</span>`).join('')}
          ${state.decisions[item.id] === 'going' ? '<span class="badge badge-going">Going</span>' : ''}
          ${repeatsOf(item)
            ? `<span class="badge badge-repeat">${esc(cadenceLabel(item))}</span>` : ''}
          ${audienceOf(item) === 'family' ? '<span class="badge badge-kids">Family &amp; kids</span>' : ''}
          ${audienceOf(item) === 'seniors' ? '<span class="badge badge-kids">Seniors</span>' : ''}
          ${audienceOf(item) === 'adults' ? '<span class="badge badge-adults">21+</span>' : ''}

        </div>
        ${links.join('')}
      </div>
      <div class="card-verdict">
        <button type="button" class="verdict-btn is-no" data-verdict="hidden"
                title="Not for me" aria-label="Not for me — hide ${esc(item.title)}">✕</button>
        <button type="button" class="verdict-btn is-yes" data-verdict="going"
                title="Add to calendar"
                aria-label="I'm going — add ${esc(item.title)} to calendar">✓</button>
      </div>`;

    // The rail is a fixed backdrop the card slides over, so it stays put while
    // the card moves and is revealed on the side the card is leaving. Dragging
    // left uncovers the right edge, so "Not for me" lives on the right.
    const rail = document.createElement('div');
    rail.className = 'swipe-rail';
    rail.innerHTML = '<span class="rail-yes">✓ Going</span><span class="rail-no">Not for me ✕</span>';
    li.append(rail, surface);

    for (const btn of surface.querySelectorAll('.verdict-btn')) {
      btn.addEventListener('click', () => {
        const want = btn.dataset.verdict;
        decide(item, verdict === want ? null : want);
      });
    }
    attachSwipe(li, surface, item);
    return li;
  }

  function dayDivider(dayNum, n) {
    const li = document.createElement('li');
    li.className = 'day-head';
    li.setAttribute('role', 'presentation');
    li.innerHTML = `<span class="day-name">${esc(dayHeading(dayNum))}</span>
                    <span class="day-count">${n}</span>`;
    return li;
  }

  let lastRenderDay = null;

  function render() {
    // today rolls over and the ongoing-run test moves with it.
    todayCache = null;
    const today = todayNumber();
    if (lastRenderDay !== today) {
      // A page left open past midnight holds per-item day indices that were
      // true yesterday. Cheap to drop, and only ever once a day.
      for (const item of state.items) item._day = undefined;
      lastRenderDay = today;
    }

    const results = sorted(filtered());
    const isGrouped = grouped();
    const nodes = [];

    if (isGrouped) {
      // Walk the sorted list and drop a heading in whenever the day changes.
      let current = null;
      let runStart = 0;
      const flush = (endIndex) => {
        if (current === null) return;
        nodes.splice(runStart, 0, dayDivider(current, endIndex - runStart));
      };
      for (const item of results) {
        const d = effectiveDay(item);
        if (d !== current) {
          flush(nodes.length);
          current = d;
          runStart = nodes.length;
        }
        nodes.push(card(item, true));
      }
      flush(nodes.length);
    } else {
      for (const item of results) nodes.push(card(item, false));
    }

    el.list.replaceChildren(...nodes);

    el.empty.hidden = results.length > 0;
    if (!results.length) {
      el.empty.textContent = state.items.length
        ? 'Nothing matches those filters. Try looking further ahead, widening the radius, or clearing a category.'
        : 'No upcoming listings.';
    }

    state.lastResults = results;
    updateVenueBanner();
    updateContextBar(results.length);
    updateHiddenNote();
    updateFilterCount();
    renderTypeCounts();
    el.applyFilters.textContent =
      `Show ${results.length} ${results.length === 1 ? 'result' : 'results'}`;
  }

  // A swipe left removes a listing from view for good, so the count and the
  // way back are always on screen rather than buried in a menu.
  function updateHiddenNote() {
    if (!el.hiddenNote) return;
    const verdicts = Object.values(state.decisions);
    const hidden = verdicts.filter((v) => v === 'hidden').length;
    const going = verdicts.filter((v) => v === 'going').length;
    const bits = [];
    if (hidden) bits.push(`${hidden} hidden`);
    if (going) bits.push(`${going} going`);
    if (state.hiddenVenues.size) bits.push(`${state.hiddenVenues.size} venues muted`);
    el.hiddenNote.textContent = bits.join(' · ') || 'Nothing hidden yet.';
    el.showHiddenBtn.hidden = !hidden;
    el.clearHiddenBtn.hidden = !hidden;
    el.showHiddenBtn.textContent = state.showHidden ? 'Hide them again' : 'Show hidden';
    el.showHiddenBtn.setAttribute('aria-pressed', String(state.showHidden));
  }

  /* ── Places ────────────────────────────────────────────
     Places used to be a projection of the feed: somewhere existed because
     something was scheduled there. That answers "where is this happening" and
     never "what is around here", which leaves out most of what a region is
     actually good for — the gardens, the historic houses, the wineries, the
     antique shops, the castle. data/places.json carries those on their own
     terms, and any events they do have get attached to them.               */

  const PLACE_KIND_LABELS = {
    museum: 'Museums', gallery: 'Galleries & studios',
    'historic house': 'Historic houses & mansions', castle: 'Castles',
    'historic site': 'Historic sites', garden: 'Gardens & arboretums',
    park: 'Parks & nature', attraction: 'Attractions',
    winery: 'Wineries & vineyards', brewery: 'Breweries & distilleries',
    farm: 'Farms & orchards', theatre: 'Theatres', cinema: 'Cinemas',
    'music venue': 'Music venues', stadium: 'Stadiums & arenas',
    library: 'Libraries', bookshop: 'Book shops', 'antique shop': 'Antique shops',
    mall: 'Malls & markets', shop: 'Shops', cafe: 'Cafés',
    restaurant: 'Restaurants & bars', 'community centre': 'Community centres',
    'place of worship': 'Places of worship', school: 'Schools & colleges',
    club: 'Clubs & halls', other: 'Everywhere else'
  };

  const kindLabel = (k) => PLACE_KIND_LABELS[k] || k || 'Everywhere else';

  // The order the server used, so chips read the same way twice.
  let placeKindOrder = Object.keys(PLACE_KIND_LABELS);

  /* A place carries the distance the build computed, from the coverage
     centre. Once the reader sets their own location that number is wrong, so
     it is recomputed here and the stored one only ever serves as a fallback. */
  function placeMiles(place) {
    if (!state.origin || place.lat == null) return place.miles ?? null;
    return haversineMiles(state.origin, { lat: place.lat, lon: place.lon });
  }

  function eventCounts() {
    const counts = new Map();
    for (const item of state.items) {
      const v = venueOf(item);
      if (v) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return counts;
  }

  /* Every place worth showing: the directory, plus any venue that turned up
     on an event but that OpenStreetMap did not know about.

     This walks the whole feed and the whole directory — thousands of rows on
     each side — so it is built once and kept until something it depends on
     actually changes. Search-as-you-type filters the cached array; it does not
     rebuild it. (Rebuilding per keystroke is the same mistake that made
     swiping laggy: correct, cheap-looking, and quadratic in practice.) */
  let placeCache = null;
  let placeCacheKey = '';

  function invalidatePlaces() { placeCache = null; }

  function placeIndex() {
    const key = `${state.items.length}|${state.places.length}|`
      + (state.origin ? `${state.origin.lat},${state.origin.lon}` : '-');
    if (placeCache && placeCacheKey === key) return placeCache;
    placeCacheKey = key;
    placeCache = buildPlaceIndex();
    return placeCache;
  }

  function buildPlaceIndex() {
    const counts = eventCounts();
    const rows = [];
    const claimed = new Set();

    for (const place of state.places) {
      const n = counts.get(place.name) || place.events || 0;
      claimed.add(place.name);
      rows.push({ ...place, events: n, _miles: placeMiles(place) });
    }

    // A venue the directory missed still belongs in the list — it demonstrably
    // exists, because something is happening there tonight. But an event feed
    // names rooms as often as it names buildings ("Youth Services Program
    // Room", "311 Learning Annex"), and a room is not somewhere to go. A
    // venue earns a row by being recognisable as a kind of place, or by
    // carrying a programme big enough that it is plainly a real one.
    const extra = new Map();
    for (const item of state.items) {
      const v = venueOf(item);
      if (!v || claimed.has(v) || item.lat == null) continue;
      const row = extra.get(v);
      if (row) { row.events++; continue; }
      extra.set(v, {
        id: `feed-${v}`, name: v, kind: item.placeKind || null,
        kinds: item.placeKind ? [item.placeKind] : [],
        lat: item.lat, lon: item.lon, city: item.city, address: item.address,
        url: null, phone: null, openingHours: null, brand: null, secondHand: null,
        description: null, events: 1, source: 'Event listings',
        _miles: placeMiles(item)
      });
    }
    const REAL_PLACE_EVENTS = 3;
    return rows.concat([...extra.values()].filter(
      (p) => p.kind || p.events >= REAL_PLACE_EVENTS));
  }

  function placesMatching(all) {
    const q = (el.placesSearch?.value || '').trim().toLowerCase();
    return all.filter((p) => {
      if (state.placesSavedOnly && !state.savedPlaces.has(p.name)) return false;
      if (state.placesLocalOnly && p.brand) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q)
          || (p.city || '').toLowerCase().includes(q)
          || kindLabel(p.kind).toLowerCase().includes(q);
    });
  }

  function sortPlaces(rows) {
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (state.placeSort === 'name') return rows.sort(byName);
    if (state.placeSort === 'events') {
      return rows.sort((a, b) => b.events - a.events
        || (a._miles ?? 1e9) - (b._miles ?? 1e9) || byName(a, b));
    }
    return rows.sort((a, b) => (a._miles ?? 1e9) - (b._miles ?? 1e9) || byName(a, b));
  }

  function renderPlaceKindChips(rows) {
    const counts = new Map();
    for (const p of rows) counts.set(p.kind || 'other', (counts.get(p.kind || 'other') || 0) + 1);
    const kinds = [...counts.keys()].sort((a, b) => {
      if ((a === 'other') !== (b === 'other')) return a === 'other' ? 1 : -1;
      const ia = placeKindOrder.indexOf(a), ib = placeKindOrder.indexOf(b);
      return (ia < 0 ? 1e3 : ia) - (ib < 0 ? 1e3 : ib);
    });

    el.placesKinds.replaceChildren(...kinds.map((k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.kind = k;
      b.setAttribute('aria-pressed', String(state.placeKind === k));
      b.innerHTML = `${esc(kindLabel(k))}<span class="chip-n">${counts.get(k)}</span>`;
      b.addEventListener('click', () => {
        state.placeKind = state.placeKind === k ? null : k;
        renderPlaces();
      });
      return b;
    }));
  }

  function placeRow(p) {
    // The eye mutes a venue in the *feed*. On a place with nothing on it would
    // be a control that does nothing, on every row of a very long list — so it
    // appears once there is something to mute, or once it is already muted.
    const li = document.createElement('li');
    const hidden = state.hiddenVenues.has(p.name);
    li.className = 'place-row' + (hidden ? ' is-hidden' : '');

    const meta = [p.city, p._miles == null ? '' : formatDistance(p._miles)]
      .filter(Boolean).join(' · ');
    const hours = p.openingHours && p.openingHours.length <= 60 ? p.openingHours : '';

    const saved = state.savedPlaces.has(p.name);
    li.innerHTML = `
      <button type="button" class="place-save" aria-pressed="${saved}"
              title="${saved ? 'Remove from want to go' : 'Want to go'}"
              aria-label="${saved ? 'Remove' : 'Add'} ${esc(p.name)} ${saved ? 'from' : 'to'} want to go">
        ${saved ? '★' : '☆'}
      </button>
      <div class="place-main">
        <p class="place-name">${esc(p.name)}</p>
        <p class="place-meta">
          <span class="place-kind">${esc(kindLabel(p.kind))}</span>
          ${p.secondHand ? '<span class="place-tag">used &amp; rare</span>' : ''}
          ${p.brand ? '<span class="place-tag is-chain">chain</span>' : ''}
          ${meta ? `<span class="place-where">${esc(meta)}</span>` : ''}
        </p>
        ${p.description ? `<p class="place-note">${esc(p.description)}</p>` : ''}
        ${hours ? `<p class="place-hours">${esc(hours)}</p>` : ''}
        <p class="place-actions">
          ${p.events ? `<button type="button" class="place-events">${p.events}
             ${p.events === 1 ? 'listing' : 'listings'} →</button>` : ''}
          ${p.url ? `<a class="place-link" href="${esc(p.url)}" target="_blank"
             rel="noopener noreferrer">Website</a>` : ''}
          <a class="place-link" target="_blank" rel="noopener noreferrer"
             href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}">Map</a>
        </p>
      </div>
      ${p.events || hidden ? `
      <button type="button" class="place-mute" aria-pressed="${hidden}"
              title="${hidden ? 'Show this place again' : 'Never show this place'}"
              aria-label="${hidden ? 'Show' : 'Hide'} listings from ${esc(p.name)}">
        ${hidden ? '🚫' : '👁'}
      </button>` : ''}`;

    li.querySelector('.place-events')?.addEventListener('click', () => {
      state.venueFilter = p.name;
      showView('events');
      render();
    });
    li.querySelector('.place-save').addEventListener('click', () => {
      if (state.savedPlaces.has(p.name)) state.savedPlaces.delete(p.name);
      else state.savedPlaces.add(p.name);
      saveSavedPlaces(state.savedPlaces);
      renderPlaces();
    });
    li.querySelector('.place-mute')?.addEventListener('click', () => {
      if (state.hiddenVenues.has(p.name)) state.hiddenVenues.delete(p.name);
      else state.hiddenVenues.add(p.name);
      saveHiddenVenues(state.hiddenVenues);
      renderPlaces();
      render();
    });
    return li;
  }

  function renderPlaces() {
    if (!el.placesList) return;
    const matched = placesMatching(placeIndex());
    renderPlaceKindChips(matched);
    const rows = sortPlaces(state.placeKind
      ? matched.filter((p) => (p.kind || 'other') === state.placeKind)
      : matched);

    if (el.placesSummary) {
      const withEvents = rows.filter((p) => p.events).length;
      const saved = state.savedPlaces.size;
      el.placesSummary.textContent = rows.length
        ? `${rows.length} ${rows.length === 1 ? 'place' : 'places'}`
          + (withEvents ? ` · ${withEvents} with something on` : '')
          + (saved ? ` · ${saved} on your list` : '')
        : '';
    }

    // The directory runs to thousands of rows and the reader is scrolling a
    // phone. Cap the render and say so, rather than building 3,000 nodes.
    const CAP = 300;
    const shown = rows.slice(0, CAP);
    el.placesList.replaceChildren(...shown.map(placeRow));

    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'venue-empty';
      li.textContent = !state.places.length
        ? 'The places directory has not been built yet.'
        : state.placesSavedOnly
          ? 'Nothing on your list yet — tap ☆ on a place to add it.'
          : 'No place matches that.';
      el.placesList.append(li);
    } else if (rows.length > CAP) {
      const li = document.createElement('li');
      li.className = 'venue-empty';
      li.textContent = `Showing the ${CAP} nearest of ${rows.length}. `
        + 'Search or pick a kind to narrow it down.';
      el.placesList.append(li);
    }
  }

  function updateTabCounts() {
    if (el.tabEventsN) el.tabEventsN.textContent = state.items.length || '';
    if (el.tabPlacesN) {
      const n = state.places.length;
      el.tabPlacesN.textContent = n ? (n > 999 ? `${Math.floor(n / 100) / 10}k` : n) : '';
    }
  }

  /* ── The two views ─────────────────────────────────────── */

  function showView(view) {
    state.view = view;
    const onPlaces = view === 'places';
    el.eventsView.hidden = onPlaces;
    el.placesView.hidden = !onPlaces;
    el.tabEvents.classList.toggle('is-on', !onPlaces);
    el.tabPlaces.classList.toggle('is-on', onPlaces);
    el.tabEvents.setAttribute('aria-selected', String(!onPlaces));
    el.tabPlaces.setAttribute('aria-selected', String(onPlaces));
    // Filters, the result count and the one-venue banner all describe the
    // feed. On Places they would be describing something the reader is not
    // looking at. The location chip stays — it is what place distances are
    // measured from.
    if (el.openFilters) el.openFilters.hidden = onPlaces;
    if (el.contextScope) el.contextScope.hidden = onPlaces;
    if (el.venueBanner) el.venueBanner.hidden = onPlaces || !state.venueFilter;
    if (onPlaces) renderPlaces();
    window.scrollTo({ top: 0 });
  }

  function updateVenueBanner() {
    if (!el.venueBanner) return;
    el.venueBanner.hidden = !state.venueFilter || state.view === 'places';
    if (state.venueFilter) el.venueBannerName.textContent = state.venueFilter;
  }

  /* ── Chrome ───────────────────────────────────────────── */

  function updateContextBar(n) {
    el.contextPlace.textContent = state.origin ? state.origin.name : 'Set a location';

    const horizon = HORIZONS.find((h) => h.id === state.horizon) || HORIZONS[2];
    const bits = [horizon.label.toLowerCase()];
    const r = Number(el.radius.value);
    bits.push(r >= ANY_DISTANCE ? 'any distance' : `within ${r} ${distanceUnit()}`);
    el.contextScope.textContent =
      `${n} ${n === 1 ? 'result' : 'results'} · ${bits.join(' · ')}`;
  }

  // Count how many controls sit away from their default, so the button can say
  // how much filtering is in play without opening the sheet.
  function updateFilterCount() {
    let n = 0;
    if (state.horizon !== DEFAULTS.horizon) n++;
    if (el.radius.value !== DEFAULTS.radius) n++;
    if (el.sort.value !== DEFAULTS.sort) n++;
    if (el.q.value.trim() !== DEFAULTS.q) n++;
    if (el.price.value !== DEFAULTS.price) n++;
    if (el.freeOnly.checked) n++;
    if (el.signupOnly.checked) n++;
    if (state.activeTypes.size || state.excludedTypes.size) n++;
    if (state.timeOfDay !== DEFAULTS.timeOfDay) n++;
    if (el.foodOnly.checked) n++;
    if (el.outdoorOnly.checked) n++;
    if (state.repeatMode !== DEFAULTS.repeatMode) n++;
    if (el.showKids.checked !== DEFAULTS.showKids) n++;
    if (el.showSeniors.checked !== DEFAULTS.showSeniors) n++;
    if (el.showAdults.checked !== DEFAULTS.showAdults) n++;

    el.filtersCount.textContent = n;
    el.filtersCount.hidden = n === 0;
    el.openFilters.classList.toggle('is-active', n > 0);
  }

  function showDataAge(meta) {
    if (!meta) return;
    const bits = [];
    if (meta.scrapedAt) {
      const when = new Date(meta.scrapedAt);
      const days = todayNumber() - dayNumber(when);
      bits.push(`Refreshed ${days === 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago'}`);
    }
    if (state.staleCount) bits.push(`${state.staleCount} listing${state.staleCount === 1 ? '' : 's'} since passed`);
    bits.push('times and prices change — check before you go');
    el.banner.textContent = bits.join(' · ') + '.';
    el.banner.hidden = false;
  }

  /* ── Sheet ────────────────────────────────────────────── */

  let lastFocus = null;

  function openSheet(focusPlace) {
    lastFocus = document.activeElement;
    el.sheet.hidden = false;
    el.scrim.hidden = false;
    document.body.classList.add('sheet-open');
    el.openFilters.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => {
      el.sheet.classList.add('is-open');
      el.scrim.classList.add('is-open');
      (focusPlace ? el.placeInput : el.closeFilters).focus();
    });
  }

  function closeSheet() {
    el.sheet.classList.remove('is-open');
    el.scrim.classList.remove('is-open');
    document.body.classList.remove('sheet-open');
    el.openFilters.setAttribute('aria-expanded', 'false');
    const done = () => { el.sheet.hidden = true; el.scrim.hidden = true; };
    // Wait out the slide-out so the panel does not vanish mid-animation.
    setTimeout(done, 200);
    if (lastFocus) lastFocus.focus();
  }

  // Keep tabbing inside the sheet while it is modal.
  function trapFocus(e) {
    if (e.key !== 'Tab' || el.sheet.hidden) return;
    const f = el.sheet.querySelectorAll(
      'button, input, select, a[href], [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  el.openFilters.addEventListener('click', () => openSheet(false));
  el.openLocation.addEventListener('click', () => openSheet(true));
  el.closeFilters.addEventListener('click', closeSheet);
  el.applyFilters.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.sheet.hidden) closeSheet();
    trapFocus(e);
  });

  /* ── Controls ─────────────────────────────────────────── */

  function buildHorizonChips() {
    el.horizon.replaceChildren(...HORIZONS.map((h) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.horizon = h.id;
      b.textContent = h.label;
      b.setAttribute('aria-pressed', String(h.id === state.horizon));
      b.addEventListener('click', () => {
        state.horizon = h.id;
        for (const c of el.horizon.children) {
          c.setAttribute('aria-pressed', String(c.dataset.horizon === h.id));
        }
        render();
      });
      return b;
    }));
  }

  function buildRepeatChips() {
    el.repeats.replaceChildren(...REPEAT_MODES.map((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.mode = m.id;
      b.textContent = m.label;
      b.setAttribute('aria-pressed', String(m.id === state.repeatMode));
      b.addEventListener('click', () => {
        state.repeatMode = m.id;
        for (const c of el.repeats.children) {
          c.setAttribute('aria-pressed', String(c.dataset.mode === m.id));
        }
        render();
      });
      return b;
    }));
  }

  function buildTypeChips() {
    const types = [...new Set(state.items.flatMap(typesOf))]
      .sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));

    el.types.replaceChildren(...types.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.type = t;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `${esc(typeLabel(t))}<span class="chip-n"></span>`;
      // Three states, cycled by clicking: neutral -> only this (and other
      // included types) -> anything but this -> neutral. Exclusion is what a
      // reader wants when one busy category (say, games) is drowning the rest.
      b.addEventListener('click', () => {
        if (state.activeTypes.has(t)) {
          state.activeTypes.delete(t);
          state.excludedTypes.add(t);
        } else if (state.excludedTypes.has(t)) {
          state.excludedTypes.delete(t);
        } else {
          state.activeTypes.add(t);
        }
        b.setAttribute('aria-pressed', String(state.activeTypes.has(t)));
        b.classList.toggle('chip-exclude', state.excludedTypes.has(t));
        render();
      });
      return b;
    }));
  }

  function buildTimeOfDayChips() {
    el.tod.replaceChildren(...TIME_OF_DAY.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.tod = t.id;
      b.textContent = t.label;
      b.setAttribute('aria-pressed', String(t.id === state.timeOfDay));
      b.addEventListener('click', () => {
        state.timeOfDay = t.id;
        for (const c of el.tod.children) {
          c.setAttribute('aria-pressed', String(c.dataset.tod === t.id));
        }
        render();
      });
      return b;
    }));
  }

  // Counts reflect the other active filters but ignore the type filter itself,
  // so the numbers stay useful while picking.
  function renderTypeCounts() {
    const saved = state.activeTypes;
    const savedEx = state.excludedTypes;
    state.activeTypes = new Set();
    state.excludedTypes = new Set();
    const pool = filtered();
    state.activeTypes = saved;
    state.excludedTypes = savedEx;

    const counts = new Map();
    for (const item of pool) {
      for (const t of typesOf(item)) counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const chip of el.types.children) {
      chip.querySelector('.chip-n').textContent = counts.get(chip.dataset.type) || 0;
    }
  }

  function buildPresets() {
    el.presets.replaceChildren(...PRESETS.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.name;
      b.addEventListener('click', () => setOrigin(p.lat, p.lon, p.name));
      return b;
    }));
  }

  function syncRangeLabels() {
    const r = Number(el.radius.value);
    el.radiusOut.textContent =
      r >= ANY_DISTANCE ? 'Any distance' : `${r} ${distanceUnit()}`;

    const p = Number(el.price.value);
    el.priceOut.textContent =
      p >= Number(el.price.max) ? 'Any price' : (p === 0 ? 'Free only' : `$${p}`);
  }

  /* ── Location ─────────────────────────────────────────── */

  function setOrigin(lat, lon, name) {
    state.origin = { lat, lon, name };
    for (const item of state.items) {
      item._distance = haversineMiles(state.origin, { lat: item.lat, lon: item.lon });
    }
    el.locStatus.className = 'loc-status is-set';
    el.locStatus.textContent = `Showing distances from ${name}.`;
    render();
    // Place distances are measured from here too, so the directory is stale
    // the moment this changes — and the reader may be looking at it.
    if (state.view === 'places') renderPlaces();
  }

  function locationError(msg) {
    el.locStatus.className = 'loc-status is-err';
    el.locStatus.textContent = msg;
  }

  el.useMyLocation.addEventListener('click', () => {
    if (!navigator.geolocation) {
      locationError('This browser does not support location sharing — pick a place instead.');
      return;
    }
    el.locStatus.className = 'loc-status';
    el.locStatus.textContent = 'Asking your browser for your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => setOrigin(pos.coords.latitude, pos.coords.longitude, 'your location'),
      () => locationError('Could not get your location. Search for a place or pick one below.'),
      { timeout: 10000 }
    );
  });

  // Free-text place lookup via OpenStreetMap's Nominatim. Best effort: the
  // presets still work if it is unreachable or rate-limited.
  el.placeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = el.placeInput.value.trim();
    if (!q) return;

    el.locStatus.className = 'loc-status';
    el.locStatus.textContent = `Looking up “${q}”…`;
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search'
        + `?format=json&limit=1&q=${encodeURIComponent(q)}`,
        { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(res.status);
      const hits = await res.json();
      if (!hits.length) {
        locationError(`No place found for “${q}”. Try a town or ZIP code.`);
        return;
      }
      setOrigin(Number(hits[0].lat), Number(hits[0].lon),
                hits[0].display_name.split(',').slice(0, 2).join(',').trim());
    } catch {
      locationError('Place lookup is unavailable right now — pick one of the places below.');
    }
  });

  /* ── Wiring ───────────────────────────────────────────── */

  const rerender = () => { syncRangeLabels(); render(); };

  for (const node of [el.q, el.sort, el.radius, el.price,
                      el.freeOnly, el.signupOnly, el.unitsKm,
                      el.showKids, el.showSeniors, el.showAdults, el.foodOnly, el.outdoorOnly]) {
    node.addEventListener('input', rerender);
  }

  el.tabEvents?.addEventListener('click', () => showView('events'));
  el.tabPlaces?.addEventListener('click', () => showView('places'));
  el.placesSearch?.addEventListener('input', renderPlaces);
  el.placesSort?.addEventListener('change', () => {
    state.placeSort = el.placesSort.value;
    renderPlaces();
  });
  el.placesLocal?.addEventListener('change', () => {
    state.placesLocalOnly = el.placesLocal.checked;
    renderPlaces();
  });
  el.placesSaved?.addEventListener('change', () => {
    state.placesSavedOnly = el.placesSaved.checked;
    renderPlaces();
  });
  el.venueBannerClear?.addEventListener('click', () => {
    state.venueFilter = null;
    render();
  });

  el.showHiddenBtn?.addEventListener('click', () => {
    state.showHidden = !state.showHidden;
    render();
  });

  el.clearHiddenBtn?.addEventListener('click', () => {
    const restored = Object.entries(state.decisions)
      .filter(([, v]) => v === 'hidden').map(([id]) => id);
    if (!restored.length) return;
    const previous = { ...state.decisions };
    for (const id of restored) delete state.decisions[id];
    saveDecisions(state.decisions);
    render();
    toast(`Restored ${restored.length} hidden ${restored.length === 1 ? 'listing' : 'listings'}`,
          () => { state.decisions = previous; saveDecisions(state.decisions); render(); });
  });

  el.resetFilters.addEventListener('click', () => {
    state.horizon = DEFAULTS.horizon;
    el.radius.value = DEFAULTS.radius;
    el.sort.value = DEFAULTS.sort;
    el.q.value = DEFAULTS.q;
    el.price.value = DEFAULTS.price;
    el.freeOnly.checked = DEFAULTS.freeOnly;
    el.signupOnly.checked = DEFAULTS.signupOnly;
    el.unitsKm.checked = DEFAULTS.unitsKm;
    state.repeatMode = DEFAULTS.repeatMode;
    state.timeOfDay = DEFAULTS.timeOfDay;
    el.showKids.checked = DEFAULTS.showKids;
    el.showSeniors.checked = DEFAULTS.showSeniors;
    el.showAdults.checked = DEFAULTS.showAdults;
    el.foodOnly.checked = DEFAULTS.foodOnly;
    el.outdoorOnly.checked = DEFAULTS.outdoorOnly;
    state.activeTypes.clear();
    state.excludedTypes.clear();
    for (const chip of el.types.children) chip.classList.remove('chip-exclude');
    for (const c of el.types.children) c.setAttribute('aria-pressed', 'false');
    for (const c of el.tod.children) {
      c.setAttribute('aria-pressed', String(c.dataset.tod === DEFAULTS.timeOfDay));
    }
    for (const c of el.repeats.children) {
      c.setAttribute('aria-pressed', String(c.dataset.mode === DEFAULTS.repeatMode));
    }
    for (const c of el.horizon.children) {
      c.setAttribute('aria-pressed', String(c.dataset.horizon === DEFAULTS.horizon));
    }
    rerender();
  });

  /* ── Boot ─────────────────────────────────────────────── */

  (async function init() {
    buildPresets();
    buildHorizonChips();
    buildRepeatChips();
    buildTimeOfDayChips();
    syncRangeLabels();

    try {
      const res = await fetch('data/events.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();

      // Pushing is the deploy, so the build number counts pushes. Missing file
      // is not an error — the stamp simply stays hidden.
      fetch('data/version.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((v) => {
          if (!v?.label || !el.buildStamp) return;
          el.buildStamp.textContent = `Proximi ${v.label}`;
          el.buildStamp.hidden = false;
        })
        .catch(() => { /* the stamp is decoration, never a failure */ });

      // The directory is a separate file so a places rebuild never risks the
      // feed, and a missing one degrades to "venues we know from events".
      fetch('data/places.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d) return;
          state.places = d.items || [];
          if (Array.isArray(d.meta?.kinds) && d.meta.kinds.length) {
            placeKindOrder = d.meta.kinds;
          }
          invalidatePlaces();
          updateTabCounts();
          if (state.view === 'places') renderPlaces();
        })
        .catch(() => { /* the feed still works without the directory */ });

      state.tz = data.meta?.timezone || null;
      const all = (data.items || []).map((item) => ({
        ...item, _start: resolveStart(item), _end: resolveEnd(item)
      }));
      state.items = all.filter((item) => !isExpired(item));
      state.staleCount = all.length - state.items.length;

      buildTypeChips();
      showDataAge(data.meta);
      updateTabCounts();

      const m = data.meta;
      if (m?.centerLat != null && m?.centerLon != null) {
        setOrigin(m.centerLat, m.centerLon, m.centerName || 'the coverage area');
      } else {
        render();
      }
    } catch {
      el.empty.hidden = false;
      el.empty.textContent = 'The listings file failed to load. If you opened this file '
        + 'directly, run a local web server instead — browsers block fetch on file:// URLs.';
      el.contextScope.textContent = 'Could not load listings';
    }
  })();

})();
