#!/usr/bin/env python3
"""Star ratings for places to eat, combined from more than one service.

No free source has them: OpenStreetMap carries none, and reading Google's or
Yelp's pages is against their terms. The services' own APIs do, for a key and
a per-request price, so this runs at build time, in the weekly refresh, with
the keys in the environment; a key in the page would be a key anyone can
spend. With no key it does nothing and says so, and that is a failure to
report, not a pass: the cards simply have no stars.

  GOOGLE_PLACES_API_KEY   Google Places API (New), Text Search
  YELP_API_KEY            Yelp Fusion, Business Search

Each place is looked up by name near its coordinates, and a result is
believed only if it is within 150 metres and shares a distinctive word of
the name: a search for "Otto" near a pizzeria must not come back with the
Otto three doors down that sells shoes.

The services are combined by review count, not averaged: 4.6 from 900
Google reviews and 4.0 from 100 Yelp reviews is 4.54, because each review
counts once. It owns sources/placeratings.json and stamps the result onto
data/eats.json (and data/places.json with --all) as
    "rating": {"stars": 4.5, "count": 1000, "from": ["Google", "Yelp"]}

  python3 scripts/ratings.py --limit 500      # the next 500 not yet asked
  python3 scripts/ratings.py --report         # counts, no network
  python3 scripts/ratings.py --selftest       # matching and combining
"""

import argparse, json, math, os, re, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import date, datetime, timezone

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

PATH = 'sources/placeratings.json'
RECHECK_DAYS = 90          # ratings drift slowly; a season is fresh enough
NEAR_M = 150
GENERIC = {'restaurant', 'cafe', 'the', 'and', 'grill', 'bar', 'kitchen', 'pizza', 'pizzeria',
           'house', 'diner', 'coffee', 'bakery', 'company', 'shop', 'food', 'foods', 'tavern', 'pub',
           'village', 'family', 'main', 'street', 'corner'}


def tokens(s):
    return {w for w in re.findall(r'[a-z0-9]+', (s or '').lower()) if len(w) >= 3 and w not in GENERIC}


def metres(a_lat, a_lon, b_lat, b_lon):
    r = math.pi / 180
    h = (math.sin((b_lat - a_lat) * r / 2) ** 2
         + math.cos(a_lat * r) * math.cos(b_lat * r) * math.sin((b_lon - a_lon) * r / 2) ** 2)
    return 12_742_000 * math.asin(math.sqrt(h))


def same_place(place, name, lat, lon):
    if lat is None or lon is None or metres(place['lat'], place['lon'], lat, lon) > NEAR_M:
        return False
    mine, theirs = tokens(place['name']), tokens(name)
    # A name made only of generic words ("Village Pizza") must match whole.
    if not mine:
        return place['name'].strip().lower() == (name or '').strip().lower()
    return bool(mine & theirs)


def combine(found):
    """{source: (stars, count)} → the rating a card shows, or None."""
    rows = [(s, r, n) for s, (r, n) in found.items() if r and n]
    total = sum(n for _, _, n in rows)
    if not total:
        return None
    stars = sum(r * n for _, r, n in rows) / total
    return {'stars': round(stars, 2), 'count': total, 'from': sorted(s for s, _, _ in rows)}


# ── The services ─────────────────────────────────────────

def http_json(url, headers, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if data else 'GET')
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def google(place, key):
    body = {'textQuery': place['name'], 'maxResultCount': 3,
            'locationBias': {'circle': {'center': {'latitude': place['lat'], 'longitude': place['lon']},
                                        'radius': 300.0}}}
    data = http_json('https://places.googleapis.com/v1/places:searchText', {
        'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
        # Asking only for these fields is what keeps the request in its tier.
        'X-Goog-FieldMask': 'places.displayName,places.location,places.rating,places.userRatingCount'}, body)
    for p in data.get('places', []):
        loc = p.get('location', {})
        if same_place(place, p.get('displayName', {}).get('text'), loc.get('latitude'), loc.get('longitude')):
            return p.get('rating'), p.get('userRatingCount')
    return None


def yelp(place, key):
    q = urllib.parse.urlencode({'term': place['name'], 'latitude': place['lat'],
                                'longitude': place['lon'], 'radius': 300, 'limit': 3})
    data = http_json(f'https://api.yelp.com/v3/businesses/search?{q}', {'Authorization': f'Bearer {key}'})
    for b in data.get('businesses', []):
        c = b.get('coordinates', {})
        if same_place(place, b.get('name'), c.get('latitude'), c.get('longitude')):
            return b.get('rating'), b.get('review_count')
    return None


SERVICES = [('Google', 'GOOGLE_PLACES_API_KEY', google), ('Yelp', 'YELP_API_KEY', yelp)]


# ── The cache and the stamp ──────────────────────────────

def load(path=PATH):
    return json.load(open(path)) if os.path.exists(path) else {'places': {}}


def save(doc, path=PATH):
    doc['schemaVersion'] = 1
    doc['note'] = ('Star ratings per place, per service, so a place is asked about once a season. '
                   'Written by scripts/ratings.py, which also stamps the combined rating onto rows.')
    doc['updated'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    json.dump(doc, open(path, 'w'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    open(path, 'a').write('\n')


def stamp(rows_path, doc):
    data = json.load(open(rows_path))
    n = 0
    for p in data['items']:
        rec = doc['places'].get(p['id'], {})
        got = combine({s: tuple(v['r']) for s, v in rec.items() if v.get('r')})
        if got:
            p['rating'] = got
            n += 1
        else:
            p.pop('rating', None)
    json.dump(data, open(rows_path, 'w'), indent=2, ensure_ascii=False)
    return n


def selftest():
    shop = {'name': 'Otto', 'lat': 42.36, 'lon': -71.06}
    assert same_place(shop, 'Otto Pizza', 42.3601, -71.0601)
    assert not same_place(shop, 'Otto', 42.37, -71.06)                 # a kilometre off
    assert not same_place({'name': 'Village Pizza', 'lat': 42.0, 'lon': -72.0}, 'Pizza Village', 42.0, -72.0)
    assert same_place({'name': 'Village Pizza', 'lat': 42.0, 'lon': -72.0}, 'Village Pizza', 42.0, -72.0)
    got = combine({'Google': (4.6, 900), 'Yelp': (4.0, 100)})
    assert got == {'stars': 4.54, 'count': 1000, 'from': ['Google', 'Yelp']}, got
    assert combine({'Google': (None, None)}) is None
    return 6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--eats', default='data/eats.json')
    ap.add_argument('--places', default='data/places.json')
    ap.add_argument('--all', action='store_true', help='rate the directory too, not only places to eat')
    ap.add_argument('--limit', type=int, default=500, help='places this run asks about (0 = all)')
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()
    if args.selftest:
        print(f'{selftest()} rating cases OK')
        return 0

    doc = load()
    paths = [args.eats] + ([args.places] if args.all else [])
    rows = [p for path in paths for p in json.load(open(path))['items'] if not p.get('brand')]
    keys = [(name, os.environ.get(env), fn) for name, env, fn in SERVICES]
    live = [(n, k, f) for n, k, f in keys if k]
    if args.report or not live:
        rated = sum(1 for p in rows if doc['places'].get(p['id']))
        print(f'{len(rows)} places; {rated} asked about so far')
        if not live:
            print('skipped: no rating service key set (' + ', '.join(env for _, env, _ in SERVICES) + ')')
        return 0

    today = date.today()
    def stale(p):
        rec = doc['places'].get(p['id'], {})
        return any(n not in rec or (today - date.fromisoformat(rec[n]['checked'])).days >= RECHECK_DAYS
                   for n, _, _ in live)
    todo = [p for p in rows if stale(p)]
    if args.limit:
        todo = todo[:args.limit]
    print(f'asking {", ".join(n for n, _, _ in live)} about {len(todo)} places')
    for i, p in enumerate(todo, 1):
        rec = doc['places'].setdefault(p['id'], {})
        for name, key, fn in live:
            try:
                got = fn(p, key)
            except urllib.error.HTTPError as e:
                if e.code in (401, 403):
                    print(f'{name}: key refused ({e.code}); stopping')
                    save(doc)
                    return 1
                continue
            except Exception:
                continue
            rec[name] = {'r': list(got) if got else None, 'checked': today.isoformat()}
            time.sleep(0.2)
        if i % 100 == 0:
            save(doc)
            print(f'  {i}/{len(todo)}')
    save(doc)
    for path in paths:
        print(f'{stamp(path, doc)} rows in {path} carry a rating')
    return 0


if __name__ == '__main__':
    sys.exit(main())
