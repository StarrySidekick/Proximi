#!/usr/bin/env python3
"""Turn harvested candidates into listings in the site's schema.

Geocodes venues (cache committed to sources/geocache.json), drops anything outside the radius, and infers
categories and event-vs-activity. Price is deliberately left null: no feed
publishes one, and guessing is worse than saying "See listing". Filling those
in is the weekly job's judgement step, not this script's.

  python3 scripts/enrich.py [--in build/candidates.json] [--out build/enriched.json]
"""

import argparse, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime
from math import radians, sin, cos, asin, sqrt

UA = 'ProximiBot/0.1 (github.com/StarrySidekick/Proximi)'
NOMINATIM = 'https://nominatim.openstreetmap.org/search'
CACHE = 'sources/geocache.json'

# Nominatim's usage policy allows at most 1 request/second. The cache means a
# steady-state run makes almost none.
RATE = 1.1

KEYWORDS = [
    ('protest',   r'\b(rally|protest|march|demonstration|vigil|picket)\b'),
    ('parade',    r'\bparade\b'),
    ('comedy',    r'\b(comedy|stand-?up|improv)\b'),
    ('film',      r'\b(film|movie|screening|cinema|documentar)\w*'),
    ('music',     r'\b(concert|band|jazz|live music|songwriter|acoustic|orchestra|'
                  r'symphony|choir|blues|folk|open mic|dj|recital|quartet|trio)\b'),
    ('show',      r'\b(theat(er|re)|play|musical|performance|drag|cabaret|opera|dance|circus)\b'),
    ('art',       r'\b(art|gallery|exhibition|opening reception|painting|sculpture|'
                  r'artist|ceramic|photograph)\w*'),
    ('market',    r'\b(market|fair|festival|bazaar|vendors?|craft show)\b'),
    ('sale',      r'\b(sale|flea|rummage|tag sale|book sale|swap)\b'),
    ('tour',      r'\b(tour|guided walk|house tour|behind the scenes)\b'),
    ('outdoors',  r'\b(hike|hiking|walk|paddle|kayak|canoe|bird|trail|garden|nature|'
                  r'cleanup|forest|river|outdoor)\w*'),
    ('family',    r'\b(kids?|child(ren)?|family|storytime|story time|toddler|teen|youth)\b'),
    ('class',     r'\b(workshop|class|lesson|course|seminar|clinic|training|demo|'
                  r'lecture|talk|reading)\b'),
    ('food',      r'\b(dinner|tasting|brunch|food|wine|beer|cider|potluck|supper|'
                  r'bbq|barbecue|breakfast|lunch)\b'),
    ('sports',    r'\b(yoga|run|race|5k|10k|fitness|pickleball|hockey|baseball|'
                  r'soccer|tournament|golf)\b'),
    ('community', r'\b(meeting|forum|town hall|volunteer|community|fundraiser|'
                  r'benefit|social|meetup|club)\b'),
    ('nightlife', r'\b(bar|party|nightlife|late night|after ?party)\b'),
]

ACTIVITY_HINTS = re.compile(
    r'\b(every|weekly|monthly|daily|ongoing|drop-?in|series|recurring|'
    r'each (mon|tues|wednes|thurs|fri|satur|sun)day|open hours)\b', re.I)


def miles(lat1, lon1, lat2, lon2):
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    h = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * 3958.8 * asin(sqrt(h))


def load_cache():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def query_variants(loc):
    """Progressively simpler forms of a location string.

    Nominatim's free-text search fails on over-specified input: a venue name
    plus street plus ZIP plus country often returns nothing where the same
    place resolves fine from "Long Dock Park, Beacon, NY". So drop detail a
    layer at a time and take the first hit.
    """
    parts = [p.strip() for p in loc.split(',') if p.strip()]
    parts = [p for p in parts
             if not re.fullmatch(r'(united states|usa|us)', p, re.I)
             and not re.fullmatch(r'\d{5}(-\d{4})?', p)]
    if not parts:
        return []

    seen, out = set(), []
    def add(q):
        q = ', '.join(q).strip(', ')
        if q and q.lower() not in seen:
            seen.add(q.lower())
            out.append(q)

    add(parts)                                   # everything, minus zip/country
    if len(parts) > 2:
        add(parts[1:])                           # drop the venue name
    if len(parts) > 1:
        add([parts[0]] + parts[-2:])             # venue + town + state
        add(parts[-2:])                          # just town + state
    return out


def geocode(loc, cache, stats):
    """Resolve a location string, remembering both hits and misses.

    Caching misses matters: without it every run re-queries the same
    unresolvable strings and burns the rate limit for nothing.
    """
    key = loc.strip().lower()
    if key in cache:
        stats['cached'] += 1
        return cache[key]

    result = None
    for attempt, q in enumerate(query_variants(loc)):
        url = f'{NOMINATIM}?' + urllib.parse.urlencode(
            {'format': 'json', 'limit': 1, 'q': q})
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                hits = json.loads(r.read().decode('utf-8', 'replace'))
        except Exception as e:
            stats['errors'] += 1
            print(f'  geocode error for {q[:44]!r}: {e}', file=sys.stderr)
            return None                  # transient: do not poison the cache
        stats['looked_up'] += 1
        time.sleep(RATE)
        if hits:
            result = {'lat': float(hits[0]['lat']), 'lon': float(hits[0]['lon']),
                      'display': hits[0].get('display_name'), 'matched': q,
                      'precision': attempt}     # 0 = exact string, higher = broader
            break

    cache[key] = result
    return result


def split_location(loc):
    """Pull a venue name and town out of a free-text location line."""
    parts = [p.strip() for p in (loc or '').split(',') if p.strip()]
    if not parts:
        return None, None
    venue = parts[0]
    city = None
    for i, p in enumerate(parts):
        if re.fullmatch(r'(NY|New York|NJ|CT|MA|PA)', p, re.I) and i:
            city = parts[i - 1]
            if not re.search(r'\d', city):
                city = f'{city}, NY' if p.upper() in ('NY', 'NEW YORK') else f'{city}, {p.upper()}'
            break
    return venue, city


def categorise(text):
    found = []
    for name, pattern in KEYWORDS:
        if re.search(pattern, text, re.I) and name not in found:
            found.append(name)
    return found[:4] or ['community']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', default='build/candidates.json')
    ap.add_argument('--platform', default='build/platform.json')
    ap.add_argument('--out', default='build/enriched.json')
    ap.add_argument('--registry', default='sources/registry.json')
    args = ap.parse_args()

    registry = json.load(open(args.registry))
    center = registry['center']
    # Venue feeds usually omit LOCATION — every event is at the same address —
    # so the registry carries the venue's own coordinates as a fallback.
    venue_default = {s['id']: s['venue'] for s in registry['sources'] if s.get('venue')}
    data = json.load(open(args.src))
    cache, stats = load_cache(), {'cached': 0, 'looked_up': 0, 'errors': 0}
    dropped = {'no_location': 0, 'ungeocodable': 0, 'out_of_radius': 0}

    out = []
    for c in data['candidates']:
        fallback = venue_default.get(c['sourceId'])
        loc = c.get('location')
        hit = geocode(loc, cache, stats) if loc else None

        if not hit and fallback:
            hit = {'lat': fallback['lat'], 'lon': fallback['lon']}
            loc = loc or fallback.get('address') or fallback['name']
        if not hit:
            dropped['no_location' if not loc else 'ungeocodable'] += 1
            continue

        d = miles(center['lat'], center['lon'], hit['lat'], hit['lon'])
        if d > center['radiusMiles']:
            dropped['out_of_radius'] += 1
            continue

        venue, city = split_location(loc)
        if fallback:
            venue = venue or fallback['name']
            city = city or fallback.get('city')
        blob = ' '.join(filter(None, [c['title'], c.get('description'), venue]))
        recurring = c.get('recurring') or bool(ACTIVITY_HINTS.search(blob))

        out.append({
            'id': f"{c['sourceId']}-{abs(hash(c.get('uid') or c['title'] + c['start'])) % 10**8}",
            'title': c['title'],
            'kind': 'activity' if recurring else 'event',
            'categories': categorise(blob),
            'start': c['start'],
            'end': c.get('end'),
            'venue': venue or 'See listing',
            'city': city,
            'address': loc,
            'lat': round(hit['lat'], 5),
            'lon': round(hit['lon'], 5),
            'price': None,                     # never guessed — see module docstring
            'signupRequired': False,
            'url': c.get('url'),
            'description': (c.get('description') or '').strip()[:400] or None,
            'source': c['sourceName'],
        })

    # Platform results (Ticketmaster) already arrive in final shape with real
    # coordinates and prices, so they skip enrichment — but not the radius check.
    platform_kept = 0
    if os.path.exists(args.platform):
        for e in json.load(open(args.platform)).get('events', []):
            if e.get('lat') is None or e.get('lon') is None:
                continue
            if miles(center['lat'], center['lon'], e['lat'], e['lon']) > center['radiusMiles']:
                dropped['out_of_radius'] += 1
                continue
            out.append({
                'id': f"tm-{abs(hash(e['url'] or e['title'])) % 10**8}",
                'title': e['title'], 'kind': 'event',
                'categories': e['categories'], 'start': e['start'], 'end': e.get('end'),
                'venue': e.get('venue') or 'See listing', 'city': e.get('city'),
                'address': e.get('address') or e.get('venue'),
                'lat': round(e['lat'], 5), 'lon': round(e['lon'], 5),
                'price': e.get('price'),
                'signupRequired': True, 'signupUrl': e.get('signupUrl'),
                'url': e.get('url'),
                'description': (e.get('description') or '').strip()[:400] or None,
                'source': e['sourceName'],
            })
            platform_kept += 1

    out.sort(key=lambda x: x['start'])
    os.makedirs('build', exist_ok=True)
    json.dump(cache, open(CACHE, 'w'), indent=0)
    json.dump({'enrichedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
               'center': center, 'items': out}, open(args.out, 'w'),
              indent=2, ensure_ascii=False)

    print(f"\n{len(out)} listings kept → {args.out}"
          + (f" (incl. {platform_kept} from platform APIs)" if platform_kept else ""))
    print(f"  geocoding: {stats['looked_up']} looked up, {stats['cached']} cached, "
          f"{stats['errors']} errors")
    print(f"  dropped:   {dropped['out_of_radius']} outside {center['radiusMiles']} mi, "
          f"{dropped['ungeocodable']} ungeocodable, {dropped['no_location']} with no location")
    return 0


if __name__ == '__main__':
    sys.exit(main())
