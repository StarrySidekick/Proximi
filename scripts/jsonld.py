#!/usr/bin/env python3
"""Extract schema.org Event data from registry sources that publish it.

Sites with no iCal feed often still emit JSON-LD for search engines, and unlike
iCal that data carries coordinates AND price. This turns several html sources
into machine-readable ones and is the only automated route to a real price.

Writes build/jsonld.json in the same shape scripts/platforms.py uses, so
enrich.py folds it in without geocoding what already has coordinates.

  python3 scripts/jsonld.py [--registry sources/registry.json]
"""

import argparse, gzip, html as htmlmod, io, json, os, re, sys, time, zlib
import urllib.error, urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from enrich import type_of, setting_of, time_of_day, audience_of, categorise, \
                   clean_text, FOOD, ACTIVITY_HINTS

UA = 'Mozilla/5.0 (compatible; ProximiBot/0.1; +https://github.com/StarrySidekick/Proximi)'
LD = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)

def decode_body(raw, encoding):
    """urllib does not decompress. A gzip-only host otherwise yields mojibake
    that silently parses as "no events" rather than failing loudly."""
    enc = (encoding or '').lower()
    try:
        if 'gzip' in enc:
            raw = gzip.decompress(raw)
        elif 'deflate' in enc:
            raw = zlib.decompress(raw, -zlib.MAX_WBITS)
    except (OSError, zlib.error):
        pass
    return raw.decode('utf-8', 'replace')

EVENTISH = re.compile(r'Event$|^Event', re.I)


def fetch(url, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml',
                'Accept-Encoding': 'gzip, deflate'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return decode_body(r.read(), r.headers.get('Content-Encoding'))
        except (urllib.error.URLError, urllib.error.HTTPError, OSError):
            if attempt == tries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def walk(node, out):
    """JSON-LD nests events inside @graph, itemListElement and offers alike."""
    if isinstance(node, list):
        for n in node:
            walk(n, out)
        return
    if not isinstance(node, dict):
        return
    t = node.get('@type')
    types = [t] if isinstance(t, str) else (t or [])
    if any(EVENTISH.search(str(x)) for x in types) and node.get('name'):
        out.append(node)
    for v in node.values():
        if isinstance(v, (dict, list)):
            walk(v, out)


def first(v):
    return v[0] if isinstance(v, list) and v else v


def price_of(node):
    """schema.org Offer → our price object, or None when unpublished.

    An offer with no price at all is not free; it just has not said. Only an
    explicit numeric 0 means free.
    """
    offers = node.get('offers')
    if not offers:
        return None
    vals = []
    for o in (offers if isinstance(offers, list) else [offers]):
        if not isinstance(o, dict):
            continue
        for key in ('price', 'lowPrice', 'highPrice'):
            raw = o.get(key)
            if raw in (None, ''):
                continue
            try:
                vals.append(float(str(raw).replace('$', '').replace(',', '').strip()))
            except ValueError:
                pass
    if not vals:
        return None
    return {'min': round(min(vals), 2), 'max': round(max(vals), 2),
            'note': 'from the listing page'}


def location_of(node):
    loc = first(node.get('location'))
    if isinstance(loc, str):
        return {'name': loc}
    if not isinstance(loc, dict):
        return {}
    addr = loc.get('address')
    if isinstance(addr, str):
        street, city, region = addr, None, None
    elif isinstance(addr, dict):
        street = addr.get('streetAddress')
        city = addr.get('addressLocality')
        region = addr.get('addressRegion')
    else:
        street = city = region = None
    geo = loc.get('geo') or {}
    lat = lon = None
    if isinstance(geo, dict):
        try:
            lat = float(geo['latitude'])
            lon = float(geo['longitude'])
        except (KeyError, TypeError, ValueError):
            lat = lon = None
    return {'name': loc.get('name'), 'street': street, 'city': city,
            'region': region, 'lat': lat, 'lon': lon}


def parse_dt(raw):
    if not raw:
        return None
    s = str(raw).strip().replace('Z', '+00:00')
    for candidate in (s, s + 'T00:00:00'):
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            continue
    return None


def harvest_source(src):
    page = fetch(src['url'])
    blocks = LD.findall(page)
    nodes = []
    for b in blocks:
        # Do NOT html-unescape before parsing: &quot; inside a description
        # becomes a bare quote and breaks the JSON. Entities are decoded later,
        # per field, by clean_text().
        try:
            walk(json.loads(b.strip()), nodes)
        except json.JSONDecodeError:
            continue

    now = datetime.now(timezone.utc)
    seen, events = set(), []
    for n in nodes:
        start = parse_dt(n.get('startDate'))
        if not start:
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        end = parse_dt(n.get('endDate'))
        if (end or start) < now:
            continue

        name = clean_text(n.get('name'), 200)
        url = first(n.get('url')) or src['url']
        key = (name, start.date())
        if not name or key in seen:
            continue
        seen.add(key)

        loc = location_of(n)
        desc = clean_text(n.get('description'))
        organizer = first(n.get('organizer'))
        host = (organizer.get('name') if isinstance(organizer, dict) else organizer)

        blob = ' '.join(filter(None, [name, desc, loc.get('name')]))
        events.append({
            'sourceId': src['id'],
            'sourceName': src.get('publisher', src['id']),
            'title': name,
            'type': type_of(name, desc),
            'start': start.isoformat(),
            'end': end.isoformat() if end else None,
            'url': url,
            # Venue and address come straight off the page and carry entities
            # just like descriptions do; clean them on the same path.
            'venue': clean_text(loc.get('name'), 120) or src.get('publisher'),
            'city': clean_text(', '.join(filter(None, [loc.get('city'), loc.get('region')])), 120),
            'address': clean_text(', '.join(filter(None, [
                loc.get('name'), loc.get('street'), loc.get('city'), loc.get('region')])), 200),
            'lat': loc.get('lat'), 'lon': loc.get('lon'),
            'price': price_of(n),
            'categories': categorise(blob),
            'audience': audience_of(blob, name, type_of(name, desc)),
            'setting': setting_of(blob),
            'timeOfDay': time_of_day(start),
            'hasFood': bool(FOOD.search(blob)),
            'repeats': bool(ACTIVITY_HINTS.search(blob)),
            'host': clean_text(host, 120) or src.get('publisher'),
            'description': desc,
            'signupRequired': bool(n.get('offers')),
            'signupUrl': url if n.get('offers') else None,
        })
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--out', default='build/jsonld.json')
    args = ap.parse_args()

    reg = json.load(open(args.registry))
    targets = [s for s in reg['sources']
               if s.get('enabled', True) and s['kind'] in ('html', 'jsonld')]

    all_events, report = [], []
    for src in targets:
        try:
            got = harvest_source(src)
        except Exception as e:
            report.append((src['id'], 0, f'{type(e).__name__}: {e}'))
            continue
        all_events.extend(got)
        priced = sum(1 for e in got if e['price'])
        geo = sum(1 for e in got if e['lat'])
        report.append((src['id'], len(got),
                       'ok' if got else 'no JSON-LD events',
                       ))
        if got:
            report[-1] = (src['id'], len(got), f'ok — {priced} priced, {geo} geocoded')
        time.sleep(0.5)

    os.makedirs('build', exist_ok=True)
    json.dump({'fetchedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
               'events': all_events}, open(args.out, 'w'), indent=2, ensure_ascii=False)

    width = max((len(r[0]) for r in report), default=10)
    for sid, n, status in sorted(report, key=lambda r: -r[1]):
        print(f"{' ' if n else '!'} {sid:<{width}} {n:>4}  {status}")
    print(f'\n{len(all_events)} events with structured data → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
