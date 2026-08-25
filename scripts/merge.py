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
from enrich import type_of

# Fields computed from a listing rather than reported by its source. They are
# only ever as good as the code that derived them, so a listing already in the
# set must not keep a classification made by an older vocabulary — otherwise
# improving the rules only ever fixes listings we happen to be seeing for the
# first time. Curated records (manual-) are exempt: a person checked those.
DERIVED = ('type', 'categories', 'audience', 'setting', 'timeOfDay',
           'hasFood', 'repeats', 'recurrence')


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
    return merged


# Internal governance that is not "something to do".
NOISE = re.compile(r'\b(board meeting|planning meeting|committee meeting|'
                   r'staff meeting|agm|annual general meeting)\b', re.I)

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
        if NOISE.search(item['title']):
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
        if is_curated(item):
            continue
        fresh = type_of(item.get('title', ''), item.get('description') or '')
        if fresh != item.get('type'):
            item['type'] = fresh
            retyped += 1

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
    if args.dry_run:
        return 0

    json.dump({'meta': meta, 'items': merged}, open(args.out, 'w'),
              indent=2, ensure_ascii=False)
    open(args.out, 'a').write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
