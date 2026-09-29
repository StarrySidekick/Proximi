/* Opening hours, shared by the list (app.js) and Drive (drive.js).

   OpenStreetMap's opening_hours is a small language and most of this corner
   of the map speaks the plain half of it: "Mo-Su 11:00-22:00",
   "Tu-Th 17:00-22:00, Fr 17:00-23:00, Mo off", a bare "05:00-19:00". 45% of
   the food rows carry one.

   Three rules keep this honest, because "open" is a claim that sends
   somebody driving. Anything this does not fully understand — a public
   holiday clause, a season, a comment in quotes, a word like sunset —
   returns null and the caller says nothing at all rather than guessing. A day
   the string never mentions is closed, which is what the format means. And
   the answer is only ever as fresh as the map.

   It lived inside app.js until Drive needed it too; one parser, so the list
   and the car can never disagree about whether a place is open. */

(() => {
  'use strict';

  const DAY_N = { Su: 0, Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6 };
  const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
  const HOURS_RULE = new RegExp(
    `(?:(${DAY}(?:\\s*[-,]\\s*${DAY})*)\\s+)?` +
    '(off|closed|\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2}' +
    '(?:\\s*,\\s*\\d{1,2}:\\d{2}\\s*-\\s*\\d{1,2}:\\d{2})*)', 'g');
  /* Everything this parser cannot evaluate. Each one is a reason to say
     nothing: a holiday clause, a season, a school term, a comment. */
  const HOURS_BEYOND_US =
    /\b(PH|SH|su?n(rise|set)|dawn|dusk|easter|open|week\s*\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|"|\[/i;

  function daysOf(spec) {
    if (!spec) return [0, 1, 2, 3, 4, 5, 6];
    const out = new Set();
    for (const part of spec.split(',')) {
      const ends = part.split('-').map((x) => DAY_N[x.trim()]);
      if (ends[0] == null) continue;
      if (ends.length === 1) { out.add(ends[0]); continue; }
      if (ends[1] == null) continue;
      for (let d = ends[0]; ; d = (d + 1) % 7) {   // Sa-Su wraps the week end
        out.add(d);
        if (d === ends[1]) break;
      }
    }
    return [...out];
  }

  function rangesOf(spec) {
    if (/^(off|closed)$/i.test(spec.trim())) return [];
    const out = [];
    for (const part of spec.split(',')) {
      const m = part.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
      if (m) out.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
    }
    return out;
  }

  // The rules, or null for a string this cannot fully read; 'always' for 24/7.
  function rulesOf(hours) {
    const text = String(hours || '').trim();
    if (!text) return null;
    if (/^24\/7$/.test(text)) return 'always';
    if (HOURS_BEYOND_US.test(text)) return null;
    const rules = [];
    const leftover = text.replace(HOURS_RULE, (_m, days, spec) => {
      rules.push({ days, spec });
      return '';
    });
    // Anything left but separators means the string said something else too,
    // and a half-read rule is the one that gets somebody's evening wrong.
    if (!rules.length || !/^[\s;,]*$/.test(leftover)) return null;
    return rules;
  }

  // Today's spans, in minutes from midnight, by the rule that governs today
  // (a later rule wins for the days it names). A span past midnight ends
  // past 1440.
  function spansOn(rules, day) {
    let spans = [];
    for (const rule of rules) {
      if (daysOf(rule.days).includes(day)) {
        spans = rangesOf(rule.spec).map(([from, to]) => [from, to > from ? to : to + 1440]);
      }
    }
    return spans;
  }

  /* Minutes from `now` until it closes: 0 if it is closed, Infinity if it
     never does, null if the string cannot be read. Drive asks this at the
     time you would arrive, so a museum shutting ten minutes after you get
     there reads as the waste of a detour that it is. */
  function minutesLeft(hours, now = new Date()) {
    const rules = rulesOf(hours);
    if (rules == null) return null;
    if (rules === 'always') return Infinity;
    const day = now.getDay();
    const mins = now.getHours() * 60 + now.getMinutes();
    // Yesterday's kitchen may still be open: "Fr,Sa 17:00-01:00" on a Saturday
    // at half past midnight is Friday's rule still running.
    const spans = spansOn(rules, day)
      .concat(spansOn(rules, (day + 6) % 7).map(([a, b]) => [a - 1440, b - 1440]));
    let best = 0;
    for (const [from, to] of spans) if (mins >= from && mins < to) best = Math.max(best, to - mins);
    return best;
  }

  function openState(hours, now = new Date()) {
    const left = minutesLeft(hours, now);
    return left == null ? null : left > 0 ? 'open' : 'closed';
  }

  window.ProximiHours = { openState, minutesLeft };
})();
