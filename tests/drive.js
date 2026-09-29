/* Drives the real app in a real (headless) Chromium and asserts on what a
 * person would actually see and touch. validate.py gates the data; this gates
 * the page. It exists because a refactor once deleted the Places page's
 * like/mute handlers and nothing noticed until a hand on a phone did.
 *
 * Ground rules, learned the hard way:
 *  · Assert with document.elementFromPoint, not innerText — text reads fine
 *    from an element painted over by a sibling.
 *  · Test touch with CDP Input.dispatchTouchEvent, not the mouse — touch
 *    pointers are implicitly captured, so setPointerCapture *transfers* them
 *    and a mouse-driven test structurally cannot see that bug.
 *  · Scroll the target into view before synthesizing touches — coordinates
 *    outside the viewport dispatch nothing, silently.
 *
 *   node tests/drive.js            # starts its own server on :8917
 *   BASE_URL=http://... node tests/drive.js
 */

const fs = require('fs');
const { spawn } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const exe = process.env.CHROMIUM_PATH
  || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

(async () => {
  let server = null;
  let base = process.env.BASE_URL;
  if (!base) {
    server = spawn('python3', ['-m', 'http.server', '8917'],
      { cwd: __dirname + '/..', stdio: 'ignore' });
    base = 'http://localhost:8917';
    await new Promise((r) => setTimeout(r, 800));
  }

  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
    acceptDownloads: true,   // a booking hands over an .ics; do not let it throw
  });
  const page = await ctx.newPage();
  const errors = [];
  /* data/eats.json is optional — places.py writes it and a checkout that has
     not run it yet is not a broken app — but the browser logs its own 404
     whatever the fetch does with the rejection. */
  const OPTIONAL_404 = /eats\.json|version\.json|places\.json/;
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/404/.test(m.text()) && OPTIONAL_404.test(m.location()?.url || '')) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const fail = [];
  const ok = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
    if (!cond) fail.push(name);
  };

  // ── Events list ────────────────────────────────────────
  const nCards = await page.locator('#list .card-slot').count();
  ok('events render', nCards > 10, `${nCards} cards`);
  const touchable = await page.evaluate(() => {
    const card = document.querySelector('#list .card-slot .card-title');
    if (!card) return 'no card';
    const r = card.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && (card.contains(hit) || hit.contains(card)) ? 'yes'
      : 'covered by ' + (hit ? hit.className : 'nothing');
  });
  ok('first card touchable (elementFromPoint)', touchable === 'yes', touchable);

  // ── ♥ takes a listing out of the feed, into Saved ──────
  //    A saved listing has a tab of its own, so leaving it in the feed as well
  //    made a right swipe look like it had done nothing.
  const toSave = await page.locator('#list .card-slot').first().getAttribute('data-id');
  await page.locator('#list .card-slot .verdict-btn.is-yes').first().click();
  await page.waitForTimeout(200);
  ok('verdict ♥ saves', await page.evaluate(
    (id) => window.__proximi.decisions[id] === 'saved', toSave));
  ok('a saved listing leaves the feed',
    await page.locator(`#list .card-slot[data-id="${toSave}"]`).count() === 0);
  // And stays out of a list built from scratch, not just out of the one the
  // click patched — the card is removed in two places and only one of them is
  // the filter that actually decides what the feed is.
  await page.locator('#open-filters').click();
  await page.waitForTimeout(250);
  await page.click('#reset-filters');
  await page.locator('#apply-filters').click();
  await page.waitForTimeout(400);
  ok('and stays out of a rebuilt feed',
    await page.locator(`#list .card-slot[data-id="${toSave}"]`).count() === 0);
  // Dropping it again from Saved puts it back in the feed. The feed is behind
  // another tab at that moment and switching tabs does not re-render, so this
  // is the case where a stale list would survive unnoticed.
  await page.locator('#tab-saved').click();
  await page.waitForTimeout(300);
  ok('the saved listing is in Saved',
    await page.locator(`#saved-list .card-slot[data-id="${toSave}"]`).count() === 1);
  await page.locator(`#saved-list .card-slot[data-id="${toSave}"] .verdict-btn.is-no`).click();
  await page.waitForTimeout(300);
  await page.locator('#tab-events').click();
  await page.waitForTimeout(300);
  ok('dropping it from Saved puts it back in the feed',
    await page.locator(`#list .card-slot[data-id="${toSave}"]`).count() === 1,
    await page.evaluate((id) => String(window.__proximi.decisions[id]), toSave));

  // ── The feed builds a screenful, not the whole week ────
  const window0 = await page.locator('#list .card-slot').count();
  const total = await page.evaluate(() => (window.__proximi?.plan || []).length);
  ok('feed renders a window, not everything', window0 > 5 && window0 <= 45,
    `${window0} cards of a ${total}-entry plan`);
  if (total > window0) {
    await page.locator('#list .list-more button').click();
    await page.waitForTimeout(200);
    const window1 = await page.locator('#list .card-slot').count();
    ok('showing more appends the next batch', window1 > window0, `${window0} → ${window1}`);
  }

  // ── Event detail sheet: tap, hash, content, back ───────
  const firstTitle = await page.locator('#list .card-slot .card-title').first().textContent();
  await page.locator('#list .card-slot .card-desc, #list .card-slot .card-title').first().click();
  await page.waitForTimeout(400);
  ok('tap opens event detail', await page.locator('#detail-sheet.is-open').count() === 1);
  ok('detail shows the event', (await page.locator('#detail-title').textContent()).trim() === firstTitle.trim());
  ok('event permalink in hash', await page.evaluate(() => location.hash.startsWith('#e=')));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  ok('escape closes detail', await page.locator('#detail-sheet.is-open').count() === 0);
  ok('hash cleared on close', await page.evaluate(() => location.hash === ''));

  // ── Deep link: a fresh load with #e=<id> opens the sheet
  const anyId = await page.locator('#list .card-slot').nth(3).getAttribute('data-id');
  await page.goto(base + '/#e=' + encodeURIComponent(anyId), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  ok('deep link opens event detail', await page.locator('#detail-sheet.is-open').count() === 1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ── Touch swipe left hides a card, with an undo toast ──
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (b, dx) => {
    const y = b.y + b.height / 2, x0 = b.x + b.width * 0.8;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + dx * i / 10, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  /* A listing that repeats on a nameable cadence asks "just today, or every
     time?" instead of hiding, and the repeat section below tests that. So
     this swipe picks a card that hides outright: picking "the third card"
     meant the test passed or failed by the hour it ran at, because the feed
     is sorted by time and at 11pm the third card was a weekday cruise. */
  const plainIdx = await page.evaluate(() => {
    const P = window.__proximi;
    const slots = [...document.querySelectorAll('#list .card-slot')];
    const i = slots.findIndex((s, n) => n >= 2 && !P.hasCadence(P.byId.get(s.dataset.id)));
    return i < 0 ? 2 : i;
  });
  const target = page.locator('#list .card-slot').nth(plainIdx);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  /* And it starts the swipe somewhere a swipe can start. A touch that lands
     on a link or button stays a tap by design (delegateSwipe), and a tall
     card can have its venue link or Sign up button right at the midpoint the
     swipe used to aim for — so find a plain spot on the card, top to bottom. */
  const box = await target.evaluate((slot) => {
    const r = slot.getBoundingClientRect();
    for (let f = 0.5; f < 0.95; f += 0.05) {
      for (const g of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const y = r.top + r.height * g;
        const hit = document.elementFromPoint(r.left + r.width * f, y);
        if (hit && slot.contains(hit) && !hit.closest('a, button')) {
          // swipe() starts at 80% across and halfway down a box: aim both there.
          const width = (r.width * f) / 0.8;
          return { x: r.left, y: y - 10, width, height: 20 };
        }
      }
    }
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const idBefore = await target.getAttribute('data-id');
  await swipe(box, -160);
  await page.waitForTimeout(300);
  ok('touch swipe left hides card',
    await page.locator(`#list .card-slot[data-id="${idBefore}"]`).count() === 0);
  ok('toast with undo appears', await page.locator('#toast:not([hidden])').count() === 1);
  const undoBtn = page.locator('.toast-undo');
  if (await undoBtn.isVisible()) { await undoBtn.click(); await page.waitForTimeout(200); }
  ok('swipe did not open detail', await page.locator('#detail-sheet.is-open').count() === 0);

  // ── The host place is a link to that place's page ──────
  const withVenue = page.locator('#list .card-slot').filter(
    { has: page.locator('.card-venue') }).first();
  await withVenue.locator('.card-title').click();
  await page.waitForTimeout(400);
  const eventTitle = (await page.locator('#detail-title').textContent()).trim();
  ok('detail names the host place',
    await page.locator('#detail-sheet #detail-venue-page').count() === 1);
  await page.locator('#detail-venue-page').click();
  await page.waitForTimeout(400);
  const placeTitle = (await page.locator('#detail-title').textContent()).trim();
  ok('host place opens its own page', placeTitle !== eventTitle && placeTitle.length > 0,
    `${eventTitle} → ${placeTitle}`);
  ok('place page is a place permalink',
    await page.evaluate(() => location.hash.startsWith('#p=')));
  ok('place page lists what is on there',
    await page.locator('#detail-sheet .detail-whatson').count() === 1);
  // Escape goes back one entry, which is the event the place was opened from —
  // correct navigation, and two presses to get out of both.
  for (let i = 0; i < 4 && await page.locator('#detail-sheet.is-open').count(); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  ok('backing out of a place returns to the event, then the list',
    await page.locator('#detail-sheet.is-open').count() === 0);

  // ── A repeating listing asks which "hide" you meant ────
  //    Narrow to weekly listings first. Scanning whatever happened to be in
  //    the window found four repeat badges and no nameable cadence between
  //    them by late afternoon, once the day's listings had passed — a check
  //    that depends on the hour is not a check. The filter is also how a
  //    reader would go looking for one.
  await page.locator('#open-filters').click();
  await page.waitForTimeout(300);
  await page.click('#repeats [data-mode="weekly"]');
  await page.locator('#apply-filters').click();
  await page.waitForTimeout(600);
  const repeatIdx = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('#list .card-slot')];
    return slots.findIndex((s) => s.querySelector('.badge-repeat')
      && window.__proximi.hasCadence(window.__proximi.byId.get(s.dataset.id)));
  });
  if (repeatIdx < 0) {
    ok('a repeating listing is on screen to test', false, 'none found');
  } else {
    const repeatSlot = page.locator('#list .card-slot').nth(repeatIdx);
    await repeatSlot.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const rId = await repeatSlot.getAttribute('data-id');
    const rBox = await repeatSlot.boundingBox();
    await swipe(rBox, -160);
    await page.waitForTimeout(300);
    ok('repeating swipe left asks once or every time',
      await page.locator('#choice-dialog.is-open').count() === 1);
    ok('the card is still there while the question stands',
      await page.locator(`#list .card-slot[data-id="${rId}"]`).count() === 1);
    const before = await page.evaluate((id) =>
      window.__proximi.byId.get(id)._start.toISOString(), rId);
    await page.locator('#choice-once').click();
    await page.waitForTimeout(400);
    const after = await page.evaluate((id) =>
      window.__proximi.byId.get(id)._start.toISOString(), rId);
    ok('hiding just this one moves it to the next occurrence',
      after !== before, `${before} → ${after}`);
    ok('hiding just this one does not hide the series',
      await page.evaluate((id) => !window.__proximi.decisions[id], rId));
    // and the whole series, from the same dialog
    await page.locator('#list .card-slot').nth(0).scrollIntoViewIfNeeded();
  }

  // Back to the whole feed for everything after this.
  await page.locator('#open-filters').click();
  await page.waitForTimeout(300);
  await page.click('#repeats [data-mode="any"]');
  await page.locator('#apply-filters').click();
  await page.waitForTimeout(600);

  // ── Saved: a right swipe puts it there, a second books it
  await page.evaluate(() => {
    const s = document.querySelector('#list .card-slot');
    window.__savedId = s.dataset.id;
    s.querySelector('.verdict-btn.is-yes').click();
  });
  await page.waitForTimeout(300);
  await page.locator('#tab-saved').click();
  await page.waitForTimeout(400);
  ok('saved tab is the third tab', await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.viewtab')].map((t) => t.id);
    return tabs.join(',') === 'tab-events,tab-places,tab-saved';
  }));
  ok('a saved listing shows in Saved', await page.evaluate(() =>
    !!document.querySelector(`#saved-list .card-slot[data-id="${CSS.escape(window.__savedId)}"]`)
    || !!document.querySelector('#saved-list .card-slot')));
  const savedSlot = page.locator('#saved-list .card-slot').first();
  await savedSlot.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const savedBox = await savedSlot.boundingBox();
  const savedId = await savedSlot.getAttribute('data-id');
  await swipe(savedBox, 170);
  await page.waitForTimeout(400);
  ok('swiping right in Saved books the calendar', await page.evaluate((id) =>
    window.__proximi.calendar.has(id), savedId));
  ok('it stays in Saved once booked', await page.evaluate((id) =>
    !!document.querySelector(`#saved-list .card-slot[data-id="${CSS.escape(id)}"]`), savedId));
  await page.locator(`#saved-list .card-slot[data-id="${savedId}"] .verdict-btn.is-no`).click();
  await page.waitForTimeout(300);
  ok('the ✕ in Saved drops it again', await page.evaluate((id) =>
    !document.querySelector(`#saved-list .card-slot[data-id="${CSS.escape(id)}"]`), savedId));
  await page.locator('#tab-events').click();
  await page.waitForTimeout(300);

  // ── Places: render, touchability, like/mute, detail ────
  await page.locator('#tab-places').click();
  await page.waitForTimeout(600);
  const nPlaces = await page.locator('#places-list .place-slot').count();
  ok('places render', nPlaces > 10, `${nPlaces} rows`);
  const rowTouch = await page.evaluate(() => {
    const el = document.querySelector('#places-list .place-slot .place-name');
    if (!el) return 'no row';
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.min(r.left + 5, innerWidth - 1), r.top + r.height / 2);
    return hit && (el.contains(hit) || hit.contains(el) || el.parentElement.contains(hit)) ? 'yes'
      : 'covered by ' + (hit ? hit.className : 'nothing');
  });
  ok('place row touchable', rowTouch === 'yes', rowTouch);

  const heart = page.locator('#places-list .place-slot .place-save').first();
  await heart.click();
  await page.waitForTimeout(200);
  ok('heart tap likes a place', await page.locator('#places-list .place-slot').first()
    .evaluate((n) => n.classList.contains('is-saved')));
  await page.locator('#places-list .place-slot .place-save').first().click();
  await page.waitForTimeout(200);
  ok('heart tap unlikes again', await page.locator('#places-list .place-slot').first()
    .evaluate((n) => !n.classList.contains('is-saved')));

  const placeName = await page.locator('#places-list .place-slot .place-name').first().textContent();
  await page.locator('#places-list .place-slot .place-name').first().click();
  await page.waitForTimeout(400);
  ok('tap opens place detail', await page.locator('#detail-sheet.is-open').count() === 1);
  ok('detail shows the place', (await page.locator('#detail-title').textContent()).trim() === placeName.trim());
  ok('place permalink in hash', await page.evaluate(() => location.hash.startsWith('#p=')));
  await page.locator('#detail-scrim').click({ position: { x: 10, y: 10 }, force: true });
  await page.waitForTimeout(400);
  ok('scrim closes place detail', await page.locator('#detail-sheet.is-open').count() === 0);

  // ── Touch swipe right likes a place ────────────────────
  await page.locator('#places-list .place-slot').nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const rowBox = await page.locator('#places-list .place-slot').nth(1).boundingBox();
  const rowName = await page.locator('#places-list .place-slot').nth(1)
    .evaluate((n) => n.querySelector('.place-name').textContent);
  await swipe(rowBox, 170);
  await page.waitForTimeout(300);
  ok('touch swipe right likes a place', await page.evaluate((name) => {
    const row = [...document.querySelectorAll('#places-list .place-slot')]
      .find((r) => r.querySelector('.place-name').textContent === name);
    return row ? row.classList.contains('is-saved') : false;
  }, rowName));

  // ── "Has something on" leaves only places with a programme
  await page.locator('#places-events').check();
  await page.waitForTimeout(400);
  //    The list itself is capped at 300 rows, so the total to compare is the
  //    one in the summary line, not the number of rows on screen.
  const placesTotal = () => page.evaluate(() =>
    Number((document.getElementById('places-summary').textContent.match(/^(\d+)/) || [])[1]));
  const onlyOn = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#places-list .place-slot')];
    return { rows: rows.length, without: rows.filter((r) => !r.querySelector('.place-events')).length };
  });
  const nOn = await placesTotal();
  ok('"has something on" leaves only places with listings',
    onlyOn.rows > 0 && onlyOn.without === 0, `${onlyOn.rows} rows, ${onlyOn.without} without`);
  await page.locator('#places-events').uncheck();
  await page.waitForTimeout(400);
  const nAll = await placesTotal();
  ok('unticking it brings the rest back', nAll > nOn, `${nOn} with events, ${nAll} in all`);

  // ── A place the audit read and found nothing on ────────
  //    Conditional: the audit runs in batches, so a directory rebuilt ahead of
  //    it carries no verdicts yet. The count is printed either way.
  const quietName = await page.evaluate(() => {
    const p = (window.__proximi.places || []).find((x) => x.eventInfo === 'none' && !x.events);
    return p ? p.name : null;
  });
  if (quietName) {
    await page.fill('#places-search', quietName);
    await page.waitForTimeout(400);
    ok('an audited place says "no event calendar"',
      await page.locator('#places-list .place-slot .place-tag.is-quiet').count() > 0, quietName);
    await page.fill('#places-search', '');
    await page.waitForTimeout(400);
  } else {
    console.log('SKIP  no audited places in data/places.json yet');
  }

  // ── The kind select ────────────────────────────────────
  //    It rendered the right kinds with the right counts from the day Places
  //    became a page, and was never listened to, so choosing one did nothing
  //    at all. Nothing about the control looked broken, which is the only
  //    reason it lasted. Assert on the rows, not on the select's value.
  const kindPick = await page.evaluate(() => {
    const opt = [...document.querySelectorAll('#places-kinds option')]
      .find((o) => o.value && /\((\d+)\)/.test(o.textContent)
        && +o.textContent.match(/\((\d+)\)/)[1] > 3);
    return opt ? { value: opt.value, n: +opt.textContent.match(/\((\d+)\)/)[1] } : null;
  });
  if (kindPick) {
    await page.selectOption('#places-kinds', kindPick.value);
    await page.waitForTimeout(400);
    const shown = await page.evaluate((want) => {
      const by = new Map((window.__proximi.places || []).map((p) => [p.id, p]));
      const rows = [...document.querySelectorAll('#places-list .place-slot')];
      const wrong = rows.filter((r) => {
        const p = by.get(r.dataset.id);
        return p && (p.kind || 'other') !== want;
      }).length;
      return { rows: rows.length, wrong };
    }, kindPick.value);
    ok('choosing a kind filters the list',
      shown.rows > 0 && shown.rows <= kindPick.n && shown.wrong === 0,
      `${kindPick.value}: ${shown.rows} rows of ${kindPick.n}, ${shown.wrong} of another kind`);
    await page.selectOption('#places-kinds', '');
    await page.waitForTimeout(400);
  } else {
    console.log('SKIP  no kind with enough rows to filter on');
  }

  // ── Somewhere to eat ───────────────────────────────────
  //    Its own file, fetched in the background, so the first assertion here is
  //    that it arrived at all.
  await page.locator('#places-scope .chip', { hasText: 'To eat' }).click();
  await page.waitForTimeout(1500);
  // Conditional the same way the audit block is: places.py writes data/eats.json
  // and a checkout that has not run it yet is not a broken app.
  const eatsState = await page.evaluate(() => window.__proximi.eats);
  if (eatsState === 'failed') {
    console.log('SKIP  data/eats.json has not been built — the food filters cannot be driven');
  } else {
  const eats = await page.evaluate(() => ({
    state: window.__proximi.eats,
    rows: document.querySelectorAll('#places-list .place-slot').length,
    food: (window.__proximi.places || []).filter(
      (p) => p.kind === 'restaurant' || p.kind === 'cafe').length,
    foodControls: !document.getElementById('places-food').hidden,
    notFood: [...document.querySelectorAll('#places-list .place-slot')]
      .filter((r) => {
        const p = (window.__proximi.places || []).find((x) => x.id === r.dataset.id);
        return p && p.kind !== 'restaurant' && p.kind !== 'cafe';
      }).length
  }));
  ok('the food list loads on demand', eats.state === 'ready' && eats.food > 100,
    `${eats.state}, ${eats.food} places to eat`);
  ok('"to eat" shows only somewhere to eat', eats.rows > 0 && eats.notFood === 0,
    `${eats.rows} rows, ${eats.notFood} not food`);
  ok('the food filters appear with it', eats.foodControls);

  // Kind of food: the ask this was built for. Every row has to carry the
  // cuisine it was filtered to, read off the row rather than off the state.
  const cuisinePick = await page.evaluate(() => {
    const opt = [...document.querySelectorAll('#places-cuisines option')]
      .find((o) => o.value && +o.textContent.match(/\((\d+)\)/)[1] > 5);
    return opt ? { value: opt.value,
                   label: opt.textContent.replace(/\s*\(\d+\)$/, '').trim() } : null;
  });
  if (cuisinePick) {
    await page.selectOption('#places-cuisines', cuisinePick.value);
    await page.waitForTimeout(400);
    const wrong = await page.evaluate((want) => {
      const by = new Map((window.__proximi.places || []).map((p) => [p.id, p]));
      const rows = [...document.querySelectorAll('#places-list .place-slot')];
      return {
        rows: rows.length,
        bad: rows.filter((r) => {
          const p = by.get(r.dataset.id);
          return !p || !(p.cuisine || []).includes(want);
        }).length
      };
    }, cuisinePick.value);
    ok('kind of food narrows to that food',
      wrong.rows > 0 && wrong.bad === 0,
      `${cuisinePick.label}: ${wrong.rows} rows, ${wrong.bad} without it`);
    // And it is on the row, not only in the filter — the label is how somebody
    // scanning the list tells a chowder house from a taqueria.
    ok('the row says what kind of food it is',
      await page.locator('#places-list .place-slot .place-tag.is-cuisine').count() > 0);
    await page.selectOption('#places-cuisines', '');
    await page.waitForTimeout(400);
  } else {
    console.log('SKIP  no cuisine with enough rows to filter on');
  }

  // Open now: the filter that can most easily lie, so it is held to "the row
  // itself says open". A place with no hours on the map must not be in here.
  await page.locator('#places-open').check();
  await page.waitForTimeout(500);
  const openRows = await page.evaluate(() => {
    const by = new Map((window.__proximi.places || []).map((p) => [p.id, p]));
    const rows = [...document.querySelectorAll('#places-list .place-slot')];
    return {
      rows: rows.length,
      unlabelled: rows.filter((r) => !r.querySelector('.place-tag.is-open')).length,
      guessed: rows.filter((r) => {
        const p = by.get(r.dataset.id);
        return !p || !p.openingHours
          || window.__proximi.openState(p.openingHours) !== 'open';
      }).length
    };
  });
  ok('"open now" only keeps places the map says are open now',
    openRows.rows > 0 && openRows.unlabelled === 0 && openRows.guessed === 0,
    `${openRows.rows} rows, ${openRows.unlabelled} unlabelled, ${openRows.guessed} guessed`);
  await page.locator('#places-open').uncheck();
  await page.waitForTimeout(400);

  // Both halves, or this passes on a list that never had a chain in it.
  const chainsBefore = await page.locator('#places-list .place-slot .place-tag.is-chain').count();
  await page.locator('#places-indie').check();
  await page.waitForTimeout(500);
  const chains = await page.locator('#places-list .place-slot .place-tag.is-chain').count();
  ok('"independents only" leaves no chains', chainsBefore > 0 && chains === 0,
    `${chainsBefore} chains before, ${chains} after`);
  await page.locator('#places-indie').uncheck();
  await page.waitForTimeout(400);
  // Leaving with the food filters still ticked must not empty the directory:
  // nothing to visit has a cuisine and half of it has no hours, and on this
  // scope there is no control on screen to explain the empty page.
  await page.locator('#places-open').check();
  await page.waitForTimeout(300);
  }
  await page.locator('#places-scope .chip', { hasText: 'To visit' }).click();
  await page.waitForTimeout(500);
  const backToVisit = await page.locator('#places-list .place-slot').count();
  ok('the food filters do not follow you back to "to visit"', backToVisit > 50,
    `${backToVisit} rows`);
  if (eatsState !== 'failed') {
    await page.locator('#places-scope .chip', { hasText: 'To eat' }).click();
    await page.waitForTimeout(400);
    await page.locator('#places-open').uncheck();
    await page.waitForTimeout(300);
    await page.locator('#places-scope .chip', { hasText: 'To visit' }).click();
    await page.waitForTimeout(400);
  }

  // ── One place's listings: filters step aside, then come back
  //    "12 listings →" has to hand over twelve listings. It used to hand over
  //    whatever survived the feed's own filters, which for a place 40 miles
  //    out was routinely nothing at all.
  await page.locator('#tab-events').click();
  await page.waitForTimeout(300);
  await page.locator('#open-filters').click();
  await page.waitForTimeout(300);
  await page.click('#tonight-free');
  await page.locator('#apply-filters').click();
  await page.waitForTimeout(400);
  const filtersBefore = await page.evaluate(() => ({
    n: document.getElementById('filters-count').textContent,
    radius: document.getElementById('radius').value,
    free: document.getElementById('free-only').checked
  }));
  ok('filters are in play before the peek', Number(filtersBefore.n) > 0, filtersBefore.n);

  await page.locator('#tab-places').click();
  await page.waitForTimeout(500);
  const withListings = page.locator('#places-list .place-slot').filter(
    { has: page.locator('.place-events') }).first();
  const promised = Number((await withListings.locator('.place-events').textContent())
    .trim().split(/\s+/)[0]);
  await withListings.locator('.place-events').click();
  await page.waitForTimeout(500);
  const peek = await page.evaluate(() => ({
    view: document.getElementById('events-view').hidden ? 'hidden' : 'events',
    banner: !document.getElementById('venue-banner').hidden,
    note: !document.getElementById('venue-banner-note').hidden,
    count: document.getElementById('filters-count').hidden
      ? 0 : Number(document.getElementById('filters-count').textContent),
    scope: document.getElementById('context-scope').textContent
  }));
  ok('the listings link opens the events tab', peek.view === 'events');
  ok('it names the place, and says filters are paused', peek.banner && peek.note);
  ok('no filters are left in play while looking at one place', peek.count === 0, `${peek.count}`);
  const got = Number((peek.scope.match(/^(\d+)/) || [])[1]);
  ok('the feed shows every listing the row promised', got === promised,
    `row said ${promised}, feed showed ${got}`);

  await page.locator('#venue-banner-clear').click();
  await page.waitForTimeout(500);
  const restored = await page.evaluate(() => ({
    banner: !document.getElementById('venue-banner').hidden,
    n: document.getElementById('filters-count').textContent,
    radius: document.getElementById('radius').value,
    free: document.getElementById('free-only').checked
  }));
  ok('"show everywhere" drops the place filter', restored.banner === false);
  ok('and hands back the filters it paused',
    restored.n === filtersBefore.n && restored.radius === filtersBefore.radius
    && restored.free === filtersBefore.free,
    JSON.stringify(restored));

  // ── Filter sheet, layout, console ──────────────────────
  await page.locator('#tab-events').click();
  await page.waitForTimeout(300);
  await page.locator('#open-filters').click();
  await page.waitForTimeout(400);
  // "Free tonight, nearby" is a shortcut, not a mode: it has to move the
  // real filters, light up the real chips, and be undone by Reset. A
  // shortcut that filtered privately would be a filter you cannot see.
  await page.click('#tonight-free');
  const after = await page.evaluate(() => ({
    horizon: document.querySelector('#horizon [data-horizon="today"]')
               ?.getAttribute('aria-pressed'),
    tod: document.querySelector('#tod [data-tod="nighttime"]')
           ?.getAttribute('aria-pressed'),
    free: document.getElementById('free-only').checked,
    radius: document.getElementById('radius').value
  }));
  ok('free tonight sets Today', after.horizon === 'true', after.horizon);
  ok('free tonight sets Nighttime', after.tod === 'true', after.tod);
  ok('free tonight ticks Free only', after.free === true);
  ok('free tonight pulls the radius in', Number(after.radius) < 75, after.radius);

  await page.click('#reset-filters');
  const back = await page.evaluate(() => ({
    horizon: document.querySelector('#horizon [data-horizon="today"]')
               ?.getAttribute('aria-pressed'),
    free: document.getElementById('free-only').checked,
    radius: document.getElementById('radius').value
  }));
  ok('Reset undoes the shortcut', back.horizon === 'false' && back.free === false
     && Number(back.radius) === 75, JSON.stringify(back));

  ok('filter sheet opens', await page.locator('#filter-sheet.is-open').count() === 1);
  await page.locator('#apply-filters').click();
  await page.waitForTimeout(400);

  // ── Use my location ────────────────────────────────────
  //    The whole app hangs off where the reader is: distances, the sort, the
  //    preset row, the Places list. Asserting that the button flips a status
  //    line would prove nothing, so this pretends to be standing in Bar Harbor
  //    and checks that the numbers on the page moved to match.
  const HERE = { latitude: 44.3876, longitude: -68.2039 };   // Bar Harbor, ME
  await ctx.grantPermissions(['geolocation']);
  await ctx.setGeolocation(HERE);
  await page.locator('#open-location').click();
  await page.waitForTimeout(300);
  await page.locator('#use-my-location').click();
  await page.waitForTimeout(800);

  const located = await page.evaluate((here) => {
    const o = window.__proximi.origin || {};
    const R = 3958.8, rad = (d) => d * Math.PI / 180;
    const away = (a, b) => {
      const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    return {
      name: o.name,
      off: o.lat == null ? null
        : away({ lat: here.latitude, lon: here.longitude }, { lat: o.lat, lon: o.lon }),
      status: document.getElementById('loc-status').textContent.trim(),
      chip: document.getElementById('context-place').textContent.trim(),
      presets: [...document.querySelectorAll('#presets .chip')].map((c) => c.textContent.trim()),
      regions: (window.__proximi.regions || []).map((r) => r.name)
    };
  }, HERE);
  ok('use my location sets the origin', located.off !== null && located.off < 0.5,
    `${located.name} — ${located.off == null ? 'no origin' : located.off.toFixed(2) + ' mi off'}`);
  ok('and the page says where it is measuring from',
    /your location/i.test(located.status) && /your location/i.test(located.chip),
    `${located.status} | ${located.chip}`);
  if (located.regions.length) {
    ok('the nearest coverage area is offered as a preset',
      located.presets.length > 0 && located.presets[0] === located.regions
        .map((n) => n).find((n) => located.presets.includes(n)),
      located.presets.join(' / '));
  } else {
    console.log('SKIP  data/places.json has no coverage regions (older build)');
  }

  await page.locator('#apply-filters').click();
  await page.waitForTimeout(300);
  await page.locator('#tab-places').click();
  await page.waitForTimeout(500);
  const near = await page.evaluate((here) => {
    const R = 3958.8, rad = (d) => d * Math.PI / 180;
    const away = (a, b) => {
      const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
        + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    const by = new Map((window.__proximi.places || []).map((p) => [p.id, p]));
    const rows = [...document.querySelectorAll('#places-list .place-slot')].slice(0, 20);
    const miles = rows.map((r) => {
      const p = by.get(r.dataset.id);
      return p ? away({ lat: here.latitude, lon: here.longitude }, p) : null;
    }).filter((m) => m != null);
    // The nearest row has to be the nearest place there is, whatever the data
    // holds — a fixed mileage would only be asserting what the directory
    // happens to cover this week.
    const FOOD = new Set(['restaurant', 'cafe']);
    const scope = window.__proximi.scope;
    const best = Math.min(...(window.__proximi.places || [])
      .filter((p) => p.lat != null && (scope === 'all' ? true
        : scope === 'eat' ? FOOD.has(p.kind) : !FOOD.has(p.kind)))
      .map((p) => away({ lat: here.latitude, lon: here.longitude }, p)));
    return {
      first: miles[0],
      best,
      sorted: miles.every((m, i) => i === 0 || m >= miles[i - 1] - 0.05),
      printed: rows[0]?.querySelector('.place-where')?.textContent.trim() || ''
    };
  }, HERE);
  ok('places are measured and sorted from where the reader is',
    near.first != null && near.sorted && Math.abs(near.first - near.best) < 0.1,
    `nearest row ${near.first == null ? 'none' : near.first.toFixed(1)} mi vs `
    + `nearest place ${near.best.toFixed(1)} mi, ascending ${near.sorted}, `
    + `row says "${near.printed}"`);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('no horizontal overflow', overflow <= 0, `${overflow}px`);
  ok('no console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  console.log(fail.length ? `\n${fail.length} FAILURES` : '\nALL PASS');
  await browser.close();
  if (server) server.kill();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
