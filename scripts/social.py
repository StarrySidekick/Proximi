#!/usr/bin/env python3
"""Eventbrite and Meetup — the two big listing platforms, without an API key.

The registry note on platforms.py says Meetup has no free API path. True of the
GraphQL API, but both sites hand the data to their own front end as embedded
JSON, and that is public:

  Eventbrite  the /d/<place>/events/ page sets a csrftoken cookie and carries
              window.__SERVER_DATA__ with the numeric placeId. That pair
              authorises their internal destination-search endpoint, which
              paginates the whole place instead of the ~34 events the page
              renders. No account, no key.
  Meetup      the /find/ page ships its Apollo cache in __NEXT_DATA__, with
              fully hydrated Event objects including venue coordinates.

Both need a browser User-Agent; ProximiBot gets a bot challenge from Eventbrite.
That is the only concession — we send no credentials and read only public pages.

Neither platform is geographically scoped the way Ticketmaster's radius search
is, so we sweep a ring of place slugs across the valley and filter to the
registry radius afterwards. Events outside it are dropped here, not downstream.

  python3 scripts/social.py [--pages 8] [--out build/social.json]
"""

import argparse, http.cookiejar, json, math, os, re, sys, time
import urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')

EB_SEARCH = 'https://www.eventbrite.com/api/v3/destination/search/'
EB_EXPAND = ['primary_venue', 'image', 'ticket_availability', 'primary_organizer']

# Place slugs whose catchments together cover the 75-mile ring around Beacon.
# Eventbrite dedups within a place but not across them; ids are unique so the
# overlap collapses on merge.
EB_PLACES = ['ny--beacon', 'ny--poughkeepsie', 'ny--newburgh', 'ny--kingston',
             'ny--middletown', 'ny--peekskill', 'ny--white-plains', 'ny--nyack',
             'ct--danbury']

MEETUP_PLACES = ['us--ny--Beacon', 'us--ny--Poughkeepsie', 'us--ny--Newburgh',
                 'us--ny--Kingston', 'us--ny--White Plains', 'us--ct--Danbury']

# Eventbrite's category vocabulary onto ours, mirroring platforms.py SEGMENT.
EB_CATEGORY = {
    'Music': 'music', 'Food & Drink': 'food', 'Arts': 'art', 'Film & Media': 'film',
    'Community': 'community', 'Sports & Fitness': 'sports', 'Health': 'wellness',
    'Family & Education': 'family', 'Business': 'community', 'Charity & Causes': 'community',
    'Seasonal & Holiday': 'seasonal', 'Home & Lifestyle': 'community',
    'Hobbies': 'community', 'Fashion': 'community', 'Performing & Visual Arts': 'art',
    'Travel & Outdoor': 'outdoors', 'Government': 'community', 'Science & Technology': 'community',
    'Spirituality': 'community', 'Auto, Boat & Air': 'community', 'Other': None,
}


def opener():
    """One cookie jar per platform; Eventbrite's CSRF pairs with its session."""
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def fetch(op, url, data=None, headers=None, tries=3):
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data,
                                     headers={'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9',
                                              **(headers or {})})
        try:
            with op.open(req, timeout=40) as r:
                return r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < tries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def brace_json(text, marker):
    """Decode the first brace-balanced object after `marker`.

    These bundles append trailing JavaScript, so a greedy regex match will not
    parse; walk the braces instead. String-aware, or a `}` inside a title ends
    the object early.
    """
    at = text.find(marker)
    if at < 0:
        return None
    start = text.find('{', at)
    if start < 0:
        return None
    try:
        return json.JSONDecoder().raw_decode(text[start:])[0]
    except ValueError:
        return None


def miles(lat1, lon1, lat2, lon2):
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return 3958.8 * 2 * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------- #
# Eventbrite
# --------------------------------------------------------------------------- #

def eventbrite_place(op, slug, pages):
    seed = f'https://www.eventbrite.com/d/{slug}/events/'
    html = fetch(op, seed)
    data = brace_json(html, 'window.__SERVER_DATA__')
    place_id = (data or {}).get('placeId')
    csrf = next((c.value for c in op.handlers[0].cookiejar if c.name == 'csrftoken'), None) \
        if hasattr(op.handlers[0], 'cookiejar') else None
    if csrf is None:
        for h in op.handlers:
            jar = getattr(h, 'cookiejar', None)
            if jar:
                csrf = next((c.value for c in jar if c.name == 'csrftoken'), None)
                break
    if not place_id or not csrf:
        raise RuntimeError('no placeId/csrftoken from seed page')

    out, continuation = [], None
    for page in range(1, pages + 1):
        search = {'dates': 'current_future', 'dedup': True, 'places': [str(place_id)],
                  'page': page, 'page_size': 50}
        if continuation:
            search['continuation'] = continuation
        body = json.dumps({'event_search': search,
                           'expand.destination_event': EB_EXPAND}).encode()
        payload = json.loads(fetch(op, EB_SEARCH, data=body, headers={
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'X-CSRFToken': csrf, 'Referer': seed, 'Origin': 'https://www.eventbrite.com'}))
        block = payload.get('events') or {}
        results = block.get('results') or []
        if not results:
            break
        out.extend(results)
        pagination = block.get('pagination') or {}
        continuation = pagination.get('continuation')
        if page >= pagination.get('page_count', 1):
            break
        time.sleep(0.7)
    return out


def local_iso(date, clock, tzname):
    """Eventbrite gives wall-clock plus an IANA zone and no offset.

    The schema requires an explicit offset, and the valley straddles a DST
    boundary every autumn, so resolve the offset against the event's own date
    rather than stamping a fixed -04:00 on everything.
    """
    if not date:
        return None
    if not clock:
        return date                                  # date-only; no offset to give
    naive = datetime.fromisoformat(f'{date}T{clock}')
    try:
        return naive.replace(tzinfo=ZoneInfo(tzname or 'America/New_York')).isoformat()
    except (ZoneInfoNotFoundError, ValueError):
        return naive.isoformat()


def eventbrite_event(e):
    v = e.get('primary_venue') or {}
    a = v.get('address') or {}
    tz = e.get('timezone') or 'America/New_York'
    start = local_iso(e.get('start_date'), e.get('start_time'), tz)
    end = local_iso(e.get('end_date'), e.get('end_time'), tz)
    cats = []
    for t in e.get('tags') or []:
        if t.get('prefix') == 'EventbriteCategory':
            mapped = EB_CATEGORY.get(t.get('display_name'))
            if mapped:
                cats.append(mapped)
    avail = e.get('ticket_availability') or {}
    free = avail.get('is_free')
    price = None
    if free is False and avail.get('minimum_ticket_price'):
        lo = avail['minimum_ticket_price'].get('major_value')
        hi = (avail.get('maximum_ticket_price') or {}).get('major_value', lo)
        if lo is not None:
            price = {'min': float(lo), 'max': float(hi or lo), 'note': 'Eventbrite ticket price'}
    elif free is True:
        price = {'min': 0.0, 'max': 0.0, 'note': 'Free on Eventbrite'}

    return {
        'sourceId': 'eventbrite', 'sourceName': 'Eventbrite',
        'title': e.get('name'), 'start': start, 'end': end, 'allDay': False,
        'url': e.get('url') or f"https://www.eventbrite.com/e/{e.get('id')}",
        'venue': v.get('name'),
        'city': ', '.join(filter(None, [a.get('city'), a.get('region')])) or None,
        'address': a.get('address_1'),
        'lat': float(a['latitude']) if a.get('latitude') else None,
        'lon': float(a['longitude']) if a.get('longitude') else None,
        'price': price,
        'categories': sorted(set(cats)),
        'description': e.get('summary'),
        'signupRequired': True,
        'signupUrl': e.get('tickets_url') or e.get('url'),
    }


# --------------------------------------------------------------------------- #
# Meetup
# --------------------------------------------------------------------------- #

NEXT_DATA = re.compile(r'id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


def meetup_place(op, location):
    url = 'https://www.meetup.com/find/?' + urllib.parse.urlencode(
        {'location': location, 'source': 'EVENTS'})
    m = NEXT_DATA.search(fetch(op, url))
    if not m:
        return []
    apollo = ((json.loads(m.group(1)).get('props') or {}).get('pageProps') or {}).get('__APOLLO_STATE__') or {}

    def deref(ref):
        return apollo.get(ref['__ref']) if isinstance(ref, dict) and '__ref' in ref else ref

    ORDINAL = {1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'last', -1: 'last'}

    def recurrence_of(node):
        """Meetup's stated cadence for a recurring event, or None.

        The find page lists only the *next* occurrence of a series, so a monthly
        group arrives as a single dated event and nothing downstream can infer a
        pattern from one date. The series object says it outright — including a
        ready-made human phrase — so take it rather than guess.
        """
        series = deref(node.get('series'))
        if not isinstance(series, dict):
            return None
        monthly = deref(series.get('monthlyRecurrence'))
        if isinstance(monthly, dict) and monthly.get('monthlyDayOfWeek'):
            week = ORDINAL.get(monthly.get('monthlyWeekOfMonth'))
            day = str(monthly['monthlyDayOfWeek']).capitalize()
            if week:
                return f'Every {week} {day} of the month'
            return f'Every month on a {day}'
        weekly = deref(series.get('weeklyRecurrence'))
        if isinstance(weekly, dict) and weekly.get('weeklyDaysOfWeek'):
            days = [str(d).capitalize() for d in weekly['weeklyDaysOfWeek']]
            joined = days[0] if len(days) == 1 else f"{', '.join(days[:-1])} & {days[-1]}"
            every = 'Every' if (weekly.get('weeklyInterval') or 1) == 1 else 'Every other'
            return f'{every} {joined}'
        text = series.get('description')
        return text.strip() if isinstance(text, str) and text.strip() else None

    out = []
    for key, node in apollo.items():
        if not key.startswith('Event:') or not isinstance(node, dict) or not node.get('title'):
            continue
        venue = deref(node.get('venue')) or {}
        group = deref(node.get('group')) or {}
        repeats = recurrence_of(node)
        out.append({
            'sourceId': 'meetup', 'sourceName': 'Meetup',
            'title': node.get('title'), 'start': node.get('dateTime'),
            'end': node.get('endTime'), 'allDay': False,
            'repeats': bool(repeats), 'recurrence': repeats,
            'url': node.get('eventUrl'),
            'venue': venue.get('name') or ('Online' if node.get('eventType') == 'ONLINE' else None),
            'city': ', '.join(filter(None, [venue.get('city'), venue.get('state')])) or None,
            'address': venue.get('address'),
            'lat': venue.get('lat'), 'lon': venue.get('lng') or venue.get('lon'),
            'price': None,
            'categories': ['community'],
            'description': node.get('description'),
            'signupRequired': True,
            'signupUrl': node.get('eventUrl'),
            '_group': group.get('name'),
        })
    return out


# --------------------------------------------------------------------------- #

def sweep(label, places, harvester, center, report):
    """Run one platform across its place ring, dedup by url, filter to radius."""
    seen, kept, dropped, failed = {}, 0, 0, 0
    for place in places:
        op = opener()
        try:
            raw = harvester(op, place)
        except Exception as exc:                            # one dead slug must not kill the sweep
            failed += 1
            report.append({'source': f'{label}:{place}', 'ok': False, 'error': str(exc)[:120]})
            continue
        for rec in raw:
            if not rec.get('url') or rec['url'] in seen:
                continue
            if rec.get('lat') is not None and rec.get('lon') is not None:
                if miles(center['lat'], center['lon'], rec['lat'], rec['lon']) > center['radiusMiles']:
                    dropped += 1
                    continue
            elif rec.get('venue') == 'Online':
                dropped += 1                                # online events are not "near me"
                continue
            seen[rec['url']] = rec
            kept += 1
        report.append({'source': f'{label}:{place}', 'ok': True, 'raw': len(raw)})
        time.sleep(0.5)
    print(f'{label:<12} {kept:>5}  ok  ({dropped} outside radius, {failed} slug failures)')
    return list(seen.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--pages', type=int, default=8, help='Eventbrite pages per place (50/page)')
    ap.add_argument('--out', default='build/social.json')
    args = ap.parse_args()

    center = json.load(open(args.registry))['center']
    report, events = [], []

    events += sweep('eventbrite', EB_PLACES,
                    lambda op, slug: [eventbrite_event(e) for e in eventbrite_place(op, slug, args.pages)],
                    center, report)
    events += sweep('meetup', MEETUP_PLACES, meetup_place, center, report)

    events.sort(key=lambda e: e.get('start') or '9999')
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'fetchedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
               'report': report, 'events': events},
              open(args.out, 'w'), indent=2, ensure_ascii=False)

    geo = sum(1 for e in events if e['lat'] is not None)
    priced = sum(1 for e in events if e['price'])
    print(f'\n{len(events)} events ({geo} with coordinates, {priced} with a price) → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
