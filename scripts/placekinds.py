"""The one place taxonomy, shared by everything that categorises a place.

Two things categorise places and they used to do it separately: enrich.py
matched a venue *name* ("Howland Public Library" → library) because an event
only ever tells us what its venue is called, while places.py reads OSM *tags*
(`amenity=library`) because a place directory has real structured data. Two
lists naming the same kinds is how a rename in one silently leaves the other
emitting a dead value that renders fine and no filter can reach — the codebase
already carried an import-time assert against exactly that.

So the kinds live here once, and both readers are defined against them. The
assert at the bottom is now a completeness check rather than a drift check: it
fails if either reader names a kind this file does not define.

Order is significance, not alphabet: the first rule that matches wins, so the
specific kinds come before the general ones they would otherwise fall into.
A used book store is a shop, a botanical garden is a park and a castle is a
historic site — but nobody browsing for somewhere to go on Sunday wants those
three filed under "shop", "park" and "historic site".
"""

# (kind, plural label shown in the UI). The order here is the order the
# filter chips appear in, so it reads as a rough tour of what there is.
KINDS = [
    ('museum',           'Museums'),
    ('gallery',          'Galleries & studios'),
    ('historic house',   'Historic houses & mansions'),
    ('castle',           'Castles'),
    ('historic site',    'Historic sites'),
    ('garden',           'Gardens & arboretums'),
    ('park',             'Parks & nature'),
    ('lookout',          'Lookouts & towers'),
    ('landmark',         'Landmarks & monuments'),
    ('zoo',              'Zoos & aquariums'),
    ('theme park',       'Theme & water parks'),
    ('winery',           'Wineries & vineyards'),
    ('brewery',          'Breweries & distilleries'),
    ('farm',             'Farms & orchards'),
    ('theatre',          'Theatres'),
    ('cinema',           'Cinemas'),
    ('music venue',      'Music venues'),
    ('stadium',          'Stadiums & arenas'),
    ('bowling alley',    'Bowling alleys'),
    ('library',          'Libraries'),
    ('bookshop',         'Book shops'),
    ('antique shop',     'Antique shops'),
    ('mall',             'Malls & markets'),
    ('shop',             'Specialty shops'),
    ('cafe',             'Cafés'),
    ('restaurant',       'Restaurants & bars'),
    ('community centre', 'Community centres'),
    ('place of worship', 'Places of worship'),
    ('school',           'Schools & colleges'),
    ('club',             'Clubs & halls'),
]

LABELS = dict(KINDS)
ORDER = [name for name, _ in KINDS]

# Kinds worth browsing for their own sake — somewhere to go, not somewhere a
# thing happens to be happening. places.py collects these; the rest only ever
# enter the directory by hosting an event.
DESTINATIONS = {
    'museum', 'gallery', 'historic house', 'castle', 'historic site', 'garden',
    'park', 'lookout', 'landmark', 'zoo', 'theme park', 'winery', 'brewery',
    'farm', 'theatre', 'cinema', 'music venue', 'stadium', 'bowling alley',
    'library', 'bookshop', 'antique shop', 'mall', 'shop',
}

# --- reading OSM tags -------------------------------------------------------
#
# Each entry is (kind, [Overpass selectors]). A selector is whatever goes
# inside the brackets of an Overpass `nwr[...]` clause, so a rule can test one
# tag, a regex over one tag, or two tags at once.
#
# These are also what places.py *queries* — a kind with no selectors is never
# fetched, only ever inferred from an event venue's name.
OSM_RULES = [
    ('museum', ['"tourism"="museum"', '"historic"="museum"',
                '"amenity"="planetarium"']),
    ('gallery', ['"tourism"="gallery"']),
    # historic=manor is OSM's tag for a country house open to visitors, which
    # is most of what people mean by "a mansion you can go and look at".
    # historic=house alone is any old house; it needs a reason to be on a map
    # as a destination, which substantial() checks for.
    ('historic house', ['"historic"="manor"', '"historic"="villa"',
                        '"building"="manor"', '"historic"="house"']),
    ('castle', ['"historic"="castle"', '"building"="castle"']),
    ('historic site', ['"historic"~"^(monument|memorial|ruins|archaeological_site|'
                       'battlefield|fort|city_gate|aqueduct|tomb|mine|heritage|'
                       'lighthouse|locomotive|ship|wreck)$"',
                       '"tourism"="historic"', '"heritage"']),
    ('garden', ['"leisure"="garden"', '"garden:type"="botanical"',
                '"tourism"="botanical_garden"', '"leisure"="arboretum"']),
    ('park', ['"leisure"="nature_reserve"', '"leisure"="park"',
              '"boundary"="protected_area"']),
    # "Attractions" was one bucket holding planetariums, water parks, overlooks,
    # theme parks, zoos, fire towers and a handful of notable rocks. That is a
    # label, not a category — nobody browsing wants a zoo and a roadside marker
    # behind the same chip. Split into the things people actually go to.
    ('zoo', ['"tourism"="zoo"', '"tourism"="aquarium"']),
    ('theme park', ['"tourism"="theme_park"', '"leisure"="water_park"']),
    # Overlooks, summits, and the fire and observation towers you climb for the
    # same reason.
    ('lookout', ['"tourism"="viewpoint"', '"man_made"="tower"']),
    # Whatever is left of tourism=attraction: the arches, the boulders, the
    # markers, the notable bridges. Worth seeing, not worth an afternoon.
    ('landmark', ['"tourism"="attraction"', '"natural"="arch"']),
    # NOT shop=wine: that is the liquor store on the corner, and it swamps the
    # dozen actual vineyards you can drive out to. landuse=vineyard needs a
    # name to count, or every planted hillside arrives.
    ('winery', ['"craft"="winery"', '"amenity"="winery"', '"tourism"="wine_cellar"',
                '"landuse"="vineyard"']),
    ('brewery', ['"craft"~"^(brewery|distillery|cidery)$"', '"microbrewery"="yes"',
                 '"amenity"="biergarten"']),
    # NOT shop=greengrocer: half of those are a town grocer, a natural foods
    # shop, or in one case a chemist. shop=farm is the farm stand at the gate.
    ('farm', ['"shop"="farm"', '"tourism"="farm"']),
    ('theatre', ['"amenity"="theatre"', '"amenity"="arts_centre"']),
    ('cinema', ['"amenity"="cinema"']),
    ('music venue', ['"amenity"="music_venue"', '"amenity"="nightclub"']),
    ('stadium', ['"leisure"="stadium"', '"leisure"="ice_rink"']),
    # Pat Tarsio Lanes is not a stadium.
    ('bowling alley', ['"leisure"="bowling_alley"']),
    ('library', ['"amenity"="library"']),
    # Chains are the thing the user does not want here, and OSM marks them:
    # `brand` is set on a Barnes & Noble and absent on a village book shop.
    ('bookshop', ['"shop"="books"']),
    ('antique shop', ['"shop"="antiques"']),
    # NOT shop=department_store: that is Marshalls, TJ Maxx, Macy's and Sears —
    # 270 of 464 results, and each one is a shop inside a mall rather than
    # somewhere you set out for. amenity=marketplace stays: it is the farmers
    # markets and the flea markets, which are exactly the kind of thing worth
    # a Saturday.
    ('mall', ['"shop"="mall"', '"amenity"="marketplace"']),
    # A category of one is silly. These are the shop types people make a trip
    # for, which is the same reason antique shops and book shops earned their
    # own kinds — not the supermarket and the phone repair place.
    ('shop', ['"shop"="gift"', '"shop"="craft"', '"shop"="art"',
              '"shop"="music"', '"shop"="musical_instrument"',
              '"shop"="second_hand"', '"shop"="charity"',
              '"shop"="garden_centre"', '"shop"="pottery"',
              '"shop"="chocolate"', '"shop"="cheese"', '"shop"="tea"',
              '"shop"="games"', '"shop"="collector"', '"shop"="comics"',
              '"shop"="record"', '"shop"="frame"', '"shop"="fabric"']),
    ('cafe', []),
    ('restaurant', []),
    ('community centre', []),
    ('place of worship', []),
    ('school', []),
    ('club', []),
]

# --- reading a venue name ---------------------------------------------------
#
# Only ever reached for a venue that arrived on an event, where the name is
# all we have.
NAME_RULES = [
    ('museum',         r'\b(museum|planetarium|historical societ(y|ies))\b'),
    ('castle',         r'\bcastle\b'),
    ('historic house', r'\b(mansion|manor|homestead|estate|house museum|'
                       r'historic (house|home|site)|birthplace)\b'),
    ('historic site',  r'\b(battlefield|monument|memorial|fort\b|ruins|'
                       r'lighthouse|heritage (site|cent(er|re)))\b'),
    ('garden',         r'\b(botanical|arboretum|conservatory|gardens?)\b'),
    ('cinema',         r'\b(cinema|drive-?in|film cent(er|re)|movie ?house|'
                       r'picture house|screening room)\b'),
    ('theatre',        r'\b(theat(er|re)|playhouse|opera house)\b'),
    ('music venue',    r'\b(ballroom|music hall|amphitheat\w*|bandshell|bowl\b|'
                       r'lounge|jazz club|concert hall|sound ?stage|'
                       r'performing arts|arts cent(er|re))\b'),
    ('bowling alley',  r'\b(bowl(ing)?\s*(alley|lanes?|centre|center)|lanes\b|bowlero)\b'),
    ('zoo',            r'\b(zoo\b|aquarium|safari park|wildlife cent(er|re))\b'),
    ('theme park',     r'\b(theme park|amusement park|water ?park|fun ?plex|playland)\b'),
    ('lookout',        r'\b(overlook|lookout|fire tower|observation (tower|deck)|'
                       r'watchtower|scenic (vista|view))\b'),
    ('stadium',        r'\b(stadium|ball ?park|arena|speedway|racetrack|raceway|'
                       r'coliseum|ballfield|fairgrounds?|ice rink)\b'),
    ('gallery',        r'\b(galler(y|ies)|art cent(er|re)|studios?)\b'),
    ('winery',         r'\b(winer\w*|vineyards?|meader\w*|wine cellar)\b'),
    ('brewery',        r'\b(brew\w*|taproom|tap house|beer (garden|hall)|'
                       r'cider\w*|distiller\w*)\b'),
    ('farm',           r'\b(farm\b|farmstead|orchard|creamery|apiary|'
                       r'pick[- ]your[- ]own|cider mill)\b'),
    ('library',        r'\b(librar(y|ies)|reading room|athenaeum)\b'),
    ('bookshop',       r'\b(book ?(shop|store|s\b)|booksellers?|bindery)\b'),
    ('antique shop',   r'\b(antiques?|vintage|salvage|flea market)\b'),
    ('mall',           r'\b(mall\b|shopping cent(er|re)|galleria|marketplace|'
                       r'farmers.? market|market\b)\b'),
    ('park',           r'\b(park|preserve|sanctuary|trail|nature cent(er|re)|'
                       r'conservation|lake|beach|woods|state forest)\b'),
    ('cafe',           r'\b(caf[eé]|coffee|espresso|roaster\w*|tea (room|shop|house)|'
                       r'bakery|patisserie|gelato|java)\b'),
    ('restaurant',     r'\b(restaurant|kitchen|bistro|trattoria|osteria|tavern|'
                       r'grill(e|house)?|diner|eatery|pizzeria|steakhouse|'
                       r'bar\ ?&|pub\b|saloon)\b'),
    ('community centre', r'\b(community cent(er|re)|civic cent(er|re)|rec(reation)? cent(er|re)|'
                       r'senior cent(er|re)|ymca|ywca|jcc\b|grange|'
                       r'american legion|elks|rotary|town hall|village hall|'
                       r'city of\b|town of\b|firehouse|fire (department|company))\b'),
    ('school',         r'\b(school|college|universit(y|ies)|academy|institute|campus)\b'),
    ('place of worship', r'\b(church|temple|synagogue|chapel|cathedral|mosque|'
                       r'meeting ?house|congregation|parish|sangha|monastery)\b'),
    ('shop',           r'\b(shop|store|boutique|emporium)\b'),
    ('club',           r'\b(club|society|lodge|guild|hall\b)\b'),
]

_DEFINED = set(ORDER)
_STRAY = ({k for k, _ in OSM_RULES} | {k for k, _ in NAME_RULES}
          | DESTINATIONS) - _DEFINED
assert not _STRAY, f'rules name kinds that KINDS does not define: {sorted(_STRAY)}'
