#!/usr/bin/env python3
"""Platform sources that need an API key or bespoke handling.

Ticketmaster Discovery — free key, 2 req/sec and 5000 req/day, native radius
search, and (uniquely among our sources) it returns real price ranges. Set
TICKETMASTER_API_KEY to enable; without it this reports "no key" and exits
cleanly rather than failing the run.

Meetup is deliberately NOT here. Its GraphQL API only issues OAuth consumers to
accounts with a paid Meetup Pro subscription, so there is no free API path.
Public group and event pages do embed parseable JSON, so Meetup belongs in the
registry as an html source for the weekly job to read.

  python3 scripts/platforms.py [--days 45] [--out build/platform.json]
"""

import argparse, json, os, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

UA = 'Mozilla/5.0 (compatible; ProximiBot/0.1; +https://github.com/StarrySidekick/Proximi)'
TM = 'https://app.ticketmaster.com/discovery/v2/events.json'

# Ticketmaster's segment/genre vocabulary onto ours.
SEGMENT = {'Music': 'music', 'Sports': 'sports', 'Arts & Theatre': 'show',
           'Film': 'film', 'Miscellaneous': 'community'}
GENRE = {'Comedy': 'comedy', 'Theatre': 'show', 'Dance': 'show', 'Family': 'family',
         'Food & Drink': 'food', 'Fairs & Festivals': 'market', 'Art': 'art'}


def get(url, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8', 'replace'))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < tries - 1:      # documented 2 req/s cap
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, OSError):
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise


def categories(ev):
    out = []
    for c in ev.get('classifications') or []:
        for key, table in (('segment', SEGMENT), ('genre', GENRE), ('subGenre', GENRE)):
            name = (c.get(key) or {}).get('name')
            if name and name in table and table[name] not in out:
                out.append(table[name])
    return out or ['community']


def price(ev):
    """Ticketmaster omits priceRanges more often than you would expect.

    Absent means unknown, which our schema represents as null — never as free.
    """
    ranges = ev.get('priceRanges') or []
    if not ranges:
        return None
    lo = min(r['min'] for r in ranges if r.get('min') is not None)
    hi = max(r['max'] for r in ranges if r.get('max') is not None)
    # Ticketmaster fills 0.00-0.00 in when a promoter has not published a price:
    # a third of the priced events on a page come back that way, including club
    # shows that certainly charge at the door. Passing it through would render
    # "Free" — the one error the schema exists to prevent — so it reads as
    # unknown. A genuinely free listing loses its badge; that is the safe side.
    if lo == 0 and hi == 0:
        return None
    return {'min': round(lo, 2), 'max': round(hi, 2), 'note': 'Ticketmaster face value'}


# One circle drawn from Beacon at the registry radius reaches Manhattan, and
# Manhattan has more events than the rest of the circle combined: a plain
# date-sorted sweep came back 756-of-1000 Midtown and buried everything local.
# Sweeping tight circles around the towns instead guarantees each of them a
# share, and the wide pull still runs last for the big-ticket rooms.
ANCHORS = [
    ('Beacon',        41.5048, -73.9696, 20),
    ('Poughkeepsie',  41.7004, -73.9210, 20),
    ('Newburgh',      41.5034, -74.0104, 15),
    ('Kingston',      41.9270, -73.9974, 20),
    ('Danbury',       41.3948, -73.4540, 20),
    ('White Plains',  41.0340, -73.7629, 20),
    ('Peekskill',     41.2901, -73.9204, 15),
    ('Bethel',        41.6712, -74.8735, 20),
]


# A circle of this size drawn from Beacon cannot leave these states. Ticketmaster
# hands some venues the wrong coordinates — Chicago's Empty Bottle is filed at
# 41.90,-74.01, which is Kingston — so 77 Illinois shows arrived inside the
# radius and would have been listed as local. The stated address is right where
# the geometry is wrong, so the address is what gets trusted.
REACHABLE_STATES = {'NY', 'NJ', 'CT', 'PA', 'MA', 'VT', 'RI', 'NH'}


def in_region(venue):
    code = ((venue.get('state') or {}).get('stateCode') or '').upper()
    return not code or code in REACHABLE_STATES


def sweep(lat, lon, radius, days, key, seen, pages=3):
    """Date-ascending pull around one point. Returns new events only."""
    start = datetime.now(timezone.utc)
    end = start + timedelta(days=days)
    events, page = [], 0

    while page < pages:
        q = urllib.parse.urlencode({
            'apikey': key,
            'latlong': f'{lat},{lon}',
            'radius': int(radius),
            'unit': 'miles',
            'startDateTime': start.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'endDateTime': end.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'size': 200, 'page': page, 'sort': 'date,asc',
        })
        data = get(f'{TM}?{q}')
        batch = (data.get('_embedded') or {}).get('events') or []
        if not batch:
            break

        for ev in batch:
            if ev.get('id') in seen:
                continue
            seen.add(ev.get('id'))
            dates = (ev.get('dates') or {}).get('start') or {}
            # dateTime is the UTC instant; localDate alone means the time is
            # still TBA. The schema wants a real offset and inventing one would
            # put a made-up showtime on the card, so those wait until the
            # promoter announces — they come back with a time when they do.
            when = dates.get('dateTime')
            if not when:
                continue
            venue = ((ev.get('_embedded') or {}).get('venues') or [{}])[0]
            if not in_region(venue):
                continue
            loc = venue.get('location') or {}
            events.append({
                'sourceId': 'ticketmaster',
                'sourceName': 'Ticketmaster',
                'title': ev.get('name'),
                'start': when,
                'end': None,
                'url': ev.get('url'),
                'venue': venue.get('name'),
                'city': ', '.join(filter(None, [
                    (venue.get('city') or {}).get('name'),
                    (venue.get('state') or {}).get('stateCode')])) or None,
                'address': ((venue.get('address') or {}).get('line1')),
                'lat': float(loc['latitude']) if loc.get('latitude') else None,
                'lon': float(loc['longitude']) if loc.get('longitude') else None,
                'price': price(ev),
                'categories': categories(ev),
                'description': ev.get('info') or ev.get('pleaseNote'),
                'signupRequired': True,
                'signupUrl': ev.get('url'),
            })

        pageinfo = data.get('page') or {}
        if page + 1 >= pageinfo.get('totalPages', 1):
            break
        page += 1
        time.sleep(0.6)                                    # stay under 2 req/sec

    return events


def ticketmaster(center, days, key):
    seen, events = set(), []
    for name, lat, lon, radius in ANCHORS:
        got = sweep(lat, lon, radius, days, key, seen)
        events.extend(got)
        print(f'  {name:<14} {len(got):>4}')
        time.sleep(0.6)
    wide = sweep(center['lat'], center['lon'], center['radiusMiles'], days, key, seen, pages=5)
    events.extend(wide)
    print(f'  {"wide circle":<14} {len(wide):>4}')
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--days', type=int, default=45)
    ap.add_argument('--out', default='build/platform.json')
    args = ap.parse_args()

    center = json.load(open(args.registry))['center']
    key = os.environ.get('TICKETMASTER_API_KEY', '').strip()

    if not key:
        print('ticketmaster  — skipped: TICKETMASTER_API_KEY not set.')
        print('  Get a free key at https://developer.ticketmaster.com/ and export it')
        print('  before the weekly run. Everything else works without it.')
        return 0

    try:
        events = ticketmaster(center, args.days, key)
    except urllib.error.HTTPError as e:
        print(f'ticketmaster  — failed: HTTP {e.code} {e.reason}', file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'fetchedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
               'events': events}, open(args.out, 'w'), indent=2, ensure_ascii=False)

    priced = sum(1 for e in events if e['price'])
    print(f'ticketmaster  {len(events):>4}  ok  ({priced} with a price) → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
