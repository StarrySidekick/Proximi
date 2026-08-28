#!/usr/bin/env python3
"""Cinema — the two local film houses that serve their schedule as HTML.

Independent cinemas are the worst-served category in the registry. Almost all
of them run a ticketing SPA (Indy Systems, Filmbot's hosted app, Agile
Ticketing behind Imperva), so the served HTML is a shell and there is nothing
to read. Of twenty-odd theatres inside fifty miles, exactly two render their
schedule into the page:

  Jacob Burns Film Center  every showtime carries an ISO `data-showtime`
                           attribute, so no date arithmetic is needed. The
                           page is a rolling three-day window — today plus
                           two — and ignores any ?date= parameter, so a weekly
                           run keeps it current and there is nothing to page
                           through.

  Rosendale Theatre        a Filmbot month grid. Each day is a gridcell whose
                           child <li>s carry the whole show card in an escaped
                           `data-show-card` attribute: title, link, blurb and
                           that day's times. Month navigation is a path
                           segment, /calendar/YYYY-MM, not a query parameter.

Everything else in the cinema tier is read by hand into sources/manual.json.

The two are hard-coded rather than driven off the registry because each needs
its own parser anyway; a `kind` for "one of two bespoke cinema readers" would
be a registry field that only ever has two values.

  python3 scripts/cinema.py [--months 2] [--out build/cinema.json]
"""

import argparse, html, json, os, re, sys, time, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')

EASTERN = ZoneInfo('America/New_York')

JBFC = {
    'venue': 'Jacob Burns Film Center',
    'city': 'Pleasantville, NY',
    'address': '364 Manville Rd, Pleasantville, NY 10570',
    'lat': 41.1352, 'lon': -73.7847,
    'source': 'Jacob Burns Film Center',
}

ROSENDALE = {
    'venue': 'Rosendale Theatre',
    'city': 'Rosendale, NY',
    'address': '330 Main St, Rosendale, NY 12472',
    'lat': 41.8434, 'lon': -74.0779,
    'source': 'Rosendale Theatre',
}

# A cinema's own programming is not always a film. These run in the same
# schedule and the same seats, but calling them "film" would put an opera and
# a stand-up set behind the film filter and nowhere else.
NOT_FILM = (
    (re.compile(r'\b(met opera|opera|the met:|the musical)\b', re.I), 'musical'),
    (re.compile(r'\b(nt live|national theatre live|the play|on stage)\b', re.I), 'play'),
    (re.compile(r'\b(stand-?up|comedy night)\b', re.I), 'comedy show'),
    (re.compile(r'\b(live music|concert|in concert)\b', re.I), 'concert'),
    (re.compile(r'\btrivia\b', re.I), 'trivia'),
)

# A screening with a guest is worth surfacing as such — it is the difference
# between "a film is on" and "a thing is happening".
WITH_QA = re.compile(r'\b(q&a|q and a|meet the (director|cast)|filmmaker|'
                     r'in person|discussion)\b', re.I)


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


def strip_tags(s):
    s = re.sub(r'(?s)<[^>]+>', ' ', s or '')
    return re.sub(r'\s+', ' ', html.unescape(s)).strip()


def types_for(title):
    for pattern, kind in NOT_FILM:
        if pattern.search(title):
            return [kind, 'film'] if kind != 'trivia' else [kind]
    return ['film', 'q&a'] if WITH_QA.search(title) else ['film']


def shape(title, start, url, house, description=None):
    """One screening, in the shape enrich.py passes through untouched."""
    kinds = types_for(title)
    return {
        'id': 'cinema-{}-{}'.format(
            re.sub(r'[^a-z0-9]+', '-', house['venue'].lower()).strip('-'),
            re.sub(r'[^a-z0-9]+', '-', f'{title.lower()}-{start[:16]}').strip('-')),
        'title': title,
        'type': kinds[0],
        'types': kinds,
        'start': start,
        'end': None,
        'repeats': False,
        'audience': 'all',
        'setting': 'indoor',
        'timeOfDay': 'nighttime' if int(start[11:13]) >= 17 else 'daytime',
        'hasFood': False,
        'venue': house['venue'],
        'city': house['city'],
        'address': house['address'],
        'lat': house['lat'],
        'lon': house['lon'],
        'price': None,
        'signupRequired': False,
        'signupUrl': url,
        'url': url,
        'description': description or None,
        'host': house['venue'],
        'source': house['source'],
    }


# --- Jacob Burns ------------------------------------------------------------

JB_ITEM = re.compile(
    r"<li class='list-group-item schedule-item'>(.*?)</li>", re.S)
JB_TITLE = re.compile(
    r"<h3 class='schedule-title'><a href=\"([^\"]+)\">(.*?)</a></h3>", re.S)
JB_TIME = re.compile(r"data-showtime='([^']+)'")


def read_jbfc():
    page = fetch('https://burnsfilmcenter.org/film')
    out = []
    for block in JB_ITEM.findall(page):
        head = JB_TITLE.search(block)
        if not head:
            continue
        url, title = head.group(1), strip_tags(head.group(2))
        for stamp in JB_TIME.findall(block):
            try:
                datetime.fromisoformat(stamp)
            except ValueError:
                continue
            out.append(shape(title, stamp, url, JBFC))
    return out


# --- Rosendale --------------------------------------------------------------

# The gridcell opening tag through to the next one. Days with no shows carry
# no <li>, so an empty capture is the normal case, not a parse failure.
RZ_DAY = re.compile(r'id="calendar-day-(\d{4}-\d{2}-\d{2})"(.*?)(?=id="calendar-day-|<div class="calendar-footer|\Z)', re.S)
# Read the card out of the *escaped* attribute: every quote inside it is
# &quot;, so the attribute delimiters are unambiguous. Unescape after slicing,
# never before — unescaping first dissolves the boundary.
RZ_CARD = re.compile(r'data-show-card="([^"]*)"')
RZ_H2 = re.compile(r'<h2>(.*?)</h2>', re.S)
RZ_LINK = re.compile(r'href="(https://rosendaletheatre\.org/movies/[^"]+)"')
RZ_SUB = re.compile(r'<span class="show__subtitle"><p>(.*?)</p>', re.S)
RZ_TIME = re.compile(r'class="showtime(?: [^"]*)?">\s*([0-9]{1,2}:[0-9]{2}\s*[apAP]\.?[mM])\s*<')


def read_rosendale(months):
    out, month = [], datetime.now(EASTERN).replace(day=1)
    for _ in range(months):
        url = f'https://rosendaletheatre.org/calendar/{month:%Y-%m}'
        try:
            page = fetch(url)
        except Exception as exc:
            print(f'! rosendale {month:%Y-%m}: {exc}', file=sys.stderr)
            break
        for day, body in RZ_DAY.findall(page):
            for raw in RZ_CARD.findall(body):
                card = html.unescape(raw)
                head = RZ_H2.search(card)
                link = RZ_LINK.search(card)
                if not head or not link:
                    continue
                title = strip_tags(head.group(1))
                blurb = RZ_SUB.search(card)
                for clock in RZ_TIME.findall(card):
                    stamp = to_iso(day, clock)
                    if stamp:
                        out.append(shape(title, stamp, link.group(1), ROSENDALE,
                                         strip_tags(blurb.group(1)) if blurb else None))
        month = (month + timedelta(days=32)).replace(day=1)
        time.sleep(0.6)
    return out


# --- Independent Cinemas (Lyceum, Roosevelt, New Paltz) ---------------------

# One small operator runs three houses — Red Hook, Hyde Park and New Paltz —
# off one server-rendered page each, in a format that has not changed in
# years: a date header, then alternating title and times lines.
#
#   Friday thru Wednesday 8/28 - 9/2
#   COYOTE VS. ACME (PG)
#   1:15 4:00 7:00 9:05
#
# The times carry no meridiem because a cinema's day starts at noon. Every
# time on all three pages falls between 12:45 and 9:20, so 12 reads as noon
# and 1-9 as afternoon and evening. 10 and 11 are genuinely ambiguous and are
# dropped with a warning rather than guessed at — see clock_pm().
GMLP = [
    ('lyceum-cinemas', {
        'venue': 'Lyceum Cinemas', 'city': 'Red Hook, NY',
        'address': '15 Old Farm Rd, Red Hook, NY 12571',
        'lat': 41.9945, 'lon': -73.8716, 'source': 'Independent Cinemas'}),
    ('roosevelt-cinemas', {
        'venue': 'Roosevelt Cinemas', 'city': 'Hyde Park, NY',
        'address': '4060 Albany Post Rd, Hyde Park, NY 12538',
        'lat': 41.7846, 'lon': -73.9330, 'source': 'Independent Cinemas'}),
    ('new-paltz-cinemas', {
        'venue': 'New Paltz Cinemas', 'city': 'New Paltz, NY',
        'address': '2 New Paltz Plaza, New Paltz, NY 12561',
        'lat': 41.7471, 'lon': -74.0868, 'source': 'Independent Cinemas'}),
]

GM_HEAD = re.compile(
    r'^(?:mon|tue|wed|thu|fri|sat|sun)\w*(?:\s+thru\s+\w+)?\s+'
    r'(\d{1,2})/(\d{1,2})(?:\s*[-–]\s*(\d{1,2})/(\d{1,2}))?\s*$', re.I)
GM_TIMES = re.compile(r'^(?:\d{1,2}:\d{2}\s*)+$')
GM_RATING = re.compile(r'\s*\((G|PG|PG13|PG-13|R|NC17|NC-17|NR)\)\s*$', re.I)


# Titles come off the page shouted. Plain .title() would render "Insidious:
# Out of the Further" as "Out Of The Further", so the joining words stay down
# unless they open the title or follow a colon.
MINOR = {'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
         'nor', 'of', 'on', 'or', 'the', 'to', 'up', 'vs', 'with'}


def headline(text):
    if not text.isupper():
        return text
    words, out, opening = text.split(), [], True
    for word in words:
        lowered = word.lower()
        cased = '-'.join(p.capitalize() for p in lowered.split('-'))
        out.append(cased if opening or lowered.strip('.,:') not in MINOR else lowered)
        opening = word.endswith(':')
    return ' '.join(out)


def page_lines(page):
    body = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', page)
    body = html.unescape(re.sub(r'(?s)<[^>]+>', '\n', body))
    return [l.strip() for l in body.split('\n') if l.strip()]


def near_year(month, day, today):
    """Resolve a bare M/D against today, rolling the year at the boundary."""
    for year in (today.year, today.year + 1, today.year - 1):
        try:
            when = datetime(year, month, day, tzinfo=EASTERN)
        except ValueError:
            continue
        if -120 <= (when.date() - today.date()).days <= 245:
            return when
    return None


def clock_pm(hour, minute):
    if hour in (10, 11):
        return None
    return (12 if hour == 12 else hour + 12), minute


def read_gmlp():
    today, out = datetime.now(EASTERN), []
    for slug, house in GMLP:
        try:
            lines = page_lines(fetch(f'https://greatmovieslowerprices.com/{slug}/'))
        except Exception as exc:
            print(f'! {slug}: {exc}', file=sys.stderr)
            continue
        span, previous, found = None, '', 0
        for line in lines:
            if line.lower().startswith('coming soon'):
                span = None
            head = GM_HEAD.match(line)
            if head:
                first = near_year(int(head.group(1)), int(head.group(2)), today)
                last = (near_year(int(head.group(3)), int(head.group(4)), today)
                        if head.group(3) else first)
                span = (first, last) if first and last and last >= first else None
            elif span and GM_TIMES.match(line) and previous:
                title = headline(GM_RATING.sub('', previous).strip())
                clocks = []
                for clock in line.split():
                    hour, minute = (int(x) for x in clock.split(':'))
                    pm = clock_pm(hour, minute)
                    if pm:
                        clocks.append(pm)
                    else:
                        print(f'! {slug}: ambiguous time {clock} for {title}',
                              file=sys.stderr)
                if not clocks:
                    continue
                # One card per film per day, not per showtime. Four rows of the
                # same film four hours apart is the same answer to "what can I
                # see tonight" printed four times; the times belong in the card.
                shown = ', '.join(f'{h - 12 if h > 12 else h}:{m:02d}' for h, m in clocks)
                day = span[0]
                while day <= span[1]:
                    start = day.replace(hour=clocks[0][0], minute=clocks[0][1],
                                        second=0, microsecond=0)
                    out.append(shape(
                        title, start.isoformat(timespec='seconds'),
                        f'https://greatmovieslowerprices.com/{slug}/', house,
                        f'Showtimes that day: {shown} pm.'))
                    found += 1
                    day += timedelta(days=1)
            previous = line
        print(f'    {house["venue"]:<20} {found:>4}')
    return out


def to_iso(day, clock):
    clean = re.sub(r'[.\s]', '', clock).lower()
    try:
        when = datetime.strptime(f'{day} {clean}', '%Y-%m-%d %I:%M%p')
    except ValueError:
        return None
    return when.replace(tzinfo=EASTERN).isoformat(timespec='seconds')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--months', type=int, default=2,
                    help='months of the Rosendale calendar to walk')
    ap.add_argument('--out', default='build/cinema.json')
    args = ap.parse_args()

    events, seen = [], set()
    for label, reader in (('jacob burns', read_jbfc),
                          ('rosendale', lambda: read_rosendale(args.months)),
                          ('independent cinemas', read_gmlp)):
        try:
            got = reader()
        except Exception as exc:
            print(f'! {label}: {exc}', file=sys.stderr)
            continue
        fresh = [e for e in got if e['id'] not in seen]
        seen.update(e['id'] for e in fresh)
        events.extend(fresh)
        print(f'  {label:<14} {len(fresh):>4} screenings')

    # A cinema page keeps the day's earlier showings on it, greyed out. They
    # are real, they have simply already happened.
    now = datetime.now(EASTERN)
    events = [e for e in events if datetime.fromisoformat(e['start']) >= now]
    events.sort(key=lambda e: e['start'])

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'fetchedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
               'events': events}, open(args.out, 'w'), indent=2, ensure_ascii=False)
    print(f'\n{len(events)} upcoming screenings → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
