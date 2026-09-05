#!/usr/bin/env python3
"""Read a place's own website and decide whether it publishes anything at all.

Most of the directory has no listings, and the page could not say why. "Nothing
scheduled here" covered two completely different facts: a place that publishes a
calendar we have not collected yet, and a place that publishes nothing anywhere
and never will. The second is most of them — a garden, an antique shop, a
lookout — and saying so is more useful than an empty space, because it tells the
reader there is nothing to come back for.

So: read the site once, decide, write the verdict down, and do not read it again
unless something changes. What counts as event information is deliberately wide.
A brewery's "Trivia every Tuesday, 7pm" and a farm's "Fall Sale, Oct 3-5" are
both things happening at a time, which is the whole premise of this app, and a
site is only labelled quiet when none of it is there.

  python3 scripts/audit.py --limit 150          # next batch of unaudited domains
  python3 scripts/audit.py --verify --limit 300 # re-read quiet sites, re-audit
                                                #   only those that have changed
  python3 scripts/audit.py --recheck domain.com # force one, whatever we stored
  python3 scripts/audit.py --report             # what is in the file, no network

Verdicts, per domain:

  feed        an iCal feed with future events — register it, do not label it
  listings    a calendar, a programme, schema.org events, a platform embed
  specials    no calendar, but dated sales/deals/specials/weekly nights
  none        read it, found nothing — this is the one the card labels
  unreadable  the server sends a shell and the browser draws the site
  blocked     the site is there and will not serve a declared bot (403, 429)
  parked      a default server or registrar page, not the venue's site
  unreachable no response at all (DNS, refused, timed out)
  suspect     the domain is serving something the venue plainly did not put
              there — see the hijacked-cinema note in the refresh skill

Only `none` reaches the page, as "no event calendar" on the place's card. The
three ways of failing to read a site deliberately do not: a site we could not
read is not a site with nothing on it, and saying otherwise would be a guess
presented as a check.
"""

import argparse, gzip, hashlib, html, json, os, re, sys, time, zlib
import http.cookiejar, urllib.error, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

# A 400-domain batch is watched through a log file, and Python block-buffers
# stdout the moment it is redirected — which reads as a run that has hung when
# it is simply four kilobytes short of a flush. places.py does the same.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import discover

UA = ('Mozilla/5.0 (compatible; ProximiBot/0.1; '
      '+https://github.com/StarrySidekick/Proximi)')

AUDIT_PATH = 'sources/placeaudit.json'

# How long a verdict stands before it is worth asking again. A quiet site
# rarely becomes a busy one, and when it does it is because somebody added an
# events page — which --verify notices from the homepage alone, for one request
# instead of ten. The long horizon here is the backstop, not the mechanism.
RECHECK_DAYS = {
    'none': 365,
    'specials': 240,
    'listings': 180,
    'feed': 180,
    'suspect': 365,
    'unreadable': 120,
    'blocked': 120,
    'parked': 180,
    'unreachable': 45,
}

# Pages worth opening, and the words that make a link one of them. Both halves
# matter: the href is right on tidy sites and the link text is all there is on
# the ones that route everything through /page/12.
EVENT_LINK = re.compile(
    r'event|calendar|whats?[-_ ]?on|upcoming|happening|programme?s?\b|schedule|'
    r'exhibit|shows?\b|performances?|concerts?|gigs?|screenings?|workshops?|'
    r'classes|tastings?|live[-_ ]?music|tickets?|festival|what-to-do|visit/|'
    r'movies?\b|films?\b|now[-_ ]?(?:playing|showing)|showtimes?',
    re.I)
DEAL_LINK = re.compile(
    r'special|deals?\b|happy[-_ ]?hour|promotion|offers?\b|sales?\b|discount|'
    r'trivia|karaoke|bingo|open[-_ ]?mic|book[-_ ]?club|story[-_ ]?time',
    re.I)

# The same vocabulary in body text, where it is evidence rather than navigation.
EVENT_WORDS = re.compile(
    r'\b(event|events|calendar|upcoming|schedule|programme|program|exhibition|'
    r'performance|concert|screening|workshop|class|tasting|festival|matinee|'
    r'showtimes?|now (?:playing|showing)|doors\s+(?:open|at)|rsvp|tickets?)\b',
    re.I)
DEAL_WORDS = re.compile(
    r"\b(special|specials|deal|deals|happy hour|promotion|sale|clearance|"
    r"discount|prix[- ]fixe|tap takeover|trivia|karaoke|bingo|open mic|"
    r"story ?time|book club|farmers.? market|pick[- ]your[- ]own)\b", re.I)

MONTHS = (r'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|'
          r'jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|'
          r'dec(?:ember)?')
DATED = re.compile(
    rf'\b(?:{MONTHS})\.?\s+\d{{1,2}}\b|\b\d{{1,2}}/\d{{1,2}}(?:/\d{{2,4}})?\b|'
    rf'\b\d{{4}}-\d{{2}}-\d{{2}}\b|\b\d{{1,2}}\s+(?:{MONTHS})\b', re.I)
# A clock time counts too, but only alongside the words above: the Overlook
# Drive-In's homepage is "Cars (20th Anniversary) … Approx: 7:45 pm", which is a
# showtime and was two dates short of being read as one. On a page with no
# event words at all this is just a shop's opening hours, and the eventish test
# is what keeps those apart.
CLOCK = re.compile(r'\b\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)\b', re.I)

# "Every Thursday, 7pm" is a date for our purposes — it says when to turn up,
# which is the only thing a date is for here.
RECURRING = re.compile(
    r'\b(?:every|each)\s+(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|'
    r'\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)days?\b[^.]{0,40}?'
    r'\b\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)\b',
    re.I)

# A lapsed venue domain re-registered by somebody else answers 200 and looks
# perfectly healthy. Three cinema domains in one 50-mile pass had gone this way
# — downingfilmcenter, storyscreenbeacon, bethelcinema — so the audit that reads
# every site anyway is the cheapest place to notice the next one.
# A hijacked domain does not always advertise itself in a language the regex
# below knows. destinta.com — a cinema — now serves a Chinese streaming site,
# which every keyword here misses. Script is the tell that survives translation:
# a venue in the Hudson Valley whose page is three-quarters CJK, Cyrillic,
# Arabic or Thai, and which never says its own name, is not that venue's page.
FOREIGN_SCRIPT = re.compile(
    r'[\u0400-\u04ff\u0590-\u08ff\u0e00-\u0e7f\u3040-\u30ff'
    r'\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]')
FOREIGN_SHARE = 0.15

SUSPECT = re.compile(
    r'\b(situs|slot ?gacor|judi bola|togel|bandar|casino online|taruhan|'
    r'bahis|deneme bonusu|canl[ıi] casino|rtp slot|maxwin|pragmatic play)\b',
    re.I)

# The web server's own welcome page, a registrar's parking page, or a domain
# for sale. senatehousekingston.org serves "Caddy works! Congratulations!" —
# 2,400 characters of a healthy 200 that say nothing whatsoever about the
# Senate House, and would have been recorded as a historic site that publishes
# no events.
PARKED = re.compile(
    r'caddy works|welcome to nginx|apache2? (?:ubuntu |debian )?default page|'
    r'it works!|future home of something quite cool|this domain (?:name )?is '
    r'for sale|buy this domain|domain (?:is )?parked|godaddy\.com/domainsearch|'
    r'sedoparking|hugedomains|under construction|coming soon\b.{0,40}stay tuned',
    re.I)

SKIP_HOSTS = {
    # Aggregators and social hosts. A place whose "website" is its Facebook
    # page tells us nothing about the place, and answering the question for
    # facebook.com once and applying it to 60 venues would be a lie.
    'facebook.com', 'm.facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'linktr.ee', 'linkedin.com', 'youtube.com', 'tiktok.com', 'yelp.com',
    'eventbrite.com', 'meetup.com', 'sites.google.com', 'wixsite.com',
    'squarespace.com', 'wordpress.com', 'blogspot.com', 'google.com',
    'tripadvisor.com', 'patch.com', 'weebly.com', 'wix.com',
    # Ticketing and ordering hosts, for the same reason: a venue whose listed
    # website is its Ticketmaster page has told us about Ticketmaster.
    'ticketmaster.com', 'ticketweb.com', 'livenation.com', 'seetickets.us',
    'eventbrite.co.uk', 'opentable.com', 'toasttab.com', 'square.site',
    'shopify.com', 'etsy.com', 'airbnb.com', 'booking.com', 'doordash.com',
}

# A calendar the venue links to but does not host. Pawling Library's whole
# programme lives on engagedpatrons.org, so reading only its own pages found no
# dates anywhere and called a public library quiet — libraries, halls and small
# theatres put their calendar on somebody else's host constantly. Tighter than
# EVENT_LINK on purpose: this one fires on a link we are not going to read, so
# it has to be a link that plainly is a calendar.
OFFSITE_CALENDAR = re.compile(
    r'\bcalendar\b|\bevents?\b|whats?[-_ ]?on|showtimes?|schedule|'
    r'\btickets?\b|upcoming', re.I)

# A page that is *for* listings, rather than one that merely mentions them.
# Two dates on this page is a programme; two dates on an About page is a
# founding year and a copyright line.
CALENDAR_PATH = re.compile(
    r'/(events?|calendar|whats?[-_]?on|upcoming|shows?|showtimes?|'
    r'programs?([-_]and)?[-_]events?|programme|performances?)(/|$|\?)', re.I)

# Three gambling terms before this is a page about gambling; one is a word.
SPAM_HITS = 3

# Words too generic to identify a venue, and the ones a spam page would print
# anyway. "Center" is in a third of the directory's names.
NAME_STOPWORDS = {'the', 'and', 'of', 'at', 'inc', 'llc', 'company', 'center',
                  'centre', 'shop', 'store', 'house', 'club', 'park', 'museum'}

TAGS = re.compile(r'<(script|style|noscript)[^>]*>.*?</\1>', re.S | re.I)
ANCHOR = re.compile(r'<a\s[^>]*href=["\']([^"\'>]+)["\'][^>]*>(.*?)</a>', re.S | re.I)


def venue_named(text, names):
    """Does the page still say whose it is?

    This is what separates a lapsed domain now serving a betting site from a
    real venue's WordPress with casino spam injected into it. Montgomery Place
    Orchards' page carries 76 gambling terms and is still, unmistakably,
    Montgomery Place Orchards: it opens with the farm's name, its closing date
    and its apples. Bethel Cinema's carries 56 and never mentions Bethel.

    Whole words only. "gardenofideas.com" printed on a parking page is not the
    Garden of Ideas being named.
    """
    head = text[:2000].lower()
    for name in names or ():
        words = [w for w in re.findall(r'[a-z0-9]+', name.lower())
                 if len(w) >= 4 and w not in NAME_STOPWORDS]
        if not words:
            continue
        hits = sum(1 for w in words if re.search(rf'\b{re.escape(w)}\b', head))
        if hits >= min(2, len(words)):
            return True
    return False


def strip_html(body):
    text = TAGS.sub(' ', body)
    text = re.sub(r'<[^>]+>', ' ', text)
    return re.sub(r'\s{2,}', ' ', html.unescape(text))


def opener():
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def decode(raw, encoding):
    """Undo Content-Encoding, and undo it even when nobody declared it.

    Finkelstein Memorial Library and the Center for Photography at Woodstock
    both came back as 25,000 characters of binary noise: gzip, sent to a client
    that never asked for it. Nothing threw — the bytes decoded to replacement
    characters, which have no dates and no links in them, so both were recorded
    as venues that publish nothing. The magic-number check is the belt to the
    header's braces, because that is exactly how this went unnoticed.
    """
    if encoding in ('gzip', 'x-gzip') or raw[:2] == b'\x1f\x8b':
        try:
            return gzip.decompress(raw)
        except Exception:
            pass
    if encoding == 'deflate':
        for wbits in (-zlib.MAX_WBITS, zlib.MAX_WBITS):
            try:
                return zlib.decompress(raw, wbits)
            except Exception:
                continue
    return raw


def get(url, op, timeout=14, cap=700_000):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate', 'Accept-Language': 'en-US,en;q=0.9'})
    with op.open(req, timeout=timeout) as r:
        raw = decode(r.read(cap), (r.headers.get('Content-Encoding') or '').lower())
        return r.geturl(), raw.decode('utf-8', 'replace')


def homepage(domain, op):
    """The site's front door, however it answers.

    Returns (url, body, why). `why` is an HTTP status when the server gave one
    and a short exception name when it did not, because those are different
    facts: 403 is a venue that has a site and will not show it to a bot, and no
    fact about the venue at all. Read as "unreachable" both ways, the audit
    would have quietly stopped retrying a couple of dozen live sites.

    One retry on a network error, none on a status. A refusal is an answer, and
    asking twice is just knocking twice. A timeout under six-way concurrency is
    not — spmeadery.com failed in the batch and answered first time on its own.
    """
    why = None
    for url in (f'https://{domain}/', f'https://www.{domain}/', f'http://{domain}/'):
        for attempt in (1, 2):
            try:
                return (*get(url, op), None)
            except urllib.error.HTTPError as e:
                why = why or e.code
                break
            except Exception as e:
                why = why or type(e).__name__
                if attempt == 1:
                    time.sleep(1.5)
    return None, None, why


def candidates(base, body, limit=5):
    """Same-site pages worth opening, events before deals, in page order."""
    host = urllib.parse.urlparse(base).netloc.lower()
    events, deals, seen = [], [], set()
    for href, label in ANCHOR.findall(body):
        href = href.strip()
        if href.startswith(('#', 'mailto:', 'tel:', 'javascript:')):
            continue
        full = urllib.parse.urljoin(base, href)
        parts = urllib.parse.urlparse(full)
        if parts.scheme not in ('http', 'https') or parts.netloc.lower() != host:
            continue
        full = parts._replace(fragment='').geturl()
        if full in seen or full.rstrip('/') == base.rstrip('/'):
            continue
        text = strip_html(label).strip()
        hay = f'{parts.path} {text}'
        if EVENT_LINK.search(hay):
            seen.add(full)
            events.append(full)
        elif DEAL_LINK.search(hay):
            seen.add(full)
            deals.append(full)
    return (events + deals)[:limit]


def linked_calendars(base, body, limit=3):
    """Calendars the venue points at on somebody else's host.

    Not followed: whether engagedpatrons.org will talk to us is a fact about
    engagedpatrons.org, and the venue has already answered the question we were
    asking by linking to it. Social and aggregator hosts are excluded — every
    third site links to Facebook, and a Facebook page is not a calendar.
    """
    host = urllib.parse.urlparse(base).netloc.lower()
    out = []
    for href, label in ANCHOR.findall(body):
        full = urllib.parse.urljoin(base, href.strip())
        parts = urllib.parse.urlparse(full)
        other = parts.netloc.lower()
        if parts.scheme not in ('http', 'https') or not other or other == host:
            continue
        bare = other[4:] if other.startswith('www.') else other
        if bare in SKIP_HOSTS or any(bare.endswith('.' + h) for h in SKIP_HOSTS):
            continue
        if bare.split(':')[0] == (host[4:] if host.startswith('www.') else host):
            continue
        text = strip_html(label).strip()
        if not OFFSITE_CALENDAR.search(f'{parts.path} {parts.query} {text}'):
            continue
        clean = parts._replace(fragment='').geturl()
        if clean not in out:
            out.append(clean)
        if len(out) >= limit:
            break
    return out


# Where a calendar lives when the navigation is drawn by JavaScript and there
# is no link on the server's copy to follow. Four requests, spent only on a
# site that is otherwise heading for "no event calendar" — which is the one
# verdict worth spending requests to avoid getting wrong.
GUESS_PATHS = ['/events/', '/calendar/', '/whats-on/', '/showtimes/']


def guessed_calendars(base, op, limit=2):
    out = []
    for path in GUESS_PATHS:
        try:
            real, page = get(urllib.parse.urljoin(base, path), op, timeout=10)
        except Exception:
            continue
        # A soft 404 lands back on the homepage; that is not an events page.
        if urllib.parse.urlparse(real).path.rstrip('/') in ('', '/'):
            continue
        out.append((real, page))
        if len(out) >= limit:
            break
    return out


def signature(base, body):
    """What "unless something changes" means, in one hash.

    Not the page — a homepage with a rotating hero image changes every day and
    would make every verdict expire immediately. What is hashed is the shape of
    the site: which of its own pages it links to that could carry listings. A
    venue that adds an events page changes this; one that swaps a photograph
    does not.
    """
    paths = sorted({urllib.parse.urlparse(u).path.rstrip('/').lower()
                    for u in candidates(base, body, limit=40)})
    return hashlib.sha1('\n'.join(paths).encode()).hexdigest()[:16]


def read_signals(url, body):
    """What one page says about whether anything happens here."""
    text = strip_html(body)
    path = urllib.parse.urlparse(url).path.lower()
    eventish = bool(EVENT_LINK.search(path)) or bool(EVENT_WORDS.search(text))
    dates = len(DATED.findall(text)) + len(RECURRING.findall(text))
    if eventish:
        dates += len(CLOCK.findall(text))
    return {
        'url': url,
        'jsonld': bool(discover.JSONLD_EVENT.search(body)),
        'eventish': eventish,
        'dealish': bool(DEAL_LINK.search(path)) or bool(DEAL_WORDS.search(text)),
        'calendarPage': bool(CALENDAR_PATH.search(path)),
        'dates': dates,
        'chars': len(text),
        'suspect': bool(SUSPECT.search(text)),
    }


# Three dates on a page that merely mentions events, rather than one in a
# footer next to a copyright line. Two was enough to catch "© 2026" beside an
# address. A page whose own URL is /events is held to two, because that page
# has one job: Forsyth Nature Center's programme is a family fun day and a
# Halloween movie night, and three would have called it quiet.
DATES_FOR_LISTINGS = 3
DATES_ON_A_CALENDAR_PAGE = 2

# Under this many characters, a page about events is a shell the browser fills
# in afterwards. Irvington Theater's /events is 1,135 characters and every one
# of them is navigation; Tinker Street Cinema's homepage is 830 and reads "NOW
# PLAYING / Directed by / Starring / MORE / TRAILER" with nothing between. A
# page cannot say what is on in that much space, so it has not said it — and
# "we could not read it" is the honest answer where "nothing is on" is not.
THIN_PAGE = 1200


def audit_domain(domain, names=()):
    """Read one venue's site and return a verdict record."""
    op = opener()
    base, body, why = homepage(domain, op)
    if body is None:
        blocked = why in (401, 403, 405, 406, 429, 451)
        return {'verdict': 'blocked' if blocked else 'unreachable',
                'found': [], 'sig': None, 'url': None,
                'note': (f'HTTP {why} to a declared bot' if blocked
                         else f'no response on https, www or http ({why})')}

    # A site that renders itself in the browser hands a scraper a shell: a few
    # words and no links. LOOK Dine-In Cinemas publishes showtimes for six
    # screens and serves 33 characters of text — calling that "no event
    # calendar" would be the check reporting its own blind spot as a fact about
    # the cinema.
    text = strip_html(body)
    if PARKED.search(text[:4000]):
        return {'verdict': 'parked', 'found': [], 'sig': None, 'url': base,
                'note': 'a default server or registrar page, not the venue'}

    links = candidates(base, body, limit=1)
    if len(text) < 400 and not links:
        return {'verdict': 'unreadable', 'found': [], 'sig': None, 'url': base,
                'note': 'renders in the browser — nothing to read on the server'}

    pages = [read_signals(base, body)]
    spam = len(SUSPECT.findall(text))
    foreign = (len(FOREIGN_SCRIPT.findall(text)) / max(len(text), 1)) > FOREIGN_SHARE
    spammed = spam >= SPAM_HITS
    if (spammed or foreign) and not venue_named(text, names):
        return {'verdict': 'suspect', 'found': ['off-topic content'], 'sig': None,
                'url': base,
                'note': 'the domain is serving something the venue did not put there'}

    found, best = [], None

    # A platform embed is a calendar by definition, and discover.py knows the
    # fingerprints already. Nothing here re-derives them.
    for name, pattern in discover.PLATFORMS:
        if pattern.search(body):
            found.append(f'{name} embed')
            best = best or base

    linked = linked_calendars(base, body)
    if linked:
        found.append('linked calendar')
        best = best or linked[0]

    found_links = candidates(base, body)
    for url in found_links:
        try:
            real, page = get(url, op)
        except Exception:
            continue
        pages.append(read_signals(real, page))
        time.sleep(0.3)   # one site, one visitor's pace

    if not found_links and not linked:
        for real, page in guessed_calendars(base, op):
            pages.append(read_signals(real, page))
            time.sleep(0.3)

    for p in pages:
        if p['jsonld']:
            found.append('schema.org events')
            best = best or p['url']
            break

    listings = [p for p in pages if p['eventish'] and p['dates'] >=
                (DATES_ON_A_CALENDAR_PAGE if p['calendarPage'] else DATES_FOR_LISTINGS)]
    if listings:
        found.append('dated listings')
        best = best or listings[0]['url']

    # Two dates, not one: "Sale" beside a copyright year is not a sale.
    deals = [p for p in pages if p['dealish'] and p['dates'] >= 2]
    if deals:
        found.append('dated specials')

    sig = signature(base, body)

    # Only now, and only if nothing has turned up: the iCal sweep. It is seven
    # requests, so it is not worth spending on a site that has already answered
    # the question — but it is worth spending before writing down "nothing
    # here", because The Events Calendar answers ?ical=1 on plenty of sites
    # that never link to it.
    if not found:
        try:
            hit = discover.probe_domain(domain)
        except Exception:
            hit = None
        if hit and hit.get('url'):
            return {'verdict': 'feed', 'found': ['ical feed'], 'sig': sig,
                    'url': hit['url'],
                    'note': f"{hit.get('future', 0)} future events — worth registering"}
        if hit and hit.get('platforms'):
            return {'verdict': 'listings', 'found': [f"{p} embed" for p in hit['platforms']],
                    'sig': sig, 'url': hit.get('seenOn') or base,
                    'note': 'calendar platform, no derivable feed — register as html'}

    if not found:
        # Rough Draft Bar & Books has an events page with 304 characters on it
        # and the listings drawn in afterwards. The site has a calendar; we
        # cannot read it. That is the same blind spot as a JavaScript homepage
        # and it gets the same answer, not "no event calendar".
        thin = [p for p in pages
                if (p['calendarPage'] or p['eventish'])
                and p['chars'] < THIN_PAGE and not p['dates']]
        if thin:
            return {'verdict': 'unreadable', 'found': [], 'sig': sig,
                    'url': thin[0]['url'],
                    'note': ('its events page renders in the browser'
                             if thin[0]['calendarPage']
                             else 'renders in the browser — nothing to read on the server')}
        out = {'verdict': 'none', 'found': [], 'sig': sig, 'url': None,
               'note': f'read {len(pages)} page(s), no dates and no calendar'}
        if spammed:
            out['spammed'] = True
        return out

    verdict = 'specials' if found == ['dated specials'] else 'listings'
    out = {'verdict': verdict, 'found': found, 'sig': sig,
           'url': best or base, 'note': None}
    if spammed:
        # A real site with somebody else's casino copy injected into it. The
        # listings on it are still the venue's, so this changes nothing about
        # the verdict — it is a line in the report for a person to look at.
        out['spammed'] = True
    return out


# ── the rules, checked without a network ──────────────────

def selftest():
    """The classifier, on inputs that stand for the mistakes it has made.

    Every case here is a real page this got wrong once. None of them threw at
    the time — a compressed page decodes to replacement characters that have no
    dates in them, and a shell has no dates in it either, so both arrived as
    "this venue publishes nothing" with a clean run and a plausible count.
    """
    cases = 0

    # Compression, declared and undeclared. This is the one that cost two
    # libraries and a photography centre.
    body = b'<html><body><h1>Programme</h1><p>October 3</p></body></html>'
    assert decode(gzip.compress(body), 'gzip') == body
    assert decode(gzip.compress(body), '') == body, 'magic number, not the header'
    assert decode(zlib.compress(body), 'deflate') == body
    assert decode(body, '') == body, 'uncompressed bytes must pass through'
    cases += 4

    # Whose page is this? A hijacked domain never says; a spammed one still does.
    assert venue_named('Montgomery Place Orchards ~ closed ~ thank you',
                       ['Montgomery Place Farm Stand'])
    assert not venue_named('Kopi77 daftar akun gaming gratis', ['Elite Cinema 6'])
    assert not venue_named('gardenofideas.com is for sale', ['Garden Of Ideas']), \
        'a domain printed on a parking page is not the venue being named'
    cases += 3

    # Dates, and the clock times that only count beside event words.
    shop = read_signals('https://x.test/', '<p>Open Mon-Fri 9:00 am to 5:00 pm</p>')
    assert shop['dates'] == 0, 'opening hours are not a programme'
    show = read_signals('https://x.test/', '<p>Now playing: Cars, approx 7:45 pm</p>')
    assert show['eventish'] and show['dates'] >= 1
    assert read_signals('https://x.test/events/', '<p>x</p>')['calendarPage']
    assert not read_signals('https://x.test/about/', '<p>x</p>')['calendarPage']
    cases += 4

    # A page too small to have said what is on has not said it.
    assert read_signals('https://x.test/events/', '<p>Events</p>')['chars'] < THIN_PAGE
    cases += 1

    # The vocabulary the rest of the pipeline reads back.
    import json as _json
    if os.path.exists(AUDIT_PATH):
        for name, rec in (_json.load(open(AUDIT_PATH)).get('domains') or {}).items():
            assert rec.get('verdict') in RECHECK_DAYS, (name, rec.get('verdict'))
            cases += 1
    return cases


# ── the file ──────────────────────────────────────────────

def load_audit(path=AUDIT_PATH):
    if not os.path.exists(path):
        return {'schemaVersion': 1, 'note': '', 'domains': {}}
    doc = json.load(open(path))
    doc.setdefault('domains', {})
    return doc


def save_audit(doc, path=AUDIT_PATH):
    doc['schemaVersion'] = 1
    doc['note'] = ('What each venue domain publishes, so a site that publishes '
                   'nothing is read once rather than every week. Written by '
                   'scripts/audit.py; read by scripts/places.py, which copies '
                   'the verdict onto every place on that domain.')
    doc['updated'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    doc['domains'] = dict(sorted(doc['domains'].items()))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(doc, open(path, 'w'), indent=2, ensure_ascii=False)
    open(path, 'a').write('\n')


def domain_of(url):
    d = discover.domain_of(url or '')
    if not d:
        return None
    d = d.split(':')[0]
    return d[4:] if d.startswith('www.') else d


def place_domains(places_path, registry_path):
    """Every venue domain in the directory, with the places it stands for.

    A domain already in the registry is skipped outright: we collect its
    listings, so the question is answered and re-answering it costs requests to
    somebody else's server for nothing.
    """
    places = json.load(open(places_path))['items']
    known = {domain_of(s['url']) for s in json.load(open(registry_path))['sources']}
    out = {}
    for p in places:
        d = domain_of(p.get('url'))
        if not d or d in known or d in SKIP_HOSTS:
            continue
        if any(d.endswith('.' + h) for h in SKIP_HOSTS):
            continue
        out.setdefault(d, []).append(p['name'])
    return out


def stale(record, today):
    if not record or not record.get('checked'):
        return True
    try:
        age = (today - date.fromisoformat(record['checked'])).days
    except ValueError:
        return True
    return age >= RECHECK_DAYS.get(record.get('verdict'), 365)


def changed(domain, record):
    """One request: has the site grown a page that could carry listings?"""
    op = opener()
    base, body, _ = homepage(domain, op)
    if body is None:
        return False        # unreadable today is not the same as changed
    return signature(base, body) != record.get('sig')


def stamp_places(audit, places_path='data/places.json'):
    """Copy the verdicts onto the directory the client actually loads.

    places.py does the same on a full rebuild. This exists so a batch of audits
    reaches the site without waiting half an hour on Overpass.
    """
    doc = json.load(open(places_path))
    n = 0
    for place in doc['items']:
        rec = audit['domains'].get(domain_of(place.get('url')))
        before = (place.get('eventInfo'), place.get('eventChecked'), place.get('url'))
        # See places.py:merge_audit — a hijacked domain loses its link.
        if rec and rec['verdict'] in ('suspect', 'parked'):
            place['url'] = None
            rec = None
        # Never over a programme: a venue can publish nothing itself and still
        # be all over Eventbrite. places.py:merge_audit says the same.
        if rec and rec['verdict'] == 'none' and not place.get('events'):
            place['eventInfo'] = 'none'
            place['eventChecked'] = rec.get('checked')
        else:
            place.pop('eventInfo', None)
            place.pop('eventChecked', None)
        if before != (place.get('eventInfo'), place.get('eventChecked'), place.get('url')):
            n += 1
    json.dump(doc, open(places_path, 'w'), indent=2, ensure_ascii=False)
    return n


def report(audit, domains):
    counts = {}
    for rec in audit['domains'].values():
        counts[rec['verdict']] = counts.get(rec['verdict'], 0) + 1
    done = len(audit['domains'])
    print(f'{done} of {len(domains)} venue domains audited '
          f'({len(domains) - done} to go)')
    for verdict in ('feed', 'listings', 'specials', 'none', 'unreadable',
                    'blocked', 'unreachable', 'parked', 'suspect'):
        if counts.get(verdict):
            print(f'  {verdict:<12} {counts[verdict]}')
            counts[verdict] = 0
    leads = [(d, r) for d, r in audit['domains'].items() if r['verdict'] == 'feed']
    if leads:
        print(f'\n{len(leads)} feed(s) worth adding to sources/registry.json:')
        for d, r in leads[:20]:
            print(f"  {d:<34} {r.get('url')}")
    spammed = [d for d, r in audit['domains'].items() if r.get('spammed')]
    if spammed:
        print(f'\n{len(spammed)} real site(s) with casino spam injected into '
              'them — their listings still count, but somebody should tell them:')
        for d in spammed[:10]:
            print(f'  {d}')

    bad = [(d, r) for d, r in audit['domains'].items()
           if r['verdict'] in ('suspect', 'parked')]
    if bad:
        print(f'\n{len(bad)} domain(s) serving something other than the venue '
              '— the OSM website tag is stale:')
        for d, r in bad:
            print(f"  {d:<34} {', '.join(r.get('places', [])[:2])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--places', default='data/places.json')
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--audit', default=AUDIT_PATH)
    ap.add_argument('--limit', type=int, default=150,
                    help='how many domains this batch reads (0 = all)')
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--verify', action='store_true',
                    help='re-read audited sites and re-audit only the changed')
    ap.add_argument('--recheck', nargs='*', metavar='DOMAIN',
                    help='force these domains (or all, with no argument)')
    ap.add_argument('--report', action='store_true', help='no network, just the counts')
    ap.add_argument('--selftest', action='store_true',
                    help='check the classifier against its own past mistakes')
    ap.add_argument('--no-stamp', action='store_true',
                    help='leave data/places.json alone')
    args = ap.parse_args()

    if args.selftest:
        print(f'{selftest()} audit rule cases OK')
        return 0

    audit = load_audit(args.audit)
    domains = place_domains(args.places, args.registry)
    today = date.today()

    if args.report:
        report(audit, domains)
        return 0

    if args.recheck is not None:
        todo = [d for d in (args.recheck or domains) if d in domains]
    elif args.verify:
        # Only quiet sites are worth re-reading: a verdict of "none" is the one
        # that stops us ever looking again, so it is the one that has to be able
        # to expire when the site changes underneath it.
        quiet = [d for d in domains
                 if audit['domains'].get(d, {}).get('verdict') == 'none'
                 and audit['domains'][d].get('sig')]
        quiet = quiet[:args.limit] if args.limit else quiet
        print(f'checking {len(quiet)} quiet site(s) for a change…')
        todo = []
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for d, moved in zip(quiet, pool.map(
                    lambda d: changed(d, audit['domains'][d]), quiet)):
                if moved:
                    print(f'  changed — {d}')
                    todo.append(d)
        print(f'{len(todo)} of {len(quiet)} have changed shape since we read them')
    else:
        todo = [d for d in domains if stale(audit['domains'].get(d), today)]
        if args.limit:
            todo = todo[:args.limit]

    if not todo:
        print('nothing to audit — every domain has a current verdict')
        report(audit, domains)
        return 0

    print(f'reading {len(todo)} venue site(s), {args.workers} at a time…')
    started = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for d, rec in zip(todo, pool.map(
                lambda d: audit_domain(d, domains[d]), todo)):
            rec['checked'] = today.isoformat()
            rec['places'] = domains[d][:4]
            audit['domains'][d] = rec
            mark = {'feed': '+', 'listings': '·', 'specials': '·',
                    'none': '-', 'unreachable': '?', 'unreadable': '?',
                    'blocked': '?', 'parked': '!', 'suspect': '!'}[rec['verdict']]
            detail = ', '.join(rec['found']) or rec.get('note') or ''
            print(f"  {mark} {d:<36} {rec['verdict']:<12} {detail}")
            # A 400-domain batch is the best part of an hour, and one site can
            # hold the pool up for three minutes on its own. Write as we go, or
            # a Ctrl-C at minute fifty costs the whole run.
            done += 1
            if done % 25 == 0:
                save_audit(audit, args.audit)

    save_audit(audit, args.audit)
    print(f"\n{len(todo)} audited in {time.time() - started:.0f}s → {args.audit}")

    if not args.no_stamp and os.path.exists(args.places):
        n = stamp_places(audit, args.places)
        print(f'{n} place row(s) updated in {args.places}')

    print()
    report(audit, domains)
    return 0


if __name__ == '__main__':
    sys.exit(main())
