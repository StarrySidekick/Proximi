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

- **Location** — use the browser's geolocation, type any town/address (geocoded
  via OpenStreetMap's Nominatim), or tap a preset. Distances are computed
  client-side with the haversine formula.
- **Filters** — free-text search, type, category, "when" (today / tomorrow /
  this weekend / next 7 / next 30 days), search radius, max price, free-only,
  and needs-sign-up-only.
- **Sorting** — soonest, nearest, or cheapest.
- **Cards** carry the things you need to decide: price (with notes like
  "sliding scale at the door"), venue, town, distance, duration, description,
  category tags, and a **Sign up** button for anything requiring registration.
- Miles/kilometres toggle, light and dark themes, works down to phone widths.
- Says when the data was last refreshed, and drops listings once they have been
  and gone.

## Run it locally

The app fetches `data/events.json`, so it needs a web server — opening
`index.html` from the filesystem will fail on browser `file://` restrictions.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy to GitHub Pages

The site is plain static files at the repo root with a `.nojekyll` marker, so it
needs no build step. In **Settings → Pages**, set *Source* to **Deploy from a
branch** and pick the branch and `/ (root)`.

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
