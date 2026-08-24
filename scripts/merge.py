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


def richness(item):
    """How much a record actually tells a reader."""
    score = 0
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
        keep['kind'] = 'activity'
        keep['repeats'] = True
        when = datetime.fromisoformat(last['start']).strftime('%b %-d')
        keep['recurrence'] = f'{len(group)} dates listed through {when}'
        keep['end'] = None
        out.append(keep)
        collapsed += len(group) - 1
    return out, collapsed


def same_event(a, b):
    if day(a['start']) != day(b['start']):
        return False
    if norm(a['title']) != norm(b['title']):
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

    merged = list(curated)
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
