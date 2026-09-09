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
    'cafe', 'restaurant',
}

# Somewhere to eat is a destination, but it is not the same *kind* of question
# as somewhere to go, and there are five times as many of them: one 35-mile
# sample held 4,211 restaurants against 3,500 places in the whole directory.
# So these two are collected on the same terms and written to their own file,
# which the client loads in the background rather than ahead of the first
# screen. The taxonomy stays one taxonomy; only the delivery is split.
FOOD = {'cafe', 'restaurant'}

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
    # shop=art is "Tivoli Artists Gallery" and "Jack's Art Gallery" — galleries
    # that sell, not shops that happen to stock prints. Claimed here, before
    # the shop rule can take them.
    ('gallery', ['"tourism"="gallery"', '"shop"="art"']),
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
              '"shop"="record"', '"shop"="fabric"']),
    # Food was the one part of the directory that only ever arrived by accident:
    # both kinds had no selectors, so a restaurant existed here only if it
    # happened to host an event. That is fine for a town you live in and no use
    # at all on a drive, where "somewhere to eat, now, that is still open" is
    # most of what you want from a directory.
    #
    # NOT branded fast food. `brand` is set on 1,491 of the 2,079 fast-food
    # outlets in one 35-mile sample — the McDonald's, the Dunkin', the Subway —
    # and nobody sets out for one; they are what a phone map is for. Dropping
    # them keeps what fast_food is genuinely good for around here, which is the
    # clam shacks, the lobster pounds and the pizza counters. See food_worth().
    ('cafe', ['"amenity"="cafe"', '"amenity"="ice_cream"', '"shop"="bakery"',
              '"shop"="coffee"', '"shop"="pastry"']),
    ('restaurant', ['"amenity"="restaurant"', '"amenity"="fast_food"',
                    '"amenity"="pub"', '"amenity"="bar"',
                    '"amenity"="food_court"']),
    ('community centre', []),
    ('place of worship', []),
    ('school', []),
    ('club', []),
]

# --- what kind of food ------------------------------------------------------
#
# OSM's `cuisine` is free-ish text and the tail is very long: 224 distinct
# tokens in one 35-mile sample, of which the top twenty cover four fifths of
# the places that set it at all. So the tokens are grouped into things a person
# would actually ask for, and a token nobody has grouped yet is *dropped* rather
# than guessed at — a Portuguese bakery filed under "Other" is worse than one
# with no cuisine on it, because "Other" is a promise that the filter works.
# places.py prints the unmapped tokens it saw at the end of a run, so the list
# below grows from what the data actually contains.
#
# (group id, label shown in the UI). Order is roughly how often it turns up in
# New England, so the select reads as a tour of what is around.
CUISINES = [
    ('seafood',       'Seafood'),
    ('american',      'American'),
    ('pizza',         'Pizza'),
    ('italian',       'Italian'),
    ('burger',        'Burgers'),
    ('sandwich',      'Sandwiches & delis'),
    ('breakfast',     'Breakfast & brunch'),
    ('diner',         'Diners'),
    ('bakery',        'Bakeries & donuts'),
    ('coffee',        'Coffee, tea & juice'),
    ('dessert',       'Ice cream & desserts'),
    ('mexican',       'Mexican & Latin American'),
    ('chinese',       'Chinese'),
    ('japanese',      'Japanese & sushi'),
    ('thai',          'Thai'),
    ('korean',        'Korean'),
    ('vietnamese',    'Vietnamese'),
    ('indian',        'Indian'),
    ('asian',         'Other Asian'),
    ('mediterranean', 'Mediterranean & Middle Eastern'),
    ('french',        'French'),
    ('barbecue',      'Barbecue'),
    ('steak',         'Steakhouses'),
    ('chicken',       'Chicken & wings'),
    ('salad',         'Salads & bowls'),
    ('vegetarian',    'Vegetarian & vegan'),
    ('pub',           'Pub food'),
]

CUISINE_LABELS = dict(CUISINES)
CUISINE_ORDER = [name for name, _ in CUISINES]

# group -> the OSM cuisine tokens that mean it.
CUISINE_TOKENS = {
    'seafood': ['seafood', 'fish', 'fish_and_chips', 'lobster', 'oyster',
                'oysters', 'clam', 'clams', 'crab', 'shellfish', 'chowder',
                'sushi_and_seafood'],
    'american': ['american', 'new_american', 'american;burger', 'comfort_food',
                 'southern', 'soul_food', 'cajun', 'creole', 'bbq_and_american'],
    'pizza': ['pizza', 'italian_pizza', 'pizza_and_pasta', 'neapolitan_pizza',
              'pizzeria'],
    'italian': ['italian', 'pasta', 'sicilian', 'tuscan', 'trattoria'],
    'burger': ['burger', 'burgers', 'hamburger', 'hot_dog', 'hotdog',
               'hot_dogs', 'cheeseburger'],
    'sandwich': ['sandwich', 'sandwiches', 'deli', 'delicatessen', 'sub',
                 'subs', 'submarine', 'cheesesteak', 'wrap', 'panini', 'hoagie',
                 'roast_beef'],
    'breakfast': ['breakfast', 'brunch', 'pancake', 'pancakes', 'waffle',
                  'eggs', 'breakfast_and_lunch'],
    'diner': ['diner', 'american_diner'],
    'bakery': ['bakery', 'pastry', 'pastries', 'donut', 'donuts', 'doughnut',
               'bagel', 'bagels', 'croissant', 'cake', 'cupcake', 'pie',
               'bread', 'pretzel'],
    'coffee': ['coffee_shop', 'coffee', 'cafe', 'tea', 'bubble_tea',
               'boba', 'juice', 'smoothie', 'smoothies', 'açaí', 'acai'],
    'dessert': ['ice_cream', 'gelato', 'frozen_yogurt', 'dessert', 'desserts',
                'candy', 'chocolate', 'custard', 'shaved_ice', 'crepe_dessert'],
    'mexican': ['mexican', 'tex-mex', 'tex_mex', 'tacos', 'taco', 'burrito',
                'latin_american', 'latin', 'colombian', 'salvadoran',
                'dominican', 'brazilian', 'peruvian', 'cuban', 'caribbean',
                'jamaican', 'puerto_rican', 'venezuelan', 'argentinian',
                'honduran', 'guatemalan', 'ecuadorian', 'chilean'],
    'chinese': ['chinese', 'cantonese', 'szechuan', 'sichuan', 'dim_sum',
                'hot_pot', 'hotpot', 'dumpling', 'dumplings'],
    'japanese': ['japanese', 'sushi', 'ramen', 'izakaya', 'teppanyaki',
                 'yakitori', 'hibachi'],
    'thai': ['thai'],
    'korean': ['korean'],
    'vietnamese': ['vietnamese', 'pho'],
    'indian': ['indian', 'pakistani', 'punjabi', 'south_indian', 'curry',
               'bangladeshi'],
    'asian': ['asian', 'noodle', 'noodles', 'filipino', 'malaysian',
              'indonesian', 'mongolian', 'taiwanese', 'nepalese', 'tibetan',
              'burmese', 'cambodian', 'laotian'],
    'mediterranean': ['mediterranean', 'greek', 'turkish', 'middle_eastern',
                      'lebanese', 'falafel', 'kebab', 'shawarma', 'israeli',
                      'persian', 'iranian', 'moroccan', 'syrian', 'armenian',
                      'afghan', 'spanish', 'tapas', 'portuguese', 'gyros', 'gyro'],
    'french': ['french', 'crepe', 'crepes', 'creperie', 'patisserie'],
    'barbecue': ['barbecue', 'bbq', 'smokehouse'],
    'steak': ['steak_house', 'steakhouse', 'steak'],
    'chicken': ['chicken', 'fried_chicken', 'wings', 'chicken_wings',
                'rotisserie'],
    'salad': ['salad', 'salads', 'poke', 'hawaiian', 'healthy', 'soup',
              'bowls'],
    'vegetarian': ['vegetarian', 'vegan', 'plant_based'],
    'pub': ['pub', 'gastropub', 'bar_and_grill', 'irish', 'german', 'beer',
            'brewpub', 'tavern'],
}

CUISINE_OF = {token: group
              for group, tokens in CUISINE_TOKENS.items()
              for token in tokens}

_UNGROUPED = sorted(set(CUISINE_TOKENS) - set(CUISINE_ORDER))
assert not _UNGROUPED, f'cuisine tokens name groups CUISINES does not define: {_UNGROUPED}'


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
