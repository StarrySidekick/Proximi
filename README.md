# Proximi

Find events and activities happening near wherever you are.

**Proximi** answers "what is there to do around here?" — a single scannable list
of things happening nearby, filterable by what kind of thing it is, how far away
it is, and what it costs.

This repo holds a **working front-end prototype** served from GitHub Pages,
with real listings refreshed weekly by a scheduled Claude task — see
[How listings get updated](#how-listings-get-updated).

---

## Two kinds of listing

The app deliberately distinguishes:

| | **Event** | **Activity** |
|---|---|---|
| Happens | Once, at a specific time | Repeatedly, or across a window |
| Examples | A concert, a parade, a protest, a one-day sale | A walking tour, a weekly open mic, a farmers market, a drop-in class |
| Shown as | `Sat, Sep 5, 7 PM` | `Sat, Sep 5, 2 PM · Daily at 2pm and 4pm` |

Both are time-gated — an activity still has a schedule — so both live in one
list, tagged with a badge, and the `Type` filter separates them on demand.

## What the prototype does

The page is just the list. Everything else lives behind a **Filters** sheet, so
the default view is scannable rather than a wall of controls.

**Out of the box** it shows what's on in the **next week**, **within 50 miles**,
sorted **soonest first** — and within a day, nearest first. Day dividers
(`Today`, `Tomorrow`, `Wednesday`, then `Monday, Aug 31` once a bare weekday
would be ambiguous) stick beneath the header as you scroll, the way date
separators work in a messages thread.

The header line always states what you are looking at — place, result count,
time horizon and radius — and the Filters button carries a count of how many
controls sit away from their defaults.

Inside the sheet:

- **Location** — browser geolocation, any town or address (geocoded via
  OpenStreetMap's Nominatim), or a one-tap preset from the covered region.
- **Happening within** — today, 3 days, a week, 2 weeks, a month, or anytime.
- **Distance** — search radius, with a miles/kilometres toggle.
- **Repeating** — all, one-off only, or repeating only.
- **Who it's for** — children-only listings are **hidden by default**; 21+ ones
  are shown. Both are toggles.
- **What** — free-text search, events vs. activities, and category chips that
  show live match counts.
- **Cost** — max price, free-only, and needs-sign-up-only.
- **Sort** — soonest (default), nearest, or cheapest. Day dividers appear only
  under soonest, where they mean something.

Cards carry what you need to decide: price with its caveats ("$15 online, $20 at
the gate"), venue, town, distance, duration, category tags, and a **Sign up**
button wherever registration is required. Multi-day runs read as a range, and
something already under way reads "on now, through Sep 6".

Cards badge what they are: **Event** or **Activity**, plus **Repeats**,
**Children only** or **21+** where those apply.

## Look

The theme is **Victorian**, lifted from the [Bureau](https://github.com/StarrySidekick/bureau)
app's style system (`docs/STYLES.md`, `web/js/look.js`) — an old writing desk:
parchment and checkerboard baize, brass, sage and claret, Iowan Old Style for
display type, and panelled mouldings on the cards. Nothing pure white and
nothing pure black. Dark mode is Bureau's own reading of it: the parchment
becomes the walnut it was always sitting on, and the colours deepen rather
than change.

It works down to phone widths, where the filter sheet becomes a bottom sheet.

## Run it locally

The app fetches `data/events.json`, so it needs a web server — opening
`index.html` from the filesystem will fail on browser `file://` restrictions.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

The site is plain static files at the repo root with a `.nojekyll` marker, so it
needs no build step and no deploy workflow.

**One-time setup** (a repo setting, so it has to be done by hand — the Pages API
is not reachable from automation here):

> **Settings → Pages → Build and deployment**
> Source: **Deploy from a branch**
> Branch: **`claude/local-events-discovery-vfjgwr`** · folder: **`/ (root)`** → **Save**

The site then publishes at `https://starrysidekick.github.io/Proximi/` within a
minute or two, and republishes automatically on every push — including the
weekly listing refresh, so no further action is ever needed.

A `Validate listings` workflow checks `data/events.json` on every push (schema,
unique ids, sign-up links, and that every venue really is inside the radius), so
a bad automated scrape fails loudly instead of quietly shipping.

## Data format

`data/events.json` is the single source of truth for listings. The `meta` block
records when it was scraped, the centre and radius it covers, and the timezone
its times are published in. One entry:

```jsonc
{
  "id": "sample-001",
  "title": "Rooftop Jazz Sessions",
  "kind": "event",                 // "event" | "activity"
  "categories": ["music", "nightlife"],
  "start": "2026-09-05T19:30:00-04:00",   // ISO 8601 with offset
  "end": "2026-09-07T22:00:00-04:00",     // optional; multi-day runs only
  "durationMin": 180,
  "repeats": true,                 // does it come round again? drives the filter
  "recurrence": "Every Saturday",  // free text shown on the card
  "audience": "all",               // "all" | "kids" (children only) | "adults" (21+)
  "venue": "The Standard Loft",
  "city": "Long Island City, NY",
  "address": "44-02 21st St, Long Island City, NY",
  "lat": 40.7447,
  "lon": -73.9485,
  "price": { "min": 18, "max": 25, "note": "Sliding scale at the door" },
  "signupRequired": true,
  "signupUrl": "https://example.com/tickets/sample-001",
  "url": "https://example.com/listings/sample-001",
  "description": "Weekly trio set with a rotating horn player.",
  "source": "sample"
}
```

Notes:

- **Dates.** `start` is ISO 8601 with an explicit offset; add `end` for multi-day
  runs, which render as a date range. Times are displayed in the dataset's
  `meta.timezone`, not the viewer's, so a Beacon show at 7pm reads as 7pm from
  anywhere. Listings whose date has passed are dropped at load.
- **Price.** `min` and `max` are numbers; `max: 0` means free. `note` is free
  text for the caveats that matter ("$10 parking", "free before 7pm"). Use
  **`"price": null`** when the source publishes no price — the card then reads
  "See listing". Null is never treated as free, and never guessed at.
- **Repeating.** `repeats` is the machine-readable flag the filter uses;
  `recurrence` is the human sentence on the card. A weekly market and a monthly
  repair clinic are both `repeats: true`. Validation rejects a listing that
  states a recurrence but claims not to repeat.
- **Audience.** `kids` means children *only* — a drop-off programme or an
  age-capped class — not a family day where children are welcome alongside
  everyone else. Family listings stay `all`, and the inference has an explicit
  family override so "family festival, ages 3-12" is not mistaken for
  children-only and hidden from the people it is for.
- **Categories** are open-ended. Unknown values are title-cased and get a filter
  chip automatically, so a scraper can introduce new ones without a code change.
- Anything with `signupRequired: true` should have a `signupUrl`.

Current category vocabulary: `music`, `show`, `art`, `market`, `sale`, `parade`,
`tour`, `protest`, `food`, `sports`, `class`, `outdoors`, `family`, `film`,
`comedy`, `community`, `nightlife`.

## Layout

```
index.html              markup and the filter sheet
assets/styles.css       styling, light + dark themes
assets/app.js           loading, filtering, sorting, geolocation, rendering
data/events.json        the listings the site serves

sources/registry.json   curated list of feeds, pages and APIs to check
sources/geocache.json   remembered geocoding results, hits and misses alike

scripts/icsparse.py     minimal iCalendar reader
scripts/harvest.py      pull feeds listed in the registry
scripts/platforms.py    Ticketmaster Discovery (needs TICKETMASTER_API_KEY)
scripts/discover.py     find new venues (OSM) and probe them for feeds
scripts/enrich.py       geocode, radius-filter, infer categories
scripts/merge.py        collapse repeats, dedupe, fold into data/events.json
scripts/validate.py     schema and radius gate, also run in CI
```

## How listings get updated

No backend and no scraper daemon. A **weekly scheduled task** wakes Claude, which
runs a scripted pipeline and commits `data/events.json` back to this branch.
GitHub Pages serves that file directly, so the push *is* the deploy.

The pipeline is deliberately split between what a script can do reliably and
what needs judgement:

```
sources/registry.json     the curated list of places to look
        │
        ├─ harvest.py     pull iCal feeds          → build/candidates.json
        ├─ platforms.py   Ticketmaster (API key)   → build/platform.json
        ├─ enrich.py      geocode, radius-filter, categorise
        ├─ merge.py       collapse repeats, dedupe → data/events.json
        └─ validate.py    gate before anything ships
```

Everything above is deterministic — no model is involved, so nothing in it can
invent an event. Claude's job is the rest: reading the sources that have no
feed, finding real prices, and spot-checking what the scripts inferred.

### The registry is the point

Searching the web each week only ever finds what aggregators already collected,
so the long tail is excluded by construction. `sources/registry.json` replaces
that with a list of specific places to check, each tagged `ics` (machine-readable
feed), `html` (Claude reads the page) or `api` (needs a key). Search's job moves
from *harvesting* to *discovering new sources*, which happens monthly.

### Finding new sources

```bash
python3 scripts/discover.py --overpass   # every venue with a website in the radius, from OSM
python3 scripts/discover.py --probe      # test each domain for a live iCal feed
```

A lot of venues run WordPress with The Events Calendar, which always answers
`?ical=1`. **Roughly 7% of venue domains expose a usable feed** — that is how
Storm King (111 listings), Savage Wonder, Scenic Hudson and Millbrook Vineyards
were found. The winery is the case that motivated all this: tasting dinners
never reach a county calendar, but its feed publishes them.

### A feed existing is not a feed working

Both Towne Crier and The Beacon serve well-formed iCal that is frozen months in
the past, while their HTML calendars stay current. Ingesting either would have
put confident, obsolete listings on the site. So:

- Every feed is re-checked each run, and one with **no future events is reported
  as stale, not treated as empty**.
- Confirmed-dead feeds stay in the registry with `enabled: false` and a note, so
  they are not rediscovered and re-trusted later.
- Hosts that answer a bot challenge (HTTP 202 with an HTML interstitial — Opus 40
  and Maverick Concerts both do) are reported as `blocked`, never silently
  counted as zero.

### Price is the known gap

No iCal feed carries a price, and small venue sites do not publish
`schema.org/Event` data either — only ticketing platforms do. So most listings
show "See listing" until Claude opens the event's own page and reads the price
out of prose. **`price: null` means unpublished and is never rendered as free**;
`validate.py` fails the build if a bare number appears where the schema expects
null or an object.

### Accuracy caveats

Listings are only as good as the calendars they come from, and those go stale.
The page states when it last refreshed and tells people to check before turning
up. Categories are inferred by keyword matching and are sometimes thin or wrong.

## Status

**Working:** the browsing experience (location, filters, sorting, cards,
responsive layout) and the weekly refresh described above.

**Limits worth knowing:**

- **Most venues have no feed.** The 7% hit rate means the other 93% — the
  restaurant with a one-off wine dinner — still need either an `html` registry
  entry or a human to mention them. Letting people submit an event would close
  more of that gap than any amount of scraping.
- **Instagram and Facebook are where a lot of this actually gets announced**,
  and both are hostile to scraping. Deliberately not attempted.
- **Coverage is one region.** A single static JSON file suits a metro area; more
  regions means partitioning by area or a real backend.
- **The radius filter is client-side.** Every listing ships to every visitor.
  Fine in the hundreds, not in the tens of thousands.
- **Geocoding is approximate** — venues resolve to a street address where one is
  given, otherwise to their town.
- **Weekly is coarse** for anything that sells out or gets cancelled.

Also worth adding: a map view, saved locations, calendar export, and
"free tonight nearby" as a one-tap default.
