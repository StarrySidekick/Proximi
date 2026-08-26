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
# One vocabulary. Ordered specific to generic: the first match becomes the
# primary kind — the badge and the sort key — so "Speed Dating" must be read
# before "meetup" and "Paint & Sip" before "class".
TYPES = [
    # ── unmistakable single things ──────────────────────────────
    ('scavenger hunt', r'\b(scavenger hunt|treasure hunt|geocach\w*|photo hunt)\b'),
    ('speed dating',   r'\b(speed dating|singles (night|mixer|event)|matchmaking|'
                       r'blind date|date night mixer)\b'),
    ('trivia',         r'\b(trivia|pub quiz|quizzo|bingo)\b'),
    ('open mic',       r'\b(open[- ]mic|open mike)\b'),
    ('open studio',    r'\b(open studio\w*|studio tour|maker\w* space night)\b'),
    ('q&a',            r'\b(q\s*&\s*a|q and a|ask me anything|fireside chat|'
                       r'audience questions)\b'),
    ('meet & greet',   r'\b(meet[ &and]*greet|meet the (artist|author|maker|brewer)|'
                       r'book signing|autograph)\b'),
    ('animal encounter', r'\b(petting zoo|animal (encounter|meet|feeding|ambassador)|'
                       r'raptor|falconry|reptile show|aquarium feeding|zoo ?(kids|babies|tots)|'
                       r'meet (the|our) (animals|raptors|reptiles|owls)|'
                       r'critter|creature feature|read to (a )?(dog|rover))\b'),
    ('religious ceremony', r'\b(mass\b|worship|service\b|liturgy|vespers|evensong|'
                       r'shabbat|kiddush|jumu.?ah|puja|sangha|rosary|novena|'
                       r'communion|baptism|confirmation|sermon|prayer (service|meeting)|'
                       r'high holy days|yom kippur|rosh hashanah)\b'),
    # Something is being handed out, free. A distinct thing from a sale and from
    # a volunteer shift, and the reason people turn up.
    ('giveaway',       r'\b(free (vegetable|produce|food|book|meal|lunch|dinner|'
                       r'grocer\w*|clothing|coat|backpack|supplies|naloxone|narcan)|'
                       r'giveaway|give[- ]?away|food (pantry|distribution)|'
                       r'produce distribution|book cave|little free|'
                       r'distribution (day|event)|swap shop|really really free)\b'),
    # A staffed table you walk up to: a legislator's mobile office, an insurer
    # signing people up, a librarian helping with a phone.
    ('tabling',        r'\b(tabling|mobile office|office hours|navigator|'
                       r'drop[- ]?in (tech|computer|legal|health|help)|'
                       r'(tech|computer|legal|homework|resume) help|'
                       r'enrollment assistance|sign[- ]?up (table|event)|'
                       r'information table|resource (table|fair)|'
                       r'assemblymember|state senator|councilmember)\b'),
    ('yoga',           r'\b(yoga|pilates|tai chi|qi ?gong|meditation|sound bath|'
                       r'breathwork|restorative|mindfulness)\b'),
    ('workout',        r'\b(workout|bootcamp|hiit|crossfit|spin class|zumba|'
                       r'strength (class|training)|fitness class|barre)\b'),
    ('tasting',        r'\b(tasting|flight night|cellar|sommelier|cupping|'
                       r'wine (dinner|pairing)|beer pairing)\b'),
    ('breakfast',      r'\b(breakfast|brunch|pancake|coffee hour|morning social)\b'),
    ('lunch',          r'\b(lunch(eon)?|midday meal)\b'),
    ('dinner',         r'\b(dinner|supper|bbq|barbecue|clambake|fish fry|'
                       r'pot ?luck|feast|banquet)\b'),

    # ── performance ─────────────────────────────────────────────
    ('musical',        r'\b(musicals?|operas?|operetta)\b'),
    ('comedy show',    r'\b(comedy|stand[- ]?up|improv|sketch show)\b'),
    ('play',           r'\b(theat(er|re)|cabaret|drag show|puppet show)\b|'
                       r'\b(?:a|the|new|one[- ]act) plays?\b|\bplay (?:by|reading)\b'),
    ('film',           r'\b(films?|movies?|screening|cinema|documentar\w*|matinee)\b'),
    ('dj',             r'\b(dj\b|turntabl\w*|vinyl night|silent disco)\b'),
    ('dance',          r'\b(dance|ballet|salsa|swing|tango|contra|line dancing)\b'),
    ('concert',        r'\b(concert|live music|bands?|recital|symphony|orchestra|'
                       r'quartet|trio|songwriter|acoustic|jazz|blues|folk|choir|'
                       r'singer|tribute|residency|tour dates?)\b'),

    # ── gatherings ──────────────────────────────────────────────
    ('party',          r'\b(party|bash|afterparty|after[- ]party|nightlife|'
                       r'block party|mixer)\b'),
    ('celebration',    r'\b(celebration|anniversary|birthday|gala|jubilee|'
                       r'tree lighting|fireworks|opening day|ceremony)\b'),
    ('festival',       r'\b(festival|fest\b|fair(?! (booth|trade))|carnival|jamboree)\b'),
    ('parade',         r'\bparade\b'),
    ('protest',        r'\b(rally|protest|demonstration|vigil|picket|walkout)\b|'
                       r'\bmarch(es|ing)? (for|on|against|to demand)\b'),
    ('market',         r'\b(market|bazaar|makers?\b|vendors?|craft fair|swap meet)\b'),
    ('sale',           r'\b(sale|flea|rummage|tag sale|book sale|clearance)\b'),
    ('volunteer',      r'\b(volunteer|work ?day|stewardship|planting|fundraiser|benefit|'
                       r'(blood|food|coat|toy|book|clothing|donation|canned[- ]food) drive|'
                       r'give ?back|charity|clean[- ]?up day)\b'),
    ('game',           r'\b(game night|board ?games?|trading cards?|escape room|chess|'
                       r'mah ?jong?g?|bridge club|dungeons|karaoke|tabletop|video ?game|dominoes|cribbage|canasta)\b'),
    ('sporting event', r'\b(basketball|soccer|volleyball|baseball|softball|hockey|'
                       r'lacrosse|tennis|golf|swimming|diving|cross country|'
                       r'field hockey|football|rugby|pickleball|race|5k|10k|marathon|'
                       r'tournament|martial arts|karate|taekwondo|jiu[- ]?jitsu|judo|'
                       r'boxing|regatta|derby)\b'),

    # ── things to look at, learn from, or join ──────────────────
    ('art exhibit',    r'\b(art (exhibit\w*|show)|gallery|opening reception|'
                       r'installation|sculpture|paintings?|artist talk)\b'),
    ('museum exhibit', r'\b(exhibit\w*|on view|retrospective|showcase|'
                       r'permanent collection|special collection|museums?|'
                       r'planetarium|observatory|aquarium|zoo\b|'
                       r'historic (house|site|home)|admission|general admission)\b'),
    ('tour',           r'\b(tours?|guided walk|house tour|behind the scenes|'
                       r'hike|hiking|walking tour|birding|paddle|kayak)\b'),
    # The libraries publish a real share of their programme in Spanish; read
    # literally it is all "other". These are the words that actually appear.
    ('talk',           r'\b(charla|conferencia|presentaci[oó]n|taller|'
                       r'programa de|consejos|c[oó]mo\b|clase de)\b|'
                       r'\b(talk|lecture|reading|panel|author|poet|keynote|symposium|'
                       r'seminar|presentation|storytime|story time|planetarium|'
                       r'astronomy|book club)\b'),
    ('craft',          r'\b(knit\w*|crochet|quilt\w*|sewing|weaving|needlepoint|'
                       r'embroider\w*|macram|pottery|ceramics?|kiln|collage|'
                       r'printmaking|linocut|calligraphy|woodworking|whittl\w*|'
                       r'jewel\w*[- ]making|scrapbook\w*|papercraft|origami|'
                       r'make[- ]your[- ]own|make this|diy\b|craft(?!\ (beer|brew|'
                       r'cocktail|distiller|cider|fair|show)))\b'),
    ('class',          r'\b(workshops?|class(es)?|lessons?|courses?|clinic|training|'
                       r'demo|certification|certificate|bootcamp|intro to|101|'
                       r'paint[- ]?(and|n|&)[- ]?sip|watercolou?r\w*)\b'),
    ('club',           r'\b(club\b|society|guild|chapter meeting|circle\b|'
                       r'meetup|town hall|forum|networking|gathering|'
                       r'support group|social hour)\b'),

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


# What a venue implies, for listings whose own words say nothing. "Hudson
# Valley Renegades vs. Brooklyn Cyclones" names two teams and no sport;
# "Wicked (NY)" names no kind at all. The building does: a ballpark holds
# sport, a Broadway house holds theatre.
VENUE_KINDS = [
    # Comedy clubs before music rooms, or every one of them reads as a gig.
    ('comedy show',    r'\b(comedy (club|cellar|works)|laugh (factory|lounge))\b'),
    ('sporting event', r'\b(stadium|ball ?park|arena|speedway|racetrack|raceway|'
                       r'coliseum|ballfield|athletic (field|complex)|ice rink)\b'),
    # A room whose name says music. Reached only when the listing is a bare
    # artist name — "Mad Caddies", "Kota the Friend" — which is most of what a
    # music venue posts and none of what its title explains.
    ('concert',        r'\b(ballroom|music hall|amphitheat\w*|bandshell|bowl\b|'
                       r'lounge|tavern|jazz club|underground|sound ?stage|'
                       r'concert hall|fairgrounds?)\b'),
    ('play',           r'\b(theatres?|theaters?|playhouse|opera house)\b'),
    ('museum exhibit', r'\b(museum|planetarium|observatory|aquarium|zoo)\b'),
    ('film',           r'\b(cinema|film center|drive[- ]in)\b'),
    ('art exhibit',    r'\b(gallery|art cent(er|re))\b'),
]


# What sort of place this is, for grouping and filtering the Places list.
# Ordered: the first match wins, so "Museum Cafe" is a museum, not a cafe.
PLACE_KINDS = [
    ('library',        r'\b(librar(y|ies)|biblioteca)\b'),
    ('museum',         r'\b(museum|planetarium|observatory|aquarium|zoo\b|'
                       r'historic (house|site|home)|mill house|manor|mansion)\b'),
    ('theatre',        r'\b(theatres?|theaters?|playhouse|opera house|cinema|'
                       r'film cent(er|re)|drive[- ]in)\b'),
    ('music venue',    r'\b(ballroom|music hall|amphitheat\w*|bandshell|bowl\b|'
                       r'lounge|jazz club|concert hall|sound ?stage|'
                       r'performing arts|arts cent(er|re))\b'),
    ('stadium',        r'\b(stadium|ball ?park|arena|speedway|racetrack|raceway|'
                       r'coliseum|ballfield|fairgrounds?|ice rink)\b'),
    ('gallery',        r'\b(galler(y|ies)|art cent(er|re)|studios?)\b'),
    ('brewery',        r'\b(brew\w*|taproom|tap house|beer (garden|hall)|'
                       r'cider\w*|distiller\w*|winer\w*|vineyards?|meader\w*)\b'),
    ('cafe',           r'\b(caf[eé]|coffee|espresso|roaster\w*|tea (room|shop|house)|'
                       r'bakery|patisserie|creamery|gelato|java)\b'),
    ('restaurant',     r'\b(restaurant|kitchen|bistro|trattoria|osteria|tavern|'
                       r'grill(e|house)?|diner|eatery|pizzeria|steakhouse|'
                       r'bar\ ?&|pub\b|saloon)\b'),
    ('park',           r'\b(park|preserve|sanctuary|trail|gardens?|arboretum|'
                       r'nature cent(er|re)|conservation|farm\b|orchard|'
                       r'lake|beach|woods|state forest)\b'),
    ('community centre', r'\b(community cent(er|re)|civic cent(er|re)|rec(reation)? cent(er|re)|'
                       r'senior cent(er|re)|ymca|ywca|jcc\b|grange|'
                       r'american legion|elks|rotary|town hall|village hall|'
                       r'city of\b|town of\b|firehouse|fire (department|company))\b'),
    ('school',         r'\b(school|college|universit(y|ies)|academy|institute|campus)\b'),
    ('place of worship', r'\b(church|temple|synagogue|chapel|cathedral|mosque|'
                       r'meeting ?house|congregation|parish|sangha|monastery)\b'),
    ('shop',           r'\b(shop|store|boutique|market\b|bookstore|books\b|'
                       r'gallery shop|mall\b|emporium)\b'),
    ('club',           r'\b(club|society|lodge|guild|hall\b)\b'),
]


def place_kind(venue):
    """Categorise a venue by name, or None when the name gives nothing away."""
    for name, pattern in PLACE_KINDS:
        if venue and re.search(pattern, str(venue), re.I):
            return name
    return None


# VENUE_KINDS and PLACE_KINDS are separate lists that name kinds from TYPES,
# so a rename in one can silently leave the others emitting a dead value —
# which renders fine and no filter can reach. Caught at import instead.
_VOCABULARY = {name for name, _ in TYPES}
_STRAY = {k for k, _ in VENUE_KINDS} - _VOCABULARY
assert not _STRAY, f'VENUE_KINDS emits kinds outside the vocabulary: {sorted(_STRAY)}'


def venue_kind(venue):
    for name, pattern in VENUE_KINDS:
        if venue and re.search(pattern, str(venue), re.I):
            return name
    return None


def types_of(title, description='', venue=None, limit=3):
    """All the kinds of thing a listing is, most defining first.

    A paint-and-sip is a class, and creative, and food & drink; forcing one
    label on it loses whichever two the reader was filtering for. The title is
    read first and exhausted before the description is consulted, because what
    a thing *is* lives in its name while the description lists what it
    contains — a county fair whose blurb mentions grandstand concerts is a
    festival, not a concert.

    Capped, since a long description will eventually touch half the vocabulary
    and a listing tagged eight ways is no more findable than one tagged none.
    """
    def matches(text):
        return [name for name, pattern in TYPES if re.search(pattern, text, re.I)]

    found = matches(title or '')[:limit]
    # The description may contribute one more kind and no further. It is where
    # the incidental words live — a blurb long enough will eventually touch
    # half the vocabulary — so it can round a listing out but never define it.
    if len(found) < limit:
        for name in matches(description or ''):
            if name not in found:
                found.append(name)
                break
    # The building is consulted only when the listing's own words yielded
    # nothing. An arena hosts concerts as readily as basketball, so letting the
    # venue speak over a title that already said "concert" would be worse than
    # silence — but against 'other' it is all we have.
    if not found:
        implied = venue_kind(venue)
        if implied:
            return [implied]
        # "Hudson Valley Renegades vs. Brooklyn Cyclones" at Heritage Financial
        # Park: two proper nouns either side of vs., and a venue named Park that
        # no pattern can safely claim, since most Parks really are parks. The
        # fixture line is the signal. Only reached when nothing else matched, so
        # "Beatles Vs. Stones - A Musical Showdown" is long gone by here.
        if re.search(r'^[A-Z][\w.\'-]*(?:\s+[\w.&\'-]+){0,4}\s+vs\.?\s+[A-Z]', title or ''):
            return ['sporting event']
    return found[:limit] or ['other']


def type_of(title, description='', venue=None):
    """The single most defining kind — the badge, and the sort key."""
    return types_of(title, description, venue)[0]


def setting_of(text):
    out, ind = bool(OUTDOOR.search(text)), bool(INDOOR.search(text))
    if out and not ind:
        return 'outdoor'
    if ind and not out:
        return 'indoor'
    return 'unknown'


def time_of_day(dt):
    """Daytime or nighttime, split at 5pm.

    Four buckets asked the reader to care about the seam between afternoon and
    evening, which nobody browsing for something to do on a Friday does. Five
    is where a listing stops being something you fit into a day and starts
    being the evening itself.
    """
    return 'daytime' if dt.hour < 17 else 'nighttime'


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


# A street address is not the name of a place. Feeds put one in LOCATION
# constantly — Storm King's own calendar says "1 Museum Rd" — and a card
# reading "1 Museum Rd · New Windsor" tells a reader nothing about where they
# would actually be going.
STREET_ONLY = re.compile(
    r"^\s*\d+[-\d]*\s+[\w.'\- ]+?\s*"
    r"(st|street|rd|road|ave|avenue|blvd|boulevard|ln|lane|dr|drive|way|"
    r"pl|place|ct|court|hwy|highway|tpke|turnpike|pkwy|parkway|route|rt|sq|square)"
    r"\.?\s*$", re.I)


# The aggregators are not places. Falling back to the publisher put
# "Eventbrite" in the venue field of ninety listings, which is no more a place
# to go on a Friday than "email" is.
NOT_A_PLACE = {'eventbrite', 'meetup', 'ticketmaster', 'songkick',
               'see listing', 'online', 'tbd', 'tba', 'various', 'various locations'}


def place_name(venue, *fallbacks):
    """The name of the place, preferring a real name over a street address.

    Falls back through the source's own venue block, the organiser and the
    publisher — whichever first gives something that is neither an address nor
    the name of the platform the listing came through.
    """
    for candidate in (venue, *fallbacks):
        if not candidate:
            continue
        text = str(candidate).strip()
        if text.lower() in NOT_A_PLACE or STREET_ONLY.match(text):
            continue
        return text
    return None


def audience_of(text, title=None, kind=None):
    """Who a listing is for: 'family', 'seniors', 'adults' or 'all'.

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
        # Children-only and family-with-young-children are one audience now:
        # both are hidden by the same switch, and the distinction only ever
        # mattered to the code that drew it.
        return 'family'
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
    ap.add_argument('--cinema', default='build/cinema.json')
    ap.add_argument('--manual', default='sources/manual.json')
    ap.add_argument('--out', default='build/enriched.json')
    ap.add_argument('--registry', default='sources/registry.json')
    args = ap.parse_args()

    registry = json.load(open(args.registry))
    center = registry['center']
    # Venue feeds usually omit LOCATION — every event is at the same address —
    # so the registry carries the venue's own coordinates as a fallback.
    # Some entries carry the venue as a bare address string rather than a
    # block; normalise so the fallback is always a dict to read from.
    venue_default = {s['id']: (s['venue'] if isinstance(s['venue'], dict)
                               else {'name': s['venue'], 'address': s['venue']})
                     for s in registry['sources'] if s.get('venue')}
    data = json.load(open(args.src))
    cache, stats = load_cache(), {'cached': 0, 'looked_up': 0, 'errors': 0}
    dropped = {'no_location': 0, 'ungeocodable': 0, 'out_of_radius': 0}

    out = []
    for c in data['candidates']:
        fallback = venue_default.get(c['sourceId'])
        loc = c.get('location')
        # A venue feed often gives a street and nothing else — every event is
        # at the same place, so the town goes without saying locally. It does
        # not go without saying to a global gazetteer: "7 East Main Street"
        # resolves to Uphall, Scotland. Where the registry knows the venue's
        # town, say it.
        query = loc
        if loc and ',' not in loc and (fallback or {}).get('city'):
            query = f"{loc}, {fallback['city']}"
        hit = geocode(query, cache, stats) if query else None

        # Track whether the venue default was actually used. Inheriting the
        # source venue's town for an event held somewhere else put "Ossining"
        # on a Mamaroneck library listing.
        used_fallback = False
        if not hit and fallback and fallback.get('lat') is not None:
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
        venue = place_name(venue, (fallback or {}).get('name'),
                           c.get('organizer'), c['sourceName'])
        if venue and venue == venue.lower():
            venue = titlecase(venue)
        blob = ' '.join(filter(None, [c['title'], c.get('description'), venue]))
        recurring = c.get('recurring') or bool(ACTIVITY_HINTS.search(blob))

        started = datetime.fromisoformat(c['start'])
        out.append({
            'id': f"{c['sourceId']}-{abs(hash(c.get('uid') or c['title'] + c['start'])) % 10**8}",
            'title': c['title'],
            'type': type_of(c['title'], c.get('description'), venue),
            'types': types_of(c['title'], c.get('description'), venue),
            'repeats': bool(recurring),
            'audience': audience_of(blob, c['title'], type_of(c['title'], c.get('description'))),
            'setting': setting_of(blob),
            'timeOfDay': time_of_day(started),
            'hasFood': bool(FOOD.search(blob)),
            'host': c.get('organizer') or c['sourceName'],
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
                      (args.songkick, 'events'), (args.cinema, 'events'),
                      (args.manual, 'items')):
        if os.path.exists(path):
            prepared.extend(json.load(open(path)).get(key, []))

    platform_kept = 0
    for e in prepared:
        # Hand-read entries were checked by a person; pass them through whole.
        # Coordinates are the one thing a person reading a listing page does
        # not have — a pop-up screening names a brewery, not a latitude — so
        # those still go through the geocoder. Everything else stands as read.
        if str(e.get('id', '')).startswith('manual-'):
            if e.get('lat') is None or e.get('lon') is None:
                query = e.get('address') or (
                    f"{e.get('venue')}, {e.get('city')}" if e.get('city') else e.get('venue'))
                hit = geocode(query, cache, stats) if query else None
                if not hit:
                    dropped['ungeocodable'] += 1
                    continue
                e['lat'], e['lon'] = hit['lat'], hit['lon']
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
            'type': e.get('type') or type_of(e['title'], e.get('description'), e.get('venue')),
            'types': e.get('types') or (
                [e['type']] if e.get('type')
                else types_of(e['title'], e.get('description'), e.get('venue'))),
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
            'start': e['start'], 'end': e.get('end'),
            'venue': place_name(e.get('venue'), e.get('host'), e.get('sourceName'))
                     or 'See listing',
            'city': e.get('city'),
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
