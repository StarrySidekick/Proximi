#!/usr/bin/env python3
"""Find a picture for each place, from the place's own website.

The directory comes from OpenStreetMap, which has no photographs, and the
Drive page shows a card per place. Wikipedia covers the famous ones live, in
the browser; most farms, wineries and small museums have no article, but
almost every one of them has a website, and almost every website declares the
picture it wants shown when somebody shares a link to it: the Open Graph
`og:image` tag in the page's <head>. That is the venue's own choice of how to
look, which is exactly what a card wants.

So this reads each place's page once, keeps only the head, and records what
the page declares. It owns sources/placeimages.json, keyed by the place's page
URL rather than its domain, because a state-parks site declares a different
picture on every park's page. places.py copies the answers onto the rows on
every rebuild; this script also stamps them straight onto data/places.json so
a batch reaches the site without waiting on Overpass.

What it refuses, each for a reason found in the data:
  · (food was refused until the Drive page loaded data/eats.json; it does now)
  · hosts in audit.SKIP_HOSTS: a venue whose website is its Facebook page has
    told us about Facebook, and facebook.com's og:image is Facebook's logo;
  · domains the audit found hijacked or parked: a betting site's banner on a
    cinema's card is the worst picture this could show;
  · anything that is plainly a logo, an icon, an SVG, or declares itself
    smaller than a card;
  · places known only from an event listing: their "website" is the event's
    page, and its picture is the event's poster;
  · chains, whose pages show the chain rather than the shop.

  python3 scripts/images.py --limit 400      # the next 400 pages not yet read
  python3 scripts/images.py --limit 0        # everything not yet read
  python3 scripts/images.py --report         # counts, no network
  python3 scripts/images.py --selftest       # the extractor, against its rules
"""

import argparse, html, json, os, re, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit
import wikipics

IMAGES_PATH = 'sources/placeimages.json'

# Kinds the Drive page can ever suggest. Stadiums, bowling alleys, schools,
# halls and places of worship are in the directory but not in the
# questionnaire, so a picture for them would never be seen.
KINDS = {
    'castle', 'historic house', 'historic site', 'landmark', 'museum', 'gallery',
    'garden', 'lookout', 'park', 'zoo', 'winery', 'brewery', 'farm',
    'theme park', 'antique shop', 'bookshop', 'mall', 'shop', 'library',
    'music venue', 'theatre', 'cinema',
    # Somewhere to eat, from data/eats.json. A restaurant's site nearly
    # always declares a picture of its food or its room, and a card with a
    # plate on it answers "is it worth stopping" faster than any word.
    'restaurant', 'cafe',
}

# A found picture is good for a season; a page with none may grow one; a page
# that would not answer is worth asking again soon.
RECHECK_DAYS = {'image': 120, 'none': 60, 'unreachable': 21}

HEAD_CAP = 300_000     # the head is near the top; nothing below it is read

META = re.compile(r'<meta\b[^>]*>', re.I)
LINK = re.compile(r'<link\b[^>]*>', re.I)
ATTR = re.compile(r'([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|\'([^\']*)\'|([^\s>]+))')

# In order of preference: what the site says to show when shared.
IMAGE_KEYS = ('og:image:secure_url', 'og:image', 'og:image:url',
              'twitter:image', 'twitter:image:src')

# A picture of the brand rather than the place. Matched on the file name and
# path, where sites say so plainly ("logo.png", "/favicon/", "site-icon").
NOT_A_PICTURE = re.compile(
    r'(logo|favicon|site-?icon|[-_]icon\b|apple-touch|/icons?/|placeholder|default|'
    r'blank\.|spacer|avatar|badge|sprite|gravatar|/stock/|unsplash|shutterstock|istock|wordmark|stacked|'
    r'/google\.(?:jpe?g|png))', re.I)

MIN_WIDTH = 300        # only when the page declares a width


def attrs(tag):
    out = {}
    for m in ATTR.finditer(tag):
        out[m.group(1).lower()] = html.unescape(m.group(3) or m.group(4) or m.group(5) or '')
    return out


def head_of(body):
    end = re.search(r'</head\s*>', body, re.I)
    return body[:end.start()] if end else body[:HEAD_CAP]


def extract(base, body):
    """The picture a page declares for itself, or None, and why not.

    Returns (url, reason). reason is None when url is good.
    """
    head = head_of(body)
    found, width = {}, None
    for tag in META.findall(head):
        a = attrs(tag)
        key = (a.get('property') or a.get('name') or '').lower()
        if key in IMAGE_KEYS and a.get('content') and key not in found:
            found[key] = a['content'].strip()
        if key == 'og:image:width':
            try:
                width = int(float(a.get('content', '')))
            except ValueError:
                pass
    if not found:
        for tag in LINK.findall(head):
            a = attrs(tag)
            if a.get('rel', '').lower() == 'image_src' and a.get('href'):
                found['image_src'] = a['href'].strip()
                break
    for key in IMAGE_KEYS + ('image_src',):
        raw = found.get(key)
        if not raw:
            continue
        url = urllib.parse.urljoin(base, raw)
        if url.startswith('//'):
            url = 'https:' + url
        # An http picture would be blocked on an https page. Nearly every
        # site serves the same file over https, and the card falls back to a
        # drawing if this one does not load, so upgrade rather than discard.
        if url.startswith('http://'):
            url = 'https://' + url[7:]
        why = rejected(url, width)
        if why:
            return None, why
        return url, None
    return None, 'no og:image'


def rejected(url, width=None):
    p = urllib.parse.urlparse(url)
    if p.scheme != 'https' or not p.netloc:
        return 'not a web address'
    path = urllib.parse.unquote(p.path).lower()
    if path.endswith(('.svg', '.ico', '.gif')):
        return 'icon format'
    if NOT_A_PICTURE.search(path):
        return 'looks like a logo'
    if p.netloc.replace('www.', '') in ('facebook.com', 'fbcdn.net', 'static.xx.fbcdn.net'):
        return 'facebook asset'
    if width is not None and width < MIN_WIDTH:
        return f'too small ({width}px)'
    # Image hosts put the size in the address: Wix's "/fill/w_20,h_14/" is a
    # twenty-pixel thumbnail however large the original was.
    m = re.search(r'[/,_?&](?:w_|width=|w=)(\d+)', url)
    if m and int(m.group(1)) < MIN_WIDTH:
        return f'too small ({m.group(1)}px in the address)'
    return None


def read(url):
    """One page, one request; the head is all that is wanted."""
    op = audit.opener()
    try:
        final, body = audit.get(url, op, timeout=14, cap=HEAD_CAP)
    except audit.urllib.error.HTTPError as e:
        return {'verdict': 'unreachable', 'why': e.code}
    except Exception as e:
        return {'verdict': 'unreachable', 'why': type(e).__name__}
    # A parked or hijacked page declares pictures too.
    text = audit.strip_html(head_of(body))
    if audit.PARKED.search(text) or len(audit.SUSPECT.findall(body[:HEAD_CAP])) >= 2:
        return {'verdict': 'none', 'why': 'parked or suspect'}
    image, why = extract(final, body)
    if image:
        return {'verdict': 'image', 'image': image}
    return {'verdict': 'none', 'why': why}


def load(path=IMAGES_PATH):
    if not os.path.exists(path):
        return {'pages': {}}
    doc = json.load(open(path))
    doc.setdefault('pages', {})
    return doc


def save(doc, path=IMAGES_PATH):
    doc['schemaVersion'] = 1
    doc['note'] = ('The picture each place\'s own page declares for itself '
                   '(og:image), so a page is read once rather than every week. '
                   'Written by scripts/images.py; read by scripts/places.py, '
                   'which copies the image onto the place.')
    doc['updated'] = datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')
    doc['pages'] = dict(sorted(doc['pages'].items()))
    json.dump(doc, open(path, 'w'), indent=2, ensure_ascii=False)
    open(path, 'a').write('\n')


def key_of(url):
    """The page, give or take the things that do not make it a different page."""
    p = urllib.parse.urlparse(url if '://' in url else 'https://' + url)
    host = p.netloc.lower()
    host = host[4:] if host.startswith('www.') else host
    return host + (p.path.rstrip('/') or '')


def wanted(places_path, audit_path, eats_path=None):
    """Every page worth reading: {key: url}."""
    bad = {d for d, r in audit.load_audit(audit_path)['domains'].items()
           if r.get('verdict') in ('suspect', 'parked')}
    out = {}
    rows = json.load(open(places_path))['items']
    if eats_path and os.path.exists(eats_path):
        rows = rows + json.load(open(eats_path))['items']
    for p in rows:
        url = p.get('url')
        if not url or p.get('kind') not in KINDS:
            continue
        # A place known only from an event listing has that listing's page for
        # a website, and its picture is the poster: "Les Misérables — sold
        # out" on a theatre's card. Only places from the map have a page that
        # is about the place.
        if p.get('source') != 'OpenStreetMap':
            continue
        # A chain's page shows the chain: Michaels' "Discover your next DIY".
        if p.get('brand'):
            continue
        d = audit.domain_of(url)
        if not d or d in bad or d in audit.SKIP_HOSTS or any(d.endswith('.' + h) for h in audit.SKIP_HOSTS):
            continue
        out.setdefault(key_of(url), url if '://' in url else 'https://' + url)
    return out


def stale(rec, today):
    if not rec or not rec.get('checked'):
        return True
    try:
        age = (today - date.fromisoformat(rec['checked'])).days
    except ValueError:
        return True
    return age >= RECHECK_DAYS.get(rec.get('verdict'), 60)


def merge_images(places, path=IMAGES_PATH):
    """Copy the pictures onto rows. places.py calls this too: one owner."""
    if not os.path.exists(path):
        return 0
    pages = json.load(open(path)).get('pages', {})

    def found(place):
        rec = pages.get(key_of(place['url'])) if place.get('url') else None
        # The rules are applied again here, not only when the page was read,
        # so tightening one cleans up old answers without re-reading a site.
        if rec and rec.get('verdict') == 'image' and not rejected(rec['image']):
            return rec['image']
        return None

    # A picture on more than two places is the site's, not the place's: one
    # view of the Charlestown Navy Yard was about to stand for 27 buildings,
    # and a city manager's portrait for five library branches.
    shared = {}
    for place in places:
        img = found(place)
        if img:
            shared[img] = shared.get(img, 0) + 1
    n = 0
    for place in places:
        img = found(place)
        if img and shared[img] <= 2:
            place['image'] = img
            n += 1
        else:
            place.pop('image', None)
    return n


def stamp(doc_path, path=IMAGES_PATH):
    doc = json.load(open(doc_path))
    n = merge_images(doc['items'], path)
    # Wikidata's photographs ride along: one stamp, both sources.
    wikipics.merge_wiki(doc['items'])
    json.dump(doc, open(doc_path, 'w'), indent=2, ensure_ascii=False)
    return n


def report(doc, pages):
    counts = {}
    for k in pages:
        v = doc['pages'].get(k, {}).get('verdict', 'unread')
        counts[v] = counts.get(v, 0) + 1
    whys = {}
    for k in pages:
        r = doc['pages'].get(k, {})
        if r.get('verdict') == 'none':
            whys[r.get('why')] = whys.get(r.get('why'), 0) + 1
    print(f'{len(pages)} pages: ' + ', '.join(f'{v} {n}' for v, n in sorted(counts.items(), key=lambda x: -x[1])))
    if whys:
        print('  no picture because: ' + ', '.join(f'{w} {n}' for w, n in sorted(whys.items(), key=lambda x: -x[1])))


def selftest():
    cases = [
        # (base, head, expected image or None)
        ('https://olana.org/', '<meta property="og:image" content="https://olana.org/wp/olana.jpg">',
         'https://olana.org/wp/olana.jpg'),
        # Relative paths are resolved against the page, not the host root.
        ('https://a.org/visit/', "<meta property='og:image' content='img/house.jpg'>",
         'https://a.org/visit/img/house.jpg'),
        # secure_url wins over og:image when both are present.
        ('https://a.org/', '<meta property="og:image" content="https://a.org/x.jpg">'
         '<meta property="og:image:secure_url" content="https://cdn.a.org/x.jpg">',
         'https://cdn.a.org/x.jpg'),
        # Twitter's tag, used by sites that never added Open Graph.
        ('https://a.org/', '<meta name="twitter:image" content="https://a.org/t.jpg">', 'https://a.org/t.jpg'),
        # A logo is the brand, not the place.
        ('https://a.org/', '<meta property="og:image" content="https://a.org/uploads/site-logo.png">', None),
        ('https://a.org/', '<meta property="og:image" content="https://a.org/favicon/f.png">', None),
        # http is upgraded, since an https page would block it as it stands.
        ('https://a.org/', '<meta property="og:image" content="http://a.org/x.jpg">', 'https://a.org/x.jpg'),
        # The size is in the address.
        ('https://a.org/', '<meta property="og:image" content="https://static.wixstatic.com/media/a~mv2.jpg/v1/fill/w_20,h_14/a.jpg">', None),
        ('https://a.org/', '<meta property="og:image" content="https://static.wixstatic.com/media/a~mv2.jpg/v1/fill/w_1200,h_630/a.jpg">',
         'https://static.wixstatic.com/media/a~mv2.jpg/v1/fill/w_1200,h_630/a.jpg'),
        # A stock photograph is a picture of somewhere else.
        ('https://a.org/', '<meta property="og:image" content="https://img1.wsimg.com/isteam/stock/100622">', None),
        ('https://a.org/', '<meta property="og:image" content="https://a.org/up/elisa-calvet-unsplash-1024.jpg">', None),
        # WordPress's site icon, however it is cropped.
        ('https://a.org/', '<meta property="og:image" content="https://a.org/wp/cropped-house-icon.jpg">', None),
        # Declared smaller than a card.
        ('https://a.org/', '<meta property="og:image" content="https://a.org/x.jpg">'
         '<meta property="og:image:width" content="120">', None),
        # Only the head is read: a picture in the body is not a declaration.
        ('https://a.org/', '</head><body><meta property="og:image" content="https://a.org/x.jpg">', None),
        # Attribute order and entities do not matter.
        ('https://a.org/', '<meta content="https://a.org/a.jpg?w=1200&amp;h=630" property="og:image" />',
         'https://a.org/a.jpg?w=1200&h=630'),
    ]
    for base, head, want in cases:
        got, why = extract(base, '<html><head>' + head)
        assert got == want, (head, got, why)
    assert key_of('https://www.parks.ny.gov/parks/olana/') == key_of('http://parks.ny.gov/parks/olana')
    return len(cases)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--places', default='data/places.json')
    ap.add_argument('--eats', default='data/eats.json')
    ap.add_argument('--retry-unreachable', action='store_true',
                    help='ask again now of pages that did not answer, whatever their age')
    ap.add_argument('--audit', default=audit.AUDIT_PATH)
    ap.add_argument('--images', default=IMAGES_PATH)
    ap.add_argument('--limit', type=int, default=400, help='pages this batch reads (0 = all)')
    ap.add_argument('--workers', type=int, default=10)
    ap.add_argument('--report', action='store_true', help='no network, just the counts')
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--no-stamp', action='store_true', help='leave data/places.json alone')
    args = ap.parse_args()

    if args.selftest:
        print(f'{selftest()} image rule cases OK')
        return 0

    doc = load(args.images)
    pages = wanted(args.places, args.audit, args.eats)
    if args.report:
        report(doc, pages)
        return 0

    today = date.today()
    todo = [k for k in pages if stale(doc['pages'].get(k), today)
            or (args.retry_unreachable and doc['pages'].get(k, {}).get('verdict') == 'unreachable')]
    if args.limit:
        todo = todo[:args.limit]
    print(f'{len(pages)} pages worth a picture; reading {len(todo)}')

    # Sites are read one page each and spread across many hosts, so plain
    # concurrency is polite enough; a host with many pages (nps.gov, parks)
    # is still only ever asked for pages that are genuinely different.
    done = 0
    with ThreadPoolExecutor(args.workers) as pool:
        futures = {pool.submit(read, pages[k]): k for k in todo}
        for f in as_completed(futures):
            k = futures[f]
            rec = f.result()
            rec['checked'] = today.isoformat()
            doc['pages'][k] = rec
            done += 1
            if done % 100 == 0:
                save(doc, args.images)
                print(f'  {done}/{len(todo)}')
    save(doc, args.images)
    report(doc, pages)
    if not args.no_stamp:
        print(f'{stamp(args.places, args.images)} places now carry a picture')
        if os.path.exists(args.eats):
            print(f'{stamp(args.eats, args.images)} places to eat now carry a picture')
    return 0


if __name__ == '__main__':
    sys.exit(main())
