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
from urllib.parse import urljoin
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

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

# A calendar that shows one month at a time is empty by definition on the last
# day of it. Howland Public Library's page carried 89 schema.org Events on 31
# October and not one of them was still ahead, so nine Assabet Interactive
# libraries all reported "no JSON-LD events" while November sat one link away.
# The page says where that link goes, so follow it rather than guessing at a
# URL shape — and keep it to a few months, since this is a whole page fetched
# per month per library.
NEXT_MONTH = re.compile(r'href=["\']([^"\']+\?from=next)["\']', re.I)
MONTH_PAGES = 3


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


ZIP = re.compile(r'^\d{5}(?:-\d{4})?$')
STATE = re.compile(r'^[A-Z]{2}$')


def split_postal(addr):
    """Street, town and state out of an address written as one string.

    schema.org allows `address` to be a PostalAddress with the town in its own
    field, or a plain string. Assabet Interactive uses the string — "Mahopac
    Public Library, 668 Route 6, Mahopac, NY, 10541" — and treating the whole
    thing as the street left 917 library listings with no town at all: nothing
    on the card, nothing for the Places filter, and a geocoder being handed a
    room name. The town is there; it just has to be read off the end.
    """
    parts = [p.strip() for p in addr.split(',') if p.strip()]
    if ZIP.match(parts[-1] if parts else ''):
        parts.pop()
    region = parts.pop() if parts and STATE.match(parts[-1]) else None
    city = parts.pop() if region and parts else None
    return ', '.join(parts) or None, city, region


def location_of(node):
    loc = first(node.get('location'))
    if isinstance(loc, str):
        return {'name': loc}
    if not isinstance(loc, dict):
        return {}
    addr = loc.get('address')
    if isinstance(addr, str):
        street, city, region = split_postal(addr)
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


DURATION = re.compile(r'^P(?:(?P<d>\d+)D)?(?:T(?:(?P<h>\d+)H)?'
                      r'(?:(?P<m>\d+)M)?(?:(?P<s>\d+(?:\.\d+)?)S)?)?$')


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


def dated_only(raw):
    """Is this a day with no hour in it?"""
    return bool(raw) and 'T' not in str(raw) and ':' not in str(raw)


def clock_of(raw):
    """A bare time of day — schema.org doorTime — as (hour, minute, second)."""
    bits = str(raw or '').strip().split(':')
    try:
        return tuple(int(b) for b in (bits + ['0', '0'])[:3])
    except ValueError:
        return None


def duration_of(raw):
    """An ISO 8601 duration as a timedelta, or None."""
    m = DURATION.match(str(raw or '').strip())
    if not m or not any(m.groupdict().values()):
        return None
    g = {k: float(v or 0) for k, v in m.groupdict().items()}
    return timedelta(days=g['d'], hours=g['h'], minutes=g['m'], seconds=g['s'])


def harvest_source(src, tz):
    """Every event this source publishes, across its next few month pages."""
    seen, events, visited = set(), [], set()
    url = src['url']
    for _ in range(MONTH_PAGES):
        page = fetch(url)
        visited.add(url)
        events.extend(events_on(page, src, seen, tz))
        link = NEXT_MONTH.search(page)
        if not link:
            break
        url = urljoin(url, htmlmod.unescape(link.group(1)))
        if url in visited:
            break
        time.sleep(0.5)
    return events


def events_on(page, src, seen, tz):
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
    zone = ZoneInfo(tz)
    events = []
    for n in nodes:
        start = parse_dt(n.get('startDate'))
        if not start:
            continue
        # A day with no hour in it, plus a separate doorTime, is how Assabet
        # Interactive writes every library programme: startDate "2026-10-01",
        # doorTime "11:00:00", duration "PT1800S". Reading the date alone put
        # all 917 of them at midnight, and midnight stamped UTC is eight the
        # previous evening in New York — so a Thursday story hour was filed as
        # Wednesday night, and a half-hour class became an all-day entry.
        clock = clock_of(n.get('doorTime')) if dated_only(n.get('startDate')) else None
        if clock:
            start = start.replace(hour=clock[0], minute=clock[1], second=clock[2])
        # The registry's zone, not UTC. A naive timestamp from a Hudson Valley
        # calendar is Hudson Valley wall-clock, and CI runs in UTC.
        if start.tzinfo is None:
            start = start.replace(tzinfo=zone)
        end = parse_dt(n.get('endDate'))
        # start is normalised above; end has to be too, or a feed that omits
        # the offset (Howland's does) throws on the comparison below and the
        # whole source reports zero events.
        if end and end.tzinfo is None:
            end = end.replace(tzinfo=zone)
        # An endDate that is the same bare day as the start says nothing the
        # start did not. The duration is what says when it is over.
        span = duration_of(n.get('duration'))
        if clock and span and (end is None or end <= start):
            end = start + span
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
    tz = reg['center'].get('timezone', 'America/New_York')
    targets = [s for s in reg['sources']
               if s.get('enabled', True) and s['kind'] in ('html', 'jsonld')]

    all_events, report = [], []
    for src in targets:
        try:
            got = harvest_source(src, tz)
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
               # Written down, not just printed. Nine libraries reported zero
               # for weeks and the only record of it was a terminal that had
               # scrolled away.
               'report': [{'id': sid, 'events': n, 'status': status}
                          for sid, n, status in report],
               'events': all_events}, open(args.out, 'w'), indent=2, ensure_ascii=False)

    width = max((len(r[0]) for r in report), default=10)
    for sid, n, status in sorted(report, key=lambda r: -r[1]):
        print(f"{' ' if n else '!'} {sid:<{width}} {n:>4}  {status}")
    print(f'\n{len(all_events)} events with structured data → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
