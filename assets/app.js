/* Proximi — prototype client.
 * Loads listings from data/events.json, filters/sorts them in the browser.
 * No backend yet: a scraper is expected to regenerate that JSON later. */

(() => {
  'use strict';

  const MI_PER_KM = 0.621371;

  // Categories we know how to label. Anything else in the data still works —
  // it just gets title-cased automatically.
  const CATEGORY_LABELS = {
    music: 'Music', show: 'Shows', art: 'Art', market: 'Markets',
    sale: 'Sales', parade: 'Parades', tour: 'Tours', protest: 'Protests',
    food: 'Food', sports: 'Sports', class: 'Classes', outdoors: 'Outdoors',
    family: 'Family', film: 'Film', comedy: 'Comedy', community: 'Community',
    nightlife: 'Nightlife'
  };

  const PRESETS = [
    { name: 'New York, NY',   lat: 40.7580, lon: -73.9855 },
    { name: 'Brooklyn, NY',   lat: 40.6782, lon: -73.9442 },
    { name: 'Yonkers, NY',    lat: 40.9312, lon: -73.8988 },
    { name: 'White Plains, NY', lat: 41.0340, lon: -73.7629 },
    { name: 'Peekskill, NY',  lat: 41.2901, lon: -73.9204 },
    { name: 'Beacon, NY',     lat: 41.5048, lon: -73.9696 }
  ];

  const $ = (id) => document.getElementById(id);

  const el = {
    list: $('list'), count: $('count'), empty: $('empty'),
    cats: $('cats'), presets: $('presets'),
    q: $('q'), kind: $('kind'), when: $('when'), sort: $('sort'),
    radius: $('radius'), radiusOut: $('radius-out'), radiusMax: $('radius-max'),
    price: $('price'), priceOut: $('price-out'),
    freeOnly: $('free-only'), signupOnly: $('signup-only'), unitsKm: $('units-km'),
    locStatus: $('loc-status'), useMyLocation: $('use-my-location'),
    placeForm: $('place-form'), placeInput: $('place-input'),
    resetFilters: $('reset-filters')
  };

  const state = {
    items: [],
    origin: null,        // { name, lat, lon }
    activeCats: new Set()
  };

  /* ── Geo ──────────────────────────────────────────────── */

  function haversineMiles(a, b) {
    const R = 3958.8; // earth radius, miles
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const useKm = () => el.unitsKm.checked;
  const toDisplayDistance = (mi) => useKm() ? mi / MI_PER_KM : mi;
  const distanceUnit = () => useKm() ? 'km' : 'mi';

  function formatDistance(mi) {
    const d = toDisplayDistance(mi);
    if (d < 0.1) return 'Right here';
    const rounded = d < 10 ? d.toFixed(1) : Math.round(d);
    return `${rounded} ${distanceUnit()} away`;
  }

  /* ── Dates ────────────────────────────────────────────── */

  // Sample data carries daysFromNow + time so the prototype never goes stale.
  // Real scraped data should carry an ISO `start` instead — prefer it if present.
  function resolveStart(item) {
    if (item.start) return new Date(item.start);
    const d = new Date();
    d.setDate(d.getDate() + (item.daysFromNow || 0));
    const [h, m] = (item.time || '00:00').split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d;
  }

  function startOfDay(d) {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c;
  }

  function formatWhen(item) {
    const start = item._start;
    const today = startOfDay(new Date());
    const days = Math.round((startOfDay(start) - today) / 86400000);

    const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                      .replace(':00', '');
    let day;
    if (days === 0) day = 'Today';
    else if (days === 1) day = 'Tomorrow';
    else if (days < 7) day = start.toLocaleDateString([], { weekday: 'long' });
    else day = start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    return `${day}, ${time}`;
  }

  /* ── Price ────────────────────────────────────────────── */

  const priceMin = (item) => item.price?.min ?? 0;
  const priceMax = (item) => item.price?.max ?? priceMin(item);
  const isFree = (item) => priceMax(item) === 0;

  function formatPrice(item) {
    const lo = priceMin(item), hi = priceMax(item);
    if (hi === 0) return 'Free';
    if (lo === 0) return `Free – $${hi}`;
    if (lo === hi) return `$${lo}`;
    return `$${lo}–$${hi}`;
  }

  /* ── Filtering ────────────────────────────────────────── */

  // The radius slider treats 0 as "any distance"; the price slider treats its
  // maximum as "any price". Both are read through these helpers.
  const radiusMiles = () => {
    const v = Number(el.radius.value);
    if (v === 0) return Infinity;
    return useKm() ? v * MI_PER_KM : v;
  };

  const maxPrice = () => {
    const v = Number(el.price.value);
    return v >= Number(el.price.max) ? Infinity : v;
  };

  function matchesWhen(item) {
    const mode = el.when.value;
    if (mode === 'any') return true;

    const today = startOfDay(new Date());
    const days = Math.round((startOfDay(item._start) - today) / 86400000);

    if (mode === 'today') return days === 0;
    if (mode === 'tomorrow') return days === 1;
    if (mode === 'weekend') {
      const dow = item._start.getDay(); // 0 Sun … 6 Sat
      return days >= 0 && days <= 7 && (dow === 5 || dow === 6 || dow === 0);
    }
    return days >= 0 && days <= Number(mode);
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
      if (priceMin(item) > pMax) return false;
      if (item._distance != null && item._distance > rMax) return false;
      if (!matchesWhen(item)) return false;
      if (!matchesQuery(item)) return false;
      return true;
    });
  }

  function sorted(items) {
    const by = el.sort.value;
    const copy = items.slice();
    if (by === 'nearest' && state.origin) {
      copy.sort((a, b) => a._distance - b._distance || a._start - b._start);
    } else if (by === 'cheapest') {
      copy.sort((a, b) => priceMin(a) - priceMin(b) || a._start - b._start);
    } else {
      copy.sort((a, b) => a._start - b._start);
    }
    return copy;
  }

  /* ── Rendering ────────────────────────────────────────── */

  function catLabel(c) {
    return CATEGORY_LABELS[c] || c.charAt(0).toUpperCase() + c.slice(1);
  }

  function card(item) {
    const li = document.createElement('li');
    li.className = 'card';

    const badgeClass = item.kind === 'event' ? 'badge-event' : 'badge-activity';
    const free = isFree(item);

    const meta = [];
    meta.push(`<span>${esc(item.venue)}${item.city ? ' · ' + esc(item.city) : ''}</span>`);
    if (item._distance != null) {
      meta.push(`<span class="dist">${esc(formatDistance(item._distance))}</span>`);
    }
    if (item.durationMin) meta.push(`<span>${formatDuration(item.durationMin)}</span>`);

    const tags = (item.categories || [])
      .map((c) => `<span class="tag">${esc(catLabel(c))}</span>`).join('');

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
        <div>
          <h3 class="card-title">${esc(item.title)}</h3>
          <div class="card-when">
            ${esc(formatWhen(item))}
            ${item.recurrence ? `<span class="repeat">· ${esc(item.recurrence)}</span>` : ''}
          </div>
        </div>
        <div class="price-tag ${free ? 'is-free' : ''}">
          ${esc(formatPrice(item))}
          ${item.price?.note ? `<span class="price-note">${esc(item.price.note)}</span>` : ''}
        </div>
      </div>
      <div class="card-meta">${meta.join('')}</div>
      ${item.description ? `<p class="card-desc">${esc(item.description)}</p>` : ''}
      <div class="card-bottom">
        <div class="tags">
          <span class="badge ${badgeClass}">${item.kind === 'event' ? 'Event' : 'Activity'}</span>
          ${tags}
        </div>
        ${links.join('')}
      </div>`;
    return li;
  }

  function formatDuration(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h} hr`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function render() {
    const results = sorted(filtered());

    el.list.replaceChildren(...results.map(card));
    el.empty.hidden = results.length > 0;

    const noun = results.length === 1 ? 'result' : 'results';
    const where = state.origin ? ` near ${state.origin.name}` : '';
    el.count.textContent = `${results.length} ${noun}${where}`;

    renderCategoryCounts();
  }

  /* ── Controls ─────────────────────────────────────────── */

  function buildCategoryChips() {
    const counts = new Map();
    for (const item of state.items) {
      for (const c of item.categories || []) {
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    const cats = [...counts.keys()].sort((a, b) =>
      catLabel(a).localeCompare(catLabel(b)));

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

  // Show how many of the *currently visible* items each category would match,
  // ignoring the category filter itself so the numbers stay useful.
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
    el.radiusOut.textContent = r === 0 ? 'Any distance' : `${r} ${distanceUnit()}`;
    el.radiusMax.textContent = `60 ${distanceUnit()}`;

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
    if (el.sort.value === 'soonest') el.sort.value = 'nearest';
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

  // Free-text place lookup via OpenStreetMap's Nominatim. Best-effort: if it is
  // unreachable or rate-limited, the presets still work.
  el.placeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = el.placeInput.value.trim();
    if (!q) return;

    el.locStatus.className = 'loc-status';
    el.locStatus.textContent = `Looking up “${q}”…`;
    try {
      const url = 'https://nominatim.openstreetmap.org/search'
                + `?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(res.status);
      const hits = await res.json();
      if (!hits.length) {
        locationError(`No place found for “${q}”. Try a town or ZIP code.`);
        return;
      }
      const hit = hits[0];
      setOrigin(Number(hit.lat), Number(hit.lon),
                hit.display_name.split(',').slice(0, 2).join(',').trim());
    } catch {
      locationError('Place lookup is unavailable right now — pick one of the places below.');
    }
  });

  /* ── Wiring ───────────────────────────────────────────── */

  const rerender = () => { syncRangeLabels(); render(); };

  for (const node of [el.q, el.kind, el.when, el.sort, el.radius, el.price,
                      el.freeOnly, el.signupOnly, el.unitsKm]) {
    node.addEventListener('input', rerender);
  }

  el.resetFilters.addEventListener('click', () => {
    el.q.value = '';
    el.kind.value = 'all';
    el.when.value = 'any';
    el.sort.value = state.origin ? 'nearest' : 'soonest';
    el.radius.value = 0;
    el.price.value = el.price.max;
    el.freeOnly.checked = false;
    el.signupOnly.checked = false;
    state.activeCats.clear();
    for (const chip of el.cats.children) chip.setAttribute('aria-pressed', 'false');
    rerender();
  });

  /* ── Boot ─────────────────────────────────────────────── */

  (async function init() {
    buildPresets();
    syncRangeLabels();
    try {
      const res = await fetch('data/events.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      state.items = (data.items || []).map((item) => ({ ...item, _start: resolveStart(item) }));
    } catch (err) {
      el.count.textContent = 'Could not load listings.';
      el.empty.hidden = false;
      el.empty.textContent = 'The listings file failed to load. If you opened this file directly, '
                           + 'run a local web server instead — browsers block fetch on file:// URLs.';
      return;
    }
    buildCategoryChips();
    render();
  })();

})();
