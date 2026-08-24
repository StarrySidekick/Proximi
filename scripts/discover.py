#!/usr/bin/env python3
"""Find new sources to add to the registry.

Two steps, usable separately:

  --overpass          enumerate venues in the radius from OpenStreetMap
  --probe [FILE]      test domains for a usable iCal feed

The point is the long tail: a restaurant's wine dinner or a brewery's tap
takeover never reaches a county calendar, but a surprising number of those
venues run WordPress with The Events Calendar, which always answers ?ical=1.
Probing every venue website in the radius finds them mechanically.

Overpass is rate-limited and mirrors go down; if every mirror fails, pass a
domain list to --probe instead.
"""

import argparse, http.cookiejar, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import icsparse

UA = 'Mozilla/5.0 (compatible; ProximiBot/0.1; +https://github.com/StarrySidekick/Proximi)'

MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.osm.jp/api/interpreter',
]

# Places that plausibly host public events. Deliberately broad — the feed probe
# is cheap, and a false positive just fails to find a feed.
OSM_FILTER = '''
  nwr["amenity"~"^(restaurant|bar|pub|cafe|nightclub|theatre|arts_centre|community_centre|library|cinema|place_of_worship)$"]["website"]({bbox});
  nwr["tourism"~"^(museum|gallery|attraction|zoo)$"]["website"]({bbox});
  nwr["craft"~"^(brewery|winery|distillery)$"]["website"]({bbox});
  nwr["shop"~"^(books|farm|winery)$"]["website"]({bbox});
  nwr["leisure"~"^(park|nature_reserve|sports_centre)$"]["website"]({bbox});
'''

# The Events Calendar and friends answer one of these on a huge number of sites.
FEED_PATHS = [
    '/events/?ical=1',
    '/events/?ical=1&eventDisplay=list',
    '/?post_type=tribe_events&ical=1',
    '/calendar/?ical=1',
    '/events/feed/',
]


def overpass(center, timeout=180):
    r = center['radiusMiles'] * 1609.34
    body = '[out:json][timeout:120];(' + \
        OSM_FILTER.replace('{bbox}', f"around:{int(r)},{center['lat']},{center['lon']}") + ');out tags center;'
    last = None
    for mirror in MIRRORS:
        try:
            req = urllib.request.Request(
                mirror, data=urllib.parse.urlencode({'data': body}).encode(),
                headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode('utf-8', 'replace'))
        except Exception as e:
            last = f'{mirror.split("/")[2]}: {e}'
            print(f'  mirror failed — {last}', file=sys.stderr)
    raise RuntimeError(f'all Overpass mirrors failed (last: {last})')


def domain_of(url):
    try:
        host = urllib.parse.urlparse(url if '://' in url else 'https://' + url).netloc
        return host.lower().lstrip('www.') or None
    except Exception:
        return None


def collect_venues(center):
    data = overpass(center)
    seen, venues = set(), []
    for el in data.get('elements', []):
        tags = el.get('tags', {})
        dom = domain_of(tags.get('website', ''))
        if not dom or dom in seen:
            continue
        seen.add(dom)
        venues.append({
            'name': tags.get('name'),
            'domain': dom,
            'kind': tags.get('amenity') or tags.get('tourism') or tags.get('craft')
                    or tags.get('shop') or tags.get('leisure'),
            'lat': el.get('lat') or (el.get('center') or {}).get('lat'),
            'lon': el.get('lon') or (el.get('center') or {}).get('lon'),
        })
    return venues


def probe_domain(domain):
    """Return the best working iCal feed for a domain, or None.

    Best means most future events — a feed that parses but is entirely in the
    past is a frozen artifact and worse than nothing, so it is rejected here.
    """
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    best = None
    for path in FEED_PATHS:
        url = f'https://{domain}{path}'
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Accept': 'text/calendar, */*;q=0.5'})
            with opener.open(req, timeout=12) as r:
                body = r.read(600_000).decode('utf-8', 'replace')
            if 'BEGIN:VCALENDAR' not in body:
                continue
            events = icsparse.parse(body)
            future = icsparse.future_only(events)
            if future and (best is None or len(future) > best['future']):
                best = {'domain': domain, 'url': url,
                        'total': len(events), 'future': len(future)}
        except Exception:
            continue
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--overpass', action='store_true', help='enumerate venues from OSM')
    ap.add_argument('--probe', nargs='?', const='build/venues.json',
                    help='probe domains for feeds (file of venues or plain domains)')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    center = json.load(open(args.registry))['center']
    os.makedirs('build', exist_ok=True)

    if args.overpass:
        print(f"querying OpenStreetMap for venues within "
              f"{center['radiusMiles']} mi of {center['name']}…")
        try:
            venues = collect_venues(center)
        except RuntimeError as e:
            print(f'FAILED: {e}', file=sys.stderr)
            print('Pass a domain list to --probe instead.', file=sys.stderr)
            return 1
        json.dump(venues, open('build/venues.json', 'w'), indent=2, ensure_ascii=False)
        print(f'{len(venues)} venues with a website → build/venues.json')

    if args.probe:
        raw = open(args.probe).read().strip()
        if raw.startswith('['):
            domains = [v['domain'] for v in json.loads(raw) if v.get('domain')]
        else:
            domains = [d.strip() for d in raw.split('\n') if d.strip()
                       and not d.startswith('#')]
        if args.limit:
            domains = domains[:args.limit]

        known = {domain_of(s['url']) for s in json.load(open(args.registry))['sources']}
        domains = [d for d in domains if d not in known]

        print(f'probing {len(domains)} domains for iCal feeds ({args.workers} at a time)…')
        found = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for hit in pool.map(probe_domain, domains):
                if hit:
                    found.append(hit)
                    print(f"  + {hit['domain']:<38} {hit['future']:>4} future  {hit['url']}")

        json.dump(found, open('build/discovered.json', 'w'), indent=2)
        print(f'\n{len(found)}/{len(domains)} domains expose a live feed → build/discovered.json')
        print('Review, then add the good ones to sources/registry.json.')

    if not args.overpass and not args.probe:
        ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
