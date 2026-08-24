/* Proximi — client.
 * Loads listings from data/events.json and filters/sorts them in the browser.
 * A weekly scheduled job regenerates that file; nothing here talks to a server. */

(() => {
  'use strict';

  const MI_PER_KM = 0.621371;
  const ANY_DISTANCE = 105;   // the radius slider's top stop means "no limit"

  const CATEGORY_LABELS = {
    music: 'Music', show: 'Shows', art: 'Art', market: 'Markets',
    sale: 'Sales', parade: 'Parades', tour: 'Tours', protest: 'Protests',
    food: 'Food', sports: 'Sports', class: 'Classes', outdoors: 'Outdoors',
    family: 'Family', film: 'Film', comedy: 'Comedy', community: 'Community',
    nightlife: 'Nightlife'
  };

  // How far ahead to look. `days` is inclusive of today, so 0 means today only.
  const HORIZONS = [
    { id: 'today', label: 'Today',        days: 0 },
    { id: '3',     label: 'Next 3 days',  days: 3 },
    { id: '7',     label: 'Next week',    days: 7 },
    { id: '14',    label: 'Next 2 weeks', days: 14 },
    { id: '30',    label: 'Next month',   days: 30 },
    { id: 'any',   label: 'Anytime',      days: Infinity }
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
    horizon: '7', radius: '50', sort: 'soonest',
    q: '', kind: 'all', price: '101',
    freeOnly: false, signupOnly: false, unitsKm: false
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    list: $('list'), empty: $('empty'), banner: $('data-banner'),
    cats: $('cats'), presets: $('presets'), horizon: $('horizon'),
    q: $('q'), kind: $('kind'), sort: $('sort'),
    radius: $('radius'), radiusOut: $('radius-out'),
    price: $('price'), priceOut: $('price-out'),
    freeOnly: $('free-only'), signupOnly: $('signup-only'), unitsKm: $('units-km'),
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
    activeCats: new Set(),
    horizon: DEFAULTS.horizon,
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
  function dayNumber(d) {
    const p = new Intl.DateTimeFormat('en-US', {
      ...zoneOpts(), year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000;
  }

  const todayNumber = () => dayNumber(new Date());

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
    return isOngoing(item) ? todayNumber() : dayNumber(item._start);
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

  function matchesHorizon(item) {
    const limit = horizonDays();
    if (limit === Infinity) return true;
    const days = effectiveDay(item) - todayNumber();
    return days >= 0 && days <= limit;
  }

  function matchesQuery(item) {
    const q = el.q.value.trim().toLowerCase();
    if (!q) return true;
    return [item.title, item.venue, item.city, item.address,
            item.description, ...(item.categories || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  }

  function filtered() {
    const rMax = radiusMiles();
    const pMax = maxPrice();

    return state.items.filter((item) => {
      if (el.kind.value !== 'all' && item.kind !== el.kind.value) return false;
      if (state.activeCats.size &&
          !(item.categories || []).some((c) => state.activeCats.has(c))) return false;
      if (el.freeOnly.checked && !isFree(item)) return false;
      if (el.signupOnly.checked && !item.signupRequired) return false;
      if (pMax !== Infinity && (!priceKnown(item) || priceMin(item) > pMax)) return false;
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

  const catLabel = (c) => CATEGORY_LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1);

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function formatDuration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h} hr`;
  }

  function card(item, isGrouped) {
    const li = document.createElement('li');
    li.className = 'card';

    const meta = [`<span>${esc(item.venue)}${item.city ? ' · ' + esc(item.city) : ''}</span>`];
    if (item._distance != null) {
      meta.push(`<span class="dist">${esc(formatDistance(item._distance))}</span>`);
    }
    if (item.durationMin) meta.push(`<span>${formatDuration(item.durationMin)}</span>`);

    const links = [];
    if (item.signupRequired && item.signupUrl) {
      links.push(`<a class="link-btn is-signup" href="${esc(item.signupUrl)}"
                     target="_blank" rel="noopener noreferrer">Sign up ↗</a>`);
    }
    if (item.url) {
      links.push(`<a class="link-btn" href="${esc(item.url)}"
                     target="_blank" rel="noopener noreferrer">Details ↗</a>`);
    }

    li.innerHTML = `
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
          <span class="badge ${item.kind === 'event' ? 'badge-event' : 'badge-activity'}">
            ${item.kind === 'event' ? 'Event' : 'Activity'}</span>
          ${(item.categories || []).map((c) => `<span class="tag">${esc(catLabel(c))}</span>`).join('')}
        </div>
        ${links.join('')}
      </div>`;
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

  function render() {
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

    updateContextBar(results.length);
    updateFilterCount();
    renderCategoryCounts();
    el.applyFilters.textContent =
      `Show ${results.length} ${results.length === 1 ? 'result' : 'results'}`;
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
    if (el.kind.value !== DEFAULTS.kind) n++;
    if (el.price.value !== DEFAULTS.price) n++;
    if (el.freeOnly.checked) n++;
    if (el.signupOnly.checked) n++;
    if (state.activeCats.size) n++;

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

  function buildCategoryChips() {
    const cats = [...new Set(state.items.flatMap((i) => i.categories || []))]
      .sort((a, b) => catLabel(a).localeCompare(catLabel(b)));

    el.cats.replaceChildren(...cats.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.cat = c;
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `${esc(catLabel(c))}<span class="chip-n"></span>`;
      b.addEventListener('click', () => {
        state.activeCats.has(c) ? state.activeCats.delete(c) : state.activeCats.add(c);
        b.setAttribute('aria-pressed', String(state.activeCats.has(c)));
        render();
      });
      return b;
    }));
  }

  // Counts reflect the other active filters but ignore the category filter
  // itself, so the numbers stay useful while picking.
  function renderCategoryCounts() {
    const saved = state.activeCats;
    state.activeCats = new Set();
    const pool = filtered();
    state.activeCats = saved;

    const counts = new Map();
    for (const item of pool) {
      for (const c of item.categories || []) counts.set(c, (counts.get(c) || 0) + 1);
    }
    for (const chip of el.cats.children) {
      chip.querySelector('.chip-n').textContent = counts.get(chip.dataset.cat) || 0;
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

  for (const node of [el.q, el.kind, el.sort, el.radius, el.price,
                      el.freeOnly, el.signupOnly, el.unitsKm]) {
    node.addEventListener('input', rerender);
  }

  el.resetFilters.addEventListener('click', () => {
    state.horizon = DEFAULTS.horizon;
    el.radius.value = DEFAULTS.radius;
    el.sort.value = DEFAULTS.sort;
    el.q.value = DEFAULTS.q;
    el.kind.value = DEFAULTS.kind;
    el.price.value = DEFAULTS.price;
    el.freeOnly.checked = DEFAULTS.freeOnly;
    el.signupOnly.checked = DEFAULTS.signupOnly;
    el.unitsKm.checked = DEFAULTS.unitsKm;
    state.activeCats.clear();
    for (const c of el.cats.children) c.setAttribute('aria-pressed', 'false');
    for (const c of el.horizon.children) {
      c.setAttribute('aria-pressed', String(c.dataset.horizon === DEFAULTS.horizon));
    }
    rerender();
  });

  /* ── Boot ─────────────────────────────────────────────── */

  (async function init() {
    buildPresets();
    buildHorizonChips();
    syncRangeLabels();

    try {
      const res = await fetch('data/events.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();

      state.tz = data.meta?.timezone || null;
      const all = (data.items || []).map((item) => ({
        ...item, _start: resolveStart(item), _end: resolveEnd(item)
      }));
      state.items = all.filter((item) => !isExpired(item));
      state.staleCount = all.length - state.items.length;

      buildCategoryChips();
      showDataAge(data.meta);

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
