#!/usr/bin/env python3
"""Fill in prices by reading each unpriced listing's own page.

Half the feed says "See listing": iCal carries no price field, and most venue
calendars only publish the number on the event's detail page. But those pages
usually carry schema.org JSON-LD for search engines, offers included — the
same data jsonld.py reads from listing indexes. So: take the unpriced
listings, fetch their pages, and read the price the organiser themselves
published. Nothing inferred, nothing guessed — a page that states no number
leaves its listing at "See listing".

One fetch can price many listings: Localist (the college calendars) embeds
the surrounding calendar's JSON-LD on every detail page — 60-odd events with
offers per fetch — so every event node found on a fetched page is matched
back against the whole unpriced pool by url, not just the listing that
triggered the fetch.

Price policy matches jsonld.py exactly: an offer with no price says nothing,
an explicit numeric 0 means free. The Ticketmaster 0.00–0.00 placeholder
never reaches this script — those records come priced (or not) from the API.

Runs AFTER merge.py, editing data/events.json in place. merge's richness
scoring prefers a priced record over an unpriced one, so a price written here
survives the next merge on its own.

The answer cache (sources/pricecache.json) remembers url → price, including
"asked, page publishes none", so a weekly run only fetches what is new.
Entries expire after 30 days — pages change their minds about prices rarely.

  python3 scripts/prices.py [--limit 150] [--events data/events.json]
"""

import argparse, json, os, sys, time
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from jsonld import LD, fetch, walk, price_of, first

CACHE_PATH = 'sources/pricecache.json'
CACHE_DAYS = 30

# Hosts where the fetch is known to be wasted: bot walls, or pages whose
# JSON-LD demonstrably carries no price field. Everything else gets a try,
# and the per-host miss counter stops a hopeless one from eating the budget.
SKIP_HOSTS = {
    'www.ticketmaster.com', 'ticketmaster.com',   # 403s scripted fetches
    'www.ticketweb.com', 'ticketweb.com',
    'www.songkick.com', 'songkick.com',           # offers carry no price at all
    'www.meetup.com', 'meetup.com',               # price is behind their API
}
MAX_MISSES_PER_HOST = 5


def canon(url):
    """A url as a match key: scheme and tracking params do not distinguish
    one event from another, and Localist links itself both ways."""
    if not url:
        return None
    s = urlsplit(str(url))
    return (s.netloc.lower().removeprefix('www.') + s.path.rstrip('/')) or None


def load_cache():
    try:
        return json.load(open(CACHE_PATH))
    except (OSError, json.JSONDecodeError):
        return {}


def fresh(entry):
    try:
        at = datetime.fromisoformat(entry['at'])
    except (KeyError, ValueError):
        return False
    return datetime.now(timezone.utc) - at < timedelta(days=CACHE_DAYS)


def page_prices(url):
    """Every priced event node the page carries, keyed by canonical url.

    Returns ({canon_url: price}, sole_price) — sole_price is set when the
    page carries exactly one priced node, in which case it belongs to the
    listing whose url was fetched even if the node's own url differs.
    """
    page = fetch(url)
    nodes = []
    for block in LD.findall(page):
        try:
            walk(json.loads(block.strip()), nodes)
        except json.JSONDecodeError:
            continue
    by_url, priced = {}, []
    for n in nodes:
        price = price_of(n)
        if not price:
            continue
        priced.append(price)
        key = canon(first(n.get('url')))
        if key:
            by_url.setdefault(key, price)
    return by_url, (priced[0] if len(priced) == 1 else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--events', default='data/events.json')
    ap.add_argument('--limit', type=int, default=150, help='max pages fetched')
    args = ap.parse_args()

    data = json.load(open(args.events))
    items = data['items']
    cache = load_cache()
    today = datetime.now().date().isoformat()

    def unpriced(i):
        return not (i.get('price') and i['price'].get('min') is not None)

    todo = [i for i in items
            if unpriced(i) and (i.get('url') or '').startswith('http')
            and (i.get('start') or '')[:10] >= today
            and not str(i.get('id', '')).startswith('manual-')
            and urlsplit(i['url']).netloc.lower() not in SKIP_HOSTS]

    # Whole pool indexed by canonical url: any fetched page's nodes can
    # price any listing, not just the one that triggered the fetch.
    pool = {}
    for i in todo:
        pool.setdefault(canon(i['url']), []).append(i)

    # Busiest venues first: one popular page prices the listings people
    # actually see, and a shared calendar page costs one fetch for many rows.
    venue_weight = Counter(i.get('venue') for i in todo)
    todo.sort(key=lambda i: (-venue_weight[i.get('venue')], i.get('start') or ''))

    written, cached_hits, fetched = 0, 0, 0
    host_misses = Counter()
    failed_hosts = set()

    def apply(item, price, source):
        nonlocal written, cached_hits
        item['price'] = dict(price)
        written += 1
        cached_hits += source == 'cache'

    for item in todo:
        if not unpriced(item):        # a sibling's fetch already priced it
            continue
        url = item['url']
        host = urlsplit(url).netloc.lower()
        if host in failed_hosts:
            continue

        hit = cache.get(url)
        if hit and fresh(hit):
            if hit.get('price'):
                apply(item, hit['price'], 'cache')
            continue

        if fetched >= args.limit:
            continue
        fetched += 1
        try:
            by_url, sole = page_prices(url)
        except Exception:
            host_misses[host] += 1
            if host_misses[host] >= MAX_MISSES_PER_HOST:
                failed_hosts.add(host)
            continue
        time.sleep(0.7)

        mine = by_url.get(canon(url)) or sole
        cache[url] = {'price': mine, 'at': datetime.now(timezone.utc).isoformat()}
        if mine:
            apply(item, mine, 'fetch')
            host_misses[host] = 0
        else:
            host_misses[host] += 1
            if host_misses[host] >= MAX_MISSES_PER_HOST:
                failed_hosts.add(host)

        # And everything else the page happened to know about.
        for key, price in by_url.items():
            for other in pool.get(key, []):
                if unpriced(other):
                    apply(other, price, 'fetch')
                    cache[other['url']] = {'price': price,
                                           'at': datetime.now(timezone.utc).isoformat()}

    json.dump(cache, open(CACHE_PATH, 'w'), indent=0)
    json.dump(data, open(args.events, 'w'), indent=2, ensure_ascii=False)
    open(args.events, 'a').write('\n')

    total_priced = sum(1 for i in items if not unpriced(i))
    print(f'{written} listings priced from their own pages '
          f'({cached_hits} from cache, {fetched} pages fetched'
          + (f', gave up on {sorted(failed_hosts)}' if failed_hosts else '')
          + f') — {total_priced}/{len(items)} priced overall')
    return 0


if __name__ == '__main__':
    sys.exit(main())
