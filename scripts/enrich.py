#!/usr/bin/env python3
"""Turn harvested candidates into listings in the site's schema.

Geocodes venues (cache committed to sources/geocache.json), drops anything outside the radius, and infers
categories and event-vs-activity. Price is deliberately left null: no feed
publishes one, and guessing is worse than saying "See listing". Filling those
in is the weekly job's judgement step, not this script's.

  python3 scripts/enrich.py [--in build/candidates.json] [--out build/enriched.json]
"""

import argparse, html, json, os, re, sys, time, urllib.parse, urllib.request
from datetime import datetime
from math import radians, sin, cos, asin, sqrt

UA = 'ProximiBot/0.1 (github.com/StarrySidekick/Proximi)'
NOMINATIM = 'https://nominatim.openstreetmap.org/search'
CACHE = 'sources/geocache.json'

# Nominatim's usage policy allows at most 1 request/second. The cache means a
# steady-state run makes almost none.
RATE = 1.1

# The single primary answer to "what kind of thing is this?", shown on the card
# where the event/activity badge used to be. Ordered most-specific first: the
# first pattern that matches wins, so "open mic comedy night" is an Open Mic.
TYPES = [
    ('parade',      r'\bparade\b'),
    # "march" alone also matches the month, which tagged a family nature day as
    # a protest — so it only counts with a protest sense attached.
    ('protest',     r'\b(rally|protest|demonstration|vigil|picket|walkout)\b|'
                    r'\bmarch(es|ing)? (for|on|against|to demand)\b'),
    ('open-mic',    r'\bopen[- ]mic\b'),
    # Professional certifications grade in "belts" too, so a Lean Six Sigma
    # Black Belt course reads as martial arts unless it is caught first.
    ('class',       r'\b(six sigma|scrum|pmp|osha|servsafe|notary|cpr|aed|'
                    r'forklift|phlebotomy|real estate licens\w*)\b'),
    # Specific-before-generic: a speed dating night is "social", a trivia night
    # is a "meetup", and a martial-arts grading is "training", so each of these
    # must be read before the catch-alls at the bottom of the list.
    ('dating',      r'\b(speed dating|singles|matchmaking|blind date|'
                    r'date night|mixer for singles)\b'),
    ('trivia',      r'\b(trivia|pub quiz|quizzo|bingo)\b'),
    ('game',        r'\b(scavenger hunt|game night|board ?games?|trading cards?|'
                    r'escape room|chess|mahjong|bridge club|dungeons|karaoke|'
                    r'random acts of kindness)\b'),
    ('science',     r'\b(planetarium|astronomy|telescope|observatory|stargaz\w*|'
                    r'science|entomolog\w*|geolog\w*)\b'),
    ('wellness',    r'\b(meditation|mindfulness|pilates|sound bath|breathwork|'
                    r'reiki|wellness|healing|qi ?gong|tai chi|restorative)\b'),
    ('comedy',      r'\b(comedy|stand-?up|improv)\b'),
    ('film',        r'\b(film|movie|screening|cinema|documentar\w*)\b'),
    ('art',         r'\b(exhibition|exhibit|gallery|opening reception|artist talk|'
                    r'installation|sculpture|paintings?)\b'),
    ('theater',     r'\b(theat(er|re)|play|musical|opera|cabaret|drag|puppet)\b'),
    ('dance',       r'\b(dance|ballet|salsa|swing|tango|contra)\b'),
    ('concert',     r'\b(concert|music|band|recital|symphony|orchestra|quartet|'
                    r'trio|songwriter|acoustic|jazz|blues|folk|choir|singer)\b'),
    ('dj',          r'\b(dj|party|nightlife|dance party|after ?party)\b'),
    ('market',      r'\b(market|bazaar|makers?|vendors?|craft fair)\b'),
    ('sale',        r'\b(sale|flea|rummage|tag sale|book sale|swap)\b'),
    ('festival',    r'\b(festival|fest|fair)\b'),
    ('celebration', r'\b(celebration|anniversary|birthday|gala|holiday|'
                    r'tree lighting|fireworks|opening day)\b'),
    ('tour',        r'\b(tour|guided walk|house tour|behind the scenes)\b'),
    ('kids',        r'\b(storytime|story time|lego|play ?days?|kids? program)\b'),
    ('sports',      r'\b(yoga|runs?|race|5k|10k|fitness|pickleball|hockey|baseball|'
                    r'soccer|tournament|golf|paddle|kayak|climb\w*|basketball|'
                    r'tennis|martial arts|karate|taekwondo|jiu[- ]?jitsu|judo|'
                    r'black ?belt|boxing|self[- ]defense|swim\w*|cycling)\b'),
    ('outdoors',    r'\b(hikes?|hiking|walks?|birds?|birding|trails?|nature|forest|'
                    r'cleanups?|foraging?|canoe|camping|orchard)\b'),
    ('food',        r'\b(dinner|dining|dine|tasting|brunch|supper|bbq|barbecue|'
                    r'breakfast|food truck|potluck|wine|beer|cider|cocktail|'
                    r'farm[- ]to[- ]table|long table)\b'),
    ('class',       r'\b(workshops?|class(es)?|lessons?|courses?|seminar|clinic|'
                    r'training|demo|certification|certificate|bootcamp|'
                    r'paint[- ]and[- ]sip|paint ?n ?sip|intro to|101)\b'),
    ('talk',        r'\b(talk|lecture|reading|panel|author|discussion|book club)\b'),
    ('volunteer',   r'\b(volunteer|work ?day|stewardship|planting|fundraiser|benefit)\b'),
    ('meetup',      r'\b(meetup|meeting|social|club|forum|town hall|gathering)\b'),
]

# Is it under a roof? Only claimed when the text actually says so.
OUTDOOR = re.compile(
    r'\b(outdoors?|outside|park|trail|garden|lawn|riverfront|field|farm|orchard|'
    r'hike|hiking|paddle|kayak|beach|meadow|grounds|picnic|rain date|weather '
    r'permitting|plaza|courtyard)\b', re.I)
INDOOR = re.compile(
    r'\b(theat(er|re)|gallery|library|museum|hall|studio|taproom|auditorium|'
    r'ballroom|basement|indoors?|classroom|sanctuary|lounge)\b', re.I)

FOOD = re.compile(
    r'\b(dinner|tasting|brunch|supper|breakfast|lunch|bbq|barbecue|food trucks?|'
    r'potluck|refreshments|snacks|concessions|cash bar|beer|wine|cider|cocktails?|'
    r'coffee|dessert|pizza|oysters?|food (and|&) drink|catered)\b', re.I)


def blob_of(e):
    return ' '.join(filter(None, [e.get('title'), e.get('description'), e.get('venue')]))


def type_of(title, description=''):
    """Classify from the title first, falling back to the description.

    A county fair whose blurb mentions "grandstand concerts" is a Festival, not
    a Concert — what a thing *is* lives in its name, while the description only
    mentions things it contains.
    """
    for source in (title or '', description or ''):
        for name, pattern in TYPES:
            if re.search(pattern, source, re.I):
                return name
    return 'other'


def setting_of(text):
    out, ind = bool(OUTDOOR.search(text)), bool(INDOOR.search(text))
    if out and not ind:
        return 'outdoor'
    if ind and not out:
        return 'indoor'
    return 'unknown'


def time_of_day(dt):
    """Bucket by local clock hour: what a person means by morning or evening."""
    h = dt.hour
    if h < 12:
        return 'morning'
    if h < 17:
        return 'afternoon'
    if h < 21:
        return 'evening'
    return 'night'


KEYWORDS = [
    ('protest',   r'\b(rally|protest|demonstration|vigil|picket|walkout)\b|'
                  r'\bmarch(es|ing)? (for|on|against|to demand)\b'),
    ('parade',    r'\bparade\b'),
    ('comedy',    r'\b(comedy|stand-?up|improv)\b'),
    ('film',      r'\b(film|movie|screening|cinema|documentar)\w*'),
    ('music',     r'\b(concert|band|jazz|live music|songwriter|acoustic|orchestra|'
                  r'symphony|choir|blues|folk|open mic|dj|recital|quartet|trio)\b'),
    ('show',      r'\b(theat(er|re)|play|musical|performance|drag|cabaret|opera|dance|circus)\b'),
    ('art',       r'\b(art|gallery|exhibition|opening reception|painting|sculpture|'
                  r'artist|ceramic|photograph)\w*'),
    ('market',    r'\b(market|fair|festival|bazaar|vendors?|craft show)\b'),
    ('sale',      r'\b(sale|flea|rummage|tag sale|book sale|swap)\b'),
    ('tour',      r'\b(tour|guided walk|house tour|behind the scenes)\b'),
    ('outdoors',  r'\b(hike|hiking|walk|paddle|kayak|canoe|bird|trail|garden|nature|'
                  r'cleanup|forest|river|outdoor)\w*'),
    ('family',    r'\b(kids?|child(ren)?|family|storytime|story time|toddler|teen|youth)\b'),
    ('class',     r'\b(workshop|class|lesson|course|seminar|clinic|training|demo|'
                  r'lecture|talk|reading)\b'),
    ('food',      r'\b(dinner|tasting|brunch|food|wine|beer|cider|potluck|supper|'
                  r'bbq|barbecue|breakfast|lunch)\b'),
    ('sports',    r'\b(yoga|run|race|5k|10k|fitness|pickleball|hockey|baseball|'
                  r'soccer|tournament|golf)\b'),
    ('community', r'\b(meeting|forum|town hall|volunteer|community|fundraiser|'
                  r'benefit|social|meetup|club)\b'),
    ('nightlife', r'\b(bar|party|nightlife|late night|after ?party)\b'),
]

ACTIVITY_HINTS = re.compile(
    r'\b(every|weekly|monthly|daily|ongoing|drop-?in|series|recurring|'
    r'each (mon|tues|wednes|thurs|fri|satur|sun)day|open hours)\b', re.I)

# Age gating. "Kids" means children ONLY — a drop-off programme for grades K-3,
# not a family day where children are welcome alongside everyone else. The
# family override matters: without it, "family festival, ages 3-12" reads as
# kids-only and gets hidden from the people it is actually for.
KIDS_ONLY = re.compile(
    # An age range only means children when the ages are a child's. Matching any
    # two numbers made "Speed Dating Ages 25-39" a children's event. Ranges are
    # spelled "6-12", "6 to 12", "kids ages 6", and "ages 2 and up" — the first
    # pass only read the hyphen form, so half the library programming slipped by.
    r'\b(grades?\s*(k|pre-?k|\d{1,2})|'
    r'ages?\s*(?:[0-9]|1[0-8])\s*(?:[-–—]|to)\s*(?:[0-9]|1[0-8])\b|'
    r'(?:kids|children)\s+ages?\s*\d|'
    r'ages?\s*[0-9]\s*(?:and|&)\s*(?:up|older|over)|'
    r'children entering|toddlers?|pre-?school|storytime|story time|kids only|'
    r'teens?|for kids|'
    r'children only|youth (program|group|club)|drop-?off program|campers?)\b', re.I)
FAMILY = re.compile(r'\b(family|families|all ages|caregiver|parent and|adults? and children)\b', re.I)
# Aimed at children, or at families with young children — as distinct from
# merely open to them. Judged on the title: descriptions mention families
# incidentally ("family friendly patio") often enough that reading them turns
# a county fair and a Dinosaur Jr. show into children's programming.
CHILD_FOCUSED = re.compile(r'''\b(
 children'?s?|child|kids?|kiddos|toddlers?|preschool|pre-?k|
 storytime|story\ time|story\ hour|puppet|pajama|
 youth|teens?|tweens?|bab(y|ies)(?!\ boomer)|infants?|
 family\ (day|fun|night|program|workshop|storytime|festival|film|movie|concert)|
 for\ families|children\ &\ families|all[-\ ]ages\ drop[-\ ]in|
 petting\ zoo|face\ painting|bounce\ house|trick[-\ ]or[-\ ]treat|
 lego|craft\ (time|hour)|summer\ reading
)\b''', re.I | re.X)
# A gig is not children's programming because a band is called Drink Baby.
EXPLICITLY_FOR_CHILDREN = re.compile(
    r"\b(children'?s?|kids?|family|families|youth|toddlers?|storytime)\b", re.I)

# Aimed at older adults. Deliberately narrow: "Senior Vice President" gives a
# talk and "retired senior programmers" attend a dinner without either being a
# seniors event, and a campus Senior Recital is a public concert. So match the
# phrasings that name the audience, plus "Senior <activity>" programme titles.
SENIORS = re.compile(r'''(?<!\w)(?:55|60|62|65)\s*\+(?!\w)|\b(?:
 older\ adults?|senior\ citizens?|for\ seniors|seniors\ only|seniors\ welcome|
 (?:55|60|62|65)\ and\ (?:up|over|older)|
 senior\ (?:breakfast|lunch(?:eon)?|social|club|bingo|movie|matinee|fitness|
         yoga|stretch|chair|tech|hour|day|center|centre|swim|walk|exercise)
)\b''', re.I | re.X)
# Lookarounds, not \b: a word boundary cannot match after the "+" in "21+",
# so \b(21\+)\b silently never fires.
ADULTS_ONLY = re.compile(
    r'(?<!\w)(21\s*\+|18\s*\+|21 and over|18 and over|adults? only|must be 21|'
    r'ages 21|over 21|21 years|21 and up|no minors)(?!\w)', re.I)


def audience_of(text, title=None, kind=None):
    """Who a listing is for: 'kids', 'family', 'seniors', 'adults' or 'all'.

    'kids' means children only — a drop-off programme or an age-capped class.
    'family' means aimed at families with young children: open to an adult, but
    not what an adult browsing for themselves is looking for. Keeping the two
    apart lets one switch hide both without also hiding a county fair that
    merely happens to be family friendly. 'seniors' is the same idea at the
    other end of the age range.
    """
    if SENIORS.search(text):
        return 'seniors'
    if ADULTS_ONLY.search(text):
        return 'adults'
    if KIDS_ONLY.search(text):
        # A child-aged programme in a family context ("ages 2-5 with a
        # caregiver") is aimed at families, not children alone. The first
        # version used family context as a veto and sent every library
        # storytime to 'all' — the opposite of what the veto was for.
        return 'family' if FAMILY.search(text) else 'kids'
    heading = title if title is not None else text
    if CHILD_FOCUSED.search(heading):
        # Music listings must say so outright, or every band with "Baby" in its
        # name becomes a children's event.
        if kind in ('concert', 'dj', 'open-mic') and not EXPLICITLY_FOR_CHILDREN.search(heading):
            return 'all'
        return 'family'
    return 'all'


def miles(lat1, lon1, lat2, lon2):
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    h = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * 3958.8 * asin(sqrt(h))


def load_cache():
    try:
        return json.load(open(CACHE))
    except Exception:
        return {}


def query_variants(loc):
    """Progressively simpler forms of a location string.

    Nominatim's free-text search fails on over-specified input: a venue name
    plus street plus ZIP plus country often returns nothing where the same
    place resolves fine from "Long Dock Park, Beacon, NY". So drop detail a
    layer at a time and take the first hit.
    """
    parts = [p.strip() for p in loc.split(',') if p.strip()]
    parts = [p for p in parts
             if not re.fullmatch(r'(united states|usa|us)', p, re.I)
             and not re.fullmatch(r'\d{5}(-\d{4})?', p)]
    if not parts:
        return []

    seen, out = set(), []
    def add(q):
        q = ', '.join(q).strip(', ')
        if q and q.lower() not in seen:
            seen.add(q.lower())
            out.append(q)

    add(parts)                                   # everything, minus zip/country
    if len(parts) > 2:
        add(parts[1:])                           # drop the venue name
    if len(parts) > 1:
        add([parts[0]] + parts[-2:])             # venue + town + state
        add(parts[-2:])                          # just town + state
    return out


def geocode(loc, cache, stats):
    """Resolve a location string, remembering both hits and misses.

    Caching misses matters: without it every run re-queries the same
    unresolvable strings and burns the rate limit for nothing.
    """
    key = loc.strip().lower()
    if key in cache:
        stats['cached'] += 1
        return cache[key]

    result = None
    for attempt, q in enumerate(query_variants(loc)):
        url = f'{NOMINATIM}?' + urllib.parse.urlencode(
            {'format': 'json', 'limit': 1, 'q': q})
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                hits = json.loads(r.read().decode('utf-8', 'replace'))
        except Exception as e:
            stats['errors'] += 1
            print(f'  geocode error for {q[:44]!r}: {e}', file=sys.stderr)
            return None                  # transient: do not poison the cache
        stats['looked_up'] += 1
        time.sleep(RATE)
        if hits:
            result = {'lat': float(hits[0]['lat']), 'lon': float(hits[0]['lon']),
                      'display': hits[0].get('display_name'), 'matched': q,
                      'precision': attempt}     # 0 = exact string, higher = broader
            break

    cache[key] = result
    return result


def clean_text(raw, limit=400):
    """Feed descriptions arrive as HTML fragments with entities intact.

    Without this, cards render literal "&gt;" and stray markup. Truncation
    lands on a sentence or word boundary rather than mid-word.
    """
    if not raw:
        return None
    t = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', raw, flags=re.S | re.I)
    t = re.sub(r'<br\s*/?>|</p>', ' ', t, flags=re.I)
    t = re.sub(r'<[^>]+>', '', t)
    t = html.unescape(t)
    # Some feeds double-encode, so one unescape pass can leave "&amp;" behind.
    if '&' in t:
        t = html.unescape(t)
    # Others ship JavaScript string escapes that survive JSON decoding as a
    # literal backslash, which renders as "Mansion\'s" on the card.
    t = re.sub(r'\\([\'"\\])', r'\1', t)
    t = re.sub(r'\\[nrt]', ' ', t)
    t = t.replace('\u00a0', ' ')
    t = re.sub(r'\s+', ' ', t).strip()
    if len(t) <= limit:
        return t or None

    cut = t[:limit]
    stop = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '))
    if stop > limit * 0.55:
        return cut[:stop + 1]
    space = cut.rfind(' ')
    return (cut[:space] if space > 0 else cut).rstrip(' ,;:—-') + '…'


SMALL_WORDS = {'of', 'the', 'and', 'at', 'in', 'on', 'for', 'a', 'an'}


def titlecase(text):
    """Feeds sometimes give an all-lowercase venue; render it like a name."""
    words = text.split()
    return ' '.join(w if (i and w in SMALL_WORDS) else w[:1].upper() + w[1:]
                    for i, w in enumerate(words))


def split_location(loc):
    """Pull a venue name and town out of a free-text location line."""
    parts = [p.strip() for p in (loc or '').split(',') if p.strip()]
    if not parts:
        return None, None
    venue = parts[0]
    city = None
    for i, p in enumerate(parts):
        if re.fullmatch(r'(NY|New York|NJ|CT|MA|PA)', p, re.I) and i:
            city = parts[i - 1]
            if not re.search(r'\d', city):
                city = f'{city}, NY' if p.upper() in ('NY', 'NEW YORK') else f'{city}, {p.upper()}'
            break
    return venue, city


def categorise(text):
    found = []
    for name, pattern in KEYWORDS:
        if re.search(pattern, text, re.I) and name not in found:
            found.append(name)
    return found[:4] or ['community']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', default='build/candidates.json')
    ap.add_argument('--platform', default='build/platform.json')
    ap.add_argument('--jsonld', default='build/jsonld.json')
    ap.add_argument('--social', default='build/social.json')
    ap.add_argument('--libcal', default='build/libcal.json')
    ap.add_argument('--songkick', default='build/songkick.json')
    ap.add_argument('--manual', default='sources/manual.json')
    ap.add_argument('--out', default='build/enriched.json')
    ap.add_argument('--registry', default='sources/registry.json')
    args = ap.parse_args()

    registry = json.load(open(args.registry))
    center = registry['center']
    # Venue feeds usually omit LOCATION — every event is at the same address —
    # so the registry carries the venue's own coordinates as a fallback.
    venue_default = {s['id']: s['venue'] for s in registry['sources'] if s.get('venue')}
    data = json.load(open(args.src))
    cache, stats = load_cache(), {'cached': 0, 'looked_up': 0, 'errors': 0}
    dropped = {'no_location': 0, 'ungeocodable': 0, 'out_of_radius': 0}

    out = []
    for c in data['candidates']:
        fallback = venue_default.get(c['sourceId'])
        loc = c.get('location')
        hit = geocode(loc, cache, stats) if loc else None

        # Track whether the venue default was actually used. Inheriting the
        # source venue's town for an event held somewhere else put "Ossining"
        # on a Mamaroneck library listing.
        used_fallback = False
        if not hit and fallback:
            hit = {'lat': fallback['lat'], 'lon': fallback['lon']}
            loc = loc or fallback.get('address') or fallback['name']
            used_fallback = True
        if not hit:
            dropped['no_location' if not loc else 'ungeocodable'] += 1
            continue

        d = miles(center['lat'], center['lon'], hit['lat'], hit['lon'])
        if d > center['radiusMiles']:
            dropped['out_of_radius'] += 1
            continue

        venue, city = split_location(loc)
        if used_fallback:
            venue = venue or fallback['name']
            city = city or fallback.get('city')
        if venue and venue == venue.lower():
            venue = titlecase(venue)
        blob = ' '.join(filter(None, [c['title'], c.get('description'), venue]))
        recurring = c.get('recurring') or bool(ACTIVITY_HINTS.search(blob))

        started = datetime.fromisoformat(c['start'])
        out.append({
            'id': f"{c['sourceId']}-{abs(hash(c.get('uid') or c['title'] + c['start'])) % 10**8}",
            'title': c['title'],
            'type': type_of(c['title'], c.get('description')),
            'repeats': bool(recurring),
            'audience': audience_of(blob, c['title'], type_of(c['title'], c.get('description'))),
            'setting': setting_of(blob),
            'timeOfDay': time_of_day(started),
            'hasFood': bool(FOOD.search(blob)),
            'host': c.get('organizer') or c['sourceName'],
            'categories': categorise(blob),
            'start': c['start'],
            'end': c.get('end'),
            'venue': venue or 'See listing',
            'city': city,
            'address': loc,
            'lat': round(hit['lat'], 5),
            'lon': round(hit['lon'], 5),
            'price': None,                     # never guessed — see module docstring
            'signupRequired': False,
            'url': c.get('url'),
            'description': clean_text(c.get('description')),
            'source': c['sourceName'],
        })

    # Ticketmaster, JSON-LD scrapes, the Eventbrite/Meetup sweep and hand-read
    # listings all arrive in final shape. They skip classification — but never
    # the radius check. Meetup carries no coordinates, so those records fall
    # through to the geocoder below like any other address.
    prepared = []
    for path, key in ((args.platform, 'events'), (args.jsonld, 'events'),
                      (args.social, 'events'), (args.libcal, 'events'),
                      (args.songkick, 'events'), (args.manual, 'items')):
        if os.path.exists(path):
            prepared.extend(json.load(open(path)).get(key, []))

    platform_kept = 0
    for e in prepared:
        # Hand-read entries were checked by a person; pass them through whole.
        if str(e.get('id', '')).startswith('manual-'):
            if miles(center['lat'], center['lon'], e['lat'], e['lon']) > center['radiusMiles']:
                dropped['out_of_radius'] += 1
                continue
            out.append(e)
            platform_kept += 1
            continue

        if e.get('lat') is None or e.get('lon') is None:
            query = e.get('address') or e.get('venue')
            hit = geocode(query, cache, stats) if query else None
            if not hit:
                dropped['ungeocodable'] += 1
                continue
            e['lat'], e['lon'] = hit['lat'], hit['lon']

        if miles(center['lat'], center['lon'], e['lat'], e['lon']) > center['radiusMiles']:
            dropped['out_of_radius'] += 1
            continue

        blob = blob_of(e)
        out.append({
            'id': e.get('id') or f"{e.get('sourceId', 'x')}-"
                                 f"{abs(hash(e.get('url') or e['title'])) % 10**8}",
            'title': e['title'],
            'type': e.get('type') or type_of(e['title'], e.get('description')),
            'repeats': bool(e.get('repeats')),
            # Meetup states its own cadence; without carrying it here a monthly
            # group arrives as a one-off, since the find page lists only the
            # next occurrence and nothing downstream can infer a pattern from
            # a single date.
            **({'recurrence': e['recurrence']} if e.get('recurrence') else {}),
            'audience': e.get('audience') or audience_of(
                blob, e['title'], e.get('type') or type_of(e['title'], e.get('description'))),
            'setting': e.get('setting') or setting_of(blob),
            'timeOfDay': e.get('timeOfDay') or time_of_day(
                datetime.fromisoformat(e['start'].replace('Z', '+00:00'))),
            'hasFood': e.get('hasFood', bool(FOOD.search(blob))),
            'host': e.get('host') or e.get('venue') or e.get('sourceName'),
            'categories': e.get('categories') or categorise(blob),
            'start': e['start'], 'end': e.get('end'),
            'venue': e.get('venue') or 'See listing', 'city': e.get('city'),
            'address': e.get('address') or e.get('venue'),
            'lat': round(e['lat'], 5), 'lon': round(e['lon'], 5),
            'price': e.get('price'),
            'signupRequired': bool(e.get('signupRequired')),
            'signupUrl': e.get('signupUrl'),
            'url': e.get('url'),
            'description': clean_text(e.get('description')),
            'source': e.get('sourceName') or e.get('source'),
        })
        platform_kept += 1

    out.sort(key=lambda x: x['start'])
    os.makedirs('build', exist_ok=True)
    json.dump(cache, open(CACHE, 'w'), indent=0)
    json.dump({'enrichedAt': datetime.now().astimezone().isoformat(timespec='seconds'),
               'center': center, 'items': out}, open(args.out, 'w'),
              indent=2, ensure_ascii=False)

    print(f"\n{len(out)} listings kept → {args.out}"
          + (f" (incl. {platform_kept} pre-shaped: platform, JSON-LD, hand-read)"
             if platform_kept else ""))
    print(f"  geocoding: {stats['looked_up']} looked up, {stats['cached']} cached, "
          f"{stats['errors']} errors")
    print(f"  dropped:   {dropped['out_of_radius']} outside {center['radiusMiles']} mi, "
          f"{dropped['ungeocodable']} ungeocodable, {dropped['no_location']} with no location")
    return 0


if __name__ == '__main__':
    sys.exit(main())
