#!/usr/bin/env python3
"""A photograph and a one-line description for every place that has one.

The Drive page used to ask Wikipedia live, one place at a time, from the
phone: slow, rate-limited, and useless in a dead zone. This asks once, at
build time, and asks Wikidata rather than Wikipedia. Wikidata is Wikipedia's
structured sibling: its query service answers one question per box of map,
"every item here with coordinates and a photograph", with the item's name,
short description and Commons image. That covers more than Wikipedia does,
because Wikidata holds photographs of historic houses, lighthouses and
memorials that have no article. (A sweep of Wikipedia's own geosearch was
tried first and throttled to a standstill from a shared address; the query
service answered each box in under a second.)

Matching is the whole risk, because a box returns everything in it, towns
included. An item is believed only if:

  · more than half its name's distinctive words are in the place's name. One
    word is not enough: "Beacon Historical Society" and "Beacon, New York"
    share "beacon" and nothing else;
  · it is not a settlement or county, by its title ("Town, State") or by its
    own description ("village in Putnam County");
  · it is within two miles, since a matching name further off is another
    place with the same name.

It owns sources/wikiphotos.json. images.py stamps it onto the rows beside
the site pictures, and places.py carries both on every rebuild.

  python3 scripts/wikipics.py --plan        # how many boxes, no network
  python3 scripts/wikipics.py               # query what is not yet queried, then match
  python3 scripts/wikipics.py --match-only  # re-match from the cache, no network
  python3 scripts/wikipics.py --selftest
"""

import argparse, json, math, os, re, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import date, datetime, timezone

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

PATH = 'sources/wikiphotos.json'
SPARQL = 'https://query.wikidata.org/sparql'
UA = 'Proximi/1.0 (https://github.com/StarrySidekick/Proximi; build-time picture sweep)'

BOX_DEG = 0.3          # a box small enough to answer well inside the 60-second limit
PAUSE = 1.5
MATCH_MI = 2.0

STATES = ('New York|Connecticut|Massachusetts|Maine|New Hampshire|Vermont|'
          'Rhode Island|New Jersey|Pennsylvania|Quebec|New Brunswick')
SETTLEMENT = re.compile(rf', ({STATES})$')
SETTLEMENT_DESC = re.compile(
    r'^(village|town|city|hamlet|census-designated place|county|neighbou?rhood|'
    r'unincorporated community|human settlement|borough|township)\b', re.I)

# Words that say what kind of place something is rather than which one.
GENERIC = {
    'house', 'museum', 'park', 'state', 'historic', 'site', 'center', 'centre',
    'farm', 'farms', 'winery', 'garden', 'gardens', 'the', 'and', 'memorial',
    'national', 'historical', 'society', 'county', 'village', 'town', 'city',
    'hill', 'new', 'york', 'connecticut', 'massachusetts', 'maine', 'hampshire',
    'vermont', 'rhode', 'island', 'jersey', 'north', 'south', 'east', 'west',
    'street', 'road', 'avenue', 'building', 'hall', 'church', 'library',
    'public', 'school', 'district', 'light', 'lighthouse', 'station', 'restaurant',
    'cafe', 'company', 'brewing', 'brewery', 'vineyard', 'vineyards', 'shop',
    'store', 'theatre', 'theater', 'cinema', 'gallery', 'art', 'arts', 'lake',
    'pond', 'river', 'brook', 'mountain', 'mount', 'forest', 'reservation',
}


def tokens(s):
    s = re.sub(r'\([^)]*\)', ' ', s or '')          # "Olana (house)" is Olana
    return {w for w in re.findall(r'[a-z0-9]+', s.lower()) if len(w) >= 4 and w not in GENERIC}


def miles(a_lat, a_lon, b_lat, b_lon):
    r = math.pi / 180
    h = (math.sin((b_lat - a_lat) * r / 2) ** 2
         + math.cos(a_lat * r) * math.cos(b_lat * r) * math.sin((b_lon - a_lon) * r / 2) ** 2)
    return 7917.6 * math.asin(math.sqrt(h))


def believe(place_name, title, d, desc=''):
    """Is this item about this place? See the module docstring."""
    if d > MATCH_MI or SETTLEMENT.search(title) or SETTLEMENT_DESC.search(desc or ''):
        return False
    a, p = tokens(title), tokens(place_name)
    if not a:
        return False
    shared = a & p
    return len(shared) >= 1 and len(shared) / len(a) > 0.5


# ── The query ────────────────────────────────────────────

QUERY = """SELECT ?item ?itemLabel ?itemDescription ?img ?coord WHERE {
  SERVICE wikibase:box { ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:cornerSouthWest "Point(%(w)s %(s)s)"^^geo:wktLiteral .
    bd:serviceParam wikibase:cornerNorthEast "Point(%(e)s %(n)s)"^^geo:wktLiteral . }
  ?item wdt:P18 ?img .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}"""


def boxes(regions):
    """Boxes of BOX_DEG covering every region, keyed stably."""
    out = set()
    for r in regions:
        reach = r['radiusMiles'] + 3
        dlat = reach / 69.0
        dlon = reach / (69.0 * math.cos(math.radians(r['lat'])))
        s0 = math.floor((r['lat'] - dlat) / BOX_DEG) * BOX_DEG
        w0 = math.floor((r['lon'] - dlon) / BOX_DEG) * BOX_DEG
        lat = s0
        while lat < r['lat'] + dlat:
            lon = w0
            while lon < r['lon'] + dlon:
                out.add((round(lat, 2), round(lon, 2)))
                lon += BOX_DEG
            lat += BOX_DEG
    return sorted(out)


def call(query, tries=5):
    url = SPARQL + '?' + urllib.parse.urlencode({'query': query, 'format': 'json'})
    wait = 20
    for _ in range(tries):
        req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/sparql-results+json'})
        try:
            with urllib.request.urlopen(req, timeout=70) as r:
                body = json.loads(r.read())
            time.sleep(PAUSE)
            return body['results']['bindings']
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(wait)
                wait = min(wait * 2, 240)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(wait)
            continue
    raise RuntimeError('the query service kept refusing')


def file_url(commons, width=480):
    """A thumbnail of a Commons file, from the file URL Wikidata gives."""
    name = urllib.parse.unquote(commons.rsplit('/', 1)[-1])
    return ('https://commons.wikimedia.org/wiki/Special:FilePath/'
            + urllib.parse.quote(name) + f'?width={width}')


def sweep(doc, bs):
    done = doc.setdefault('boxes', {})
    items = doc.setdefault('items', {})
    todo = [b for b in bs if f'{b[0]},{b[1]}' not in done]
    print(f'{len(bs)} boxes; {len(todo)} to query')
    refused = 0
    for i, (s_, w) in enumerate(todo, 1):
        # Wikimedia's edge throttles by address, and a shared one can be
        # refused for an hour. Three refusals running ends the sweep, not the
        # run: what is cached still gets matched, and the next run carries on
        # from the next box, because every finished box is remembered.
        try:
            rows = call(QUERY % {'s': s_, 'w': w, 'n': round(s_ + BOX_DEG, 2), 'e': round(w + BOX_DEG, 2)})
            refused = 0
        except RuntimeError:
            refused += 1
            if refused >= 3:
                print(f'  refused three times running; stopping at {len(done)} of {len(bs)} boxes')
                break
            continue
        for r in rows:
            m = re.match(r'Point\(([-\d.]+) ([-\d.]+)\)', r['coord']['value'])
            if not m:
                continue
            qid = r['item']['value'].rsplit('/', 1)[-1]
            items[qid] = [r.get('itemLabel', {}).get('value', ''), round(float(m.group(2)), 5),
                          round(float(m.group(1)), 5), r['img']['value'],
                          r.get('itemDescription', {}).get('value', '')]
        done[f'{s_},{w}'] = date.today().isoformat()
        if i % 10 == 0:
            save(doc)
            print(f'  {i}/{len(todo)} boxes, {len(items)} items with photographs')
    save(doc)


# ── Matching ─────────────────────────────────────────────

def rows_of(paths):
    out = []
    for p in paths:
        if os.path.exists(p):
            out += [(p, r) for r in json.load(open(p))['items']]
    return out


def match(doc, paths):
    """{place id: qid} for every place that has its item."""
    grid = {}
    for qid, (label, lat, lon, _img, desc) in doc.get('items', {}).items():
        grid.setdefault((int(lat * 20), int(lon * 20)), []).append((qid, label, lat, lon, desc))
    found = {}
    for _, p in rows_of(paths):
        if p.get('brand'):
            continue                # a chain's item is the company's
        gy, gx = int(p['lat'] * 20), int(p['lon'] * 20)
        best = None
        for y in (gy - 1, gy, gy + 1):
            for x in (gx - 1, gx, gx + 1):
                for qid, label, lat, lon, desc in grid.get((y, x), ()):
                    d = miles(p['lat'], p['lon'], lat, lon)
                    if believe(p['name'], label, d, desc) and (best is None or d < best[0]):
                        best = (d, qid)
        if best:
            found[p['id']] = best[1]
    return found


def merge_wiki(rows, path=PATH):
    """Copy name, photograph and description onto rows. images.py calls this."""
    if not os.path.exists(path):
        return 0
    doc = json.load(open(path))
    links, items = doc.get('matches', {}), doc.get('items', {})
    n = 0
    for p in rows:
        for k in ('wikiTitle', 'wikiImage', 'wikiDesc', 'wikiLink'):
            p.pop(k, None)
        qid = links.get(p.get('id'))
        if not qid or qid not in items:
            continue
        label, _lat, _lon, img, desc = items[qid]
        p['wikiTitle'] = label
        p['wikiImage'] = file_url(img)
        # The photograph's own page, where its author and licence are.
        p['wikiLink'] = 'https://commons.wikimedia.org/wiki/File:' + urllib.parse.quote(
            urllib.parse.unquote(img.rsplit('/', 1)[-1]))
        if desc:
            p['wikiDesc'] = desc
        n += 1
    return n


def load(path=PATH):
    return json.load(open(path)) if os.path.exists(path) else {}


def save(doc, path=PATH):
    doc['schemaVersion'] = 1
    doc['note'] = ('Wikidata items with coordinates and a photograph across the coverage '
                   'areas, and which places they belong to. Written by scripts/wikipics.py; '
                   'read by scripts/images.py.')
    doc['updated'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    json.dump(doc, open(path, 'w'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    open(path, 'a').write('\n')


def selftest():
    cases = [
        ('Van Wyck Homestead Museum', 'Van Wyck Homestead', 0.1, True),
        ('Boscobel House and Gardens', 'Boscobel', 0.3, True),
        ('Olana State Historic Site', 'Olana', 0.2, True),
        # A town shares the name of everything in it.
        ('Beacon Historical Society', 'Beacon, New York', 0.4, False),
        ('Dutchess County Fairgrounds', 'Dutchess County, New York', 1.0, False),
        # One shared word out of three is somebody else.
        ('Hudson Valley Brewery', 'Hudson River Maritime Museum', 0.5, False),
        # The right name too far away is another place of that name.
        ('Fort Knox', 'Fort Knox (Maine)', 3.5, False),
        ('Fort Knox', 'Fort Knox (Maine)', 0.2, True),
        # Generic words alone never match.
        ('Main Street Historic District', 'Historic District', 0.1, False),
    ]
    for name, title, d, want in cases:
        assert believe(name, title, d) == want, (name, title, d)
    # Wikidata says what a settlement is in its description, whatever its name.
    assert not believe('Cold Spring Harbor Museum', 'Cold Spring', 0.3, 'village in Putnam County, New York')
    assert believe('Knox\'s Headquarters', 'Knox\'s Headquarters State Historic Site', 0.1, 'house')
    return len(cases)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--places', default='data/places.json')
    ap.add_argument('--eats', default='data/eats.json')
    ap.add_argument('--plan', action='store_true')
    ap.add_argument('--match-only', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()
    if args.selftest:
        print(f'{selftest()} article matching cases OK')
        return 0
    regions = json.load(open(args.places))['meta']['regions']
    bs = boxes(regions)
    if args.plan:
        print(f'{len(bs)} boxes across {len(regions)} regions')
        return 0
    doc = load()
    if not args.match_only:
        sweep(doc, bs)
    found = match(doc, [args.places, args.eats])
    doc['matches'] = found
    print(f'{len(found)} places matched to a photographed item')
    save(doc)
    return 0


if __name__ == '__main__':
    sys.exit(main())
