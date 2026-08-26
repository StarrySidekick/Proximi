#!/usr/bin/env python3
"""Gate on data/events.json before it reaches the site.

The weekly job writes this file unattended, so the checks here are the only
thing standing between a bad harvest and 121 wrong listings in public.

  python3 scripts/validate.py [path]
"""

import json, os, re, sys
from datetime import datetime, timedelta, timezone
from math import radians, sin, cos, asin, sqrt

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from enrich import TYPES

# The one vocabulary. Anything outside it is invisible to every filter chip,
# which is a silent failure — the listing renders and can never be found.
KINDS = {name for name, _ in TYPES} | {'other'}

AUDIENCES = {'all', 'family', 'seniors', 'adults'}
SETTINGS = {'indoor', 'outdoor', 'unknown'}
TIMES = {'daytime', 'nighttime'}
ISO = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)$')


def miles(a, b, c, d):
    dlat, dlon = radians(c - a), radians(d - b)
    h = sin(dlat / 2) ** 2 + cos(radians(a)) * cos(radians(c)) * sin(dlon / 2) ** 2
    return 2 * 3958.8 * asin(sqrt(h))


def main(path='data/events.json'):
    data = json.load(open(path))
    meta, items = data['meta'], data['items']
    errors, warnings = [], []

    for key in ('centerLat', 'centerLon', 'radiusMiles', 'timezone', 'scrapedAt'):
        if meta.get(key) in (None, ''):
            errors.append(f'meta.{key} is missing')
    if not ISO.match(meta.get('scrapedAt', '')):
        errors.append('meta.scrapedAt must be a full ISO timestamp with an offset — '
                      'a date-only string is read as UTC midnight')

    ids = [i.get('id') for i in items]
    for dup in {i for i in ids if ids.count(i) > 1}:
        errors.append(f'duplicate id: {dup}')

    horizon = datetime.now(timezone.utc) + timedelta(days=730)
    for i in items:
        tag = i.get('id', '?')
        for field in ('id', 'title', 'type', 'venue', 'host', 'lat', 'lon', 'url'):
            if i.get(field) in (None, '', []):
                errors.append(f'{tag}: missing {field}')
        if 'kind' in i:
            errors.append(f'{tag}: kind was removed from the schema — use type')
        if i.get('setting') not in SETTINGS:
            errors.append(f"{tag}: setting must be one of {sorted(SETTINGS)}, "
                          f"got {i.get('setting')!r}")
        if i.get('timeOfDay') not in TIMES:
            errors.append(f"{tag}: timeOfDay must be one of {sorted(TIMES)}, "
                          f"got {i.get('timeOfDay')!r}")
        if not isinstance(i.get('hasFood'), bool):
            errors.append(f'{tag}: hasFood must be true or false')

        start = i.get('start')
        if not start:
            errors.append(f'{tag}: no start')
        else:
            if not ISO.match(start):
                errors.append(f'{tag}: start {start!r} needs an explicit UTC offset')
            try:
                when = datetime.fromisoformat(start)
                if when.tzinfo and when > horizon:
                    warnings.append(f'{tag}: starts more than 2 years out ({start[:10]})')
            except ValueError:
                errors.append(f'{tag}: start {start!r} is unparseable')

        # price must be null or an object. A bare 0 would render as "Free",
        # which is the one mistake that actively misleads people.
        if 'price' not in i:
            errors.append(f'{tag}: no price key (use null when unpublished)')
        elif i['price'] is not None:
            p = i['price']
            if not isinstance(p, dict):
                errors.append(f'{tag}: price must be null or an object, got {type(p).__name__}')
            elif not isinstance(p.get('min'), (int, float)):
                errors.append(f'{tag}: price.min must be a number')

        kinds = i.get('types')
        if not isinstance(kinds, list) or not kinds:
            errors.append(f'{tag}: types must be a non-empty list')
        elif [k for k in kinds if k not in KINDS]:
            errors.append(f'{tag}: unknown kind(s) {[k for k in kinds if k not in KINDS]!r} — '
                          f'not in the vocabulary, so no filter can reach it')
        elif i.get('type') != kinds[0]:
            errors.append(f'{tag}: type {i.get("type")!r} must be the first of '
                          f'types {kinds!r} — the badge and the filter would disagree')
        if i.get('audience') not in AUDIENCES:
            errors.append(f"{tag}: audience must be one of {sorted(AUDIENCES)}, "
                          f"got {i.get('audience')!r}")
        if not isinstance(i.get('repeats'), bool):
            errors.append(f'{tag}: repeats must be true or false')
        # A stated recurrence and repeats:false contradict each other, and the
        # UI trusts repeats for filtering while showing recurrence to readers.
        if i.get('recurrence') and not i.get('repeats'):
            errors.append(f'{tag}: has a recurrence but repeats is false')

        if i.get('description') and re.search(r'<[a-z/][^>]*>|&(amp|gt|lt|quot|#\d+);',
                                              i['description'], re.I):
            warnings.append(f'{tag}: description still contains markup or entities')

        if i.get('signupRequired') and not i.get('signupUrl'):
            errors.append(f'{tag}: signupRequired with no signupUrl')

        if isinstance(i.get('lat'), (int, float)) and isinstance(i.get('lon'), (int, float)):
            d = miles(meta['centerLat'], meta['centerLon'], i['lat'], i['lon'])
            if d > meta['radiusMiles']:
                errors.append(f'{tag}: {d:.1f} mi — outside the {meta["radiusMiles"]} mi radius')

    for w in warnings:
        print(f'warning: {w}')
    if errors:
        print(f'\nFAILED — {len(errors)} problem(s):')
        for e in errors[:40]:
            print('  -', e)
        if len(errors) > 40:
            print(f'  … and {len(errors) - 40} more')
        return 1

    priced = sum(1 for i in items if i.get('price'))
    repeat = sum(1 for i in items if i.get('repeats'))
    outdoor = sum(1 for i in items if i.get('setting') == 'outdoor')
    food = sum(1 for i in items if i.get('hasFood'))
    types = len({t for i in items for t in (i.get('types') or [])})
    family = sum(1 for i in items if i.get('audience') == 'family')
    seniors = sum(1 for i in items if i.get('audience') == 'seniors')
    adults = sum(1 for i in items if i.get('audience') == 'adults')
    print(f'{len(items)} listings OK — {priced} priced, {len(items) - priced} "see listing", '
          f'{repeat} repeating, {family} family, {seniors} seniors, {adults} 21+, '
          f'{outdoor} outdoor, {food} with food, {types} types, '
          f'all within {meta["radiusMiles"]} mi of {meta["centerName"]}'
          + (f' ({len(warnings)} warning(s))' if warnings else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:]))
