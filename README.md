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
- **What** — free-text search, events vs. activities, and category chips that
  show live match counts.
- **Cost** — max price, free-only, and needs-sign-up-only.
- **Sort** — soonest (default), nearest, or cheapest. Day dividers appear only
  under soonest, where they mean something.

Cards carry what you need to decide: price with its caveats ("$15 online, $20 at
the gate"), venue, town, distance, duration, category tags, and a **Sign up**
button wherever registration is required. Multi-day runs read as a range, and
something already under way reads "on now, through Sep 6".

Light and dark themes, and it works down to phone widths — where the filter
sheet becomes a bottom sheet.

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
  "recurrence": "Every Saturday",  // activities only; free text shown on the card
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
- **Categories** are open-ended. Unknown values are title-cased and get a filter
  chip automatically, so a scraper can introduce new ones without a code change.
- Anything with `signupRequired: true` should have a `signupUrl`.

Current category vocabulary: `music`, `show`, `art`, `market`, `sale`, `parade`,
`tour`, `protest`, `food`, `sports`, `class`, `outdoors`, `family`, `film`,
`comedy`, `community`, `nightlife`.

## Layout

```
index.html         markup and controls
assets/styles.css  styling, light + dark themes
assets/app.js      loading, filtering, sorting, geolocation, rendering
data/events.json   listings (currently sample data)
```

## How listings get updated

There is no scraper process and no backend. Instead, a **weekly scheduled task**
wakes Claude, which crawls regional event calendars, normalizes what it finds
into the schema above, verifies each item is genuinely inside the radius, and
commits `data/events.json` back to this branch. GitHub Pages serves the file
directly, so the push *is* the deploy.

- **Schedule:** Mondays, 07:23 America/New_York.
- **Coverage:** 50 miles around Beacon, NY.
- **Sources:** regional calendars (A Little Beacon Blog, The Beacon, Destination
  Dutchess, Hudson Valley One, Times Hudson Valley, Hudson Valley Magazine) plus
  organiser sites directly when a price or ticket link needs confirming.

The task's instructions live in the Routine itself, not in this repo. The rules
that matter: never invent a listing, a price or a URL; use `price: null` rather
than guessing; confirm every venue is really within 50 miles (the Beacon Theatre
in Manhattan is a recurring trap); and validate the JSON and render the page
before pushing.

### Accuracy caveats

Listings are only as good as the calendars they came from, and those go stale.
The page states when it last refreshed and tells people to check the listing
before turning up. Roughly two thirds of current entries have no published
price — aggregator calendars usually omit it — so they show "See listing"
rather than a number someone made up.

## Status

**Working:** the browsing experience (location, filters, sorting, cards,
responsive layout) and the weekly refresh described above.

**Limits worth knowing:**

- **Coverage is one region.** A single static JSON file suits a metro area. More
  regions means partitioning the data by area, or a real backend.
- **The radius filter is client-side.** Everything in the file ships to every
  visitor, and the browser filters it. Fine at tens or hundreds of items; not at
  tens of thousands.
- **Weekly is coarse** for things that sell out or get cancelled. A daily run,
  or an on-demand refresh, would help.
- **Deduplication is by hand.** The same event listed by a venue, a promoter and
  two aggregators is currently caught by Claude noticing, not by any matching
  logic.
- **Geocoding is approximate** — venues get their town's coordinates unless a
  precise one was obvious.

Also worth adding: a map view, saved locations, calendar export, and
"free tonight nearby" as a one-tap default.
