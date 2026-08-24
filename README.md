# Proximi

Find events and activities happening near wherever you are.

**Proximi** answers "what is there to do around here?" — a single scannable list
of things happening nearby, filterable by what kind of thing it is, how far away
it is, and what it costs.

This repo currently holds a **working front-end prototype** running on sample
data. There is no scraper yet — see [Status](#status).

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

`data/events.json` is the single source of truth for listings. One entry:

```jsonc
{
  "id": "sample-001",
  "title": "Rooftop Jazz Sessions",
  "kind": "event",                 // "event" | "activity"
  "categories": ["music", "nightlife"],
  "daysFromNow": 0,                // prototype only — see note below
  "time": "19:30",                 // local, 24h
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

- **Dates.** The sample data uses `daysFromNow` + `time` so the prototype always
  shows upcoming listings instead of going stale. Real scraped data should carry
  an ISO 8601 `start` (and optional `end`) instead — the client already prefers
  `start` when present.
- **Price.** `min` and `max` are numbers; `max: 0` means free. `note` is free
  text for the caveats that matter ("$10 parking", "free before 7pm").
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

## Status

**Working:** the whole browsing experience — location, filters, sorting, cards,
responsive layout.

**Not built yet: the scraper.** This is the real work, and it needs a decision
first. GitHub Pages serves static files only, so ingestion has to happen
*outside* the page and commit its output back to `data/events.json`. The natural
shape is a scheduled GitHub Action that runs a scraper on a cron, normalizes
results into the schema above, geocodes addresses, dedupes, and commits — the
site then picks up new data with no deploy.

Open questions before that:

- **Sources.** Public APIs with sane terms (Eventbrite, Ticketmaster, Meetup,
  municipal calendars, library and parks-department feeds) are very different
  work from HTML scraping, which has per-site terms-of-service and robots.txt
  constraints to respect. Worth starting with feeds that permit it.
- **Coverage.** A static JSON file scales to a metro area, not the world. Going
  national means partitioning data by region, or moving to a real backend.
- **Dedupe.** The same event is listed by the venue, the promoter and three
  aggregators; matching on title + time + location is the hard part.
- **Geocoding.** Nominatim's usage policy rules out bulk use, so batch geocoding
  belongs in the ingest step with a permitted provider, not in the browser.

Also worth adding: a map view, saved locations, calendar export, and
"free tonight nearby" as a one-tap default.
