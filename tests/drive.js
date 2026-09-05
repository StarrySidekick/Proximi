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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
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

  // ── Verdict buttons toggle, and stay toggled off ───────
  const yes = page.locator('#list .card-slot .verdict-btn.is-yes').first();
  await yes.click();
  await page.waitForTimeout(150);
  const afterOne = await page.locator('#list .card-slot').first().evaluate(
    (n) => n.classList.contains('is-saved'));
  await yes.click();
  await page.waitForTimeout(150);
  const afterTwo = await page.locator('#list .card-slot').first().evaluate(
    (n) => n.classList.contains('is-saved'));
  ok('verdict ♥ saves', afterOne === true);
  ok('verdict ♥ again unsaves', afterTwo === false, afterTwo ? 'stale closure' : '');

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
  await page.locator('#list .card-slot').nth(2).scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await page.locator('#list .card-slot').nth(2).boundingBox();
  const idBefore = await page.locator('#list .card-slot').nth(2).getAttribute('data-id');
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

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('no horizontal overflow', overflow <= 0, `${overflow}px`);
  ok('no console/page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  console.log(fail.length ? `\n${fail.length} FAILURES` : '\nALL PASS');
  await browser.close();
  if (server) server.kill();
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
