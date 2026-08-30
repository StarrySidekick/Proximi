---
name: proximi-refresh
description: >
  Refresh the Proximi listings and place directory — run the scrape pipeline,
  hand-read the sources that have no feed, fill in prices, and publish. Use for
  the weekly refresh, for "update the events", "rerun the scrape", "refresh
  Proximi", or any work on scripts/ or sources/ in the StarrySidekick/Proximi
  repo. Also use before adding a source, changing a place category, or writing a
  new collector: it carries the failure modes that cost real listings, and most
  of them fail silently.
---

# Proximi — refreshing the listings and the directory

Two static JSON files behind a PWA on GitHub Pages. `data/events.json` is what
is on; `data/places.json` is where to go whether or not anything is on. Pushing
to `main` is the deploy.

**The governing rule: a silent failure is the normal failure here.** Almost
nothing in this pipeline throws. A collector that returns zero, a tag rule that
matches nothing, a cache that hands back the wrong query's answer, a feed frozen
since March — all of them produce a clean run, a plausible count, and a worse
site. Every check below exists because one of them actually happened.

## 1. Run the pipeline

Order matters: the collectors write `build/*.json`, `enrich.py` reads whatever
is there, and `merge.py` treats a missing collector as an absent week rather
than an error.

```bash
git pull origin main
python3 scripts/harvest.py     # iCal + Squarespace, from sources/registry.json
python3 scripts/jsonld.py      # schema.org Events on html sources
python3 scripts/platforms.py   # Ticketmaster (needs TICKETMASTER_API_KEY)
python3 scripts/social.py      # Eventbrite + Meetup, via their embedded JSON
python3 scripts/libcal.py      # library programming
python3 scripts/songkick.py    # ticketed concerts
python3 scripts/cinema.py      # the five film houses that serve HTML
python3 scripts/enrich.py      # geocode (cached), radius-filter, classify
python3 scripts/merge.py       # collapse repeats, dedupe → data/events.json
python3 scripts/prices.py      # read unpriced listings' own pages (cached)
python3 scripts/places.py      # the directory → data/places.json
python3 scripts/validate.py    # gates both files; must pass before committing
node tests/drive.js            # drives the page itself; must pass too
```

`prices.py` runs AFTER merge (it edits data/events.json in place; merge's
richness scoring then keeps those prices on future runs). Its cache
(sources/pricecache.json) remembers "asked, page publishes none" for 30 days,
so a weekly run only fetches what is new. It reads JSON-LD offers only —
never a visible "$" from page text — and trusts an explicit 0, same as
jsonld.py.

`places.py --only <kinds>` writes ONLY those kinds to data/places.json.
It exists for retrying a failed selector — always follow it with a full
(cached, fast) `places.py` run, or the directory ships missing 28 kinds.

Rough expected yields — **investigate anything near zero before continuing**:
harvest ~1900, jsonld ~60, platforms ~1450, social ~950, libcal ~590,
songkick ~570, cinema ~200.

`platforms.py` exits cleanly with "skipped: TICKETMASTER_API_KEY not set". That
is a **failure**, not a pass — it costs ~600 listings including the Capitol
Theatre, Daryl's House, Paramount Hudson Valley and Bethel Woods. Say so in the
summary if it happens.

`places.py` is slow (Overpass) and fully cached; it only refetches selectors it
does not already have. Run it, but do not block the events refresh on it.

### Read harvest's report and act on it

- `blocked: bot challenge` — try WebFetch on the feed URL; if that fails too,
  note it on the registry entry and move on.
- `no future events — feed looks frozen` — a real failure, not a quiet week.
  Towne Crier, The Beacon and Paramount Hudson Valley all serve well-formed
  archives frozen months back. Set `enabled: false` with a dated note so it is
  not rediscovered and re-trusted.
- `unreachable` — the script already retried three times. If it fails two weeks
  running, disable it with a note.

## 2. Check that the sources are still who they say they are

**Three theatre domains in one 50-mile pass had lapsed and been re-registered by
gambling operators** — `downingfilmcenter.com`, `storyscreenbeacon.com`,
`bethelcinema.com` now serve Indonesian and Turkish betting sites. All three
answer HTTP 200, so a liveness check reads them as healthy. A fourth,
`rivertownfilm.org`, is genuinely the film society's site but its WordPress is
SEO-spammed with casino copy sitting in the page body beside the film blurbs.

For any source that has not produced listings in a while, check what the URL
*serves*, not that it answers. Small venues lose domains often.

## 3. Hand-read the sources that have no feed

Registry entries with `"kind": "html"` are yours to read. `jsonld.py` already
takes anything with schema.org Events, so check its report first and hand-read
only what it could not.

Write findings to `sources/manual.json`, never straight into `data/events.json`
— the pipeline regenerates that file and would discard the work.

Two rules that have already caught errors:

- **Cross-check the date against the weekday the page prints beside it.** Two
  entries where the two disagreed were dropped rather than guessed at.
- **Skip multi-day runs whose per-day times the page does not spell out.** A
  summariser will happily invent "Friday 4:00pm" for a Saturday.

`lat`/`lon` may be left null — `enrich.py` geocodes hand-read entries from
`address`, or `venue` + `city`. That is the one field a person reading a
listings page genuinely does not have.

## 4. Prices — still the biggest quality gap

Many listings read "See listing". For the 20–30 most prominent upcoming ones,
open the event's own `url` and set a real price.

**Never guess.** `null` renders as "See listing"; `{"min": 0, "max": 0}` renders
as **Free**. Writing 0 for an unknown price tells someone an event is free when
it may cost $45 — the worst error this app can make. Ticketmaster returns
`0.00–0.00` as a placeholder for exactly this and `platforms.py` already
converts it to null. Do not undo that.

## 5. Fix the rule, never the record

`merge.py` re-derives `type`, `types`, `audience`, `setting`, `timeOfDay`,
`cadence`, `hasFood`, `repeats`, `recurrence` and `until` on every run. A
hand-edit to one listing is overwritten next week while the rule keeps
mislabelling everything else. Edit `scripts/enrich.py`.

Curated records (`manual-` ids) are exempt: a person checked those.

Sample ~15 listings and check:

- `type` — read from the **title first**, then the description. Check the
  "other" bucket especially.
- `audience` — `family` and `seniors` are **hidden by default**, so a false
  positive silently removes a good listing. "Ages 2–5 with a caregiver" is
  `family`; a Senior Vice President giving a talk is not `seniors`; a county
  fair whose blurb mentions kids' rides stays `all`.
- `setting` — leave `unknown` rather than guessing.

## 6. Places: the tag is not the category

`scripts/placekinds.py` is the **single** taxonomy — 30 kinds, read two ways.
`enrich.py` matches a venue *name* (an event only tells us what its venue is
called); `places.py` matches OSM *tags*. An import-time assert fails if either
names a kind the list does not define. Never add a second list.

OSM's broad tags are applied to features *inside* places as readily as to
destinations, and each needs a different signal. These filters are load-bearing
— every one was found by reading the data, not the counts:

| tag | raw | kept | what actually separates them |
| --- | --- | --- | --- |
| `leisure=park` | 6,297 | 284 | public-land designation, or a Wikipedia article |
| `shop=*` (mall) | 464 | 145 | not `department_store` — that is Marshalls and Macy's |
| `tourism=attraction` | 525 | 117 | `zoo`/`aquarium` self-evident; viewpoints need write-up |
| `leisure=garden` | 363 | 99 | `garden:type` botanical or arboretum |
| `shop=farm` | 130 | 66 | not `greengrocer` — town grocers, and one chemist |
| `tourism=viewpoint` | 457 | 62 | a tower built to be climbed, or a written-up overlook |

Two traps worth stating outright:

- **`wikidata` is worthless as a quality signal.** GNIS imports attached one to
  every pocket park in the country. `wikipedia` is rare enough to mean
  something; `wikidata` is not.
- **A designation is not an invitation.** `heritage` alone put "Broadway", "Old
  Albany Post Road" and the New Haven Line in the historic sites — once per way
  segment. Roads and rail are excluded outright, and historic sites, houses and
  landmarks need a real visit signal (website, opening hours, tourism tag).
- **`protection_title` needs a whitelist.** The commonest value in range is
  "Watershed Recreation Unit" — 464 of them, and it is permit-only reservoir
  land, not somewhere you go on Saturday.

### Overpass, which is the flaky part

- **Use a bounding box, never `around:`.** `around:` makes Overpass measure the
  distance to every candidate in the index; over 80km `out tags center` times
  out on every mirror while the *identical* query with `out count` returns in 35
  seconds — which is exactly what makes it look like a mirror problem rather
  than a query problem. A bbox is a cheap index lookup. `to_place()` drops the
  corners.
- **One query per selector, cached by selector *content*.** Keying the cache on
  a selector's position meant removing one from the middle of a list silently
  remapped every cached answer after it to the wrong query.
- **The mirror estate rotates.** `query()` prefers whichever mirror answered
  last. `overpass.osm.ch` is deliberately excluded: it answers happily and
  returns zero results outside Switzerland, which reads as "no data here". A
  mirror that lies is worse than one that is down.
- **`python3 scripts/places.py --selftest`** checks every selector parses and
  that each shape matches something. It exists because a parser that split
  selectors on `=` made every regex rule — breweries, monuments, zoos, theme
  parks — match nothing at all, and the counts stayed plausible throughout.

## 7. One fact, one owner

`merge.py` resolves a room to its building and writes `venueKey`. `places.py`
and the client both **read** it. They used to each derive it, and the directory
credited Howland Public Library with seven events while every one of them still
said "Community Room" — so the count and the filter disagreed and tapping
through found nothing.

If two things need the same derived fact, compute it once and write it down.

## 8. Verify what renders, not what exists

- `python3 scripts/validate.py` must pass. It gates both files and runs the
  Overpass selector self-test.
- `node tests/drive.js` must pass. It starts its own server, drives the page
  in headless Chromium (touch swipes via CDP, detail sheets, permalinks,
  elementFromPoint render asserts) and is the check that would have caught
  the release where every Places tap threw a ReferenceError. CI runs it on
  every push. For ad-hoc poking beyond it, Playwright is at
  `/opt/node22/lib/node_modules/playwright`, chromium at `/opt/pw-browsers/`.
- **Assert on the render.** `innerText` reads perfectly well from an element
  painted over by a sibling — a Places page where every row was hidden under its
  own swipe rail passed "300 rows, no console errors, no overflow". Use
  `document.elementFromPoint` to ask whether the element is the one you would
  actually touch.
- **Test touch with CDP `Input.dispatchTouchEvent`, not the mouse.** Touch
  pointers are implicitly captured by whatever received the `pointerdown`, so
  `setPointerCapture` *transfers* them and fires a bubbling
  `lostpointercapture`. Swiping worked with a mouse and never with a finger, and
  a mouse-driven test structurally could not see it.
- **A test you have not seen fail is not a test yet.** Re-break the thing and
  confirm the check goes red.

## 9. Ship

Commit with the listing count, how many are priced, and any source that changed
state. Push to `main`.

```bash
python3 scripts/version.py     # stamp the build number, immediately before committing
git push -u origin main
```

Do not open a pull request. Pushing is the deploy.

**Pushing to `main` is not yet the deploy, and the failure is silent.** Checked
on 2026-08-30: Pages was still serving `claude/local-events-discovery-vfjgwr`,
so `main` was five commits ahead and the live site had spent two days serving a
Places page whose every tap threw. The push succeeds, CI goes green, the site
does not move, and nothing anywhere says so.

So publish to the branch Pages actually serves, then **verify the deploy**:

```bash
git push -u origin main
git push origin origin/main:refs/heads/claude/local-events-discovery-vfjgwr
curl -s https://starrysidekick.github.io/Proximi/data/version.json   # must be the version you just stamped
```

The second push is a fast-forward (the old branch is an ancestor of `main`), so
it rewrites nothing. Drop it once Settings → Pages → Branch reads `main` — and
until then, never report a refresh as live without that `curl` coming back with
the new version. A green CI run says the data is valid, not that anyone can see
it.

The centre and both radii live in `sources/registry.json` (`center`, 100 miles
for events, `placesRadiusMiles` 50 for places). `merge.py` copies them into the
published file, so change them there and nowhere else.

## Finding new sources

```bash
python3 scripts/discover.py --overpass   # venues with a website, from OSM
python3 scripts/discover.py --probe      # test each for a live feed
```

Roughly **7% of venue domains expose a usable feed**. `data/places.json` is also
a source list: places with a website that the registry does not know are
exactly the domains worth probing.

Platform patterns that no plain path-probe reaches:

| platform | where the feed actually is |
| --- | --- |
| Localist (colleges) | `events.<domain>/calendar.ics`, not the main domain |
| Tockify | keyed on the embed's `data-tockify-calendar` attribute |
| LibCal | nothing in bulk; `libcal.py` walks the per-day ajax endpoint |
| Squarespace | `?format=json` (kind `sqsp`); `?format=ical` returns empty |
| Assabet | subdomain is not derivable — fingerprint the homepage |
| The Events Calendar | `?ical=1` — the highest-yield case by far |

Registry kinds: `ics`, `sqsp`, `html`, `api`, `social`. The CI check reads the
allowed set from `harvest.HANDLERS` rather than restating it — a hard-coded list
went stale when `sqsp` was added and failed the build for eleven runs while the
registry was perfectly fine.

A college calendar also needs `"campus": true`. Those are internal by default
and `merge.py` keeps only what is genuinely public.

**A campus source also needs a `venue` block with the campus coordinates.**
Campus feeds put building and room names in LOCATION ("Maxcy Quad", "Aquinas
Hall") that no gazetteer resolves, and without the fallback enrich drops the
listing as ungeocodable — 1,628 candidates per run, silently, until 2026-08-28.
With the block, the room falls back to the campus point and the campus filter
still decides what is public. The failure is invisible in the counts: harvest
reports the feed healthy, and the drop happens two stages later.
