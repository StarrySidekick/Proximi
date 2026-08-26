# Proximi

Find events and activities happening near wherever you are.

**Proximi** answers "what is there to do around here?" — a single scannable list
of things happening nearby, filterable by what kind of thing it is, how far away
it is, and what it costs.

This repo holds a **working front-end prototype** served from GitHub Pages,
with real listings refreshed weekly by a scheduled Claude task — see
[How listings get updated](#how-listings-get-updated).

---

## One list, many kinds of thing

There is no event-versus-activity split. Everything is a listing with a
**type** (Concert, Market, Tour, Open Mic, Film, Festival…) and a **repeats**
flag, which turned out to be the distinction that actually mattered: a weekly
farmers market and a one-off parade are both things happening at a time, and
what a reader wants to know is *what kind of thing it is* and *whether it comes
round again*. Both are filterable.

## What the prototype does

The page is just the list. Everything else lives behind a **Filters** sheet, so
the default view is scannable rather than a wall of controls.

**Out of the box** it shows what's on in the **next week**, **within 75 miles**,
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
- **Repeating** — all, one-off, daily, weekly or monthly. Knowing a thing comes
  round again is less useful than knowing how often, which is what decides
  whether you can catch it.
- **Who it's for** — family & kids and senior-focused listings are **hidden by
  default**; 21+ ones are shown. All three are toggles.
- **Kind of thing** — type chips (Concert, Market, Tour, Film…) with live
  match counts. Each cycles through three states: click once to show only that
  kind, again to hide it everywhere, a third time to clear it. Excluding is
  what you want when one busy category is drowning the rest.

  A listing is **several kinds at once** — a paint-and-sip is a class, and
  creative, and food & drink — so it answers to every one of its chips. `type`
  is the primary kind, shown as the solid badge and used for sorting; `types`
  holds the full set, and the filters read all of it. Excluding beats
  including: hiding Games hides a listing that is also a Class, or the word
  "hide" does not mean anything.
- **Your picks** — a count of what you've hidden or said yes to, with a way to
  show or restore hidden listings.
- **Features** — food or drink, outdoors, and time of day (daytime / nighttime,
  split at 5pm).
- **Places** — every venue with a count and a search, grouped by what sort of
  place it is: libraries, museums, music venues, breweries, parks and so on.
  Tap one to see only its listings; mute one to drop it from the feed for good.
  A venue's sort comes from its name where the name says something, and from
  its own programme where it does not — "Daryl's House" is a music room only
  because of what it books.
- **What** — free-text search.
- **Cost** — max price, free-only, and needs-sign-up-only.
- **Sort** — soonest (default), nearest, or cheapest. Day dividers appear only
  under soonest, where they mean something.

Cards carry what you need to decide: price with its caveats ("$15 online, $20 at
the gate"), the **name of the place** rather than its street — feeds put the
address in the venue field constantly, and "1 Museum Rd" tells a reader nothing
that "Storm King Art Center" does — plus town, distance, duration, category
tags, and a **Sign up**
button wherever registration is required. Multi-day runs read as a range, and
something already under way reads "on now, through Sep 6".

Cards badge what kind of thing they are — **Concert**, **Market**, **Tour** —
plus **Repeats**, **Children only**, **Family**, **Seniors** or **21+** where
those apply, and name the host who runs it.

### Saying yes or no

Swipe a card **left** to hide it ("not for me") or **right** to add it to your
calendar. Both actions are also buttons on every card, because a swipe is
undiscoverable and unusable from a keyboard.

The gesture only takes over once it is clearly horizontal, so a vertical drag
still scrolls the page. Every verdict raises an undo toast, and the hidden
count with a **Restore all** sits in the Filters sheet — a mis-swipe is never a
one-way door.

Saying yes builds an iCalendar file in the page and hands it over; there is no
backend to invite you from, and every calendar app reads `.ics`. A listing's
`start` and `end` describe when it is *available*, which for a daily
self-guided trail can be years wide, so anything spanning more than a day
becomes a two-hour visit with the real run in the notes, and a run already
under way is booked for today at its usual hour.

Verdicts live in `localStorage`, so they are per-browser and private to you.
Every read and write is guarded — a browser with site data blocked loses the
memory, not the feed.

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
  "categories": ["music", "nightlife"],
  "start": "2026-09-05T19:30:00-04:00",   // ISO 8601 with offset
  "end": "2026-09-07T22:00:00-04:00",     // optional; multi-day runs only
  "durationMin": 180,
  "type": "concert",               // the one primary answer to "what is this?"
  "repeats": true,                 // does it come round again? drives the filter
  "recurrence": "Every Saturday",  // free text shown on the card
  "audience": "all",               // "all" | "kids" (children only) | "adults" (21+)
  "setting": "indoor",             // "indoor" | "outdoor" | "unknown"
  "timeOfDay": "evening",          // morning | afternoon | evening | night
  "hasFood": true,                 // is food or drink part of it?
  "host": "The Standard Loft",     // who is putting it on
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
- **Every listing answers the same questions.** That is the point of the
  schema: when a field is missing you know it needs scraping, rather than
  discovering later that half the listings never had it. The standard set is
  **when** (`start`, `end`, `timeOfDay`), **how much** (`price`), **where**
  (`venue`, `city`, `lat`/`lon`, `setting`), **who runs it** (`host`), **who
  it's for** (`audience`), **does it come round again** (`repeats`), and
  **what kind of thing it is** (`type`).
- **Type** is the single primary label — Concert, Open Mic, Market, Tour,
  Film, Art Exhibit, Festival, Celebration and so on — and it is what the card
  badges. It is inferred from the **title first**, falling back to the
  description: a county fair whose blurb mentions "grandstand concerts" is a
  Festival, because what a thing *is* lives in its name. `categories` remain as
  looser secondary tags.
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
sources/manual.json     listings read by hand from feedless sources

scripts/icsparse.py     minimal iCalendar reader
scripts/harvest.py      pull feeds listed in the registry
scripts/jsonld.py       extract schema.org Event data from html sources
scripts/platforms.py    Ticketmaster Discovery (needs TICKETMASTER_API_KEY)
scripts/social.py       Eventbrite and Meetup, read through their embedded JSON
scripts/libcal.py       library programming via LibCal's per-day ajax endpoint
scripts/songkick.py     ticketed concerts via Songkick metro pages (JSON-LD)
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
sources/manual.json       listings read by hand, versioned so they survive reruns
        │
        ├─ harvest.py     pull iCal feeds          → build/candidates.json
        ├─ jsonld.py      scrape schema.org Events → build/jsonld.json
        ├─ platforms.py   Ticketmaster (API key)   → build/platform.json
        ├─ social.py      Eventbrite + Meetup       → build/social.json
        ├─ libcal.py      library calendars         → build/libcal.json
        ├─ songkick.py    ticketed concerts         → build/songkick.json
        ├─ cinema.py      independent film houses  → build/cinema.json
        ├─ enrich.py      geocode, radius-filter, classify
        ├─ merge.py       collapse repeats, dedupe → data/events.json
        └─ validate.py    gate before anything ships
```

Sources fall into four tiers, and each needs a different amount of human
attention:

| Tier | How it is read | Effort |
| --- | --- | --- |
| `ics` | `harvest.py` parses the feed | none |
| `jsonld` / `html` with structured data | `jsonld.py` extracts schema.org Events | none |
| `social` | `social.py` reads the JSON Eventbrite and Meetup hand their own front end — no key, and it carries a **price** | none |
| `html`, prose only | Claude reads the page and writes into `sources/manual.json` | manual, weekly |

`social` is where most of the volume now comes from. Eventbrite alone supplies
roughly four listings in five, which is worth knowing when reading the feed:
the long tail of paid recurring classes is real, but it is not the same thing
as a curated local calendar. The `ics` and hand-read sources still carry the
village-hall and small-venue listings no aggregator has.

Everything above is deterministic — no model is involved, so nothing in it can
invent an event. Claude's job is the rest: reading the sources that have no
feed, finding real prices, and spot-checking what the scripts inferred.

### Coverage gaps look like radius gaps

Connecticut was completely absent from the listings, which reads as "the radius
is too small". It was not: **Danbury is 27.8 miles from Beacon** and nine CT
towns were already well inside the old 50-mile circle. The registry simply had
no Connecticut sources. Before widening the circle, check whether anything is
actually looking at the places already inside it.

The radius is now 75 miles, which additionally reaches New York City, New
Haven, Hartford, Hudson and Great Barrington.

### Cinemas are the hardest tier, and three of them had lost their domains

A pass over every independent cinema within fifty miles of Beacon — Manhattan
excluded — turned up two things worth writing down.

The first is that **the cinema tier is almost entirely unreadable by script**.
Of roughly two dozen theatres, five serve their schedule as HTML: Jacob Burns
(an ISO `data-showtime` on every screening), Rosendale (a Filmbot month grid
whose day cells carry the whole show card in an escaped attribute), and the
three houses one small operator runs at Red Hook, Hyde Park and New Paltz off
one plain page each. `scripts/cinema.py` reads those five. Everything else runs
a ticketing SPA — Indy Systems, Filmbot's hosted app, or Agile Ticketing behind
an Imperva bot wall — and serves a shell with no listings in it. Those are
hand-read into `sources/manual.json` or disabled with the reason recorded.

The second is that **three theatre domains had lapsed and been re-registered by
gambling operators**: `downingfilmcenter.com`, `storyscreenbeacon.com` and
`bethelcinema.com` now serve Indonesian and Turkish betting sites. All three
answer HTTP 200, so a liveness check reads them as healthy. Story Screen is
alive at a different domain; the other two are absent from the registry with a
note. A fourth, `rivertownfilm.org`, is genuinely the film society's site but
its WordPress has been SEO-spammed with online-casino copy sitting in the page
body beside the film blurbs, so nothing is read off it either. Small venues lose
domains often — for this tier, check what a URL *serves*, not just that it
answers.

The multiplex schedules are collapsed to one card per film per day rather than
one per showtime, with the day's times in the card. Four rows of the same film
four hours apart is the same answer to "what can I see tonight" printed four
times; `merge.py` then folds the daily repeats into *Every day, through Sep 2*.

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

`--probe` tries iCal paths first, then fingerprints the page for an embedded
calendar platform and derives a feed where the address is predictable:

| Fingerprint | What it yields |
| --- | --- |
| The Events Calendar (`?ical=1`) | iCal directly — the highest-yield case |
| Squarespace (`?format=ical`) | iCal from an event collection |
| Google Calendar embed | the calendar's public `basic.ics` |
| Springshare LibCal | a library's iCal export |
| Localist / Tockify / Trumba | a known feed or API endpoint |
| Eventbrite / Bandsintown / DICE | an organiser or venue page worth registering |
| `schema.org/Event` JSON-LD | no feed, but structured data on the page |

**Roughly 7% of venue domains expose a usable feed** — that is how
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

### Reading pages by hand

Some sources have no feed and no structured data, and a few cannot be read from
a script at all:

- **Ridgefield Playhouse** renders entirely in JavaScript — fetching it returns
  zero characters of text. A headless browser would be needed.
- **HamletHub Danbury** is disabled: its own backend answers
  `getaddrinfo ENOTFOUND …execute-api.amazonaws.com`, so the page renders no
  listings. That is their outage, not ours.
- **Bethel Woods** publishes its listing index without times or prices; both
  live on each event's own detail page, so getting them right means one fetch
  per event.

Anything read by hand goes into `sources/manual.json` rather than straight into
`data/events.json`, so it is not lost the next time the pipeline regenerates.

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
