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
     Swipe left "not for me", swipe right "save it for later". Kept per
     browser in localStorage: there is no backend, and a verdict is personal
     to the reader anyway. Every access is guarded — a private window can
     throw on read as well as write, and a thrown storage call must not take
     the feed down with it.

     A right swipe used to download an .ics there and then, which made the
     gesture a commitment: you could not say "that looks good" without
     handing your calendar a file. Saving is the cheap verdict and the
     calendar is the deliberate one, so they are now two steps in two places
     — swipe right in the feed to save, swipe right again in Saved to book
     it. */

  const DECISIONS_KEY = 'proximi.decisions.v1';
  const VERDICTS = new Set(['saved', 'hidden']);

  function loadDecisions() {
    try {
      const raw = JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}') || {};
      // Migration: 'going' was one verdict meaning both "I want this" and
      // "it is on my calendar". The want becomes 'saved'; the booking moves
      // to its own set below, so nobody loses a decision to a rename.
      const out = {};
      for (const [id, v] of Object.entries(raw)) {
        if (v === 'going') out[id] = 'saved';
        else if (VERDICTS.has(v)) out[id] = v;
      }
      return out;
    } catch { return {}; }
  }

  function saveDecisions(map) {
    try { localStorage.setItem(DECISIONS_KEY, JSON.stringify(map)); } catch { /* not fatal */ }
  }

  /* What has actually been handed to a calendar app. Separate from the
     verdict so a saved listing can be booked, unbooked and still saved. */
  const CALENDAR_KEY = 'proximi.calendar.v1';

  function loadCalendar() {
    try {
      const own = JSON.parse(localStorage.getItem(CALENDAR_KEY) || 'null');
      if (Array.isArray(own)) return new Set(own);
      // First run after the rename: anything that was 'going' had already
      // been downloaded, so it is on a calendar somewhere.
      const raw = JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}') || {};
      return new Set(Object.entries(raw).filter(([, v]) => v === 'going').map(([id]) => id));
    } catch { return new Set(); }
  }

  function saveCalendar(set) {
    try { localStorage.setItem(CALENDAR_KEY, JSON.stringify([...set])); } catch { /* not fatal */ }
  }

  /* Single occurrences of a repeating listing that the reader has waved off.
     Hiding a series and hiding tonight's instance of it are different
     answers, and the old single 'hidden' verdict could only give the first
     one — so "not this week" meant never again.

     Stored as { id: [dayIndex, …] }, the same day index the feed groups by,
     because that is what identifies an occurrence: a weekly market has one
     per day it lands on and no id of its own. */
  const SKIPS_KEY = 'proximi.skips.v1';

  function loadSkips() {
    try {
      const raw = JSON.parse(localStorage.getItem(SKIPS_KEY) || '{}') || {};
      const map = new Map();
      for (const [id, days] of Object.entries(raw)) {
        if (Array.isArray(days) && days.length) map.set(id, new Set(days.filter(Number.isFinite)));
      }
      return map;
    } catch { return new Map(); }
  }

  function saveSkips(map) {
    try {
      const raw = {};
      for (const [id, days] of map) if (days.size) raw[id] = [...days];
      localStorage.setItem(SKIPS_KEY, JSON.stringify(raw));
    } catch { /* not fatal */ }
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

  /* Every filter the reader has set. Verdicts and muted venues were already
     kept; the filter panel was not, so a radius of 25 miles and a chosen
     category lasted exactly as long as the tab did. Restoring these is the
     difference between a tool and a demo.

     Stored as one object under one key so adding a control later cannot leave
     half the settings behind, and read back defensively: an older build's
     saved shape must never stop the app loading. */
  const PREFS_KEY = 'proximi.filters.v1';

  const PREF_FIELDS = [
    ['q', 'value'], ['sort', 'value'], ['radius', 'value'], ['price', 'value'],
    ['freeOnly', 'checked'], ['signupOnly', 'checked'], ['unitsKm', 'checked'],
    ['foodOnly', 'checked'], ['outdoorOnly', 'checked'],
    ['showKids', 'checked'], ['showSeniors', 'checked'], ['showAdults', 'checked'],
    ['interestedOnly', 'checked']
  ];

  function savePrefs() {
    // While the reader is looking at one place the controls hold a wide-open
    // set they did not choose (see openVenueListings). What gets remembered is
    // what they chose, or a reload mid-peek would hand back the peek and lose
    // their filters for good.
    const f = pausedFilters || captureFilters();
    const prefs = {
      types: [...f.activeTypes], excludedTypes: [...f.excludedTypes],
      horizon: f.horizon, repeatMode: f.repeatMode,
      timeOfDay: f.timeOfDay, view: state.view,
      placeKind: state.placeKind, placeSort: state.placeSort,
      placesSavedOnly: state.placesSavedOnly,
      placesEventsOnly: state.placesEventsOnly
    };
    for (const [name, prop] of PREF_FIELDS) {
      if (el[name]) prefs[name] = name in f ? f[name] : el[name][prop];
    }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* not fatal */ }
  }

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      return prefs && typeof prefs === 'object' ? prefs : null;
    } catch { return null; }
  }

  /* Applied after the chips exist, since restoring a type selection means
     pressing chips that are built from the data. */
  function applyPrefs(prefs) {
    if (!prefs) return;
    for (const [name, prop] of PREF_FIELDS) {
      if (el[name] && prefs[name] !== undefined) el[name][prop] = prefs[name];
    }
    if (Array.isArray(prefs.types)) state.activeTypes = new Set(prefs.types);
    if (Array.isArray(prefs.excludedTypes)) state.excludedTypes = new Set(prefs.excludedTypes);
    if (prefs.horizon) state.horizon = prefs.horizon;
    if (prefs.repeatMode) state.repeatMode = prefs.repeatMode;
    if (prefs.timeOfDay) state.timeOfDay = prefs.timeOfDay;
    if (prefs.placeKind !== undefined) state.placeKind = prefs.placeKind;
    if (prefs.placeSort) state.placeSort = prefs.placeSort;
    state.placesSavedOnly = !!prefs.placesSavedOnly;
    if (el.placesSaved) el.placesSaved.checked = state.placesSavedOnly;
    state.placesEventsOnly = !!prefs.placesEventsOnly;
    if (el.placesEvents) el.placesEvents.checked = state.placesEventsOnly;
    if (el.placesSort) el.placesSort.value = state.placeSort;
    syncInterested();
    syncRangeLabels();
  }

  // "See listing" is what a card says when nothing named a place; it is not
  // itself a place, so it never becomes a row in Places or a filterable venue.
  /* The venue a listing is *at*. merge.py resolves rooms to their building and
     writes the answer into venueKey, so "Community Room" counts and filters as
     Howland Public Library. Computing that here instead is what made the
     directory say seven events and the filter find none. */
  const venueOf = (item) => {
    const v = item.venueKey || item.venue;
    return (v && v !== 'See listing') ? v : null;
  };

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
    interestedOnly: $('interested-only'), interestedN: $('interested-n'),
    toast: $('toast'), hiddenNote: $('hidden-note'), showHiddenBtn: $('show-hidden'),
    tabEvents: $('tab-events'), tabPlaces: $('tab-places'), tabSaved: $('tab-saved'),
    tabEventsN: $('tab-events-n'), tabPlacesN: $('tab-places-n'),
    tabSavedN: $('tab-saved-n'),
    eventsView: $('events-view'), placesView: $('places-view'),
    savedView: $('saved-view'), savedList: $('saved-list'), savedEmpty: $('saved-empty'),
    savedPlacesBlock: $('saved-places-block'), savedPlacesList: $('saved-places'),
    choice: $('choice-dialog'), choiceScrim: $('choice-scrim'),
    choiceSub: $('choice-sub'), choiceOnce: $('choice-once'),
    choiceSeries: $('choice-series'), choiceCancel: $('choice-cancel'),
    placesList: $('places-list'), placesKinds: $('places-kinds'),
    placesSearch: $('places-search'), placesSort: $('places-sort'),
    placesSaved: $('places-saved'), placesEvents: $('places-events'),
    placesSummary: $('places-summary'),
    venueBanner: $('venue-banner'),
    buildStamp: $('build-stamp'),
    venueBannerName: $('venue-banner-name'), venueBannerClear: $('venue-banner-clear'),
    venueBannerNote: $('venue-banner-note'),
    clearHiddenBtn: $('clear-hidden'),
    locStatus: $('loc-status'), useMyLocation: $('use-my-location'),
    placeForm: $('place-form'), placeInput: $('place-input'),
    contextPlace: $('context-place'), contextScope: $('context-scope'),
    openFilters: $('open-filters'), closeFilters: $('close-filters'),
    openLocation: $('open-location'), applyFilters: $('apply-filters'),
    resetFilters: $('reset-filters'),
    tonightFree: $('tonight-free'),
    sheet: $('filter-sheet'), scrim: $('scrim'), filtersCount: $('filters-count'),
    detailSheet: $('detail-sheet'), detailScrim: $('detail-scrim'),
    detailTitle: $('detail-title'), detailBody: $('detail-body'),
    detailFoot: $('detail-foot'), closeDetail: $('close-detail')
  };

  const state = {
    items: [],                  // what is still to come, as of the last tick
    allItems: [],               // everything the file carried
    origin: null,
    activeTypes: new Set(),
    excludedTypes: new Set(),
    decisions: loadDecisions(),
    calendar: loadCalendar(),
    skips: loadSkips(),
    byId: new Map(),
    showHidden: false,
    hiddenVenues: loadHiddenVenues(),
    venueFilter: null,          // showing one venue's listings only
    places: [],                 // the directory, loaded alongside the feed
    placeKind: null,            // Places narrowed to one sort of place
    placeSort: 'near',
    savedPlaces: loadSavedPlaces(),
    placesSavedOnly: false,
    placesEventsOnly: false,     // the directory narrowed to places with a programme
    view: 'events',             // 'events' | 'places' | 'saved'
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

  /* ── The clock ─────────────────────────────────────────
     A listing is not "today"; it is a time. The feed used to work at day
     granularity for anything repeating, so a cinema's 12:45 showing sat at the
     top of the list at nine in the evening still saying 12:45. And the whole
     expiry pass ran once at load, so a page left open all afternoon kept
     offering things that had already started.

     So: keep the series' first occurrence, and derive the *next* one from it
     on every pass. A daily film that has played today is tomorrow's film, not
     a stale row and not a deleted one.                                     */

  const CADENCE_STEP = { daily: 1, weekday: 1, weekly: 7, fortnightly: 14 };

  /* A midnight start is a feed saying "this day" and nothing about the hour —
     691 of 3,239 listings, most of a library's calendar and every untimed
     Ticketmaster row. Treated as a real 00:00 they expired one minute into the
     day they were meant for, so an all-day event was never once visible on its
     own day. They last until the day does. */
  const isAllDay = (item) =>
    typeof item.start === 'string' && item.start.slice(11, 16) === '00:00' && !item.end;

  const endOfDay = (d) => {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
  };

  // Started, not finished. The card should say so rather than quoting a start
  // time that has been and gone.
  const isUnderway = (item, now = new Date()) =>
    item._end && item._start <= now && item._end >= now;

  function nextOccurrence(item, now) {
    const first = item._first;
    if (!item.repeats || first >= now) return first;

    const next = new Date(first);
    if (item.cadence === 'monthly') {
      while (next < now) next.setMonth(next.getMonth() + 1);
      return next;
    }
    const step = CADENCE_STEP[item.cadence];
    // 'occasional' and 'bookable' repeat on no pattern we can name, so there is
    // nothing to advance to. They stand on their first date and expire with it.
    if (!step) return first;

    // Jump most of the way in whole steps rather than looping a day at a time:
    // a daily series that began in January is 200-odd iterations otherwise.
    const behind = Math.floor((now - next) / 86400000);
    next.setDate(next.getDate() + Math.floor(behind / step) * step);
    while (next < now) next.setDate(next.getDate() + step);
    if (item.cadence === 'weekday') {
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    }
    return next;
  }

  /* One cadence step past a given occurrence. This is what makes "hide just
     this one" possible: skipping an instance means asking what comes after
     it, which is not the same question as "what comes after now". */
  function stepOccurrence(item, from) {
    const next = new Date(from);
    if (item.cadence === 'monthly') { next.setMonth(next.getMonth() + 1); return next; }
    const step = CADENCE_STEP[item.cadence];
    if (!step) return null;   // 'occasional' and 'bookable' step nowhere
    next.setDate(next.getDate() + step);
    if (item.cadence === 'weekday') {
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Can this listing's next instance be named? Only a listing that can says
  // "hide just this one" — for the rest, once is the whole series.
  const hasCadence = (item) =>
    !!item.repeats && (item.cadence === 'monthly' || !!CADENCE_STEP[item.cadence]);

  const skipsFor = (item) => state.skips.get(item.id);

  /* Point _start at whatever is actually next, and say whether the listing is
     still live. Returns false once a series has run out. */
  function advance(item, now) {
    let next = nextOccurrence(item, now);

    // Walk past any occurrence the reader waved off. Bounded: a daily series
    // skipped a hundred times still resolves in a hundred steps, and a
    // cadence that cannot step has nowhere to go, so it is simply gone.
    const skipped = skipsFor(item);
    if (skipped && skipped.size) {
      for (let guard = 0; guard < 400 && skipped.has(dayNumber(next)); guard++) {
        const after = stepOccurrence(item, next);
        if (!after) return false;
        next = after;
      }
      if (skipped.has(dayNumber(next))) return false;
    }

    if (next !== item._start) {
      item._start = next;
      item._day = undefined;          // the grouping day moved with it
    }
    if (item._until && next > item._until) return false;   // the series is over
    if (item._end && !item.repeats) return item._end >= now;
    if (item._end && isOngoing(item)) return true;
    if (isAllDay(item)) return endOfDay(next) >= now;
    return next >= now;
  }

  /* Whether the last pass actually moved anything. The clock ticks every
     thirty seconds and most ticks change nothing at all; repainting several
     hundred cards to find that out is the kind of work that shows up as a
     stutter under the reader's thumb. */
  let liveChanged = false;

  function liveItems(now = new Date()) {
    liveChanged = false;
    return state.allItems.filter((item) => {
      const before = item._start;
      const live = advance(item, now);
      if (item._start !== before) liveChanged = true;
      return live;
    });
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
    } else if (isUnderway(item)) {
      // Quoting "6 PM" at five to seven reads as "not yet". It has started.
      parts.push(`on now, until ${formatTime(item._end)}`);
    } else if (isAllDay(item)) {
      parts.push('all day');
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

  /* Every filter as one object, so a set of them can be put aside and handed
     back. Two things want that: Reset, which writes the defaults, and the
     one-place view, which pauses whatever is running and restores it after.
     Deliberately not units — how far away a thing is reads in miles or
     kilometres because the reader said so, and no view should second-guess it. */
  function captureFilters() {
    return {
      horizon: state.horizon, repeatMode: state.repeatMode,
      timeOfDay: state.timeOfDay,
      activeTypes: new Set(state.activeTypes),
      excludedTypes: new Set(state.excludedTypes),
      q: el.q.value, sort: el.sort.value,
      radius: el.radius.value, price: el.price.value,
      freeOnly: el.freeOnly.checked, signupOnly: el.signupOnly.checked,
      foodOnly: el.foodOnly.checked, outdoorOnly: el.outdoorOnly.checked,
      showKids: el.showKids.checked, showSeniors: el.showSeniors.checked,
      showAdults: el.showAdults.checked,
      interestedOnly: !!el.interestedOnly?.checked
    };
  }

  function applyFilters(f) {
    state.horizon = f.horizon;
    state.repeatMode = f.repeatMode;
    state.timeOfDay = f.timeOfDay;
    state.activeTypes = new Set(f.activeTypes);
    state.excludedTypes = new Set(f.excludedTypes);
    el.q.value = f.q;
    el.sort.value = f.sort;
    el.radius.value = f.radius;
    el.price.value = f.price;
    el.freeOnly.checked = f.freeOnly;
    el.signupOnly.checked = f.signupOnly;
    el.foodOnly.checked = f.foodOnly;
    el.outdoorOnly.checked = f.outdoorOnly;
    el.showKids.checked = f.showKids;
    el.showSeniors.checked = f.showSeniors;
    el.showAdults.checked = f.showAdults;
    if (el.interestedOnly) el.interestedOnly.checked = f.interestedOnly;
    syncChips();
    syncTypeChips();
    syncRangeLabels();
  }

  const DEFAULT_FILTERS = () => ({
    horizon: DEFAULTS.horizon, repeatMode: DEFAULTS.repeatMode,
    timeOfDay: DEFAULTS.timeOfDay,
    activeTypes: new Set(), excludedTypes: new Set(),
    q: DEFAULTS.q, sort: DEFAULTS.sort,
    radius: DEFAULTS.radius, price: DEFAULTS.price,
    freeOnly: DEFAULTS.freeOnly, signupOnly: DEFAULTS.signupOnly,
    foodOnly: DEFAULTS.foodOnly, outdoorOnly: DEFAULTS.outdoorOnly,
    showKids: DEFAULTS.showKids, showSeniors: DEFAULTS.showSeniors,
    showAdults: DEFAULTS.showAdults, interestedOnly: false
  });

  /* Not the defaults — everything wide open. The defaults are still a week and
     75 miles, which would hide most of a place's programme behind a heading
     that promises all of it. */
  const NO_FILTERS = () => ({
    ...DEFAULT_FILTERS(),
    horizon: 'any', radius: String(ANY_DISTANCE), price: el.price.max,
    showKids: true, showSeniors: true, showAdults: true
  });

  /* The filters a one-place view is holding for the reader, or null when they
     are looking at the feed proper. */
  let pausedFilters = null;

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

  function matchesHorizon(item, c) {
    const horizon = c.horizon;
    const day = effectiveDay(item);
    if (horizon.weekend) {
      const [from, to] = c.weekend;
      // A run already under way counts if it covers any of the weekend.
      const end = item._end ? dayNumber(item._end) : day;
      return day <= to && end >= from;
    }
    if (horizon.days === Infinity) return true;
    const days = day - c.today;
    return days >= 0 && days <= horizon.days;
  }

  /* The haystack is built once per listing and kept. Rebuilding it — six
     fields joined and lower-cased — on every keystroke over every listing was
     most of what made search-as-you-type feel like typing through treacle. */
  function haystack(item) {
    return item._hay ??= [item.title, item.venue, item.city, item.address,
                          item.description, ...(item.categories || [])]
      .filter(Boolean).join(' ').toLowerCase();
  }

  const matchesQuery = (item, q) => haystack(item).includes(q);

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

  /* Two things want the filtered feed: the list, and the type chips' counts —
     and the counts are deliberately blind to the type chips themselves, so
     the numbers stay useful while you are picking. That used to mean running
     the whole filter twice over four and a half thousand listings on every
     keystroke, slider nudge and swipe.

     One pass now. Everything except the type chips runs once; the counts are
     read off that; then the type chips narrow it. Same answers, half the
     work. */
  function filterPass() {
    // Read every control once, not once per listing. Four and a half thousand
    // listings times fifteen DOM property reads is the difference between a
    // filter that feels instant and one that hitches.
    const c = {
      rMax: radiusMiles(), pMax: maxPrice(),
      kids: el.showKids.checked, seniors: el.showSeniors.checked,
      adults: el.showAdults.checked,
      food: el.foodOnly.checked, outdoor: el.outdoorOnly.checked,
      free: el.freeOnly.checked, signup: el.signupOnly.checked,
      interested: !!el.interestedOnly?.checked,
      repeatMode: state.repeatMode,
      repeatMatch: REPEAT_MODES.find((m) => m.id === state.repeatMode)?.match,
      tod: TIME_OF_DAY.find((t) => t.id === state.timeOfDay),
      horizon: HORIZONS.find((h) => h.id === state.horizon) || HORIZONS[3],
      weekend: weekendWindow(),
      today: todayNumber(),
      q: el.q.value.trim().toLowerCase(),
      showHidden: state.showHidden, venueFilter: state.venueFilter
    };

    const base = state.items.filter((item) => matchesBase(item, c));

    const counts = new Map();
    for (const item of base) {
      for (const t of typesOf(item)) counts.set(t, (counts.get(t) || 0) + 1);
    }

    const include = state.activeTypes, exclude = state.excludedTypes;
    const results = (include.size || exclude.size)
      ? base.filter((item) => {
          const kinds = typesOf(item);
          // Excluding wins over including: hiding Games should hide a listing
          // that is also a Class, or the exclusion does not do what it says.
          if (kinds.some((t) => exclude.has(t))) return false;
          if (include.size && !kinds.some((t) => include.has(t))) return false;
          return true;
        })
      : base;

    return { results, counts };
  }

  const filtered = () => filterPass().results;

  function matchesBase(item, c) {
    const audience = audienceOf(item);
    // 'kids' is children-only, 'family' is aimed at families with young
    // children. One control hides both — an adult browsing for themselves
    // wants neither, and splitting them across two checkboxes only asks the
    // reader to understand a distinction the data draws for its own reasons.
    if (audience === 'family' && !c.kids) return false;
    if (audience === 'seniors' && !c.seniors) return false;
    if (audience === 'adults' && !c.adults) return false;
    if (c.repeatMode !== 'any') {
      if (c.repeatMode === 'once') {
        if (repeatsOf(item)) return false;
      } else if (!c.repeatMatch?.(item.cadence)) {
        return false;
      }
    }
    // A decided listing leaves the feed. Hidden is gone until the reader asks
    // to see hidden ones — the whole point of a left swipe — and saved has a
    // tab of its own now, so leaving it in the feed as well made a right swipe
    // look like it had done nothing. Both run before anything else and are not
    // softened by the other filters.
    const verdict = state.decisions[item.id];
    if (verdict === 'hidden' && !c.showHidden) return false;
    if (verdict === 'saved') return false;
    const venue = venueOf(item);
    if (c.venueFilter) {
      if (venue !== c.venueFilter) return false;
    } else if (venue && state.hiddenVenues.has(venue)) {
      return false;
    }
    if (c.food && !item.hasFood) return false;
    if (c.outdoor && item.setting !== 'outdoor') return false;
    // The directory's Interested list, used as a lens on the feed: show me
    // only what is on at the places I already said I want to go to.
    if (c.interested && !state.savedPlaces.has(venue)) return false;
    if (c.tod?.match && !c.tod.match(item.timeOfDay)) return false;
    if (c.free && !isFree(item)) return false;
    if (c.signup && !item.signupRequired) return false;
    // Only exclude what we know costs too much. A listing with no published
    // price stays in and shows "See listing" — the cap filters expensive
    // things, it does not filter unknowns.
    if (c.pMax !== Infinity && priceKnown(item) && priceMin(item) > c.pMax) return false;
    if (item._distance != null && item._distance > c.rMax) return false;
    if (!matchesHorizon(item, c)) return false;
    if (c.q && !matchesQuery(item, c.q)) return false;
    return true;
  }

  const grouped = () => el.sort.value === 'soonest';

  /* An all-day listing has no published time, so sorting it at 00:00 put every
     library's untimed morning class above the gig that actually starts at
     seven. Sorted to the end of its own day instead: what is happening at a
     known hour comes first, and "some time today" follows. */
  const whenKey = (i) => (isAllDay(i) ? endOfDay(i._start).getTime() : i._start.getTime());

  function sorted(items) {
    const by = el.sort.value;
    const dist = (i) => (i._distance == null ? Infinity : i._distance);
    const copy = items.slice();

    if (by === 'nearest' && state.origin) {
      copy.sort((a, b) => dist(a) - dist(b) || whenKey(a) - whenKey(b));
    } else if (by === 'cheapest') {
      const key = (i) => (priceKnown(i) ? priceMin(i) : Infinity);
      copy.sort((a, b) => key(a) - key(b) || whenKey(a) - whenKey(b));
    } else {
      // Soonest: by day, then by start time, then by how close it is.
      copy.sort((a, b) =>
        effectiveDay(a) - effectiveDay(b) ||
        whenKey(a) - whenKey(b) ||
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

  // esc() keeps a value inside its attribute; it does not make it a web URL.
  // The feeds are scraped, and scraped domains get hijacked — so a link is
  // only a link when it actually starts http(s).
  const safeUrl = (u) =>
    (typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

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

  function downloadIcs(item) {
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

  const onCalendar = (item) => state.calendar.has(item.id);

  /* Booking is the deliberate half of the gesture, so it says so and it is
     undoable — the file is already downloaded by then, but the mark on the
     card is what the reader is actually reading. */
  function addToCalendar(item) {
    downloadIcs(item);
    const had = onCalendar(item);
    state.calendar.add(item.id);
    saveCalendar(state.calendar);
    afterVerdict(item);
    toast(had ? `Downloaded “${item.title}” again`
              : `Added “${item.title}” to your calendar`,
          had ? null : () => removeFromCalendar(item));
  }

  function removeFromCalendar(item) {
    state.calendar.delete(item.id);
    saveCalendar(state.calendar);
    afterVerdict(item);
    toast(`Unmarked “${item.title}” — the downloaded file is still in your calendar app`,
          () => { state.calendar.add(item.id); saveCalendar(state.calendar); afterVerdict(item); });
  }

  /* ── Verdicts ──────────────────────────────────────────── */

  const verdictOf = (item) => state.decisions[item.id] || null;

  /* Everything that has to catch up after a verdict, a booking or a skip.
     Touch only the card that changed where we can: a verdict cannot alter
     which other listings match, so rebuilding the list to show one badge is
     work nobody asked for — and it is what the swipe was waiting on. */
  function afterVerdict(item) {
    if (state.view === 'saved') {
      renderSaved();
      // Un-saving here puts the listing back in the feed, which the reader is
      // not looking at. Rebuild it now rather than leaving a stale list behind
      // the tab: switching tabs does not re-render, so it would still be
      // missing when they got back to it.
      render();
    } else if (!patchCard(item)) render();
    updateHiddenNote();
    updateFilterCount();
    updateTabCounts();
  }

  function decide(item, verdict) {
    const previous = verdictOf(item);
    if (verdict) state.decisions[item.id] = verdict;
    else delete state.decisions[item.id];
    saveDecisions(state.decisions);
    afterVerdict(item);
    // The card leaves the feed on a save now, so the toast has to say where it
    // went — a listing that simply vanishes reads as a bug, not as a save.
    toast(verdict === 'saved' ? `Saved “${item.title}” — it is in the Saved tab`
          : verdict === 'hidden' ? `Hid “${item.title}”`
          : `Restored “${item.title}”`,
          () => decide(item, previous));
  }

  /* ── Hiding something that comes round again ────────────
     "Not for me" has two meanings for a repeating listing and the old single
     verdict could only carry one of them. Swiping left on this Tuesday's
     trivia night hid trivia night for ever, which is not what anybody meant
     — so a listing with a cadence we can name asks which one, once, on the
     swipe itself. Everything else hides outright, as before. */

  let pendingHide = null;

  function requestHide(item) {
    if (verdictOf(item) === 'hidden' || !hasCadence(item)) { decide(item, 'hidden'); return; }
    pendingHide = item;
    el.choiceSub.textContent = `“${item.title}” — ${cadenceLabel(item).toLowerCase()}.`;
    el.choiceOnce.textContent = `Just ${occurrenceLabel(item)}`;
    openChoice();
  }

  /* The occurrence a skip records. advance() tests the day of _start, so that
     is the day to store — not effectiveDay(), which folds an already-running
     multi-day run onto today. The two agree for everything that can reach the
     dialog, and writing one where the other is read is exactly how they would
     stop agreeing. */
  const occurrenceDay = (item) => dayNumber(item._start);

  // How the reader would name the instance in front of them: "today",
  // "tomorrow", or its date.
  function occurrenceLabel(item) {
    const day = occurrenceDay(item);
    const diff = day - todayNumber();
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    return dayToDate(day).toLocaleDateString([], {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  }

  function openChoice() {
    el.choice.hidden = false;
    el.choiceScrim.hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => {
      el.choice.classList.add('is-open');
      el.choiceScrim.classList.add('is-open');
      el.choiceOnce.focus();
    });
  }

  function closeChoice() {
    pendingHide = null;
    el.choice.classList.remove('is-open');
    el.choiceScrim.classList.remove('is-open');
    document.body.classList.remove('sheet-open');
    setTimeout(() => { el.choice.hidden = true; el.choiceScrim.hidden = true; }, 180);
  }

  function skipOccurrence(item) {
    const day = occurrenceDay(item);
    const when = occurrenceLabel(item);
    let days = state.skips.get(item.id);
    if (!days) state.skips.set(item.id, days = new Set());
    days.add(day);
    saveSkips(state.skips);
    reflow(item);
    toast(`Hid “${item.title}” for ${when} — it is back next time`,
          () => unskipOccurrence(item, day));
  }

  function unskipOccurrence(item, day) {
    const days = state.skips.get(item.id);
    if (!days) return;
    days.delete(day);
    if (!days.size) state.skips.delete(item.id);
    saveSkips(state.skips);
    reflow(item);
  }

  /* A skip moves a listing's next occurrence, which can move it to another
     day, out of the horizon, or off the list entirely — so unlike a verdict
     this genuinely does need the list rebuilt. */
  function reflow(item) {
    advance(item, new Date());
    state.items = liveItems();
    invalidatePlaces();
    render();
    if (state.view === 'saved') renderSaved();
    updateTabCounts();
  }

  /* Update one card in place. Returns false only when the list genuinely has
     to be rebuilt — the caller falls back to a full render then. */
  function patchCard(item) {
    const slot = el.list.querySelector(`.card-slot[data-id="${CSS.escape(item.id)}"]`);
    if (!slot) return false;
    const verdict = verdictOf(item);
    // Both verdicts take the card out of the feed — hidden for good, saved to
    // the Saved tab. Same removal, same bookkeeping.
    if (verdict === 'saved') return removeCard(item, slot);
    if (verdict === 'hidden' && !state.showHidden) return removeCard(item, slot);
    slot.classList.toggle('is-saved', verdict === 'saved');
    slot.classList.toggle('is-hidden', verdict === 'hidden');
    const tags = slot.querySelector('.tags');
    if (!tags) return true;
    const badge = tags.querySelector('.badge-saved');
    if (verdict === 'saved' && !badge) {
      const b = document.createElement('span');
      b.className = 'badge badge-saved';
      b.textContent = 'Saved';
      tags.prepend(b);
    } else if (verdict !== 'saved') {
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
    // The plan is what the next batch is built from, so a card removed from
    // the DOM has to leave it too — otherwise scrolling on brings the hidden
    // listing straight back.
    dropFromPlan(item.id);
    for (const t of typesOf(item)) {
      const chip = el.types.querySelector(`.chip[data-type="${CSS.escape(t)}"] .chip-n`);
      if (chip) chip.textContent = String(Math.max(0, Number(chip.textContent) - 1));
    }
    const left = el.list.querySelectorAll('.card-slot').length;
    // Hiding a run of cards can empty the window without the observer ever
    // seeing the sentinel move, which leaves a short list and a button where
    // there should be listings. Top it back up.
    if (left < BATCH / 2) renderMore();
    updateContextBar(left);
    return true;
  }

  /* Drop one card from the render plan, and from its day's heading count, so
     that the batch after it stays honest about what is left. */
  function dropFromPlan(id) {
    const plan = state.plan;
    if (!plan) return;
    const i = plan.findIndex((e) => e.card && e.card.id === id);
    if (i < 0) return;
    for (let j = i; j >= 0; j--) {
      if (plan[j].day !== undefined) { plan[j].n--; break; }
    }
    plan.splice(i, 1);
    if (i < state.shown) state.shown--;
  }

  let toastTimer = null;
  function toast(message, undo) {
    const box = el.toast;
    if (!box) return;
    box.querySelector('.toast-msg').textContent = message;
    const btn = box.querySelector('.toast-undo');
    btn.hidden = !undo;   // "Link copied" has nothing to undo
    btn.onclick = () => { clearTimeout(toastTimer); box.hidden = true; undo?.(); };
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

  /* A drag that committed (or nearly did) still delivers a click on the same
     element at pointerup, and that click must not open the detail sheet the
     reader never asked for. One timestamp, checked by the tap handlers. */
  let lastSwipeAt = 0;
  const justSwiped = () => Date.now() - lastSwipeAt < 400;

  /* One gesture, three lists. The feed swipes a listing to hidden/saved, Saved
     swipes it to the calendar or off the list, and the directory swipes a
     place to muted/liked. Same physics, same commit distance, same
     implicit-capture trap avoided below — so it takes a verdict callback
     rather than knowing what it is swiping.

     Delegated to the list rather than attached per row. Four listeners on
     every one of several hundred cards is several thousand listeners that
     the browser has to keep alive and hit-test through, and rebuilding them
     on every render is most of what a render costs. One set per list does
     the same job and never grows. */
  function delegateSwipe(root, slotSel, surfaceSel, onVerdict) {
    let slot = null, surface = null, pid = null;
    let startX = 0, startY = 0, dx = 0, active = false, decided = false, frame = null;

    const reset = () => {
      slot = surface = null; pid = null;
      startX = startY = dx = 0; active = false;
    };

    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.target.closest('a, button')) return;   // links keep their taps
      const s = e.target.closest(slotSel);
      if (!s) return;
      slot = s;
      surface = s.querySelector(surfaceSel);
      if (!surface) { slot = null; return; }
      pid = e.pointerId;
      startX = e.clientX; startY = e.clientY; dx = 0;
      active = false; decided = false;
    });

    root.addEventListener('pointermove', (e) => {
      if (!slot || e.pointerId !== pid) return;
      if (e.buttons === 0) return;
      const mx = e.clientX - startX, my = e.clientY - startY;
      if (!active) {
        if (Math.abs(mx) < 12 || Math.abs(mx) <= Math.abs(my)) return;
        active = true;
        root.setPointerCapture?.(e.pointerId);
        slot.classList.add('is-swiping');
        surface.classList.add('is-swiping');
      }
      dx = mx;
      // Pointer events can outpace the display; writing style on each one asks
      // for style recalculation the frame will never show. One write per frame.
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!surface) return;
          surface.style.setProperty('--dx', `${dx}px`);
          const want = dx > SWIPE_COMMIT ? 'yes' : dx < -SWIPE_COMMIT ? 'no' : 'none';
          if (slot.dataset.swipe !== want) slot.dataset.swipe = want;
        });
      }
      e.preventDefault();
    });

    const finish = (e) => {
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      if (!slot) return;
      if (e && pid != null && e.pointerId !== pid) return;
      if (!active) { reset(); return; }
      lastSwipeAt = Date.now();
      const verdict = dx > SWIPE_COMMIT ? 'yes' : dx < -SWIPE_COMMIT ? 'no' : null;
      const target = slot;
      slot.classList.remove('is-swiping');
      surface.classList.remove('is-swiping');
      surface.style.removeProperty('--dx');
      delete slot.dataset.swipe;
      const fire = verdict && !decided;
      decided = true;
      reset();
      if (fire) onVerdict(target, verdict);
    };
    // pointerup and pointercancel are enough: capturing the pointer guarantees
    // both are delivered here. lostpointercapture must NOT end the gesture —
    // a touch pointer is implicitly captured by whatever element received the
    // pointerdown, so calling setPointerCapture above *transfers* it and fires
    // lostpointercapture on that descendant, which bubbles up to this listener.
    // Treating that as the end reset the drag a few pixels in, which is why
    // swiping worked with a mouse (no implicit capture) and never with a
    // finger.
    root.addEventListener('pointerup', finish);
    root.addEventListener('pointercancel', finish);
  }

  /* Two rails, because a card means different things in different lists.
     In the feed a right swipe saves; in Saved it books. The labels have to
     say which, or the same gesture quietly does two things. */
  const RAILS = {
    feed:  { yes: '\u2665 Save',            no: 'Not for me \u2715' },
    saved: { yes: '\ud83d\udcc5 Add to calendar', no: 'Remove \u2715' }
  };

  function card(item, isGrouped, context = 'feed') {
    const li = document.createElement('li');
    const verdict = verdictOf(item);
    const booked = onCalendar(item);
    li.className = 'card-slot'
      + (verdict === 'saved' ? ' is-saved' : verdict === 'hidden' ? ' is-hidden' : '')
      + (booked ? ' is-booked' : '');
    li.dataset.id = item.id;
    li.dataset.context = context;
    const surface = document.createElement('article');
    surface.className = 'card';

    const meta = [];
    if (item._distance != null) {
      meta.push(`<span class="dist">${esc(formatDistance(item._distance))}</span>`);
    }
    if (item.durationMin) meta.push(`<span>${formatDuration(item.durationMin)}</span>`);
    if (item.host && item.host !== item.venue) {
      meta.push(`<span class="host">by ${esc(item.host)}</span>`);
    }

    const links = [];
    const signupHref = item.signupRequired ? safeUrl(item.signupUrl) : null;
    const detailsHref = safeUrl(item.url);
    if (signupHref) {
      links.push(`<a class="link-btn is-signup" href="${esc(signupHref)}"
                     target="_blank" rel="noopener noreferrer">Sign up \u2197</a>`);
    }
    if (detailsHref) {
      links.push(`<a class="link-btn" href="${esc(detailsHref)}"
                     target="_blank" rel="noopener noreferrer">Details \u2197</a>`);
    }

    // The place is the answer to "could I get there, and what else is it?", so
    // it is a link on the card as well as in the sheet.
    const venueName = venueOf(item);
    const where = venueName
      ? `<button type="button" class="card-venue" data-venue="${esc(venueName)}">${esc(venueName)}</button>`
      : `<span>${esc(item.venue || 'See listing')}</span>`;

    surface.innerHTML = `
      <div class="card-top">
        <div class="card-lead">
          <h3 class="card-title">${esc(item.title)}</h3>
          <div class="card-when">
            ${esc(formatWhen(item, isGrouped))}
            ${item.recurrence ? `<span class="repeat">\u00b7 ${esc(item.recurrence)}</span>` : ''}
          </div>
        </div>
        <div class="price-tag ${isFree(item) ? 'is-free' : ''} ${priceKnown(item) ? '' : 'is-unknown'}">
          ${esc(formatPrice(item))}
          ${item.price?.note ? `<span class="price-note">${esc(item.price.note)}</span>` : ''}
        </div>
      </div>
      <div class="card-meta">${where}${item.city ? `<span>${esc(item.city)}</span>` : ''}${meta.join('')}</div>
      ${item.description ? `<p class="card-desc">${esc(item.description)}</p>` : ''}
      <div class="card-bottom">
        <div class="tags">
          ${verdict === 'saved' ? '<span class="badge badge-saved">Saved</span>' : ''}
          ${booked ? '<span class="badge badge-going">On your calendar</span>' : ''}
          <span class="badge badge-type">${esc(typeLabel(item.type))}</span>
          ${typesOf(item).slice(1).map((t) =>
            `<span class="badge badge-type is-secondary">${esc(typeLabel(t))}</span>`).join('')}
          ${repeatsOf(item)
            ? `<span class="badge badge-repeat">${esc(cadenceLabel(item))}</span>` : ''}
          ${audienceOf(item) === 'family' ? '<span class="badge badge-kids">Family &amp; kids</span>' : ''}
          ${audienceOf(item) === 'seniors' ? '<span class="badge badge-kids">Seniors</span>' : ''}
          ${audienceOf(item) === 'adults' ? '<span class="badge badge-adults">21+</span>' : ''}
        </div>
        ${links.join('')}
      </div>
      <div class="card-verdict">
        <button type="button" class="verdict-btn is-no" data-verdict="no"
                title="${context === 'saved' ? 'Remove from Saved' : 'Not for me'}"
                aria-label="${context === 'saved' ? 'Remove' : 'Not for me \u2014 hide'} ${esc(item.title)}">\u2715</button>
        <button type="button" class="verdict-btn is-yes" data-verdict="yes"
                title="${context === 'saved' ? 'Add to calendar' : 'Save for later'}"
                aria-label="${context === 'saved'
                  ? `Add ${esc(item.title)} to your calendar`
                  : `Save ${esc(item.title)} for later`}">${context === 'saved' ? '\ud83d\udcc5' : '\u2665'}</button>
      </div>`;

    // The rail is a fixed backdrop the card slides over, so it stays put while
    // the card moves and is revealed on the side the card is leaving. Dragging
    // left uncovers the right edge, so "Not for me" lives on the right.
    const rail = document.createElement('div');
    rail.className = 'swipe-rail';
    const labels = RAILS[context] || RAILS.feed;
    rail.innerHTML = `<span class="rail-yes">${labels.yes}</span>`
      + `<span class="rail-no">${labels.no}</span>`;
    li.append(rail, surface);

    // No listeners here. The list delegates clicks, keys and pointers, so a
    // card is pure markup and rendering four hundred of them costs four
    // hundred innerHTML parses rather than two and a half thousand
    // addEventListener calls.
    surface.setAttribute('tabindex', '0');
    surface.setAttribute('role', 'button');
    surface.setAttribute('aria-label', `More about ${item.title}`);
    return li;
  }

  /* ── One set of handlers per list ─────────────────────── */

  const itemOf = (slot) => state.byId.get(slot?.dataset.id);

  // What a swipe or a verdict button means depends on which list it is in.
  function actOnCard(slot, verdict) {
    const item = itemOf(slot);
    if (!item) return;
    if (slot.dataset.context === 'saved') {
      if (verdict === 'yes') addToCalendar(item);
      else decide(item, null);           // out of Saved, back to undecided
      return;
    }
    if (verdict === 'yes') decide(item, verdictOf(item) === 'saved' ? null : 'saved');
    else requestHide(item);
  }

  function wireList(root) {
    delegateSwipe(root, '.card-slot', '.card', actOnCard);

    root.addEventListener('click', (e) => {
      const slot = e.target.closest('.card-slot');
      if (!slot) return;
      const venueBtn = e.target.closest('.card-venue');
      if (venueBtn) { openPlaceByName(venueBtn.dataset.venue, itemOf(slot)); return; }
      const btn = e.target.closest('.verdict-btn');
      if (btn) { actOnCard(slot, btn.dataset.verdict); return; }
      if (e.target.closest('a, button') || justSwiped()) return;
      const item = itemOf(slot);
      if (item) openEventDetail(item);
    });

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.classList?.contains('card')) return;
      const item = itemOf(e.target.closest('.card-slot'));
      if (!item) return;
      e.preventDefault();
      openEventDetail(item);
    });
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

  /* The feed is a clock face, so it has to tick. A phone left on the counter
     all afternoon, or woken from a locked screen an hour later, was showing
     the state of the world when the tab was opened. Re-derive on a minute
     boundary and whenever the tab comes back to the front — both are cheap,
     and neither fires while nothing is changing on screen. */
  let lastTick = 0;

  function tick() {
    const minute = Math.floor(Date.now() / 60000);
    if (minute === lastTick) return;
    lastTick = minute;
    const before = state.items.length;
    state.items = liveItems();
    state.staleCount = state.allItems.length - state.items.length;
    // Most minutes change nothing. Repainting several hundred cards to
    // discover that is a stutter the reader feels and never asked for, so the
    // pass only repaints when a listing actually dropped or a repeat moved.
    if (state.items.length === before && !liveChanged) return;
    invalidatePlaces();
    render();
    updateTabCounts();
    if (state.view === 'places') renderPlaces();
    if (state.view === 'saved') renderSaved();
  }

  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  /* ── Rendering the feed, a screenful at a time ──────────
     The default view is a week inside seventy-five miles, which is several
     hundred listings, and every one of them used to become a DOM node before
     the first was on screen. That is what made the list heavy: heavy to
     build, heavy to swipe on, heavy to remove a card from.

     So the sorted results become a *plan* — a flat list of "day heading" and
     "card" entries — and only the first screenful is built. A sentinel at the
     bottom asks for the next batch as it comes into view, so scrolling to the
     end still gets everything and arriving at the top costs one batch. */

  const BATCH = 40;

  function buildPlan(results, isGrouped) {
    if (!isGrouped) return results.map((item) => ({ card: item }));
    const plan = [];
    let i = 0;
    while (i < results.length) {
      const d = effectiveDay(results[i]);
      let j = i;
      while (j < results.length && effectiveDay(results[j]) === d) j++;
      plan.push({ day: d, n: j - i });
      for (; i < j; i++) plan.push({ card: results[i] });
    }
    return plan;
  }

  let sentinel = null;
  let observer = null;

  function ensureObserver() {
    if (observer || typeof IntersectionObserver !== 'function') return;
    observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) renderMore();
    }, { rootMargin: '800px 0px' });
  }

  function renderMore() {
    const plan = state.plan || [];
    if (state.shown >= plan.length) return;
    const to = Math.min(plan.length, state.shown + BATCH);
    const nodes = [];
    for (let i = state.shown; i < to; i++) {
      const e = plan[i];
      nodes.push(e.card ? card(e.card, state.planGrouped, 'feed') : dayDivider(e.day, e.n));
    }
    state.shown = to;
    if (sentinel) sentinel.remove();
    el.list.append(...nodes);
    placeSentinel();
  }

  function placeSentinel() {
    const more = (state.plan || []).length - state.shown;
    if (more <= 0) { sentinel = null; return; }
    ensureObserver();
    sentinel = document.createElement('li');
    sentinel.className = 'list-more';
    sentinel.innerHTML = `<button type="button">Show more (${more} left)</button>`;
    sentinel.querySelector('button').addEventListener('click', renderMore);
    el.list.append(sentinel);
    observer?.observe(sentinel);
  }

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

    const { results: matched, counts } = filterPass();
    const results = sorted(matched);
    const isGrouped = grouped();

    state.plan = buildPlan(results, isGrouped);
    state.planGrouped = isGrouped;
    state.shown = 0;
    sentinel = null;
    el.list.replaceChildren();
    renderMore();

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
    renderTypeCounts(counts);
    el.applyFilters.textContent =
      `Show ${results.length} ${results.length === 1 ? 'result' : 'results'}`;
  }

  /* ── Saved ─────────────────────────────────────────────
     A right swipe used to hand the reader a calendar file on the spot, which
     made "that looks good" and "I am going" the same gesture. Saved is the
     room in between: swipe right in the feed to put something here, swipe
     right again here to book it. */

  function savedItems() {
    return sorted(state.items.filter((i) => verdictOf(i) === 'saved'));
  }

  function renderSaved() {
    if (!el.savedList) return;
    const items = savedItems();
    el.savedList.replaceChildren(...items.map((i) => card(i, false, 'saved')));

    el.savedEmpty.hidden = items.length > 0;
    if (!items.length) {
      el.savedEmpty.textContent = Object.values(state.decisions).includes('saved')
        ? 'Everything you saved has now passed.'
        : 'Nothing saved yet — swipe a listing right, or tap the \u2665 on its card.';
    }

    // Liked places belong here too: the directory's right swipe is the same
    // gesture making the same promise, and splitting them across two tabs
    // means "the things I picked" lives in two places.
    const liked = placeIndex().filter((p) => state.savedPlaces.has(p.name));
    el.savedPlacesBlock.hidden = liked.length === 0;
    if (liked.length) {
      el.savedPlacesList.replaceChildren(...sortPlaces(liked.slice()).map(placeRow));
    }
  }

  // A swipe left removes a listing from view for good, so the count and the
  // way back are always on screen rather than buried in a menu.
  function updateHiddenNote() {
    if (!el.hiddenNote) return;
    const verdicts = Object.values(state.decisions);
    const hidden = verdicts.filter((v) => v === 'hidden').length;
    const saved = verdicts.filter((v) => v === 'saved').length;
    let skipped = 0;
    for (const days of state.skips.values()) skipped += days.size;
    const bits = [];
    if (hidden) bits.push(`${hidden} hidden`);
    if (skipped) bits.push(`${skipped} single ${skipped === 1 ? 'date' : 'dates'} skipped`);
    if (saved) bits.push(`${saved} saved`);
    if (state.calendar.size) bits.push(`${state.calendar.size} on your calendar`);
    if (state.hiddenVenues.size) bits.push(`${state.hiddenVenues.size} venues muted`);
    el.hiddenNote.textContent = bits.join(' · ') || 'Nothing hidden yet.';
    el.showHiddenBtn.hidden = !hidden;
    el.clearHiddenBtn.hidden = !hidden && !skipped;
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
    park: 'Parks & nature', lookout: 'Lookouts & towers',
    landmark: 'Landmarks & monuments', zoo: 'Zoos & aquariums',
    'theme park': 'Theme & water parks',
    winery: 'Wineries & vineyards', brewery: 'Breweries & distilleries',
    farm: 'Farms & orchards', theatre: 'Theatres', cinema: 'Cinemas',
    'music venue': 'Music venues', stadium: 'Stadiums & arenas',
    'bowling alley': 'Bowling alleys',
    library: 'Libraries', bookshop: 'Book shops', 'antique shop': 'Antique shops',
    mall: 'Malls & markets', shop: 'Specialty shops', cafe: 'Cafés',
    restaurant: 'Restaurants & bars', 'community centre': 'Community centres',
    'place of worship': 'Places of worship', school: 'Schools & colleges',
    club: 'Clubs & halls', other: 'Everywhere else'
  };

  const kindLabel = (k) => PLACE_KIND_LABELS[k] || k || 'Everywhere else';

  /* Somewhere the audit has read and found nothing to read: no feed, no
     calendar page, no dated sales or specials. Worth saying on the card,
     because "no listings" otherwise reads as "we have not got round to it"
     — and for most of the directory that is exactly what it used to mean.
     A place with listings is never labelled, whatever the audit last saw. */
  const noEventInfo = (p) => p.eventInfo === 'none' && !p.events;

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
  let placeByNameCache = null;

  function invalidatePlaces() { placeCache = null; placeByNameCache = null; }

  function placeIndex() {
    const key = `${state.items.length}|${state.places.length}|`
      + (state.origin ? `${state.origin.lat},${state.origin.lon}` : '-');
    if (placeCache && placeCacheKey === key) return placeCache;
    placeCacheKey = key;
    placeCache = buildPlaceIndex();
    placeByNameCache = null;
    return placeCache;
  }

  /* Name is the key a listing has for its venue, so it is the key the
     directory has to answer to. Built once from the index rather than
     scanning three and a half thousand rows on every tap. */
  function placeByName(name) {
    if (!name) return null;
    const rows = placeIndex();
    if (!placeByNameCache) {
      placeByNameCache = new Map();
      for (const p of rows) if (!placeByNameCache.has(p.name)) placeByNameCache.set(p.name, p);
    }
    return placeByNameCache.get(name) || null;
  }

  /* Every listing's host has a page, whether or not OpenStreetMap has heard
     of it. A venue the directory missed still has a name, a town and a pin —
     which is a place page with less on it, not no place page at all. */
  function placeFromItem(item) {
    const name = venueOf(item);
    if (!name) return null;
    return {
      id: `feed-${name}`, name,
      kind: item.placeKind || null, kinds: item.placeKind ? [item.placeKind] : [],
      lat: item.lat, lon: item.lon, city: item.city, address: item.address,
      url: null, phone: null, openingHours: null, brand: null, secondHand: null,
      description: null, source: 'Event listings',
      events: state.items.reduce((a, i) => a + (venueOf(i) === name ? 1 : 0), 0),
      _miles: placeMiles(item)
    };
  }

  function openPlaceByName(name, item) {
    const p = placeByName(name) || (item ? placeFromItem(item) : null);
    if (!p) { toast('No page for that place yet.'); return; }
    openPlaceDetail(p);
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
      // "Has something on" reads the same count the row prints, which is every
      // live listing at that place — not the filtered feed. A place does not
      // stop having a programme because the reader is looking at next Tuesday.
      if (state.placesEventsOnly && !p.events) return false;
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

  /* Thirty kinds is a wall of chips — four hundred pixels before a single
     place. A select says the same thing in one line and carries the counts. */
  function renderPlaceKinds(rows) {
    const counts = new Map();
    for (const p of rows) counts.set(p.kind || 'other', (counts.get(p.kind || 'other') || 0) + 1);
    const kinds = [...counts.keys()].sort((a, b) => {
      if ((a === 'other') !== (b === 'other')) return a === 'other' ? 1 : -1;
      const ia = placeKindOrder.indexOf(a), ib = placeKindOrder.indexOf(b);
      return (ia < 0 ? 1e3 : ia) - (ib < 0 ? 1e3 : ib);
    });

    const total = rows.length;
    const opts = [`<option value="">All kinds (${total})</option>`];
    for (const k of kinds) {
      opts.push(`<option value="${esc(k)}"${state.placeKind === k ? ' selected' : ''}>`
        + `${esc(kindLabel(k))} (${counts.get(k)})</option>`);
    }
    // A kind chosen and then filtered out of existence by a search must still
    // appear, or the select silently jumps to "All kinds" underneath the reader.
    if (state.placeKind && !kinds.includes(state.placeKind)) {
      opts.push(`<option value="${esc(state.placeKind)}" selected>`
        + `${esc(kindLabel(state.placeKind))} (0)</option>`);
    }
    el.placesKinds.innerHTML = opts.join('');
  }

  /* Restored 2026-08-28: the Places-page tidy (d1a359d) deleted these while
     reworking placeRow, so every heart tap, mute tap and place swipe threw a
     ReferenceError and the whole like/mute feature was dead on the live site. */
  function togglePlaceSaved(p) {
    const had = state.savedPlaces.has(p.name);
    if (had) state.savedPlaces.delete(p.name);
    else state.savedPlaces.add(p.name);
    saveSavedPlaces(state.savedPlaces);
    syncInterested();
    renderPlaces();
    render();               // the feed can be filtered on this list
    updateTabCounts();
    if (state.view === 'saved') renderSaved();
    toast(had ? `Removed “${p.name}” from your liked places`
              : `Liked “${p.name}”`,
          () => togglePlaceSaved(p));
  }

  function togglePlaceMuted(p) {
    const had = state.hiddenVenues.has(p.name);
    if (had) state.hiddenVenues.delete(p.name);
    else state.hiddenVenues.add(p.name);
    saveHiddenVenues(state.hiddenVenues);
    renderPlaces();
    render();
    if (state.view === 'saved') renderSaved();
    toast(had ? `Unmuted “${p.name}”` : `Muted “${p.name}”`,
          () => togglePlaceMuted(p));
  }

  function placeRow(p) {
    // Same shape as a listing card: a slot that clips, a rail underneath, and
    // a surface that slides. Left mutes the place, right adds it to Interested
    // — the same directions the feed uses, so the gesture transfers.
    const li = document.createElement('li');
    const hidden = state.hiddenVenues.has(p.name);
    const saved = state.savedPlaces.has(p.name);
    li.className = 'place-slot'
      + (hidden ? ' is-muted' : '') + (saved ? ' is-saved' : '');
    li.dataset.name = p.name;

    const rail = document.createElement('div');
    rail.className = 'swipe-rail';
    // A right swipe slides the row right and reveals the *left* half of the
    // rail, so the yes label lives on the left — the same order the feed uses.
    // Reversed, they read as each other's opposite.
    rail.innerHTML = `<span class="rail-yes">${saved ? '\u2605 Liked' : '\u2665 Like'}</span>`
      + `<span class="rail-no">${hidden ? 'Unmute' : 'Mute'}</span>`;
    li.append(rail);

    const row = document.createElement('div');
    row.className = 'place-row';

    const meta = [p.city, p._miles == null ? '' : formatDistance(p._miles)]
      .filter(Boolean).join(' \u00b7 ');
    const hours = p.openingHours && p.openingHours.length <= 60 ? p.openingHours : '';

    row.innerHTML = `
      <button type="button" class="place-save" aria-pressed="${saved}"
              title="${saved ? 'Unlike' : 'Like'}"
              aria-label="${saved ? 'Unlike' : 'Like'} ${esc(p.name)}">
        ${saved ? '\u2665' : '\u2661'}
      </button>
      <div class="place-main">
        <p class="place-name">${esc(p.name)}</p>
        <p class="place-meta">
          ${p.kind ? `<span class="place-kind">${esc(kindLabel(p.kind))}</span>` : ''}
          ${p.secondHand ? '<span class="place-tag">used &amp; rare</span>' : ''}
          ${p.brand ? '<span class="place-tag is-chain">chain</span>' : ''}
          ${noEventInfo(p) ? '<span class="place-tag is-quiet">no event calendar</span>' : ''}
          ${meta ? `<span class="place-where">${esc(meta)}</span>` : ''}
        </p>
        ${p.description ? `<p class="place-note">${esc(p.description)}</p>` : ''}
        ${hours ? `<p class="place-hours">${esc(hours)}</p>` : ''}
        <p class="place-actions">
          ${p.events ? `<button type="button" class="place-events">${p.events}
             ${p.events === 1 ? 'listing' : 'listings'} \u2192</button>` : ''}
          ${safeUrl(p.url) ? `<a class="place-link" href="${esc(safeUrl(p.url))}" target="_blank"
             rel="noopener noreferrer">Website</a>` : ''}
          ${p.lat != null ? `<a class="place-link" target="_blank" rel="noopener noreferrer"
             href="${esc(mapLink(p.lat, p.lon))}">Map</a>` : ''}
        </p>
      </div>
      ${p.events || hidden ? `
      <button type="button" class="place-mute" aria-pressed="${hidden}"
              title="${hidden ? 'Show this place again' : 'Never show this place'}"
              aria-label="${hidden ? 'Show' : 'Hide'} listings from ${esc(p.name)}">
        ${hidden ? '\ud83d\udeab' : '\ud83d\udc41'}
      </button>` : ''}`;

    li.append(row);
    // The row's main column opens the place in full — hours, phone, website,
    // what is on there, everything the row has no room for. Handled by the
    // list, not by this row: see wirePlaceList.
    const main = row.querySelector('.place-main');
    main.setAttribute('tabindex', '0');
    main.setAttribute('role', 'button');
    main.setAttribute('aria-label', `More about ${p.name}`);
    return li;
  }

  const placeOf = (slot) => slot && placeByName(slot.dataset.name);

  function wirePlaceList(root) {
    delegateSwipe(root, '.place-slot', '.place-row', (slot, verdict) => {
      const p = placeOf(slot);
      if (p) (verdict === 'yes' ? togglePlaceSaved(p) : togglePlaceMuted(p));
    });

    root.addEventListener('click', (e) => {
      const slot = e.target.closest('.place-slot');
      if (!slot) return;
      const p = placeOf(slot);
      if (!p) return;
      if (e.target.closest('.place-save')) { togglePlaceSaved(p); return; }
      if (e.target.closest('.place-mute')) { togglePlaceMuted(p); return; }
      if (e.target.closest('.place-events')) {
        openVenueListings(p.name);
        return;
      }
      if (e.target.closest('a, button') || justSwiped()) return;
      openPlaceDetail(p);
    });

    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (!e.target.classList?.contains('place-main')) return;
      const p = placeOf(e.target.closest('.place-slot'));
      if (!p) return;
      e.preventDefault();
      openPlaceDetail(p);
    });
  }

  function renderPlaces() {
    if (!el.placesList) return;
    const matched = placesMatching(placeIndex());
    renderPlaceKinds(matched);
    const rows = sortPlaces(state.placeKind
      ? matched.filter((p) => (p.kind || 'other') === state.placeKind)
      : matched);

    if (el.placesSummary) {
      const withEvents = rows.filter((p) => p.events).length;
      const saved = state.savedPlaces.size;
      el.placesSummary.textContent = rows.length
        ? `${rows.length} ${rows.length === 1 ? 'place' : 'places'}`
          + (withEvents ? ` · ${withEvents} with something on` : '')
          + (saved ? ` · ${saved} liked` : '')
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
          ? 'Nothing liked yet — swipe a place right, or tap the heart.'
          : state.placesEventsOnly
            ? 'Nothing here has anything on. Most places worth going to never '
              + 'publish a calendar — untick "Has something on" to see them.'
            : 'No place matches that.';
      el.placesList.append(li);
    } else if (rows.length > CAP) {
      const li = document.createElement('li');
      li.className = 'venue-empty';
      const capWord = state.placeSort === 'near' ? 'nearest'
        : state.placeSort === 'events' ? 'busiest' : 'first';
      li.textContent = `Showing the ${CAP} ${capWord} of ${rows.length}. `
        + 'Search or pick a kind to narrow it down.';
      el.placesList.append(li);
    }
  }

  function syncInterested() {
    if (!el.interestedOnly) return;
    const n = state.savedPlaces.size;
    if (el.interestedN) el.interestedN.textContent = n ? String(n) : '';
    // An empty list would filter the feed to nothing and read as a bug.
    el.interestedOnly.disabled = n === 0;
    if (!n) el.interestedOnly.checked = false;
  }

  function updateTabCounts() {
    if (el.tabEventsN) el.tabEventsN.textContent = state.items.length || '';
    if (el.tabPlacesN) {
      const n = state.places.length;
      el.tabPlacesN.textContent = n ? (n > 999 ? `${Math.floor(n / 100) / 10}k` : n) : '';
    }
    if (el.tabSavedN) {
      const n = state.items.reduce((a, i) => a + (verdictOf(i) === 'saved' ? 1 : 0), 0)
        + state.savedPlaces.size;
      el.tabSavedN.textContent = n || '';
    }
  }

  /* ── Detail sheet ──────────────────────────────────────
     Tap a card, get the whole story: the full description the card clamps,
     every link, and buttons big enough to mean it. One sheet serves both
     lists. Each open writes a hash — #e=<id> for a listing, #p=<id> for a
     place — so any event or place is a link someone can be sent. */

  let detailOpen = null;   // {kind:'event'|'place', id} while the sheet is up

  const detailHash = (kind, id) =>
    (kind === 'event' ? '#e=' : '#p=') + encodeURIComponent(id);

  const shareUrlFor = (kind, id) =>
    location.origin + location.pathname + location.search + detailHash(kind, id);

  async function shareLink(title, url) {
    // The native share sheet where there is one; the clipboard everywhere
    // else. A dismissed share sheet is a decision, not a failure.
    if (navigator.share) {
      try { await navigator.share({ title, url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast(url);   // last resort: at least show it
    }
  }

  function showDetailSheet() {
    el.detailSheet.hidden = false;
    el.detailScrim.hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => {
      el.detailSheet.classList.add('is-open');
      el.detailScrim.classList.add('is-open');
      el.closeDetail.focus();
    });
  }

  function hideDetailSheet() {
    detailOpen = null;
    el.detailSheet.classList.remove('is-open');
    el.detailScrim.classList.remove('is-open');
    document.body.classList.remove('sheet-open');
    setTimeout(() => { el.detailSheet.hidden = true; el.detailScrim.hidden = true; }, 200);
  }

  /* Close via UI: if this open wrote a history entry, going back both closes
     the sheet and eats the entry, so the back button never needs pressing
     twice. Opened straight from a shared link, there is no entry to eat —
     drop the hash in place instead. */
  function closeDetail() {
    if (history.state && history.state.proximiDetail) history.back();
    else {
      hideDetailSheet();
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
  }

  function detailFootButton(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ' + (cls || '');
    b.innerHTML = label;
    b.addEventListener('click', onClick);
    return b;
  }

  const mapLink = (lat, lon) =>
    `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;

  function renderEventDetail(item) {
    el.detailTitle.textContent = item.title;
    const verdict = state.decisions[item.id];

    // venue, address and city overlap constantly — the address usually opens
    // with the venue's own name and closes with the city — so the venue keeps
    // the front (as the tappable name) and the rest is trimmed around it.
    const venueName = venueOf(item);
    let addr = item.address;
    if (addr && venueName) {
      if (addr === venueName) addr = null;
      else if (addr.startsWith(venueName)) {
        addr = addr.slice(venueName.length).replace(/^[\s,·–—-]+/, '') || null;
      }
    }
    let cityBit = item.city;
    if (cityBit && ((addr || '').includes(cityBit) || (venueName || '').includes(cityBit))) {
      cityBit = null;
    }
    const whereBits = [addr, cityBit].filter(Boolean).map(esc);
    if (item._distance != null) whereBits.push(esc(formatDistance(item._distance)));

    const links = [];
    const signupHref = item.signupRequired ? safeUrl(item.signupUrl) : null;
    const detailsHref = safeUrl(item.url);
    links.push(`<button type="button" class="link-btn is-cal" id="detail-cal">${
      onCalendar(item) ? '📅 On your calendar' : '📅 Add to calendar'}</button>`);
    if (signupHref) links.push(`<a class="link-btn is-signup" href="${esc(signupHref)}"
      target="_blank" rel="noopener noreferrer">Sign up ↗</a>`);
    if (detailsHref) links.push(`<a class="link-btn" href="${esc(detailsHref)}"
      target="_blank" rel="noopener noreferrer">Full listing ↗</a>`);
    if (item.lat != null) links.push(`<a class="link-btn" href="${esc(mapLink(item.lat, item.lon))}"
      target="_blank" rel="noopener noreferrer">Map ↗</a>`);

    el.detailBody.innerHTML = `
      <p class="detail-when">
        ${esc(formatWhen(item, false))}
        ${item.recurrence ? `<span class="repeat"> · ${esc(item.recurrence)}</span>` : ''}
        ${item.durationMin ? `<span class="repeat"> · ${esc(formatDuration(item.durationMin))}</span>` : ''}
      </p>
      <p class="detail-price ${isFree(item) ? 'is-free' : ''} ${priceKnown(item) ? '' : 'is-unknown'}">
        ${esc(formatPrice(item))}
        ${item.price?.note ? `<span class="price-note">${esc(item.price.note)}</span>` : ''}
      </p>
      <div class="detail-tags">
        <span class="badge badge-type">${esc(typeLabel(item.type))}</span>
        ${typesOf(item).slice(1).map((t) =>
          `<span class="badge badge-type is-secondary">${esc(typeLabel(t))}</span>`).join('')}
        ${verdict === 'saved' ? '<span class="badge badge-saved">Saved</span>' : ''}
        ${onCalendar(item) ? '<span class="badge badge-going">On your calendar</span>' : ''}
        ${repeatsOf(item) ? `<span class="badge badge-repeat">${esc(cadenceLabel(item))}</span>` : ''}
        ${audienceOf(item) === 'family' ? '<span class="badge badge-kids">Family &amp; kids</span>' : ''}
        ${audienceOf(item) === 'seniors' ? '<span class="badge badge-kids">Seniors</span>' : ''}
        ${audienceOf(item) === 'adults' ? '<span class="badge badge-adults">21+</span>' : ''}
        ${item.signupRequired ? '<span class="badge">Needs sign-up</span>' : ''}
      </div>
      ${(venueName || whereBits.length) ? `<div class="detail-place">
        ${venueName ? `<p class="detail-hosted">Hosted by</p>
        <p class="place-line"><button type="button" class="detail-venue-btn"
           id="detail-venue-page">${esc(venueName)} →</button></p>` : ''}
        ${whereBits.length ? `<p class="place-sub">${whereBits.join(' · ')}</p>` : ''}
      </div>` : ''}
      ${item.description ? `<p class="detail-desc">${esc(item.description)}</p>` : ''}
      <div class="detail-links">${links.join('')}</div>
      <p class="detail-fine">From ${esc(item.source || item.host || 'the listing feed')} —
        times and prices change; check the listing before you go.</p>`;

    // The place that is putting it on is a place, not a filter term — so
    // tapping it opens that place's own page, where its hours, its website
    // and everything else it has on live. The listings filter is one tap
    // further in, on the page itself.
    el.detailBody.querySelector('#detail-venue-page')?.addEventListener('click', () => {
      openPlaceByName(venueName, item);
    });

    el.detailBody.querySelector('#detail-cal')?.addEventListener('click', () => {
      if (onCalendar(item)) removeFromCalendar(item); else addToCalendar(item);
      renderEventDetail(item);
    });

    el.detailFoot.replaceChildren(
      detailFootButton(verdict === 'hidden' ? 'Restore' : '✕ Not for me', 'btn-ghost', () => {
        closeDetail();
        // The "just this one or every time?" question is its own dialog, and
        // the sheet closing underneath it would take the scrim with it.
        if (verdict === 'hidden') decide(item, null);
        else setTimeout(() => requestHide(item), 220);
      }),
      detailFootButton('Share', '', () =>
        shareLink(item.title, shareUrlFor('event', item.id))),
      detailFootButton(verdict === 'saved' ? '♥ Saved' : '♥ Save', 'btn-primary', () => {
        decide(item, verdict === 'saved' ? null : 'saved');
        renderEventDetail(item);   // reflect the new verdict in place
      }));
  }

  /* A place's own page. It carries what the row cannot: hours, phone, the
     website, and — the part that makes it a destination rather than a
     database row — what is actually on there in the days ahead. */
  function renderPlaceDetail(p) {
    el.detailTitle.textContent = p.name;
    const saved = state.savedPlaces.has(p.name);
    const muted = state.hiddenVenues.has(p.name);
    const miles = p._miles ?? placeMiles(p);

    const links = [];
    if (safeUrl(p.url)) links.push(`<a class="link-btn" href="${esc(safeUrl(p.url))}"
      target="_blank" rel="noopener noreferrer">Website ↗</a>`);
    if (p.phone) links.push(`<a class="link-btn" href="tel:${esc(String(p.phone).replace(/[^+\d]/g, ''))}">Call</a>`);
    if (p.lat != null) links.push(`<a class="link-btn" href="${esc(mapLink(p.lat, p.lon))}"
      target="_blank" rel="noopener noreferrer">Map ↗</a>`);

    // What is on here, soonest first. Five is enough to show the shape of the
    // programme; the rest are one tap away behind the whole-venue filter.
    // Always chronological here, whatever the feed is sorted by: a programme
    // reads as a programme or it reads as nothing.
    const here = state.items
      .filter((i) => venueOf(i) === p.name && verdictOf(i) !== 'hidden')
      .sort((a, b) => effectiveDay(a) - effectiveDay(b) || whenKey(a) - whenKey(b));
    const SHOWN = 5;

    el.detailBody.innerHTML = `
      <div class="detail-tags">
        ${p.kind ? `<span class="badge badge-type">${esc(kindLabel(p.kind))}</span>` : ''}
        ${(p.kinds || []).filter((k) => k !== p.kind).map((k) =>
          `<span class="badge badge-type is-secondary">${esc(kindLabel(k))}</span>`).join('')}
        ${p.secondHand ? '<span class="badge">used &amp; rare</span>' : ''}
        ${p.brand ? '<span class="badge">chain</span>' : ''}
        ${p.free ? '<span class="badge badge-going">Free entry</span>' : ''}
        ${p.wheelchair === 'yes' ? '<span class="badge">♿ accessible</span>' : ''}
        ${saved ? '<span class="badge badge-saved">♥ Liked</span>' : ''}
        ${muted ? '<span class="badge">Muted</span>' : ''}
      </div>
      <div class="detail-place"><p class="place-line">
        ${[p.address, p.city, miles != null ? formatDistance(miles) : null]
          .filter(Boolean).map(esc).join(' · ') || 'Location on the map below.'}
      </p></div>
      ${p.openingHours ? `<p class="detail-desc">Hours: ${esc(p.openingHours)}</p>` : ''}
      ${p.description ? `<p class="detail-desc">${esc(p.description)}</p>` : ''}
      <div class="detail-links">${links.join('')}</div>
      <section class="detail-whatson">
        <h3 class="detail-h">What's on here</h3>
        ${here.length ? `<ul class="detail-events">${here.slice(0, SHOWN).map((i) => `
          <li><button type="button" class="detail-event" data-id="${esc(i.id)}">
            <span class="detail-event-when">${esc(formatWhen(i, false))}</span>
            <span class="detail-event-title">${esc(i.title)}</span>
            ${priceKnown(i) ? `<span class="detail-event-price">${esc(formatPrice(i))}</span>` : ''}
          </button></li>`).join('')}</ul>
          ${here.length > SHOWN ? `<button type="button" class="detail-venue-btn"
             id="detail-place-events">See all ${here.length} listings here →</button>` : ''}`
        : noEventInfo(p)
          ? `<p class="detail-fine">No event calendar. We read their site${
              p.eventChecked ? ` on ${esc(p.eventChecked)}` : ''} and found no
             listings, sales or specials published anywhere on it — plenty of
             places worth going never publish one.</p>`
          : '<p class="detail-fine">Nothing scheduled here in the feed right now — '
            + 'plenty of places worth going never publish a calendar.</p>'}
      </section>
      <p class="detail-fine">${p.source === 'Event listings'
        ? 'Known from the event feed.'
        : 'Place data from OpenStreetMap contributors (ODbL).'}</p>`;

    el.detailBody.querySelector('#detail-place-events')?.addEventListener('click', () => {
      closeDetail();
      openVenueListings(p.name);
    });

    // A listing on a place's page opens that listing, the same as anywhere
    // else — the two pages link both ways or neither is a page.
    for (const b of el.detailBody.querySelectorAll('.detail-event')) {
      b.addEventListener('click', () => {
        const item = state.byId.get(b.dataset.id);
        if (item) openEventDetail(item);
      });
    }

    el.detailFoot.replaceChildren(
      detailFootButton(muted ? 'Unmute' : 'Mute this place', 'btn-ghost', () => {
        togglePlaceMuted(p);
        renderPlaceDetail(p);
      }),
      detailFootButton('Share', '', () =>
        shareLink(p.name, shareUrlFor('place', p.id || p.name))),
      detailFootButton(saved ? '♥ Liked' : '♡ Like', 'btn-primary', () => {
        togglePlaceSaved(p);
        renderPlaceDetail(p);
      }));
  }

  function openEventDetail(item, { push = true } = {}) {
    renderEventDetail(item);
    detailOpen = { kind: 'event', id: item.id };
    showDetailSheet();
    if (push) history.pushState({ proximiDetail: detailOpen }, '', detailHash('event', item.id));
  }

  function openPlaceDetail(p, { push = true } = {}) {
    renderPlaceDetail(p);
    detailOpen = { kind: 'place', id: p.id || p.name };
    showDetailSheet();
    if (push) history.pushState({ proximiDetail: detailOpen }, '', detailHash('place', p.id || p.name));
  }

  /* A shared link, or the back/forward button, decides what is open. */
  function openFromHash({ push = false } = {}) {
    const m = location.hash.match(/^#(e|p)=(.+)$/);
    if (!m) { if (detailOpen) hideDetailSheet(); return; }
    const id = decodeURIComponent(m[2]);
    if (m[1] === 'e') {
      const item = state.allItems.find((i) => i.id === id);
      if (item) { openEventDetail(item, { push }); return; }
    } else {
      const p = placeIndex().find((x) => (x.id || x.name) === id || x.name === id)
        || placeByName(id.replace(/^feed-/, ''));
      if (p) {
        openPlaceDetail(p, { push });
        return;
      }
    }
    // The listing has passed, or the id belongs to a week that is gone.
    history.replaceState(null, '', location.pathname + location.search);
    toast('That listing is no longer here — it may have passed.');
  }

  window.addEventListener('popstate', () => openFromHash());

  /* ── The three views ───────────────────────────────────── */

  const TABS = [
    { view: 'events', tab: 'tabEvents', panel: 'eventsView' },
    { view: 'places', tab: 'tabPlaces', panel: 'placesView' },
    { view: 'saved',  tab: 'tabSaved',  panel: 'savedView'  }
  ];

  function showView(view) {
    if (!TABS.some((t) => t.view === view)) view = 'events';
    state.view = view;
    savePrefs();
    for (const t of TABS) {
      const on = t.view === view;
      if (el[t.panel]) el[t.panel].hidden = !on;
      if (el[t.tab]) {
        el[t.tab].classList.toggle('is-on', on);
        el[t.tab].setAttribute('aria-selected', String(on));
      }
    }
    // Filters, the result count and the one-venue banner all describe the
    // feed. On the other tabs they would be describing something the reader is
    // not looking at. The location chip stays — it is what place distances are
    // measured from.
    const onEvents = view === 'events';
    if (el.openFilters) el.openFilters.hidden = !onEvents;
    if (el.contextScope) el.contextScope.hidden = !onEvents;
    if (el.venueBanner) el.venueBanner.hidden = !onEvents || !state.venueFilter;
    if (view === 'places') renderPlaces();
    if (view === 'saved') renderSaved();
    window.scrollTo({ top: 0 });
  }

  function updateVenueBanner() {
    if (!el.venueBanner) return;
    el.venueBanner.hidden = !state.venueFilter || state.view === 'places';
    if (state.venueFilter) el.venueBannerName.textContent = state.venueFilter;
    if (el.venueBannerNote) el.venueBannerNote.hidden = !pausedFilters;
  }

  /* ── One place's listings ──────────────────────────────
     "12 listings →" promises twelve listings, and the feed's own filters were
     quietly taking most of them away: a place 40 miles off with a show next
     month showed nothing at all under the default week and 75 miles, which
     reads as a broken link rather than as a filter.

     So the filters step aside for as long as the reader is looking at the one
     place, and come back the moment they leave. Everything they had set is
     held in pausedFilters — it is not thrown away, and savePrefs keeps writing
     it rather than the peek, so a reload mid-look cannot cost them their
     feed. */
  function openVenueListings(name) {
    if (!name) return;
    if (!pausedFilters) pausedFilters = captureFilters();
    applyFilters(NO_FILTERS());
    state.venueFilter = name;
    showView('events');
    rerender();
  }

  function clearVenueListings() {
    state.venueFilter = null;
    if (pausedFilters) {
      applyFilters(pausedFilters);
      pausedFilters = null;
    }
    rerender();
  }

  /* ── Chrome ───────────────────────────────────────────── */

  function updateContextBar(n) {
    el.contextPlace.textContent = state.origin ? state.origin.name : 'Set a location';

    // Same fallback as matchesHorizon — the 7-day default, not the weekend.
    const horizon = HORIZONS.find((h) => h.id === state.horizon) || HORIZONS[3];
    const bits = [horizon.label.toLowerCase()];
    const r = Number(el.radius.value);
    bits.push(r >= ANY_DISTANCE ? 'any distance' : `within ${r} ${distanceUnit()}`);
    el.contextScope.textContent =
      `${n} ${n === 1 ? 'result' : 'results'} · ${bits.join(' · ')}`;
  }

  /* Count how many controls sit away from their baseline, so the button can
     say how much filtering is in play without opening the sheet.

     The baseline is normally the defaults. While one place's listings are up
     it is the wide-open set that view installs — nothing there is the reader
     narrowing anything, and a badge reading "5 filters" over a banner saying
     "filters paused" would be the page contradicting itself. Narrow something
     from inside the sheet during a peek and it counts again, which is the
     whole reason this compares against a baseline rather than special-casing
     the peek to zero. */
  function updateFilterCount() {
    const base = pausedFilters ? NO_FILTERS() : DEFAULT_FILTERS();
    const now = captureFilters();
    const FIELDS = ['horizon', 'repeatMode', 'timeOfDay', 'sort', 'radius', 'price',
                    'freeOnly', 'signupOnly', 'foodOnly', 'outdoorOnly',
                    'showKids', 'showSeniors', 'showAdults', 'interestedOnly'];
    let n = FIELDS.reduce((a, f) => a + (now[f] !== base[f] ? 1 : 0), 0);
    if (now.q.trim() !== base.q) n++;
    if (now.activeTypes.size || now.excludedTypes.size) n++;

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

  // Keep tabbing inside whichever sheet is modal right now.
  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const sheet = !el.choice.hidden ? el.choice
                : !el.detailSheet.hidden ? el.detailSheet
                : !el.sheet.hidden ? el.sheet : null;
    if (!sheet) return;
    const f = sheet.querySelectorAll(
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
  el.closeDetail.addEventListener('click', closeDetail);
  el.detailScrim.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!el.choice.hidden) closeChoice();
      else if (!el.detailSheet.hidden) closeDetail();
      else if (!el.sheet.hidden) closeSheet();
    }
    trapFocus(e);
  });

  /* ── The repeating-listing question ───────────────────── */

  el.choiceOnce.addEventListener('click', () => {
    const item = pendingHide;
    closeChoice();
    if (item) skipOccurrence(item);
  });
  el.choiceSeries.addEventListener('click', () => {
    const item = pendingHide;
    closeChoice();
    if (item) decide(item, 'hidden');
  });
  el.choiceCancel.addEventListener('click', closeChoice);
  el.choiceScrim.addEventListener('click', closeChoice);

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
        savePrefs();
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
        savePrefs();
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
      // Read from state, not hard-coded false: these are rebuilt after the
      // saved filters are applied, so a restored selection has to show.
      b.setAttribute('aria-pressed', String(state.activeTypes.has(t)));
      if (state.excludedTypes.has(t)) b.classList.add('chip-exclude');
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
        savePrefs();
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
        savePrefs();
        render();
      });
      return b;
    }));
  }

  // Counts reflect the other active filters but ignore the type filter itself,
  // so the numbers stay useful while picking. filterPass() already worked them
  // out on the way past — running the whole filter a second time to recover
  // them was pure duplicated effort.
  function renderTypeCounts(counts) {
    if (!counts) counts = filterPass().counts;
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
    // the moment this changes — and the reader may be looking at it, or at
    // the liked places on Saved.
    if (state.view === 'places') renderPlaces();
    if (state.view === 'saved') renderSaved();
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

  const rerender = () => { syncRangeLabels(); savePrefs(); render(); };

  /* A slider dragged across its track fires `input` on every pixel, and a
     search box fires on every letter. Filtering and rebuilding the list on
     each of those is work that is thrown away a frame later — so the labels
     move at once (they are what the thumb is watching) and the list catches
     up when the hand stops. */
  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
  }

  const rerenderSoon = debounce(rerender, 140);

  // Checkboxes and selects are one decision each: no reason to make them wait.
  for (const node of [el.sort, el.freeOnly, el.signupOnly, el.unitsKm,
                      el.showKids, el.showSeniors, el.showAdults, el.foodOnly,
                      el.outdoorOnly, el.interestedOnly]) {
    node.addEventListener('input', rerender);
  }
  for (const node of [el.q, el.radius, el.price]) {
    node.addEventListener('input', () => { syncRangeLabels(); rerenderSoon(); });
  }

  el.tabEvents?.addEventListener('click', () => showView('events'));
  el.tabPlaces?.addEventListener('click', () => showView('places'));
  el.tabSaved?.addEventListener('click', () => showView('saved'));
  el.placesSearch?.addEventListener('input', debounce(renderPlaces, 140));
  el.placesSort?.addEventListener('change', () => {
    state.placeSort = el.placesSort.value;
    savePrefs();
    renderPlaces();
  });
  el.placesSaved?.addEventListener('change', () => {
    state.placesSavedOnly = el.placesSaved.checked;
    savePrefs();
    renderPlaces();
  });
  el.placesEvents?.addEventListener('change', () => {
    state.placesEventsOnly = el.placesEvents.checked;
    savePrefs();
    renderPlaces();
  });
  el.venueBannerClear?.addEventListener('click', clearVenueListings);

  el.showHiddenBtn?.addEventListener('click', () => {
    state.showHidden = !state.showHidden;
    render();
  });

  el.clearHiddenBtn?.addEventListener('click', () => {
    const restored = Object.entries(state.decisions)
      .filter(([, v]) => v === 'hidden').map(([id]) => id);
    const skipped = state.skips.size;
    if (!restored.length && !skipped) return;
    const previous = { ...state.decisions };
    const previousSkips = state.skips;
    for (const id of restored) delete state.decisions[id];
    saveDecisions(state.decisions);
    // Single occurrences waved off count as hidden too — "Restore all" that
    // leaves half of them hidden is not restoring all of them.
    state.skips = new Map();
    saveSkips(state.skips);
    state.items = liveItems();
    invalidatePlaces();
    render();
    updateTabCounts();
    const n = restored.length + skipped;
    toast(`Restored ${n} hidden ${n === 1 ? 'listing' : 'listings'}`, () => {
      state.decisions = previous;
      state.skips = previousSkips;
      saveDecisions(state.decisions);
      saveSkips(state.skips);
      state.items = liveItems();
      invalidatePlaces();
      render();
      updateTabCounts();
    });
  });

  /* Repaint every chip group from `state`. The chips carry their own pressed
     state, so anything that sets a filter in code rather than by tapping has
     to say so afterwards or the sheet shows one thing and the feed does
     another. Reset had this inline; the shortcut below needs the same six
     lines, and two copies would drift. */
  function syncChips() {
    for (const c of el.tod.children)
      c.setAttribute('aria-pressed', String(c.dataset.tod === state.timeOfDay));
    for (const c of el.repeats.children)
      c.setAttribute('aria-pressed', String(c.dataset.mode === state.repeatMode));
    for (const c of el.horizon.children)
      c.setAttribute('aria-pressed', String(c.dataset.horizon === state.horizon));
  }

  // The type chips carry two states between them, so they get their own pass.
  function syncTypeChips() {
    for (const c of el.types.children) {
      c.setAttribute('aria-pressed', String(state.activeTypes.has(c.dataset.type)));
      c.classList.toggle('chip-exclude', state.excludedTypes.has(c.dataset.type));
    }
  }

  /* "Free tonight nearby" — the question this app exists to answer, in one
     tap, on a phone, on the way out of the door.

     It sets four filters that were always there rather than inventing a
     fifth: it is a shortcut, not a mode, and there is nothing to turn off.
     Every chip it moves lights up in the sheet, the "N filters active" badge
     counts them, and Reset undoes it — a filter you cannot see is a filter
     you cannot understand, and this one has to survive being pressed by
     someone who has forgotten they pressed it.

     Deliberately NOT the default view. Opening onto an aggressively filtered
     feed reads as an empty town rather than as a narrow question. */
  /* 25, not 10, and the number was measured rather than chosen. Free
     listings are the scarce kind — 696 of 4,588 — so from Beacon on a
     given evening, 10, 15 and 20 miles all return nothing at all, and 25
     is the first radius that returns anything. A one-tap that reliably
     opens an empty feed teaches the reader not to press it. Still well
     inside the 75-mile default, so it means something. */
  const NEARBY_RADIUS = '25';   // in whatever unit the reader has chosen

  if (el.tonightFree) el.tonightFree.addEventListener('click', () => {
    state.horizon = 'today';
    state.timeOfDay = 'nighttime';
    el.freeOnly.checked = true;
    el.radius.value = NEARBY_RADIUS;
    syncChips();
    syncRangeLabels();
    rerender();
  });

  el.resetFilters.addEventListener('click', () => {
    applyFilters(DEFAULT_FILTERS());
    el.unitsKm.checked = DEFAULTS.unitsKm;
    // Reset is the reader saying what they want the feed to be, so there is
    // nothing left to hand back when they leave a one-place view.
    pausedFilters = null;
    rerender();
  });

  /* A narrow window for tests/drive.js, which drives the real page and has to
     be able to see what the app believes: how long the render plan is, where
     a listing's next occurrence sits, what has been saved or booked. Nothing
     in the app reads it back — it exists so a test can assert on behaviour
     rather than on the shape of the DOM. */
  window.__proximi = {
    get plan() { return state.plan; },
    get byId() { return state.byId; },
    get decisions() { return state.decisions; },
    get calendar() { return state.calendar; },
    get skips() { return state.skips; },
    get places() { return state.places; },
    hasCadence
  };

  /* ── Boot ─────────────────────────────────────────────── */

  (async function init() {
    // Before any chip group is built: the horizon, repeat and time-of-day
    // chips read their pressed state from `state` as they are constructed.
    const prefs = loadPrefs();
    applyPrefs(prefs);
    buildPresets();
    buildHorizonChips();
    buildRepeatChips();
    buildTimeOfDayChips();
    syncRangeLabels();

    // One set of handlers per list, attached once and never rebuilt.
    wireList(el.list);
    wireList(el.savedList);
    wirePlaceList(el.placesList);
    wirePlaceList(el.savedPlacesList);

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
          // The build ships its own labels, so a kind added in Python can
          // never render as a raw slug here again.
          if (d.meta?.kindLabels) Object.assign(PLACE_KIND_LABELS, d.meta.kindLabels);
          invalidatePlaces();
          updateTabCounts();
          if (state.view === 'places') renderPlaces();
          if (state.view === 'saved') renderSaved();
          // A shared place link can only resolve once the directory is here.
          if (location.hash.startsWith('#p=')) openFromHash();
        })
        .catch(() => { /* the feed still works without the directory */ });

      state.tz = data.meta?.timezone || null;
      state.allItems = (data.items || []).map((item) => {
        const first = resolveStart(item);
        return {
          ...item, _first: first, _start: first, _end: resolveEnd(item),
          _until: item.until ? new Date(item.until) : null
        };
      });
      // Every list works from ids now — a card carries one and nothing else,
      // so a click has to be able to get back to the listing without holding
      // a closure per card.
      state.byId = new Map(state.allItems.map((i) => [i.id, i]));
      state.items = liveItems();
      state.staleCount = state.allItems.length - state.items.length;

      buildTypeChips();
      showDataAge(data.meta);
      updateTabCounts();
      syncInterested();

      const m = data.meta;
      if (m?.centerLat != null && m?.centerLon != null) {
        setOrigin(m.centerLat, m.centerLon, m.centerName || 'the coverage area');
      } else {
        render();
      }
      // Last, once there is something to show: reopen on whichever tab was
      // last in use, and honour a shared event link.
      if (prefs?.view === 'places' || prefs?.view === 'saved') showView(prefs.view);
      if (location.hash.startsWith('#e=')) openFromHash();
    } catch {
      el.empty.hidden = false;
      el.empty.textContent = 'The listings file failed to load. If you opened this file '
        + 'directly, run a local web server instead — browsers block fetch on file:// URLs.';
      el.contextScope.textContent = 'Could not load listings';
    }
  })();

})();
