#!/usr/bin/env python3
"""Places — the directory of somewhere to go, whether or not anything is on.

The venue list used to be a projection of the event feed: a place existed only
because something was scheduled there. That answers "where is this happening"
and not "what is around here", which leaves out most of what the Hudson Valley
is actually good for — the gardens, the historic houses, the wineries, the
antique shops, the castle. None of those publish a calendar and most of them
never will.

OpenStreetMap already knows where they all are, tagged well enough to
categorise mechanically. This pulls them at the places radius, keeps the ones
worth a trip (scripts/placekinds.DESTINATIONS), and writes data/places.json.
merge_events() then links each place to any events already on its calendar, so
a theatre carries its listings and a garden simply sits there being a garden.

Overpass is the constraint, in two ways worth naming.

The first is the query. `around:` makes Overpass measure the distance to every
candidate in the index, and over 80km that is slow enough that `out tags center`
times out on every mirror — while the identical query with `out count` returns
in 35 seconds, which is exactly what makes it look like a mirror problem rather
than a query problem. A bounding box is a cheap index lookup and returns the
same museums in 37 seconds. It over-selects at the corners, which costs nothing:
to_place() drops anything past the radius anyway.

The second is the mirrors, which rot. So: one small query per selector, each
answer cached under build/places-cache/, every mirror tried in turn, and a
partial result reported rather than thrown away. A bad afternoon costs one
selector on one run; the next run picks up what is missing.

Coverage is a list of circles, not one circle. The centre is still the centre —
it is what `miles` is measured from and what the app opens on — and
`placesRegions` in the registry adds further areas collected on exactly the same
terms. One circle big enough to hold both Bar Harbor and Hartford also holds the
Gulf of Maine, Montreal and most of New Jersey, and Overpass would be asked for
every park in it. Six small circles along the road are cheaper and say something
true. A registry with no `placesRegions` is today's behaviour exactly: one
region, the centre.

  python3 scripts/places.py [--radius 50] [--out data/places.json]
  python3 scripts/places.py --selftest      # the tag rules actually match
  python3 scripts/places.py --refresh       # ignore the cache
  python3 scripts/places.py --regions acadia,midcoast --fetch-only
                                            # fill the cache for two regions and
                                            # write nothing; run it again with
                                            # no flags to assemble the file
"""

import argparse, hashlib, json, math, os, re, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone

# This run takes half an hour and is watched through a log file. Python buffers
# stdout when it is redirected, so the per-kind counts sat in the buffer while
# the failures — stderr, unbuffered — appeared immediately, which read as
# "every kind is failing" when nothing of the sort was happening.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import placekinds
import images

UA = 'Mozilla/5.0 (compatible; ProximiBot/0.1; +https://github.com/StarrySidekick/Proximi)'

# Tried in order. The public Overpass estate is not reliable: on the day this
# was written the main endpoint reset every connection and two mirrors answered
# 500/502, leaving one that worked but was slow enough that a 100-second
# timeout cut off queries that would have succeeded — which is why the timeouts
# below are generous and the cache exists.
#
# overpass.osm.ch is deliberately absent: it answers every query happily and
# returns zero results for anything outside Switzerland, which reads as "no
# data here" rather than as a failure. A mirror that lies is worse than one
# that is down.
MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]

STATE_NAMES = {'NY': 'NY', 'New York': 'NY', 'CT': 'CT', 'Connecticut': 'CT',
               'NJ': 'NJ', 'New Jersey': 'NJ', 'MA': 'MA', 'Massachusetts': 'MA',
               'PA': 'PA', 'Pennsylvania': 'PA', 'VT': 'VT', 'Vermont': 'VT'}

# Some tags are applied to things you can visit and to things you merely walk
# past, with nothing in the tag to tell them apart: historic=memorial covers a
# battlefield and a plaque on a rock, historic=house covers a house museum and
# a private home with a plaque by the door. What separates a destination is
# that somebody bothered to record a way in — a website, an opening time, a
# heritage listing, a description. Kinds listed here have to show one.
THIN = {'historic site', 'historic house', 'garden', 'park', 'landmark',
        'lookout'}


def miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def save_json(path, data):
    """Write through a temp file, so a half-written cache never exists.

    Two things read these: the next run, and now a second process filling a
    different region. A reader that catches a file mid-write gets a truncated
    document, and the old failure was worse than that — the bad file stayed on
    disk and poisoned every run after it, silently, because a cache hit never
    looks twice.
    """
    tmp = f'{path}.{os.getpid()}.tmp'
    with open(tmp, 'w') as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def load_json(path):
    """None for a file that is missing *or* unreadable — both mean refetch."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def slot(selector):
    """Cache key for one selector — its content, never its position.

    Keying on the index within a kind meant that removing a selector from the
    middle of a list silently remapped every cached answer after it to the
    wrong query. Nothing errors; the counts just quietly become someone else's.
    Selector lists get tuned constantly, so this had to stop being positional.
    """
    return hashlib.sha1(selector.encode()).hexdigest()[:10]


def region_slot(region):
    """Cache directory for one region — its geometry, never just its name.

    `slot()` learned this lesson for selectors: a cache key that does not
    describe the query eventually answers a different one. A region's id is a
    label a person types, so moving a region's coordinates while keeping its id
    would hand back the old area's museums with nothing anywhere saying so.
    """
    fingerprint = f"{region['lat']:.4f},{region['lon']:.4f},{region['radiusMiles']:g}"
    return f"{region['id']}-{hashlib.sha1(fingerprint.encode()).hexdigest()[:8]}"


def load_regions(registry_path, radius_override=None):
    """Every area to collect, home first.

    Home is the registry `center`, unchanged and still the one owner of where
    this app is based. Everything after it comes from `placesRegions`.
    """
    doc = json.load(open(registry_path))
    center = doc['center']
    default_radius = radius_override or center.get('placesRadiusMiles') or 50
    regions = [{'id': 'home', 'name': center['name'], 'lat': center['lat'],
                'lon': center['lon'], 'radiusMiles': default_radius}]
    for extra in doc.get('placesRegions', []):
        regions.append({
            'id': extra['id'], 'name': extra['name'],
            'lat': extra['lat'], 'lon': extra['lon'],
            'radiusMiles': radius_override or extra.get('radiusMiles') or default_radius,
        })
    ids = [r['id'] for r in regions]
    repeated = sorted({i for i in ids if ids.count(i) > 1})
    if repeated:
        raise SystemExit(f'placesRegions ids must be unique — repeated: {repeated}')
    return regions


def bbox(center, radius):
    """(south,west,north,east) covering a radius, for Overpass.

    `around:` makes Overpass measure the distance to every candidate in the
    index, and over 80km that is slow enough that `out tags center` times out
    on every mirror while the identical `out count` returns in 35 seconds. A
    bbox is a cheap index lookup. It over-selects at the corners by up to 27%,
    which costs nothing: to_place() already drops anything past the radius.
    """
    dlat = radius / 69.0
    dlon = radius / (69.0 * max(0.2, math.cos(math.radians(center['lat']))))
    return (f"{center['lat'] - dlat:.4f},{center['lon'] - dlon:.4f},"
            f"{center['lat'] + dlat:.4f},{center['lon'] + dlon:.4f}")


# Which mirror answered last. The estate rotates — in one session the main
# endpoint reset every connection for an hour and then came back while the
# mirror that had been carrying the run went down — so a static order is
# always wrong eventually, and a dead mirror at the front of the list costs
# its full timeout on every single selector.
_LAST_GOOD = None


def query(body, timeout=180, sweeps=3):
    """Whatever worked last, then every mirror, then round again after a pause.

    A 504 here means one mirror is busy, not that the data is missing, and the
    busy one is rarely the same two minutes later. Giving up after a single
    sweep is what made an earlier run report "museum: 0" for a county with
    forty of them.
    """
    global _LAST_GOOD
    last = None
    for sweep in range(sweeps):
        order = ([_LAST_GOOD] + [m for m in MIRRORS if m != _LAST_GOOD]
                 if _LAST_GOOD else list(MIRRORS))
        for mirror in order:
            try:
                req = urllib.request.Request(
                    mirror, data=urllib.parse.urlencode({'data': body}).encode(),
                    headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    payload = json.loads(resp.read().decode('utf-8', 'replace'))
                _LAST_GOOD = mirror
                return payload
            except Exception as exc:
                last = f'{mirror.split("/")[2]}: {exc}'
                if mirror == _LAST_GOOD:
                    _LAST_GOOD = None       # it stopped working; stop preferring it
        if sweep < sweeps - 1:
            time.sleep(20 * (sweep + 1))
    raise RuntimeError(f'all Overpass mirrors failed (last: {last})')


def settlements(region, cache_dir='build/places-cache'):
    """Every named town in range, so a place with no addr:city still gets one.

    OSM puts addr:city on shop nodes and almost never on the ways that carry
    a park, a castle or a vineyard — the things this directory is most about.
    Reverse-geocoding two thousand of them is out; one query for the towns and
    a nearest-neighbour lookup costs one request.
    """
    # Cached like every other query. Without this a run that collects fine but
    # loses the town lookup silently drops 800 town labels that the previous
    # run had — which is what happened once, and looked like nothing.
    path = os.path.join(cache_dir, region_slot(region), 'towns.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = load_json(path)
    if data is not None:
        towns = [(e['lat'], e['lon'], e['tags']['name'],
                  STATE_NAMES.get(e['tags'].get('is_in:state', ''), None),
                  {'city': 3, 'town': 2, 'village': 1, 'hamlet': 0}[e['tags']['place']])
                 for e in data.get('elements', [])]
        print(f'  {"towns":<16} {len(towns):>5}  (cached)')
        return towns

    area = f'({bbox(region, region["radiusMiles"] + 15)})'
    try:
        # Deliberately a small budget. Town labels are a nicety — the places
        # themselves are the point — so this must never be what a run spends
        # its afternoon on. One sweep, and if the mirrors are having a bad day
        # the places keep whatever addr:city they carry.
        data = query('[out:json][timeout:90];('
                     f'node["place"~"^(city|town|village|hamlet)$"]["name"]{area};'
                     ');out tags center;', timeout=120, sweeps=1)
    except Exception as exc:
        print(f'  ! towns unavailable ({exc}) — places keep whatever addr:city they carry',
              file=sys.stderr)
        return []
    save_json(path, data)
    towns = []
    for el in data.get('elements', []):
        tags = el.get('tags', {})
        state = STATE_NAMES.get(tags.get('is_in:state', ''), None)
        towns.append((el['lat'], el['lon'], tags['name'], state,
                      {'city': 3, 'town': 2, 'village': 1, 'hamlet': 0}[tags['place']]))
    print(f'  {"towns":<16} {len(towns):>5}')
    return towns


def town_index(towns):
    """Towns bucketed by whole degree, because there are eight regions now.

    nearest_town scans every town for every place. One region was 800 towns
    against 3,500 places; the corridor is 3,000 against 25,000, which is 75
    million distance tests and about two minutes of doing nothing useful. A
    degree of latitude is 69 miles and the cutoff below is 12, so the 3x3 block
    around a place can only ever miss towns that would have been rejected.
    """
    cells = {}
    for town in towns:
        cells.setdefault((int(town[0]), int(town[1])), []).append(town)
    return cells


def nearby_towns(lat, lon, cells):
    out = []
    for dlat in (-1, 0, 1):
        for dlon in (-1, 0, 1):
            out.extend(cells.get((int(lat) + dlat, int(lon) + dlon), ()))
    return out


def nearest_town(lat, lon, towns):
    best, best_d = None, 1e9
    for tlat, tlon, name, state, rank in towns:
        # Cheap planar distance — over ten miles the ranking is the same as the
        # great-circle one, and this runs a few thousand times per town.
        d = ((tlat - lat) * 69) ** 2 + ((tlon - lon) * 51.5) ** 2
        d -= rank * 0.25          # a town beats a hamlet at equal distance
        if d < best_d:
            best, best_d = (name, state), d
    if not best or best_d > 144:  # more than ~12 miles out is not "in" anywhere
        return None
    name, state = best
    return f'{name}, {state}' if state else name


def fetch_kind(kind, selectors, region, cache_dir):
    """One query per selector, cached to disk.

    OR-ing a kind's selectors into one query means the cheap ones wait behind
    the expensive one: leisure=garden covers every named garden polygon in
    fifty miles and times out, taking leisure=nature_reserve down with it.
    Separately, each answer is cached under build/, so a mirror having a bad
    afternoon costs one selector on one run rather than the whole sweep — the
    next run picks up only what is still missing.
    """
    area = f'({bbox(region, region["radiusMiles"])})'
    home = os.path.join(cache_dir, region_slot(region))
    os.makedirs(home, exist_ok=True)
    elements, missed = [], 0
    for sel in selectors:
        path = os.path.join(home, f'{kind.replace(" ", "-")}-{slot(sel)}.json')
        cached = load_json(path)
        if cached is not None:
            elements.extend(cached.get('elements', []))
            continue
        # ["name"] is the cheapest possible quality filter: an unnamed node is
        # a map feature, not a destination.
        body = f'[out:json][timeout:180];(nwr[{sel}]["name"]{area};);out tags center;'
        try:
            data = query(body, timeout=240, sweeps=2)
        except Exception as exc:
            print(f'    {sel} — {exc}', file=sys.stderr)
            missed += 1
            continue
        save_json(path, data)
        elements.extend(data.get('elements', []))
        time.sleep(0.8)
    if missed and not elements:
        raise RuntimeError(f'all {missed} selector(s) failed')
    return {'elements': elements}, missed


def city_of(tags):
    town = (tags.get('addr:city') or tags.get('addr:town')
            or tags.get('addr:village') or tags.get('addr:hamlet'))
    state = STATE_NAMES.get(tags.get('addr:state', ''), tags.get('addr:state'))
    if town and state:
        return f'{town}, {state}'
    return town or None


def address_of(tags):
    house, street = tags.get('addr:housenumber'), tags.get('addr:street')
    if not street:
        return None
    line = f'{house} {street}' if house else street
    city = city_of(tags)
    return f'{line}, {city}' if city else line


def website_of(tags):
    for key in ('website', 'contact:website', 'url', 'website:official'):
        value = tags.get(key)
        if value and value.startswith(('http://', 'https://')):
            return value
    return None


# An Overpass selector is one of three shapes, and they have to be told apart
# before splitting: "craft"~"^(brewery|distillery)$" contains no "=" but plenty
# of characters that look like structure. Splitting on "=" first — which an
# earlier version did — left every regex rule matching nothing at all, so
# monuments, breweries and attractions were fetched and then silently dropped
# for having no kind. Hence SELECTOR, and hence test_selectors() below.
SELECTOR = re.compile(r'^"(?P<key>[^"]+)"(?:(?P<op>[~=])"(?P<val>.*)")?$')


def parse_selector(sel):
    m = SELECTOR.match(sel.strip())
    if not m:
        raise ValueError(f'unparseable Overpass selector: {sel!r}')
    return m.group('key'), m.group('op'), m.group('val')


def matches(tags, sel):
    key, op, val = parse_selector(sel)
    if op is None:              # ["heritage"] — the tag simply being present
        return key in tags
    if op == '=':
        return tags.get(key) == val
    return key in tags and re.search(val, tags[key]) is not None


def classify(tags):
    """Every kind whose OSM rules this place satisfies, most specific first."""
    hits = []
    for kind, selectors in placekinds.OSM_RULES:
        if any(matches(tags, sel) for sel in selectors):
            hits.append(kind)
    return hits


def test_selectors():
    """Every selector parses, and the three shapes each behave.

    Run by --selftest, and by validate.py, because the failure mode here is
    silent: a rule that matches nothing looks exactly like a region that has
    none of that kind of place.
    """
    for _, selectors in placekinds.OSM_RULES:
        for sel in selectors:
            parse_selector(sel)
    cases = [
        ({'historic': 'monument'}, 'historic site'),
        ({'historic': 'memorial'}, 'historic site'),
        ({'heritage': '2'}, 'historic site'),
        ({'man_made': 'lighthouse'}, 'historic site'),
        ({'craft': 'brewery'}, 'brewery'),
        ({'craft': 'distillery'}, 'brewery'),
        ({'tourism': 'attraction'}, 'landmark'),
        ({'tourism': 'zoo'}, 'zoo'),
        ({'tourism': 'aquarium'}, 'zoo'),
        ({'tourism': 'theme_park'}, 'theme park'),
        ({'leisure': 'water_park'}, 'theme park'),
        ({'tourism': 'viewpoint'}, 'lookout'),
        ({'leisure': 'bowling_alley'}, 'bowling alley'),
        ({'amenity': 'planetarium'}, 'museum'),
        ({'shop': 'gift'}, 'shop'),
        ({'tourism': 'museum'}, 'museum'),
        ({'leisure': 'garden'}, 'garden'),
        ({'historic': 'castle'}, 'castle'),
        ({'shop': 'antiques'}, 'antique shop'),
        ({'shop': 'books'}, 'bookshop'),
        ({'amenity': 'cinema'}, 'cinema'),
        ({'craft': 'winery'}, 'winery'),
        ({'amenity': 'restaurant'}, 'restaurant'),
        ({'amenity': 'pub'}, 'restaurant'),
        ({'amenity': 'fast_food'}, 'restaurant'),
        ({'amenity': 'cafe'}, 'cafe'),
        ({'shop': 'bakery'}, 'cafe'),
    ]
    bad = [(tags, want, classify(tags)) for tags, want in cases
           if want not in classify(tags)]
    if bad:
        raise AssertionError('selectors match nothing: '
                             + '; '.join(f'{t} should be {w}, got {g}' for t, w, g in bad))
    # A regex rule must not match everything either.
    assert 'brewery' not in classify({'craft': 'bakery'}), 'craft regex is too loose'
    assert 'historic site' not in classify({'historic': 'castle'}), \
        'historic regex swallowed castle'
    assert not substantial('historic site', {'man_made': 'lighthouse'}), \
        'a lighthouse still has to show a way in'
    assert substantial('historic site',
                       {'man_made': 'lighthouse', 'wikipedia': 'en:Portland Head Light'})
    assert 'stadium' not in classify({'leisure': 'bowling_alley'}), \
        'a bowling alley is not a stadium'
    # A brewpub is a brewery. Both rules match it and OSM_RULES is ordered by
    # significance, so this is really a test that the order has not drifted.
    assert classify({'amenity': 'pub', 'microbrewery': 'yes'})[0] == 'brewery', \
        'a brewpub should lead with brewery, not restaurant'
    assert classify({'shop': 'chocolate'})[0] == 'shop', \
        'a chocolate shop is a specialty shop, not a caf\u00e9'

    # The food bar, which is the difference between a directory and a phone book.
    assert not food_worth({'amenity': 'restaurant'}), \
        'a name and nothing else is not something a reader can act on'
    assert food_worth({'amenity': 'restaurant', 'cuisine': 'seafood'})
    assert food_worth({'amenity': 'restaurant', 'phone': '555'})
    assert not food_worth({'amenity': 'fast_food', 'cuisine': 'burger',
                           'brand': 'McDonald\u2019s'}), \
        'branded fast food is what a phone map is for'
    assert food_worth({'amenity': 'fast_food', 'cuisine': 'seafood'}), \
        'the clam shack has to survive the chain filter'
    assert cuisines({'cuisine': 'pizza;italian'}) == ['pizza', 'italian']
    assert cuisines({'cuisine': 'coffee_shop;donut'}) == ['coffee', 'bakery']
    assert cuisines({'cuisine': 'regional'}) is None, \
        'an ungrouped token must be dropped, never bucketed into "other"'
    assert cuisines({'amenity': 'bar'}) == ['pub']
    assert diets({'diet:vegan': 'yes'}) == ['vegan']
    assert yes('no') is False and yes(None) is None and yes('yes') is True
    return len(cases)


# Tokens seen on a run that no cuisine group claims. Printed at the end so the
# vocabulary grows from the data rather than from guesswork — the same job
# audit.py's --report does for feeds nobody has registered yet.
UNMAPPED_CUISINE = {}


def cuisines(tags):
    """OSM `cuisine` as a list of groups the filter can actually offer.

    The tag is a semicolon list and its tail is very long, so a token nobody
    has grouped is dropped and counted, never bucketed into "other": a filter
    is a promise that the thing behind it is what it says.
    """
    raw = tags.get('cuisine') or ''
    out = []
    for token in raw.split(';'):
        token = token.strip().lower().replace(' ', '_')
        if not token:
            continue
        group = placekinds.CUISINE_OF.get(token)
        if not group:
            UNMAPPED_CUISINE[token] = UNMAPPED_CUISINE.get(token, 0) + 1
            continue
        if group not in out:
            out.append(group)
    # A bar tagged only `pub` is pub food; a brewpub already left as a brewery.
    if not out and tags.get('amenity') in ('pub', 'bar'):
        out.append('pub')
    return out or None


def diets(tags):
    """Only what the map actually says, and only the two people search for.

    2.4% of food places carry diet:vegetarian and 1.4% diet:vegan, which is far
    too sparse to filter on — a "vegan" filter would hide almost every
    restaurant that can in fact feed you. It is a badge on the row and nothing
    more.
    """
    out = [name for name, key in (('vegetarian', 'diet:vegetarian'),
                                  ('vegan', 'diet:vegan'),
                                  ('gluten-free', 'diet:gluten_free'))
           if tags.get(key) in ('yes', 'only')]
    return out or None


def yes(value):
    """Tri-state: yes/no as recorded, absent as unknown. Never guess a no."""
    if value in ('yes', 'only', 'designated'):
        return True
    if value == 'no':
        return False
    return None


# A garden that says what kind of garden it is has declared itself a
# destination; the rest have not.
VISITABLE_GARDENS = {'botanical', 'arboretum'}

# Tags that are a destination on their own terms — nobody labels a traffic
# island a zoo. tourism=attraction and tourism=viewpoint are the opposite: the
# first is a catch-all that collects boundary markers and historic districts,
# and the second is 290 scenic overlooks, most of them "GWB View".
SELF_EVIDENT = {'zoo', 'aquarium', 'theme_park', 'water_park', 'planetarium'}

# OSM's protection_title for land the public is invited onto. Deliberately not
# a catch-all: the commonest value in range is "Watershed Recreation Unit" (464
# of them), which is New York City's permit-only reservoir land — real, large,
# and not somewhere you can decide to go on Saturday. "Forest Preserve Detached
# Parcel" is likewise a deed, not a destination.
PUBLIC_LAND = {
    'State Park', 'State Forest', 'State Historic Site', 'Wild Forest',
    'Wildlife Management Area', 'Wildlife Sanctuary', 'Nature Preserve',
    'Multiple Use Area', 'Unique Area', 'County Park',
    'National Park', 'National Wildlife Refuge', 'National Historic Site',
}


# A road is not a place you visit, however historic. "Broadway", "Old Albany
# Post Road", "Storm King Highway" and the New Haven Line all carry heritage
# tags, and each arrives once per way segment — 22 rows between them.
LINEAR = ('highway', 'railway', 'route', 'waterway')

# What "you can go there" looks like in tags. A heritage listing on its own is
# a designation, not an invitation: it is what put the roads in.
VISIT_SIGNALS = ('website', 'contact:website', 'url', 'opening_hours',
                 'tourism', 'wikipedia', 'description', 'fee', 'access')


def visitable(tags):
    if any(k in tags for k in LINEAR):
        return False
    return any(tags.get(k) for k in VISIT_SIGNALS)


# Every named amenity=restaurant is a real restaurant, so the question these
# two ask is not "is it real" but "can a reader do anything with it". A row
# carrying a name and nothing else cannot be chosen between, cannot be phoned,
# and cannot be checked for whether it is open — which is the entire reason
# somebody opens this on a Tuesday evening a long way from home. One in seven
# restaurants in the sample was exactly that.
FOOD_SIGNALS = ('cuisine', 'website', 'contact:website', 'opening_hours',
                'phone', 'contact:phone')


def chain(tags):
    return bool(tags.get('brand') or tags.get('brand:wikidata')
                or tags.get('operator:brand'))


def food_worth(tags):
    if not any(tags.get(k) for k in FOOD_SIGNALS):
        return False
    # 1,491 of 2,079 fast-food outlets in one sample are a brand. Keeping them
    # would make the food list mostly Dunkin', and the clam shack next door
    # would be on page four.
    return not (tags.get('amenity') == 'fast_food' and chain(tags))


def substantial(kind, tags):
    """Is this a destination, or a map feature that happens to have a name?

    Of 363 named gardens inside fifty miles, 208 were a bare leisure=garden
    with nothing else on them — "Rose Garden", "Butterfly Garden", "College
    Courtyard", "9/11 Memorial Garden". Those are features *inside* somewhere
    else, and listing them as places to go buries the dozen botanical gardens
    and arboretums that are the reason anyone asked for gardens.
    """
    if kind in placekinds.FOOD:
        return food_worth(tags)
    if kind == 'garden' and tags.get('garden:type') in VISITABLE_GARDENS:
        return True
    if kind == 'attraction':
        if (tags.get('tourism') in SELF_EVIDENT or tags.get('amenity') == 'planetarium'
                or tags.get('leisure') == 'water_park'):
            return True
        return bool(website_of(tags) or tags.get('wikipedia')
                    or tags.get('description') or tags.get('opening_hours'))
    if kind == 'lookout':
        # A tower built to be climbed is a destination by construction — the
        # fire towers and the lookout towers. A radio mast and a clock tower
        # are not, whatever man_made says.
        if tags.get('tower:type') in ('observation', 'fire'):
            return True
        if tags.get('man_made') == 'tower':
            return False
        # Everything else is tourism=viewpoint, which is 285 named pull-offs in
        # range — "GWB View", "HBP 187 View". Same test the rest of the soft
        # kinds get: somebody has to have written it up.
        return bool(website_of(tags) or tags.get('wikipedia')
                    or tags.get('description') or tags.get('wikidata'))
    if kind == 'park':
        # 6,297 named parks inside fifty miles, nearly all of them a municipal
        # ballfield or a traffic island with a name. Two things separate a
        # park worth the drive: an official public-land designation, or a
        # Wikipedia article. Not wikidata — GNIS imports attached one to every
        # pocket park in the country, so it says nothing.
        return (tags.get('protection_title') in PUBLIC_LAND
                or bool(tags.get('wikipedia')))
    if kind in ('historic site', 'historic house', 'landmark'):
        # These three are where "it is old" gets mistaken for "you can see it".
        return visitable(tags)
    if kind not in THIN:
        return True
    return bool(website_of(tags) or tags.get('wikidata') or tags.get('wikipedia')
                or tags.get('heritage') or tags.get('description')
                or tags.get('opening_hours') or tags.get('tourism'))


# OSM descriptions are free text written for mappers, not readers: they run to
# paragraphs and often park a bare URL in the middle, which is one unbreakable
# word that shoves a phone layout sideways. The link is already on the place as
# `url` where there is one.
# A URL is usually inside a parenthetical — "(see https://…)" — so take the
# whole bracket, or the stripped link leaves a dangling "(see" behind.
SECOND_HAND_NAME = re.compile(
    r'\b(used|rare|antiquarian|second[- ]?hand|out[- ]of[- ]print|book ?barn)\b', re.I)

URL_IN_TEXT = re.compile(r'\s*\([^)]*https?://[^)]*\)?|\s*\bhttps?://\S+')


def describe(text, limit=180):
    text = URL_IN_TEXT.sub('', (text or ''))
    text = re.sub(r'\s{2,}', ' ', text).strip(' \t;,:-–—(')
    if len(text) > limit:
        cut = text[:limit].rsplit(' ', 1)[0]
        text = cut.rstrip('.,;:') + '…'
    return text or None


def to_place(element, kinds, center):
    tags = element.get('tags', {})
    lat = element.get('lat') or (element.get('center') or {}).get('lat')
    lon = element.get('lon') or (element.get('center') or {}).get('lon')
    if lat is None or lon is None or not tags.get('name'):
        return None
    fee = tags.get('fee')
    place = {
        'id': f"osm-{element['type']}-{element['id']}",
        'name': tags['name'].strip(),
        'kind': kinds[0],
        'kinds': kinds,
        'lat': round(lat, 6),
        'lon': round(lon, 6),
        'miles': round(miles(center['lat'], center['lon'], lat, lon), 1),
        'city': city_of(tags),
        'address': address_of(tags),
        'url': website_of(tags),
        'phone': tags.get('phone') or tags.get('contact:phone'),
        'openingHours': tags.get('opening_hours'),
        # A chain has a brand; the village book shop does not. Kept so the
        # client can offer "local only", which is the whole point of asking
        # for used book stores rather than book stores.
        'brand': tags.get('brand') or tags.get('operator:brand'),
        # "used book store" was asked for by name. OSM has a tag for it and
        # almost nobody sets it — 2 of 118 book shops in range — so the shop's
        # own name is read as well. That still only finds three, which is the
        # honest ceiling here: whether a shop sells used books is mostly not
        # recorded anywhere. `brand` is the reliable half of the ask, and it
        # is what the Independents-only toggle runs on.
        'secondHand': (tags.get('second_hand') in ('yes', 'only')
                       or 'second_hand' in (tags.get('books') or '')
                       or 'antiquarian' in (tags.get('books') or '')
                       or bool(SECOND_HAND_NAME.search(tags.get('name', '')))) or None,
        'free': None if fee is None else (fee == 'no'),
        'wheelchair': tags.get('wheelchair'),
        'description': describe(tags.get('description')),
        'events': 0,
        'source': 'OpenStreetMap',
    }
    if kinds[0] in placekinds.FOOD:
        # Only on food rows: on a museum these would be twenty thousand nulls.
        place['cuisine'] = cuisines(tags)
        place['diet'] = diets(tags)
        place['outdoorSeating'] = yes(tags.get('outdoor_seating'))
        place['takeaway'] = yes(tags.get('takeaway'))
    return place


def collapse_repeats(places):
    """A second pass: same name, same kind, same town is one place.

    dedupe() keys on a coarse coordinate grid, which cannot see that seven
    segments of "Broadway" strung across ten miles are one entry. Including the
    town keeps two genuinely different Memorial Parks apart, and keeps all
    three Bowlero locations, which are in three different towns.
    """
    best = {}
    for place in places:
        key = (norm(place['name']), place['kind'], (place.get('city') or '').lower())
        rival = best.get(key)
        if not rival or filled(place) > filled(rival) or (
                filled(place) == filled(rival) and place['miles'] < rival['miles']):
            best[key] = place
    return list(best.values())


def dedupe(places):
    """One business, one row.

    The same shop is often both a node and a building way, and both come back.
    Keying on the name plus a coarse grid catches that without merging two
    genuinely different places that share a name a county apart.
    """
    best = {}
    for place in places:
        key = (norm(place['name']), round(place['lat'], 2), round(place['lon'], 2))
        rival = best.get(key)
        if not rival or filled(place) > filled(rival):
            best[key] = place
    return list(best.values())


def filled(place):
    return sum(1 for f in ('url', 'address', 'city', 'phone', 'openingHours',
                           'description') if place.get(f))


def collect(regions, home, only=None, cache_dir='build/places-cache'):
    os.makedirs(cache_dir, exist_ok=True)
    seen, places, failed = {}, [], []
    for region in regions:
        print(f"\n{region['name']} — within {region['radiusMiles']:g} mi")
        for kind, selectors in placekinds.OSM_RULES:
            if not selectors or kind not in placekinds.DESTINATIONS:
                continue
            if only and kind not in only:
                continue
            try:
                data, missed = fetch_kind(kind, selectors, region, cache_dir)
            except Exception as exc:
                print(f'  {kind:<16} — {exc}', file=sys.stderr)
                failed.append(kind)
                continue
            if missed:
                failed.append(kind)
            kept = 0
            for element in data.get('elements', []):
                tags = element.get('tags', {})
                kinds = [k for k in classify(tags) if k in placekinds.DESTINATIONS]
                if not kinds or not substantial(kinds[0], tags):
                    continue
                place = to_place(element, kinds, home)
                if not place:
                    continue
                # Against *this* region, not home: the bbox over-selects at the
                # corners and this is what drops the overshoot. A corner place
                # that genuinely belongs to another region arrives again on
                # that region's own query, so nothing is lost by being strict.
                if miles(region['lat'], region['lon'],
                         place['lat'], place['lon']) > region['radiusMiles']:
                    continue
                # A place matching several kinds arrives once per query, and a
                # place in two overlapping regions arrives once per region.
                # Keep the first, which is the most specific, since OSM_RULES
                # is ordered.
                if place['id'] in seen:
                    continue
                seen[place['id']] = place
                places.append(place)
                kept += 1
            print(f'  {kind:<16} {kept:>5}' + ('  (partial)' if missed else ''))
    return places, failed


def norm(name):
    return re.sub(r'[^a-z0-9]+', ' ', (name or '').lower()).strip()


def merge_events(places, events_path, center, radius):
    """Attach event counts, and add any event venue OSM did not know about."""
    if not os.path.exists(events_path):
        return places
    items = json.load(open(events_path)).get('items', [])

    # Exact, not normalised. merge.py already collapsed the spellings, and the
    # client filters on the literal string — matching loosely here is what let
    # a place claim events the filter could never find.
    by_name = {}
    for place in places:
        by_name.setdefault(place['name'], place)

    extra = {}
    for item in items:
        # merge.py resolved rooms to their building and wrote the answer down;
        # recomputing it here is how the count and the filter came to disagree.
        # No `or item['venue']` fallback: merge deliberately nulls venueKey for
        # placeholders like "See listing", and falling back resurrected it as a
        # directory row claiming ninety-two events.
        venue = item.get('venueKey')
        if not venue or not item.get('lat'):
            continue
        key = venue
        hit = by_name.get(key)
        if hit:
            hit['events'] += 1
            continue
        away = miles(center['lat'], center['lon'], item['lat'], item['lon'])
        if away > radius:
            continue
        row = extra.get(key)
        if row:
            row['events'] += 1
            continue
        kind = item.get('placeKind')
        extra[key] = {
            # norm() lowercases; the raw key does not, and this character
            # class only spans lowercase — so "Veronica Wagman Concert Hall"
            # slugged to "eronica-agman-oncert-all" and two venues collided on
            # an id. The match stays exact; only the slug is normalised.
            'id': f'venue-{re.sub(r"[^a-z0-9]+", "-", norm(key)).strip("-") or "unnamed"}',
            'name': venue, 'kind': kind, 'kinds': [kind] if kind else [],
            'lat': item['lat'], 'lon': item['lon'], 'miles': round(away, 1),
            'city': item.get('city'), 'address': item.get('address'),
            'url': item.get('url'), 'phone': None, 'openingHours': None,
            'brand': None, 'secondHand': None, 'free': None, 'wheelchair': None,
            'description': None, 'events': 1, 'source': 'Event listings',
        }
    # A venue with no recognisable kind used to need three events to earn a
    # row, as a crude guard against rooms — "Community Room", "311 Learning
    # Annex". merge.py resolves rooms to their building now and rejects the
    # shapes that are the feed shrugging (a bare state code, a town on its own,
    # a street corner), so the count can come down. At three, The Falcon and
    # Happy Valley Arcade Bar were both missing from the directory.
    REAL_PLACE_EVENTS = 2
    return places + [row for row in extra.values()
                     if row['kind'] or row['events'] >= REAL_PLACE_EVENTS]


def merge_audit(places, audit_path, quiet=True):
    """Carry scripts/audit.py's verdicts onto the rows the client loads.

    One fact, one owner: sources/placeaudit.json owns "does this venue publish
    anything", keyed by domain because that is what was actually read. This
    copies it, and copies nothing else — a place with listings is never marked
    quiet, whatever the audit last saw, since the listings are the answer.
    """
    if not os.path.exists(audit_path):
        return 0
    domains = json.load(open(audit_path)).get('domains', {})
    if not domains:
        return 0

    def host(url):
        try:
            h = urllib.parse.urlparse(url if '://' in url else 'https://' + url).netloc
        except Exception:
            return None
        h = h.lower().split(':')[0]
        return h[4:] if h.startswith('www.') else h

    n = 0
    for place in places:
        rec = domains.get(host(place.get('url') or ''))
        if not rec:
            continue
        # A hijacked domain's "Website" button sends a reader looking for a
        # cinema to an Indonesian betting site. OpenStreetMap still carries the
        # tag and will for years; the audit has read the page and knows better,
        # so the link comes off. elitecinema6.com and goodtidingsgiftshop.com
        # were found this way, on top of the three cinemas already known.
        if rec.get('verdict') in ('suspect', 'parked'):
            place['url'] = None
        # A place with listings is never marked quiet. It happens: a venue that
        # publishes nothing on its own site still turns up on Eventbrite, and
        # the row would then carry "no event calendar" over its own six
        # listings. validate.py fails the build on exactly that pair.
        if quiet and rec.get('verdict') == 'none' and not place.get('events'):
            place['eventInfo'] = 'none'
            place['eventChecked'] = rec.get('checked')
            n += 1
    return n


def compact(place):
    """Drop the keys that carry nothing.

    Every row used to ship twenty keys whether or not the map knew anything
    about them, and the directory is now a file people load on a phone with two
    bars of signal in Hancock County. `False` and `0` stay: on `free` and
    `outdoorSeating` a no is a fact, and dropping it would read as unknown.
    """
    return {k: v for k, v in place.items()
            if v is not None and v != [] and not (k == 'events' and not v)}


def write_file(path, places, meta):
    """One row per line, and no space wasted inside a row.

    Pretty-printed at indent 2 the food file is 6.8 MB of which most is
    indentation, and it is downloaded by somebody with two bars of signal.
    Minified to a single line it halves, and every weekly commit then rewrites
    one enormous line, so git stores a whole new copy and diffs say nothing.
    A row per line is both: the file is small and a diff still reads as "these
    forty places changed".
    """
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    rows = ',\n'.join(json.dumps(compact(p), ensure_ascii=False,
                                 separators=(',', ':')) for p in places)
    with open(path, 'w') as fh:
        fh.write('{\n"meta": ')
        fh.write(json.dumps(meta, ensure_ascii=False, indent=2))
        fh.write(',\n"items": [\n')
        fh.write(rows)
        fh.write('\n]\n}\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--radius', type=float, default=None,
                    help='miles, applied to every region '
                         '(default: each region\'s own, else 50)')
    ap.add_argument('--only', help='comma-separated kinds, for re-running one')
    ap.add_argument('--regions', help='comma-separated region ids, for splitting '
                                      'the fetch across processes')
    ap.add_argument('--fetch-only', action='store_true',
                    help='fill the cache for --regions and write nothing')
    ap.add_argument('--cache', default='build/places-cache',
                    help='per-region, per-selector Overpass cache; --refresh empties it')
    ap.add_argument('--refresh', action='store_true', help='ignore the cache')
    ap.add_argument('--selftest', action='store_true',
                    help='check every selector parses and matches, then exit')
    ap.add_argument('--mirror', help='prefer this Overpass mirror — how one '
                                     'fetch is split across processes without '
                                     'four of them queueing on the same host')
    ap.add_argument('--registry', default='sources/registry.json')
    ap.add_argument('--events', default='data/events.json')
    ap.add_argument('--audit', default='sources/placeaudit.json')
    ap.add_argument('--out', default='data/places.json')
    ap.add_argument('--eats', default='data/eats.json',
                    help='where the food directory goes; it is five times the '
                         'size of everything else, so it is its own file')
    args = ap.parse_args()

    if args.selftest:
        print(f'{test_selectors()} selector cases OK')
        # And that the registry's regions are loadable, which is the other way
        # this run can be silently wrong: a duplicate id means two areas share
        # a cache and one of them quietly gets the other's answers.
        regions = load_regions(args.registry)
        for r in regions:
            if not (-90 <= r['lat'] <= 90 and -180 <= r['lon'] <= 180
                    and 0 < r['radiusMiles'] <= 200):
                raise SystemExit(f'region {r["id"]} has implausible geometry: {r}')
        print(f'{len(regions)} coverage region(s) OK: '
              + ', '.join(f'{r["id"]} {r["radiusMiles"]:g}mi' for r in regions))
        return 0

    if args.mirror:
        global _LAST_GOOD
        match = [m for m in MIRRORS if args.mirror in m]
        if not match:
            raise SystemExit(f'--mirror {args.mirror!r} matches none of {MIRRORS}')
        _LAST_GOOD = match[0]

    # --only leaves kinds uncollected. The file has to say so, or a directory
    # holding two kinds out of nineteen reads as a region with nothing in it.

    all_regions = load_regions(args.registry, args.radius)
    home = all_regions[0]
    regions = all_regions
    if args.regions:
        want = {r.strip() for r in args.regions.split(',')}
        unknown = want - {r['id'] for r in all_regions}
        if unknown:
            raise SystemExit(f'unknown region id(s): {sorted(unknown)} — '
                             f'known: {[r["id"] for r in all_regions]}')
        regions = [r for r in all_regions if r['id'] in want]
    only = {k.strip() for k in args.only.split(',')} if args.only else None
    collectable = [k for k, sel in placekinds.OSM_RULES
                   if sel and k in placekinds.DESTINATIONS]
    skipped = [k for k in collectable if only and k not in only]

    print(f'Overpass — destinations in {len(regions)} region(s): '
          + ', '.join(f'{r["name"]} ({r["radiusMiles"]:g} mi)' for r in regions))
    if args.refresh and os.path.isdir(args.cache):
        for root, _, names in os.walk(args.cache):
            for name in names:
                os.remove(os.path.join(root, name))
    places, failed = collect(regions, home, only, args.cache)
    if failed and not places:
        print('every kind failed — leaving the existing file alone', file=sys.stderr)
        return 1

    places = dedupe(places)
    towns = []
    if any(not p['city'] for p in places):
        for region in regions:
            towns.extend(settlements(region, args.cache))
    if towns:
        cells = town_index(towns)
        for place in places:
            if not place['city']:
                place['city'] = nearest_town(
                    place['lat'], place['lon'],
                    nearby_towns(place['lat'], place['lon'], cells))
    # Only now — the collapse keys on town, so it has to run once every place
    # has one.
    before_collapse = len(places)
    places = collapse_repeats(places)
    if before_collapse != len(places):
        print(f'  collapsed {before_collapse - len(places)} repeated rows')

    if UNMAPPED_CUISINE:
        top = sorted(UNMAPPED_CUISINE.items(), key=lambda kv: -kv[1])[:15]
        print('\ncuisine tokens no group claims yet (add the good ones to '
              'placekinds.CUISINE_TOKENS):')
        print('  ' + ', '.join(f'{t} {n}' for t, n in top))

    if args.fetch_only:
        print(f'\n--fetch-only: {len(places)} places cached, nothing written')
        return 0

    # Events first, then the split. The other way round, a restaurant that
    # hosts live music matches nothing in the directory it is being merged
    # into, so merge_events adds it back as a second row — and the client,
    # which loads both files into one list, shows The Falcon twice.
    before = len(places)
    places = merge_events(places, args.events, home, home['radiusMiles'])

    # Two files, one taxonomy. Somewhere to eat outnumbers somewhere to go
    # about five to one, and the client wants the directory before the first
    # screen and the food list only when somebody asks for dinner.
    food = [p for p in places if p['kind'] in placekinds.FOOD]
    directory = [p for p in places if p['kind'] not in placekinds.FOOD]

    audited = merge_audit(directory, args.audit)
    # Each place's own website picture, for the Drive page's cards. One fact,
    # one owner: sources/placeimages.json, written by scripts/images.py.
    pictured = images.merge_images(directory)
    # A hijacked domain loses its link wherever it appears; only the directory
    # gets "no event calendar", because a restaurant not publishing a calendar
    # is not news about the restaurant.
    merge_audit(food, args.audit, quiet=False)
    directory.sort(key=lambda p: (p['miles'], p['name']))
    food.sort(key=lambda p: (p['miles'], p['name']))

    stamp = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    meta = {
        'schemaVersion': 1,
        'scrapedAt': stamp,
        'centerName': home['name'], 'centerLat': home['lat'],
        'centerLon': home['lon'], 'radiusMiles': home['radiusMiles'],
        # Every circle collected, so the client can say where coverage actually
        # is and offer them as places to measure from. `miles` on a row is
        # still distance from the centre and nothing else.
        'regions': [dict(r) for r in regions],
        'kinds': placekinds.ORDER,
        # Shipped with the data so the client cannot drift from the
        # taxonomy. Its own map is a fallback for an older file; five new
        # kinds rendered as raw "lookout42" chips before this existed.
        'kindLabels': placekinds.LABELS,
        'cuisines': placekinds.CUISINE_ORDER,
        'cuisineLabels': placekinds.CUISINE_LABELS,
        'partial': sorted(set(failed) | set(skipped)) or None,
        'note': 'Places from OpenStreetMap (ODbL), plus venues known only '
                'from the event feed. A place needs no events to be listed.',
    }
    write_file(args.out, directory, meta)
    write_file(args.eats, food, dict(
        meta, note='Somewhere to eat, from OpenStreetMap (ODbL). Hours and '
                   'cuisines are whatever the map records — check before you go.'))

    # Per region, because a region that silently collected nothing is the
    # failure this whole shape makes possible: the totals still look healthy
    # while one circle in the middle of the drive is empty.
    print()
    for region in regions:
        here = [p for p in places
                if miles(region['lat'], region['lon'], p['lat'], p['lon'])
                <= region['radiusMiles']]
        eat = sum(1 for p in here if p['kind'] in placekinds.FOOD)
        print(f'  {region["name"]:<18} {len(here) - eat:>6} to visit  '
              f'{eat:>6} to eat')

    kinds = {}
    for place in food:
        kinds[place['kind']] = kinds.get(place['kind'], 0) + 1
    print(f'\n{before} from OpenStreetMap + {len(places) - before} event venues '
          f'= {len(directory)} places → {args.out}')
    print(f'{len(food)} places to eat ({kinds.get("restaurant", 0)} restaurants '
          f'& bars, {kinds.get("cafe", 0)} cafés) → {args.eats}')
    withc = sum(1 for p in food if p.get('cuisine'))
    withh = sum(1 for p in food if p.get('openingHours'))
    print(f'  {withc} say what kind of food ({100 * withc // max(1, len(food))}%), '
          f'{withh} carry opening hours')
    if audited:
        print(f'{audited} marked "no event calendar" from {args.audit}')
    print(f'{pictured} places carry their own website\'s picture')
    if failed:
        print(f'partial: {", ".join(failed)} could not be fetched', file=sys.stderr)
    if skipped:
        print(f'not collected this run: {", ".join(skipped)}', file=sys.stderr)
    if len(regions) < len(all_regions):
        missing = [r['id'] for r in all_regions if r not in regions]
        print(f'only {len(regions)} of {len(all_regions)} regions collected — '
              f'{", ".join(missing)} are not in this file', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
