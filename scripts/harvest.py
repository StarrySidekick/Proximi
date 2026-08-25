#!/usr/bin/env python3
"""Pull events from every feed in the source registry.

Emits build/candidates.json — raw, un-enriched listings for the weekly job to
categorise, price and geocode. Deterministic: no model involved, so nothing
here can invent an event.

  python3 scripts/harvest.py [--registry sources/registry.json] [--json]
"""

import argparse, gzip, http.cookiejar, io, json, os, sys, time, urllib.error, urllib.request, zlib
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import icsparse

UA = 'Mozilla/5.0 (compatible; ProximiBot/0.1; +https://github.com/StarrySidekick/Proximi)'
TIMEOUT = 25

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


# A feed with no future events is stale, not empty. Towne Crier and The Beacon
# both serve well-formed archives frozen months back; ingesting them would put
# confident, obsolete listings on the site.
STALE = 'no future events — feed looks frozen'


class Blocked(Exception):
    """The server answered, but with a bot challenge rather than the feed."""


def fetch(url, tries=3):
    """GET with cookies, redirects and a short backoff.

    Some hosts (Opus 40, Maverick Concerts) answer 202 with an HTML interstitial
    instead of the feed, and others rate-limit a burst of parallel requests.
    Both look like "no events" if you do not check, so both are named.
    """
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPRedirectHandler())
    headers = {
        'User-Agent': UA,
        'Accept': 'text/calendar, text/plain, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
    }
    last = None
    for attempt in range(tries):
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=TIMEOUT) as r:
                body = decode_body(r.read(), r.headers.get('Content-Encoding'))
                ctype = (r.headers.get('Content-Type') or '').lower()
            if 'BEGIN:VCALENDAR' in body:
                return body
            if r.status == 202 or 'html' in ctype:
                raise Blocked(f'bot challenge (HTTP {r.status}, {ctype.split(";")[0] or "?"})')
            return body
        except Blocked:
            raise
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last = e
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
    raise last


def harvest_ics(src, tz):
    raw = fetch(src['url'])
    events = icsparse.parse(raw, default_tz=tz)
    if not events:
        return [], 'no VEVENTs — not an iCal feed?'
    future = icsparse.future_only(events)
    if not future:
        span = sorted(e['start'] for e in events)
        return [], f'{STALE} (latest {str(span[-1])[:10]})'

    out = []
    for e in future:
        out.append({
            'sourceId': src['id'],
            'sourceName': src.get('publisher', src['id']),
            'title': e['summary'],
            'start': e['start'].isoformat(),
            'end': e['end'].isoformat() if e.get('end') else None,
            'allDay': e.get('all_day', False),
            'url': e.get('url'),
            'location': e.get('location'),
            'description': (e.get('description') or '')[:1200] or None,
            'feedCategories': e.get('categories'),
            'organizer': e.get('organizer'),
            'recurring': bool(e.get('rrule')),
            'uid': e.get('uid'),
        })
    return out, None


def harvest_sqsp(src, tz):
    """Squarespace event collections: <url>?format=json returns the items the
    page renders, with millisecond timestamps.

    The documented ?format=ical variant answers 200 with an empty body on some
    sites (Tubby's), so JSON is the reliable route. Item location carries
    Squarespace's SoHo placeholder coordinates unless the site filled in a
    street address, so the registry entry's venue string is what gets geocoded.
    """
    import re as _re
    from urllib.parse import urlsplit
    from zoneinfo import ZoneInfo
    raw = fetch(src['url'].rstrip('/') + '?format=json')
    data = json.loads(raw)
    items = data.get('upcoming') or data.get('items') or []
    base = 'https://' + urlsplit(src['url']).netloc
    now_ms = time.time() * 1000
    out = []
    for e in items:
        if not e.get('title') or (e.get('startDate') or 0) < now_ms:
            continue
        # Millisecond epochs, converted into the registry's zone explicitly —
        # bare fromtimestamp() takes the machine's clock, which in CI is UTC,
        # and quietly shifts every show four hours late. Microseconds dropped:
        # the schema wants whole seconds.
        zone = ZoneInfo(tz)
        start = datetime.fromtimestamp(e['startDate'] / 1000, tz=zone).replace(microsecond=0)
        end = (datetime.fromtimestamp(e['endDate'] / 1000, tz=zone).replace(microsecond=0)
               if e.get('endDate') else None)
        desc = _re.sub(r'<[^>]+>', ' ', e.get('excerpt') or e.get('body') or '')
        loc = e.get('location') or {}
        out.append({
            'sourceId': src['id'],
            'sourceName': src.get('publisher', src['id']),
            'title': e['title'],
            'start': start.isoformat(),
            'end': end.isoformat() if end else None,
            'allDay': False,
            'url': base + e['fullUrl'] if e.get('fullUrl') else src['url'],
            'location': loc.get('addressLine1') or src.get('venue'),
            'description': desc.strip()[:1200] or None,
            'feedCategories': e.get('categories'),
            'organizer': src.get('publisher'),
            'recurring': False,
            'uid': e.get('id'),
        })
    if not out:
        return [], STALE
    return out, None


HANDLERS = {'ics': harvest_ics, 'sqsp': harvest_sqsp}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--out', default='build/candidates.json')
    ap.add_argument('--json', action='store_true', help='print the report as JSON')
    args = ap.parse_args()

    reg = json.load(open(args.registry))
    center, tz = reg['center'], reg['center'].get('timezone', 'America/New_York')

    candidates, report = [], []
    for src in reg['sources']:
        if not src.get('enabled', True):
            report.append({'id': src['id'], 'status': 'disabled', 'events': 0})
            continue
        handler = HANDLERS.get(src['kind'])
        if not handler:
            # html / api sources are handled by the weekly job, not here.
            report.append({'id': src['id'], 'status': f"skipped ({src['kind']})", 'events': 0})
            continue
        try:
            got, problem = handler(src, tz)
        except Blocked as e:
            report.append({'id': src['id'], 'status': f'blocked: {e}', 'events': 0})
            continue
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            report.append({'id': src['id'], 'status': f'unreachable: {e}', 'events': 0})
            continue
        except Exception as e:                                  # malformed feed
            report.append({'id': src['id'], 'status': f'parse error: {e}', 'events': 0})
            continue

        time.sleep(0.4)
        candidates.extend(got)
        report.append({'id': src['id'], 'status': problem or 'ok', 'events': len(got)})

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    payload = {
        'harvestedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
        'center': center,
        'report': report,
        'candidates': sorted(candidates, key=lambda c: c['start']),
    }
    json.dump(payload, open(args.out, 'w'), indent=2, ensure_ascii=False)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        width = max((len(r['id']) for r in report), default=10)
        for r in sorted(report, key=lambda r: -r['events']):
            flag = ' ' if r['status'] == 'ok' else '!'
            print(f"{flag} {r['id']:<{width}}  {r['events']:>4}  {r['status']}")
        ok = sum(1 for r in report if r['status'] == 'ok')
        print(f"\n{len(candidates)} candidates from {ok}/{len(report)} sources → {args.out}")

    return 0


if __name__ == '__main__':
    sys.exit(main())
