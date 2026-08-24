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

import argparse, http.cookiejar, json, os, re, sys, time, urllib.error, urllib.parse, urllib.request
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
    # Squarespace event collections export iCal from the collection URL.
    '/events?format=ical',
    '/calendar?format=ical',
]

# Pages to sniff for an embedded calendar platform.
SNIFF_PATHS = ['/', '/events/', '/events', '/calendar/', '/calendar', '/whats-on/']

# Fingerprints for calendar platforms that publish a feed at a derivable URL.
# This is what unlocks sites that do not run The Events Calendar — most of
# Connecticut, as it turns out.
PLATFORMS = [
    # A Google Calendar embed exposes a public ICS at a predictable address.
    ('google', re.compile(r'calendar\.google\.com/calendar/(?:embed|u/\d+/embed)\?[^"\'<>]*src=([^"\'&<>]+)', re.I)),
    # Springshare LibCal — near-universal in public libraries.
    ('libcal', re.compile(r'https?://([a-z0-9-]+\.libcal\.com)', re.I)),
    # Localist — universities, museums, city governments.
    ('localist', re.compile(r'https?://([a-z0-9.-]+)/api/2/events|localist\.com', re.I)),
    ('tockify', re.compile(r'tockify\.com/api/feeds/[a-z0-9]+|tockify\.com/([a-z0-9_-]+)', re.I)),
    ('trumba', re.compile(r'trumba\.com/calendars/([a-z0-9._-]+)', re.I)),
    ('eventbrite', re.compile(r'eventbrite\.com/o/([a-z0-9-]+)', re.I)),
    ('bandsintown', re.compile(r'bandsintown\.com/v/(\d+)|bandsintown\.com/a/(\d+)', re.I)),
    ('dice', re.compile(r'dice\.fm/(?:venue|partner)/([a-z0-9-]+)', re.I)),
]

JSONLD_EVENT = re.compile(r'"@type"\s*:\s*"?\[?"?(Event|MusicEvent|TheaterEvent|'
                          r'ScreeningEvent|FoodEvent|SocialEvent|ExhibitionEvent|Festival)', re.I)


def gcal_ics(src):
    """A Google Calendar embed src is the calendar id; the public ICS follows."""
    cal = urllib.parse.unquote(src).strip()
    if not cal or '@' not in cal:
        return None
    return ('https://calendar.google.com/calendar/ical/'
            + urllib.parse.quote(cal, safe='') + '/public/basic.ics')


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


def sniff_platforms(domain, opener):
    """Look for an embedded calendar platform and derive its feed where possible."""
    found = []
    for path in SNIFF_PATHS:
        try:
            req = urllib.request.Request(f'https://{domain}{path}', headers={
                'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.5'})
            with opener.open(req, timeout=12) as r:
                body = r.read(900_000).decode('utf-8', 'replace')
        except Exception:
            continue

        for name, pattern in PLATFORMS:
            m = pattern.search(body)
            if not m:
                continue
            hit = {'platform': name, 'seenOn': f'https://{domain}{path}'}
            if name == 'google':
                ics = gcal_ics(m.group(1))
                if ics:
                    hit['feed'] = ics
            elif name == 'libcal':
                hit['feed'] = f'https://{m.group(1)}/calendar?cid=-1&t=d&d=0000-00-00&cal=-1&ical=1'
            elif m.lastindex:
                hit['ref'] = m.group(m.lastindex)
            if not any(h['platform'] == name for h in found):
                found.append(hit)

        if JSONLD_EVENT.search(body) and not any(h['platform'] == 'jsonld' for h in found):
            found.append({'platform': 'jsonld', 'seenOn': f'https://{domain}{path}'})
        if found:
            break
    return found


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

    if best:
        return best

    # No iCal — but an embedded platform may still give us a feed or a page
    # worth registering as an html source.
    hits = sniff_platforms(domain, opener)
    for h in hits:
        if h.get('feed'):
            try:
                req = urllib.request.Request(h['feed'], headers={'User-Agent': UA})
                with opener.open(req, timeout=12) as r:
                    body = r.read(600_000).decode('utf-8', 'replace')
                if 'BEGIN:VCALENDAR' in body:
                    future = icsparse.future_only(icsparse.parse(body))
                    if future:
                        return {'domain': domain, 'url': h['feed'], 'via': h['platform'],
                                'total': len(icsparse.parse(body)), 'future': len(future)}
            except Exception:
                pass
    if hits:
        return {'domain': domain, 'platforms': [h['platform'] for h in hits],
                'seenOn': hits[0]['seenOn'], 'future': 0}
    return None


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
        feeds, leads = [], []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for hit in pool.map(probe_domain, domains):
                if not hit:
                    continue
                if hit.get('url'):
                    feeds.append(hit)
                    via = f" via {hit['via']}" if hit.get('via') else ''
                    print(f"  + {hit['domain']:<34} {hit['future']:>4} future{via}  {hit['url']}")
                else:
                    leads.append(hit)

        for l in leads:
            print(f"  ? {l['domain']:<34} {'':>4}       {'/'.join(l['platforms'])} — {l['seenOn']}")

        json.dump({'feeds': feeds, 'leads': leads},
                  open('build/discovered.json', 'w'), indent=2)
        print(f'\n{len(feeds)} live feeds, {len(leads)} platform leads '
              f'from {len(domains)} domains → build/discovered.json')
        print('Feeds can go straight into the registry as kind:ics.')
        print('Leads have a calendar but no derivable feed — register as kind:html.')

    if not args.overpass and not args.probe:
        ap.print_help()
    return 0


if __name__ == '__main__':
    sys.exit(main())
