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

import argparse, json, re, sys
from collections import defaultdict
from datetime import datetime, timezone
from math import radians, sin, cos, asin, sqrt

# Internal governance that is not "something to do".
NOISE = re.compile(r'\b(board meeting|planning meeting|committee meeting|'
                   r'staff meeting|agm|annual general meeting)\b', re.I)


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
        when = datetime.fromisoformat(last['start']).strftime('%b %-d')
        keep['recurrence'] = f'{len(group)} dates listed through {when}'
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
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    existing = json.load(open(args.existing))
    curated = existing['items']
    incoming = json.load(open(args.new))['items']

    before = len(incoming)
    incoming = [i for i in incoming if not NOISE.search(i['title'])]
    noise = before - len(incoming)

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

    added = replaced = 0
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

    merged.sort(key=lambda x: x['start'])

    meta = dict(existing['meta'])
    meta['scrapedAt'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    meta['generatedBy'] = 'scripts/harvest.py + enrich.py + merge.py, reviewed by Claude'
    meta['sources'] = sorted({i.get('source') for i in merged if i.get('source')})

    print(f'  {len(curated)} existing + {before} harvested')
    if folded:
        print(f'  −{folded} near-duplicates already in the set')
    print(f'  −{noise} internal meetings, −{collapsed} folded into recurring activities')
    print(f'  +{added} new, {replaced} upgraded  →  {len(merged)} listings')
    if args.dry_run:
        return 0

    json.dump({'meta': meta, 'items': merged}, open(args.out, 'w'),
              indent=2, ensure_ascii=False)
    open(args.out, 'a').write('\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
