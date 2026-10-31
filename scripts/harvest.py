#!/usr/bin/env python3
"""Pull events from every feed in the source registry.

Emits build/candidates.json — raw, un-enriched listings for the weekly job to
categorise, price and geocode. Deterministic: no model involved, so nothing
here can invent an event.

  python3 scripts/harvest.py [--registry sources/registry.json] [--json]
"""

import argparse, gzip, http.cookiejar, io, json, os, sys, time, urllib.error, urllib.request, zlib
from datetime import date, datetime, timedelta, timezone

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

# How far ahead harvest_wpfc walks. An iCal feed carries whatever it carries
# and gets no horizon at all, so a season here is already the conservative
# reading of "what is on".
WPFC_DAYS = 90

# The range to ask for on each page. Short on purpose — see harvest_wpfc.
WPFC_PAGE = 30

# A cap, not a horizon: harvest_tribe asks for everything from today onwards
# and stops after this many pages of 50 so one venue with a decade of repeats
# cannot run away with the run.
TRIBE_PAGES = 10


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
            # WordPress serves admin-ajax.php as text/html whatever it returns,
            # so a perfectly good wp-fullcalendar feed arrives looking exactly
            # like a challenge page. A challenge is never JSON, so parsing
            # settles which one this is.
            if body.lstrip()[:1] in ('[', '{'):
                try:
                    json.loads(body)
                    return body
                except json.JSONDecodeError:
                    pass
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
        # A VCALENDAR carrying no VEVENTs is an empty calendar, not a broken
        # one. Four Brothers Drive-In serves exactly that out of season —
        # headers, timezone, description, no events — and "not an iCal feed?"
        # sent someone looking for a parser bug that was never there.
        if 'BEGIN:VCALENDAR' in raw:
            return [], 'nothing scheduled yet (empty calendar)'
        return [], 'no VEVENTs — not an iCal feed?'
    future = icsparse.future_only(events)
    if not future:
        span = sorted(str(e['start'])[:10] for e in events)
        # Which months, not just the last date. A feed that stopped dead and a
        # museum that opens in spring and autumn are indistinguishable through
        # "latest 2026-09-20", and telling them apart is the whole question:
        # one wants removing, the other wants leaving alone until May. Hurley
        # Heritage's 19 dates fall in February, May, August and September —
        # that is a season, and it only shows if the status says so.
        months = sorted({d[:7] for d in span})
        return [], (f'{STALE} ({len(events)} dated, latest {span[-1]}, '
                    f'months {", ".join(months[-8:])})')

    out = []
    for e in future:
        out.append({
            'sourceId': src['id'],
            'sourceName': src.get('publisher', src['id']),
            'title': e['summary'],
            'start': e['start'].isoformat(),
            'end': e['end'].isoformat() if e.get('end') else None,
            'allDay': e.get('all_day', False),
            # A Google Calendar ICS carries no URL property at all, so 24
            # perfectly good library listings arrived with nothing to link to
            # and validate.py — correctly — refused the whole file. The venue's
            # own page is the honest fallback: it is where you would go to read
            # about the event anyway.
            'url': e.get('url') or src.get('homepage') or src['url'],
            'location': e.get('location'),
            'description': (e.get('description') or '')[:1200] or None,
            'feedCategories': e.get('categories'),
            'organizer': e.get('organizer'),
            'recurring': bool(e.get('rrule')),
            'uid': e.get('uid'),
        })
    return out, None


def venue_hint(src):
    """The registry venue as a plain address string, whichever shape it is in."""
    v = src.get('venue')
    if isinstance(v, dict):
        return v.get('address') or v.get('name')
    return v


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
            'location': loc.get('addressLine1') or venue_hint(src),
            'description': desc.strip()[:1200] or None,
            'feedCategories': e.get('categories'),
            'organizer': src.get('publisher'),
            'recurring': False,
            'uid': e.get('id'),
        })
    if not out:
        return [], STALE
    return out, None


def harvest_wpfc(src, tz):
    """WordPress Events Manager, read through its wp-fullcalendar front end.

    Derby Neck Library moved off The Events Calendar and left the old plugin's
    export standing: /events.ics and /?ical=1 serve the same frozen file, 50
    VEVENTs ending months back, which reads as a library that stopped running
    programmes rather than as a feed nobody writes to any more. The new stack
    publishes no iCal at all, so there is no feed to point a registry entry at.

    What the calendar page itself calls is

      /wp-admin/admin-ajax.php?action=WP_FullCalendar&type=event&start=&end=

    and it answers a JSON array: title, start, end, the all-day flag and the
    event's own URL. Nothing else — no description, no room, no price. Those
    live on the event pages at one request each, which is a bill harvest
    should not run up for fields the rest of the pipeline derives anyway.

    The one trap is the window, and it fails in the direction that looks like
    success. `end` is not a filter: the endpoint answers a fixed page of about
    160 rows and slides it further out the wider the range, so asking for 14,
    30, 45 or 60 days all return the same 164 listings (1 Nov - 12 Dec), while
    asking for 90 returns 160 that *start* on 29 November — the near month
    silently gone, the count still healthy. So the range stays short and the
    cursor walks: each page from the last start seen, which overlaps the one
    before and is deduped on the listing, until it passes the horizon or stops
    saying anything new.
    """
    import html as _html
    from urllib.parse import urlsplit
    from zoneinfo import ZoneInfo
    site = urlsplit(src['url'])
    endpoint = (f'{site.scheme}://{site.netloc}/wp-admin/admin-ajax.php'
                '?action=WP_FullCalendar&type=event&start={start}&end={end}')
    zone = ZoneInfo(tz)
    today = date.today()
    horizon = today + timedelta(days=WPFC_DAYS)
    cursor, seen, out = today, set(), []
    while cursor <= horizon:
        page = json.loads(fetch(endpoint.format(
            start=cursor.isoformat(),
            end=(cursor + timedelta(days=WPFC_PAGE)).isoformat())))
        rows = [e for e in page if e.get('start') and e.get('title')]
        if not rows:
            break
        for e in rows:
            # post_id is the event, event_id the recurrence it belongs to, so
            # the pair plus the date is one dated listing.
            uid = f"wpfc-{e.get('post_id')}-{e.get('event_id')}-{e['start'][:10]}"
            start = datetime.fromisoformat(e['start']).replace(tzinfo=zone)
            if uid in seen or start.date() > horizon:
                continue
            seen.add(uid)
            # Local wall-clock with no offset. Stamping the registry's zone on
            # it is what keeps a 7pm concert from being filed at 3pm, which is
            # what bare fromisoformat() plus a UTC CI clock would do.
            end = (datetime.fromisoformat(e['end']).replace(tzinfo=zone)
                   if e.get('end') else None)
            out.append({
                'sourceId': src['id'],
                'sourceName': src.get('publisher', src['id']),
                # Titles arrive HTML-escaped: "Drums &amp; Strings".
                'title': _html.unescape(e['title'].strip()),
                'start': start.isoformat(),
                'end': end.isoformat() if end else None,
                'allDay': bool(e.get('allDay')),
                'url': e.get('url') or src.get('homepage') or src['url'],
                'location': venue_hint(src),
                'description': None,
                'feedCategories': None,
                'organizer': src.get('publisher'),
                'recurring': False,
                'uid': uid,
            })
        last = max(date.fromisoformat(e['start'][:10]) for e in rows)
        if last <= cursor:
            break
        cursor = last
        time.sleep(0.4)
    if not out:
        return [], STALE
    return out, None


def harvest_tribe(src, tz):
    """The Events Calendar, read through its REST API instead of ?ical=1.

    Five registry feeds were failing on the iCal route and four of them were
    reported as "blocked: bot challenge": the challenge sits in front of the
    site's own pages, and /events/?ical=1 is one of those pages. /wp-json/ is
    not, and it is the plugin's documented API.

    The status line is the real repair. Maverick Concerts runs a summer
    chamber series — June to September, 46 listings, nothing afterwards — and
    "blocked" said the feed could not be read when the truth is that the
    season is over. The Castle Fun Center and Millbrook Vineyards are the same
    shape; the Corner Bookstore's last reading was three days ago and it
    schedules a few weeks out. None of them is broken, all four will refill on
    their own, and reading them this way says so instead of guessing.

    It also carries more than the iCal did: the venue arrives as an address
    rather than a room name, and `cost` is deliberately dropped — the
    candidate shape has no price, because prices.py owns that and reads it
    from the listing itself.
    """
    import html as _html
    import re as _re
    from urllib.parse import urlsplit
    from zoneinfo import ZoneInfo
    site = urlsplit(src['url'])
    api = (f'{site.scheme}://{site.netloc}/wp-json/tribe/events/v1/events'
           f'?per_page=50&start_date={date.today().isoformat()}&page=')
    out = []
    for page in range(1, TRIBE_PAGES + 1):
        payload = json.loads(fetch(api + str(page)))
        events = payload.get('events') or []
        if not events:
            break
        for e in events:
            title = _html.unescape((e.get('title') or '').strip())
            if not title or not e.get('start_date'):
                continue
            # Each event states its own zone; the registry's is the fallback
            # for the rare one that does not.
            zone = ZoneInfo(e.get('timezone') or tz)
            start = datetime.strptime(e['start_date'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=zone)
            end = (datetime.strptime(e['end_date'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=zone)
                   if e.get('end_date') else None)
            venue = e.get('venue') or {}
            where = ', '.join(filter(None, [
                venue.get('venue'), venue.get('address'),
                venue.get('city'), venue.get('stateprovince') or venue.get('state')]))
            desc = _html.unescape(_re.sub(r'<[^>]+>', ' ',
                                          e.get('description') or e.get('excerpt') or ''))
            out.append({
                'sourceId': src['id'],
                'sourceName': src.get('publisher', src['id']),
                'title': title,
                'start': start.isoformat(),
                'end': end.isoformat() if end else None,
                'allDay': bool(e.get('all_day')),
                'url': e.get('url') or src.get('homepage') or src['url'],
                'location': where or venue_hint(src),
                'description': ' '.join(desc.split())[:1200] or None,
                'feedCategories': [c.get('name') for c in (e.get('categories') or [])
                                   if c.get('name')] or None,
                'organizer': (e.get('organizer') or [{}])[0].get('organizer')
                             or src.get('publisher'),
                'recurring': False,
                # Stable across runs and unique per occurrence: a repeating
                # series gives each date its own id.
                'uid': f"tribe-{e.get('id')}",
            })
        if page >= (payload.get('total_pages') or 1):
            break
        time.sleep(0.4)
    if not out:
        # Nothing scheduled is not the same as nothing readable, and this
        # route can tell them apart: the API answered, it simply has no future
        # events. STALE would put this in the same bucket as a dead export.
        return [], 'nothing scheduled yet (API answered, 0 upcoming)'
    return out, None


HANDLERS = {'ics': harvest_ics, 'sqsp': harvest_sqsp, 'wpfc': harvest_wpfc,
            'tribe': harvest_tribe}


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
