#!/usr/bin/env python3
"""Springshare LibCal — public library programming.

Libraries run the most genuinely local calendar in the county: book clubs,
lectures, film nights, craft sessions. None of it reaches Eventbrite.

LibCal publishes nothing useful in bulk. Its documented iCal export answers a
19-byte empty body without an authenticated subscription, and rss.php returns a
well-formed feed containing zero items. What does work is the endpoint the
calendar page itself calls:

  https://<slug>.libcal.com/ajax/calendar/list?c=-1&date=YYYY-MM-DD

`c=-1` means every calendar (c=0 is rejected outright), and it answers for one
day at a time — so covering a season means walking the days. That is why this
is its own script with a bounded window rather than a registry feed.

  python3 scripts/libcal.py [--days 45] [--out build/libcal.json]
"""

import argparse, json, os, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

UA = 'Mozilla/5.0 (compatible; ProximiBot/0.1; +https://github.com/StarrySidekick/Proximi)'
AJAX = 'https://{slug}.libcal.com/ajax/calendar/list?c=-1&date={day}&perpage=100'

# slug -> (publisher, town). Found by probing <slug>.libcal.com; the ones that
# answered nothing are recorded in sources/institutions.txt, not here.
LIBRARIES = {
    'greenburghlibrary':  ('Greenburgh Public Library', 'Elmsford, NY'),
    'newburghlibrary':    ('Newburgh Free Library', 'Newburgh, NY'),
    'mountkiscolibrary':  ('Mount Kisco Public Library', 'Mount Kisco, NY'),
    'brewsterlibrary':    ('Brewster Public Library', 'Brewster, NY'),
    'irvingtonlibrary':   ('Irvington Public Library', 'Irvington, NY'),
    'ryelibrary':         ('Rye Free Reading Room', 'Rye, NY'),
    'grinnell-library':   ('Grinnell Library, Wappingers Falls', 'Wappingers Falls, NY'),
}


def fetch_day(args):
    slug, day = args
    url = AJAX.format(slug=slug, day=day.isoformat())
    try:
        req = urllib.request.Request(url, headers={'User-Agent': UA,
                                                   'X-Requested-With': 'XMLHttpRequest'})
        with urllib.request.urlopen(req, timeout=20) as r:
            payload = json.loads(r.read().decode('utf-8', 'replace'))
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError, OSError):
        return slug, day, []
    return slug, day, payload.get('results') or []


def to_event(rec, day, slug):
    """LibCal gives a clock time ("6:00pm"), not a timestamp — pair it with the
    day we asked for. An all-day entry has no parseable time."""
    clock = (rec.get('start') or '').strip()
    when, all_day = None, False
    for fmt in ('%I:%M%p', '%I%p', '%H:%M'):
        try:
            t = datetime.strptime(clock.replace(' ', '').lower(), fmt.lower()).time()
            when = datetime.combine(day, t)
            break
        except ValueError:
            continue
    if when is None:
        when, all_day = datetime.combine(day, datetime.min.time()), True

    publisher, town = LIBRARIES[slug]
    return {
        'sourceId': f'libcal:{slug}', 'sourceName': publisher,
        'title': rec.get('title'),
        # LibCal serves local wall-clock; the whole registry is one timezone.
        'start': when.isoformat() + '-04:00',
        'end': None, 'allDay': all_day,
        'url': rec.get('url') or f'https://{slug}.libcal.com',
        # LibCal's location is the room — "Multipurpose Room", "Program Room" —
        # which is where in the building, not which building. The library is
        # the venue; the room belongs with the address.
        'venue': publisher,
        'room': (rec.get('location') or '').strip() or None,
        # Include the town: "Brewster Public Library" alone resolves to
        # Brewster, Washington, and every event was dropped as out of radius.
        'city': town,
        'address': ', '.join(filter(None, [(rec.get('location') or '').strip(),
                                           publisher, town])),
        'lat': None, 'lon': None,
        'price': {'min': 0.0, 'max': 0.0, 'note': 'Free at the library'},
        'categories': ['community'],
        'description': rec.get('description'),
        'signupRequired': bool(rec.get('registration')),
        'signupUrl': rec.get('url') if rec.get('registration') else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=45, help='days ahead to walk')
    ap.add_argument('--workers', type=int, default=8)
    ap.add_argument('--out', default='build/libcal.json')
    args = ap.parse_args()

    start = date.today()
    jobs = [(slug, start + timedelta(days=n))
            for slug in LIBRARIES for n in range(args.days)]

    events, per_slug = [], {s: 0 for s in LIBRARIES}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for slug, day, results in pool.map(fetch_day, jobs):
            for rec in results:
                if not rec.get('title'):
                    continue
                events.append(to_event(rec, day, slug))
                per_slug[slug] += 1

    for slug, n in sorted(per_slug.items(), key=lambda kv: -kv[1]):
        flag = ' ' if n else '!'
        print(f'{flag} {LIBRARIES[slug][0]:<32} {n:>4}')

    events.sort(key=lambda e: e['start'])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'fetchedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
               'events': events}, open(args.out, 'w'), indent=2, ensure_ascii=False)
    print(f'\n{len(events)} library events over {args.days} days → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
