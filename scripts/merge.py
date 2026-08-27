#!/usr/bin/env python3
"""Fold newly harvested listings into data/events.json.

Three jobs, in order:

1. Collapse repeats. A venue that lists its daily tour 60 times is one
   recurring activity, not 60 events — otherwise a single source drowns the
   feed. (Storm King alone listed 111.)
2. Deduplicate across sources. The same show reaches us from the venue, the
   promoter and two aggregators; the richest copy wins, and a hand-checked
   price always beats an unpriced one.
3. Preserve curated data. Existing listings carry verified prices and written
   descriptions that no feed provides, so they are never overwritten by a
   thinner automatic record.

  python3 scripts/merge.py [--dry-run]
"""

import argparse, json, os, re, sys
from collections import defaultdict
from datetime import datetime, timezone
from math import radians, sin, cos, asin, sqrt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from enrich import (type_of, types_of, audience_of, place_name, place_kind,
                    STREET_ONLY, NOT_A_PLACE)

# Fields computed from a listing rather than reported by its source. They are
# only ever as good as the code that derived them, so a listing already in the
# set must not keep a classification made by an older vocabulary — otherwise
# improving the rules only ever fixes listings we happen to be seeing for the
# first time. Curated records (manual-) are exempt: a person checked those.
DERIVED = ('type', 'types', 'audience', 'setting', 'timeOfDay', 'cadence',
           'hasFood', 'repeats', 'recurrence', 'until')


def is_curated(item):
    return str(item.get('id', '')).startswith('manual-')


def adopt_derived(old, new):
    """Take `new`'s derived fields onto `old`, keeping everything else."""
    if is_curated(old):
        return old
    merged = dict(old)
    for f in DERIVED:
        if f in new:
            merged[f] = new[f]
    # repeats and recurrence describe one fact and have to move together. Taken
    # field by field, a new record that repeats:false and simply omits
    # recurrence left the old record's recurrence string standing beside it,
    # which validation reads — correctly — as a contradiction.
    if 'repeats' in new:
        merged['recurrence'] = new.get('recurrence')
        if not merged['recurrence']:
            merged.pop('recurrence', None)
        # until describes the same fact as recurrence and has to move with it,
        # or a record that stopped repeating keeps last week's end date.
        merged['until'] = new.get('until')
        if not merged['until']:
            merged.pop('until', None)
    return merged


# A library feed names the room, not the building: "Youth Services Program
# Room", "Riverview Meeting Room", "Third Floor Meeting Room", "311 Learning
# Annex". The event itself already knows better — it carries host="Howland
# Public Library" — so the room defers to its host.
#
# Deliberately narrow. "Charlotte's Tea Room" and "Cy's Restaurant & Lounge"
# are venues in their own right, so a bare "room" or "lounge" is not enough:
# the word has to be preceded by one of the words a library actually uses.
ROOM_NAME = re.compile(
    r"\b(program|meeting|community|conference|reading|storyhour|story|activity|"
    r"multi-?purpose|craft|computer|quiet|study|board|history|children'?s|teen|"
    r"youth services|lower level|upper level)\s+room\b"
    r"|\broom\s*\d|\bannex\b|\bauditorium\b|\bclassroom\b|\bgymnasium\b"
    r"|\b(lower|upper|ground|first|second|third|fourth)\s+(level|floor)\b", re.I)


def building_of(item):
    """The place an event is really at, not the room it booked."""
    venue, host = item.get('venue'), item.get('host')
    if not venue or not ROOM_NAME.search(venue):
        return venue
    # "Stern Auditorium, Carnegie Hall" already names its building, and its
    # host is the Berliner Philharmoniker — the act, not the address. When the
    # venue spells out where it is, believe the venue over the host.
    if ',' in venue:
        tail = venue.rsplit(',', 1)[1].strip()
        if tail and not ROOM_NAME.search(tail):
            return tail
    if host and host != venue and not ROOM_NAME.search(host):
        return host
    return venue


# Internal governance that is not "something to do".
NOISE = re.compile(r'\b(board meeting|planning meeting|committee meeting|'
                   r'staff meeting|agm|annual general meeting)\b', re.I)

# The running of a school, which reaches us through district, campus and
# aggregator feeds alike. Kept separate from the campus rule below because it
# is not tied to a source: a K-12 calendar can arrive via a library or a town,
# and "first day of school" is no more attendable for coming through Eventbrite.
# Narrow on purpose — a library's "Back to School Reading Buddies" is a real
# programme a child can attend, and stays.
SCHOOL_INTERNAL = re.compile(
    r"\b(first|last) day of (school|classes)\b"
    r"|\bschool (opens|closes|begins|resumes)\b"
    r"|\bsemester (begins|ends)\b|\bclasses (begin|resume|end)\b"
    r"|\bno school\b|\bearly dismissal\b|\bsnow day\b|\bhalf[- ]day\b"
    r"|\b(parent|student)[- ]teacher conference"
    r"|\breport cards?\b|\bpta\b|\bpto meeting\b|\bschool board\b"
    r"|\bsuperintendent\b"
    r"|\b(kindergarten|freshman|new student|student) orientation\b"
    r"|\bback[- ]to[- ]school night\b"
    r"|\bcourse (registration|selection)\b"
    r"|\bfinal exams? (week|period)\b|\bgraduation rehearsal\b"
    r"|\bconvocation\b",
    re.I)

# A college calendar is written for its own students. Most of what is on it —
# orientation, registration, finals, involvement fairs — is not something a
# neighbour can turn up to, and the campus brands them differently every year
# ("Viking Days", "Pie a Kappa"), so a blocklist of names never finishes.
# Invert it: on a campus feed, keep only what is recognisably open to the
# public, and drop everything else.
STUDENT_ONLY = re.compile(r"""\b(
 orientation|welcome\ (week|weekend|back|tables?|to)|viking\ days|move[-\ ]in|
 first\ day\ of\ class|last\ day\ of\ class|no\ classes|classes\ (resume|begin)|
 registration|add/drop|advising|final\ exams?|finals|cram\ jam|reading\ day|
 convocation|commencement|open\ house|info(rmation)?\ session|undergraduate\ visit|
 campus\ tour|admitted\ student|prospective\ student|enrollment|study\ abroad|
 career\ fair|job\ fair|resource\ fair|involvement\ fair|resume|internship|
 alumni|reunion|homecoming|sorority|fraternity|greek\ life|
 student\ (employment|involvement|organization|activities|government|meet)|
 clubs?\ carnival|common\ hour|campus\ community
)\b""", re.I | re.X)

CAMPUS_PUBLIC = re.compile(r"""\b(
 concert|recital|symphony|orchestra|choir|jazz|open\ mic|
 lecture|talk|reading|author|poet|keynote|symposium|panel|
 gallery|exhibit\w*|opening\ reception|
 film|screening|theat(er|re)|musical|comedy|
 festival|streetfest|craft\ fair|farmers?\ market|
 mass|worship|memorial|vigil|5k|10k|run/walk|marathon|
 blood\ drive|book\ club|family\ day|map-a-thon|planetarium
)\b""", re.I | re.X)

SPORT = re.compile(r'\b(basketball|soccer|volleyball|baseball|softball|hockey|lacrosse|'
                   r'tennis|golf|swimming|diving|cross country|field hockey|football|rugby)\b', re.I)
# "Fairfield Men's Soccer at UConn" is played in Storrs. It is a real event, but
# it belongs to the calendar of wherever it is held, not to ours.
AWAY_GAME = re.compile(r'\b(?:at|@)\s+[A-Z]')
HOME_GAME = re.compile(r'\bvs\.?\b', re.I)


def public_on_campus(title):
    """Would a neighbour with no connection to the college turn up to this?"""
    if STUDENT_ONLY.search(title):
        return False
    if SPORT.search(title):
        return bool(HOME_GAME.search(title)) and not AWAY_GAME.search(title)
    return bool(CAMPUS_PUBLIC.search(title))


def miles(a, b, c, d):
    dlat, dlon = radians(c - a), radians(d - b)
    h = sin(dlat / 2) ** 2 + cos(radians(a)) * cos(radians(c)) * sin(dlon / 2) ** 2
    return 2 * 3958.8 * asin(sqrt(h))


def norm(title):
    t = title.lower()
    t = re.sub(r'\(.*?\)', '', t)                      # "(Session #2)"
    t = re.sub(r'\b(session|part|day|week|no\.?|#)\s*\d+\b', '', t)
    t = re.sub(r'[^a-z0-9 ]+', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()


def day(iso):
    return (iso or '')[:10]


# Raw entities ("&amp;") and surviving JS escapes ("Mansion\\'s") render as
# literal noise on a card. A record carrying them is worth less than the same
# record re-read after the extractor learned to strip them — without this,
# richness alone would keep the corrupt copy forever, since cleaning text only
# ever makes it shorter.
UNCLEAN = re.compile(r'&(?:amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-f]+);|\\[nrt\'"]', re.I)


def richness(item):
    """How much a record actually tells a reader."""
    score = 0
    if any(UNCLEAN.search(str(item[f])) for f in
           ('title', 'description', 'venue', 'city', 'address', 'host') if item.get(f)):
        score -= 4
    if item.get('price'):
        score += 6                                     # the scarcest field
    if item.get('signupUrl'):
        score += 2
    if item.get('description'):
        score += min(len(item['description']) // 120, 3)
    if item.get('end'):
        score += 1
    if item.get('recurrence'):
        score += 1
    if item.get('host'):
        score += 1
    if item.get('setting') and item['setting'] != 'unknown':
        score += 1
    return score


WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday',
                 'Friday', 'Saturday', 'Sunday']


def join_and(names):
    """['Tuesday', 'Thursday'] -> 'Tuesday & Thursday'."""
    if len(names) == 1:
        return names[0]
    return f"{', '.join(names[:-1])} & {names[-1]}"


def cadence(dates):
    """Name the pattern a set of dates actually follows, or None if it has none.

    "12 dates listed through Sep 5" tells a reader how much data we hold, not
    when they could go. What they want to know is whether it is on this
    Thursday, so read the shape of the dates and say it plainly.

    Returns None when the dates fit no clean pattern — an irregular run is
    better described by its count than by a cadence that would be a lie.
    """
    days = sorted({d.date() for d in dates})
    if len(days) < 3:
        return None
    gaps = [(b - a).days for a, b in zip(days, days[1:])]
    weekdays = sorted({d.weekday() for d in days})
    span = (days[-1] - days[0]).days + 1

    # Daily: most days in the range are covered. A gap for a closed Monday
    # should not stop this reading as "every day".
    if span >= 4 and len(days) >= span * 0.8:
        return 'Every day'

    def weekly_on(w):
        """Do the dates falling on weekday `w` recur a whole number of weeks apart?

        Two occurrences minimum: a weekday seen once is a date, not a pattern,
        and without this a scatter of unrelated one-offs reads as
        "Every Tuesday, Friday & Saturday".
        """
        series = [d for d in days if d.weekday() == w]
        if len(series) < 2:
            return False
        steps = [(b - a).days for a, b in zip(series, series[1:])]
        return all(s % 7 == 0 and s <= 21 for s in steps)

    if all(weekly_on(w) for w in weekdays):
        if weekdays == [0, 1, 2, 3, 4]:
            return 'Every weekday'
        if len(weekdays) <= 3:
            names = [WEEKDAY_NAMES[w] for w in weekdays]
            if len(weekdays) == 1 and all(g == 14 for g in gaps):
                return f'Every other {names[0]}'
            return 'Every ' + join_and(names)

    # Calendar months drift between 28 and 31 days.
    if all(26 <= g <= 32 for g in gaps):
        return 'Every month'
    if all(12 <= g <= 16 for g in gaps):
        return 'Every other week'
    return None


# How often a thing comes round, as one of a few words a filter can offer.
# The recurrence string is written for a reader ("Every fourth Tuesday of the
# month"); this is the same fact in a form the UI can group by.
# Old vocabulary to new. Records not re-derived this run — because their text
# yields nothing and their type was asserted by a source — would otherwise keep
# names the filter no longer offers, so they would be invisible to every chip.
TYPE_ALIASES = {
    'theater': 'play', 'creative': 'class', 'art': 'art exhibit',
    'science': 'talk', 'sports': 'sporting event', 'wellness': 'yoga',
    'outdoors': 'tour', 'open-mic': 'open mic', 'food': 'dinner',
    'comedy': 'comedy show', 'dating': 'speed dating', 'kids': 'other',
    'show': 'play', 'music': 'concert', 'community': 'meetup',
    'nightlife': 'party', 'family': 'other',
    # Retired in favour of club, and of the museum/exhibit merge.
    'meetup': 'club', 'exhibit': 'museum exhibit', 'museum': 'museum exhibit',
}


# What a venue's own programme says about it, for the venues whose names say
# nothing — "Daryl's House" and "Tubby's" are music rooms, and only their
# listings reveal it.
KIND_FROM_TYPE = {
    'concert': 'music venue', 'dj': 'music venue', 'open mic': 'music venue',
    'play': 'theatre', 'musical': 'theatre', 'film': 'cinema',
    'comedy show': 'theatre', 'dance': 'theatre',
    'museum exhibit': 'museum', 'art exhibit': 'gallery',
    'sporting event': 'stadium', 'religious ceremony': 'place of worship',
    'tasting': 'brewery', 'animal encounter': 'park',
}


def assign_place_kinds(items):
    """Name first, then the venue's own programme.

    A name is only worth trusting when it says something — 'Public Library'
    does, "Colony" does not — so where it does not, the kind of thing that
    happens there decides, and only when one kind clearly dominates.
    """
    by_venue = defaultdict(list)
    for it in items:
        v = it.get('venue')
        if v and v != 'See listing':
            by_venue[v].append(it)

    kinds = {}
    for venue, listings in by_venue.items():
        named = place_kind(venue)
        if named:
            kinds[venue] = named
            continue
        tally = defaultdict(int)
        for it in listings:
            for t in (it.get('types') or []):
                if t in KIND_FROM_TYPE:
                    tally[KIND_FROM_TYPE[t]] += 1
        if tally:
            top, n = max(tally.items(), key=lambda kv: kv[1])
            # One clear kind, not a tie between two.
            if n >= max(2, 0.5 * sum(tally.values())):
                kinds[venue] = top

    for it in items:
        kind = kinds.get(it.get('venue'))
        if kind:
            it['placeKind'] = kind
        else:
            it.pop('placeKind', None)
    return kinds


def cadence_of(recurrence, repeats=False):
    if not recurrence:
        return 'occasional' if repeats else None
    text = str(recurrence).lower()
    if 'every day' in text or 'runs most days' in text:
        return 'daily'
    if 'weekday' in text:
        return 'weekday'
    if 'every other week' in text:
        return 'fortnightly'
    if 'of the month' in text or 'every month' in text or 'monthly' in text:
        return 'monthly'
    if re.search(r'every (other )?(monday|tuesday|wednesday|thursday|friday|'
                 r'saturday|sunday)', text):
        return 'fortnightly' if 'every other' in text else 'weekly'
    if re.search(r'\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|'
                 r'saturdays?|sundays?)\b', text):
        return 'weekly'
    if 'bookable' in text:
        return 'bookable'
    return 'occasional'


def collapse_repeats(items, threshold=3):
    """Turn a title repeated across many dates into one recurring activity."""
    groups = defaultdict(list)
    for it in items:
        groups[(it.get('source'), norm(it['title']), round(it['lat'], 2))].append(it)

    out, collapsed = [], 0
    for group in groups.values():
        if len(group) < threshold:
            out.extend(group)
            continue
        group.sort(key=lambda x: x['start'])
        first, last = group[0], group[-1]
        keep = dict(first)
        keep['repeats'] = True
        starts = [datetime.fromisoformat(i['start']) for i in group]
        when = datetime.fromisoformat(last['start']).strftime('%b %-d')
        pattern = cadence(starts)
        keep['recurrence'] = (f'{pattern}, through {when}' if pattern
                              else f'{len(group)} dates, through {when}')
        keep['end'] = None
        # When the series stops, machine-readable. The recurrence string says
        # "through Sep 2" and the client cannot read English — without this it
        # has no way to know a daily run has finished, or to work out which
        # occurrence is the next one still to come.
        keep['until'] = last['start']
        out.append(keep)
        collapsed += len(group) - 1
    return out, collapsed


STOP = {'the', 'a', 'an', 'at', 'in', 'on', 'of', 'and', 'for', 'to', 'with',
        'annual', 'presents', 'featuring'}


def tokens(title):
    return {w for w in norm(title).split() if w not in STOP and len(w) > 2}


def titles_match(a, b):
    """Exact after normalising, one contained in the other, or mostly the same words.

    Aggregators rewrite titles: the same county fair arrived as both "180th
    Dutchess County Fair" and "180th Dutchess County Fair in Rhinebeck (Aug 25-30)",
    which exact matching treats as two events.
    """
    na, nb = norm(a), norm(b)
    if na == nb:
        return True
    if na and nb and (na in nb or nb in na):
        return True
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return False
    overlap = len(ta & tb) / len(ta | tb)
    return overlap >= 0.6


def span(item):
    """The days a listing covers, as (first, last)."""
    first = day(item['start'])
    last = day(item.get('end')) or first
    return first, (last if last >= first else first)


def dates_overlap(a, b):
    """Same day, or overlapping runs when either is multi-day.

    A six-day fair reaches us twice — once dated to its opening and once to a
    day inside the run — so equal start dates alone miss it. Overlap is only
    allowed to match when one of them really is a multi-day run, otherwise two
    separate weekly sessions at one venue would collapse into each other.
    """
    a0, a1 = span(a)
    b0, b1 = span(b)
    if a0 == b0:
        return True
    if a1 == a0 and b1 == b0:
        return False                      # both single-day, different days
    return a0 <= b1 and b0 <= a1


def same_event(a, b):
    if not dates_overlap(a, b):
        return False
    if not titles_match(a['title'], b['title']):
        return False
    return miles(a['lat'], a['lon'], b['lat'], b['lon']) < 2.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--existing', default='data/events.json')
    ap.add_argument('--new', default='build/enriched.json')
    ap.add_argument('--out', default='data/events.json')
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    existing = json.load(open(args.existing))
    curated = existing['items']
    incoming = json.load(open(args.new))['items']

    # Publisher names, since a listing carries `source` rather than a source id.
    campus_sources = {s.get('publisher') for s in json.load(open(args.registry))['sources']
                      if s.get('campus')}

    def wanted(item):
        if NOISE.search(item['title']) or SCHOOL_INTERNAL.search(item['title']):
            return False
        if item.get('source') in campus_sources and not public_on_campus(item['title']):
            return False
        return True

    before = len(incoming)
    incoming = [i for i in incoming if wanted(i)]
    noise = before - len(incoming)

    # Apply the same rule to what is already held, so tightening it clears out
    # listings admitted under looser rules instead of leaving them forever.
    kept_curated = [i for i in curated if is_curated(i) or wanted(i)]
    purged = len(curated) - len(kept_curated)
    curated = kept_curated

    incoming, collapsed = collapse_repeats(incoming)

    # Fold duplicates already sitting in the curated set (earlier runs matched
    # on exact titles only, so near-duplicates accumulated).
    merged, folded = [], 0
    for item in curated:
        twin = next((i for i, other in enumerate(merged) if same_event(other, item)), None)
        if twin is None:
            merged.append(item)
        else:
            folded += 1
            if richness(item) > richness(merged[twin]):
                item['id'] = merged[twin]['id']
                merged[twin] = item

    added = replaced = refreshed = retyped = 0
    for new in incoming:
        match = next((i for i, old in enumerate(merged) if same_event(old, new)), None)
        if match is None:
            merged.append(new)
            added += 1
        elif richness(new) > richness(merged[match]):
            # Keep the curated id so links and any saved state stay stable.
            new['id'] = merged[match]['id']
            merged[match] = new
            replaced += 1
        else:
            # Not richer overall, but its classification is current.
            current = merged[match]
            reclassified = adopt_derived(current, new)
            if reclassified != current:
                merged[match] = reclassified
                refreshed += 1

    for item in merged:
        # types is required of every listing, including hand-checked ones —
        # filling a new field from the one it generalises is not reclassifying.
        if not item.get('types'):
            item['types'] = [item.get('type') or 'other']
        # One vocabulary now; the parallel category list is gone.
        item.pop('categories', None)
        # Vocabulary migrations, applied to every listing including hand-checked
        # ones: renaming the values a field may hold is not reclassifying what
        # a listing is, and leaving old values behind would fail validation.
        if item.get('timeOfDay') in ('morning', 'afternoon'):
            item['timeOfDay'] = 'daytime'
        elif item.get('timeOfDay') in ('evening', 'night'):
            item['timeOfDay'] = 'nighttime'
        if item.get('audience') == 'kids':
            item['audience'] = 'family'
        kinds = [TYPE_ALIASES.get(t, t) for t in (item.get('types') or [])]
        kinds = [t for i, t in enumerate(kinds) if t not in kinds[:i]]
        if kinds:
            item['types'] = kinds
            item['type'] = kinds[0]
        item['cadence'] = cadence_of(item.get('recurrence'), item.get('repeats'))
        if item['cadence'] is None:
            item.pop('cadence', None)
        # Listings already held were stored before venue resolution learned to
        # prefer a name over a street, and venue is source data rather than a
        # derived field, so nothing else would ever revisit them. "1 Museum Rd"
        # becomes "Storm King Art Center" using only what the record carries.
        stored = str(item.get('venue') or '').strip()
        if stored and (STREET_ONLY.match(stored) or stored.lower() in NOT_A_PLACE):
            better = place_name(item['venue'], item.get('host'), item.get('source'))
            if better and better != item['venue']:
                if not item.get('address'):
                    item['address'] = item['venue']
                item['venue'] = better
            elif stored.lower() in NOT_A_PLACE:
                # Nothing on the record names a place. Better to say so than to
                # let a platform's name stand in for somewhere to go.
                item['venue'] = 'See listing'
        if is_curated(item):
            continue
        fresh = types_of(item.get('title', ''), item.get('description') or '',
                         item.get('venue'))
        # 'other' is the absence of a text signal, not a verdict — a source
        # that asserted a type outright (Songkick marks every show a
        # MusicEvent) knows more than a title like "Faetooth @ Bowery
        # Ballroom" reveals, so silence never downgrades an existing type.
        if fresh != ['other'] and fresh != item.get('types'):
            # Keep a source-asserted primary that the text cannot see, but let
            # the derived kinds join it.
            asserted = item.get('type')
            if asserted and asserted != 'other' and asserted not in fresh:
                fresh = [asserted] + [t for t in fresh if t != asserted]
            item['types'] = fresh[:3]
            item['type'] = item['types'][0]
            retyped += 1
        elif not item.get('types'):
            item['types'] = [item.get('type') or 'other']
        # Audience follows the same rule as type: a held listing keeps the
        # verdict of whatever vocabulary classified it, so a rule improvement
        # that fixes new records must also re-judge the old ones.
        blob = ' '.join(filter(None, [item.get('title', ''),
                                      item.get('description') or '']))
        aud = audience_of(blob, item.get('title', ''), item.get('type'))
        if aud != item.get('audience'):
            item['audience'] = aud
            retyped += 1

    place_kinds = assign_place_kinds(merged)

    # A second look at what is still 'other', now that every venue has a kind.
    # "Berlin" and "Elsewhere" name no kind of thing and neither do the acts
    # they book, but both are known music rooms by the company their listings
    # keep — so a bare artist name at one of them is a gig.
    KIND_IMPLIES = {
        'music venue': 'concert', 'theatre': 'play', 'museum': 'museum exhibit',
        'stadium': 'sporting event', 'place of worship': 'religious ceremony',
        'cinema': 'film', 'gallery': 'art exhibit', 'winery': 'tasting',
        'brewery': 'tasting', 'garden': 'tour', 'castle': 'tour',
        'historic house': 'tour', 'historic site': 'tour',
    }
    from_venue = 0
    for item in merged:
        if item.get('types') != ['other']:
            continue
        implied = KIND_IMPLIES.get(item.get('placeKind'))
        if implied:
            item['types'] = [implied]
            item['type'] = implied
            from_venue += 1

    # The venue a listing is *at*, resolved once here so the Places count and
    # the Places filter cannot disagree. They did: the room-to-building rule
    # lived only in places.py, so the directory credited Howland Public Library
    # with seven events while every one of them still said "Community Room",
    # and tapping through to them found nothing.
    for item in merged:
        item['venueKey'] = building_of(item)

    merged.sort(key=lambda x: x['start'])

    meta = dict(existing['meta'])
    # The registry owns the search area. Without this the published file keeps
    # whatever radius it was first written with, so widening the registry left
    # validate.py failing listings the pipeline had just decided were in range.
    center = json.load(open(args.registry))['center']
    meta['centerName'] = center['name']
    meta['centerLat'], meta['centerLon'] = center['lat'], center['lon']
    meta['radiusMiles'] = center['radiusMiles']
    meta['timezone'] = center.get('timezone', meta.get('timezone'))
    meta['scrapedAt'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    meta['generatedBy'] = 'scripts/harvest.py + enrich.py + merge.py, reviewed by Claude'
    meta['sources'] = sorted({i.get('source') for i in merged if i.get('source')})

    print(f'  {len(curated)} existing + {before} harvested')
    if purged:
        print(f'  −{purged} existing listings now filtered out (campus-internal or noise)')
    if folded:
        print(f'  −{folded} near-duplicates already in the set')
    print(f'  −{noise} internal meetings, −{collapsed} folded into recurring activities')
    print(f'  +{added} new, {replaced} upgraded, {refreshed} reclassified, '
          f'{retyped} retyped  →  {len(merged)} listings')
    kinded = len({i['venue'] for i in merged if i.get('placeKind')})
    allv = len({i['venue'] for i in merged if i.get('venue') and i['venue'] != 'See listing'})
    print(f'  {kinded}/{allv} venues categorised '
          f'({len(set(place_kinds.values()))} kinds)')
    if from_venue:
        print(f'  {from_venue} listings typed from the kind of place they are at')
    if args.dry_run:
        return 0

    json.dump({'meta': meta, 'items': merged}, open(args.out, 'w'),
              indent=2, ensure_ascii=False)
    open(args.out, 'a').write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
