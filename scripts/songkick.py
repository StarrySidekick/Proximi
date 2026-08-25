#!/usr/bin/env python3
"""Songkick — the ticketed-concert layer.

The venues that host the region's date-night shows (the Capitol Theatre,
Tarrytown Music Hall, Daryl's House Club, The Chance) either answer our
fetches with bot challenges or render entirely in JavaScript, so reading them
one by one fails. Songkick aggregates all of their listings, and its metro
pages emit one schema.org MusicEvent block per show — with venue coordinates
and a ticket link — to plain HTML. Their search and API endpoints answer 406,
but the metro pages themselves serve fine with a browser User-Agent.

Metro 7644 is "New York", which Songkick draws widely enough to include
Westchester (the Capitol Theatre is in it). Everything gets radius-filtered
downstream, and the events are pre-shaped with real coordinates, so nothing
here needs geocoding.

  python3 scripts/songkick.py [--pages 12] [--out build/songkick.json]
"""

import argparse, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')

METROS = [('7644-us-new-york', 'New York')]

LD = re.compile(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', re.S | re.I)


def fetch(url, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode('utf-8', 'replace')
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def events_on(html):
    out = []
    for block in LD.findall(html):
        try:
            parsed = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        for node in parsed if isinstance(parsed, list) else [parsed]:
            if 'Event' in str(node.get('@type', '')):
                out.append(node)
    return out


def to_event(n):
    loc = n.get('location') or {}
    addr = loc.get('address') or {}
    geo = loc.get('geo') or {}
    offers = n.get('offers') or {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    url = n.get('url')
    lat, lon = geo.get('latitude'), geo.get('longitude')
    if not url or lat is None or lon is None:
        return None
    # A date with no time is an on-sale announcement, not a show you can plan
    # an evening around; the schema requires a real timestamp and inventing
    # 8pm would be fabrication. They reappear with times as the date nears.
    if 'T' not in str(n.get('startDate', '')):
        return None
    performer = n.get('performer')
    if isinstance(performer, list):
        performer = performer[0] if performer else None
    return {
        'sourceId': 'songkick', 'sourceName': 'Songkick',
        'title': n.get('name'),
        # Songkick emits local wall-clock with no offset; one metro, one zone.
        'start': (n.get('startDate') or '') + ('-04:00' if 'T' in str(n.get('startDate', '')) else ''),
        'end': None, 'allDay': False,
        'type': 'concert',
        'url': url,
        'venue': loc.get('name'),
        'city': ', '.join(filter(None, [addr.get('addressLocality'),
                                        addr.get('addressRegion')])) or None,
        'address': addr.get('streetAddress'),
        'lat': float(lat), 'lon': float(lon),
        'price': None,                      # offers carry a link, not a number
        'categories': ['music'],
        'description': None,                # theirs is boilerplate "Buy tickets…"
        'host': (performer or {}).get('name') if isinstance(performer, dict) else loc.get('name'),
        'signupRequired': True,
        'signupUrl': offers.get('url') or url,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pages', type=int, default=12, help='pages per metro (50 events each)')
    ap.add_argument('--out', default='build/songkick.json')
    args = ap.parse_args()

    seen, events = set(), []
    for metro, label in METROS:
        got = 0
        for page in range(1, args.pages + 1):
            url = f'https://www.songkick.com/metro-areas/{metro}' + (f'?page={page}' if page > 1 else '')
            try:
                nodes = events_on(fetch(url))
            except Exception as exc:
                print(f'! {label} page {page}: {exc}', file=sys.stderr)
                break
            if not nodes:
                break
            for n in nodes:
                e = to_event(n)
                if e and e['url'] not in seen:
                    seen.add(e['url'])
                    events.append(e)
                    got += 1
            time.sleep(0.6)
        print(f'  {label:<12} {got:>5} shows')

    events.sort(key=lambda e: e['start'])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'fetchedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
               'events': events}, open(args.out, 'w'), indent=2, ensure_ascii=False)
    print(f'\n{len(events)} concerts → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
