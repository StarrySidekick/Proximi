# Intent

What this is for, and what to build next. Recorded **2026-09-06** from Timothy's
own answers to a direct set of questions, so this is *stated* intent rather than
intent inferred from the code.

**Read this before choosing what to build.** Where it disagrees with the rest of
the docs about **direction**, this file is newer and wins. Where it disagrees
about **mechanics** — how the code works, what was decided deliberately, the
invariants — the other docs win, always.

When something here is done, or turns out to be wrong, **edit it**. A stale
intent file is worse than no intent file.

## What it is for

For Timothy first, and then **for everyone in New England**.

That second half is new and it changes things. A filter sheet built for one
person who already knows the Hudson Valley is not the same product as one that
has to work for someone in a town it has never heard of.

## What is next

**1. Coverage, in this order.** All of Connecticut and New York first, then
Massachusetts, New Hampshire, Rhode Island and Vermont, then Maine. This is the
through-line for the project.

**Places jumped the queue, 2026-09-09.** A drive from Bar Harbor to Hartford
turned coverage from one circle into a list of them: `placesRegions` in the
registry, seven of them chained end to end down the Maine coast, through the
New Hampshire seacoast and the North Shore, across central Massachusetts to
Hartford, meeting the Hudson Valley circle. The directory now reaches all six
New England states in the corridor. The mechanism is general — adding a region
is four numbers — so the rest of the coverage plan is now a registry edit
rather than a rewrite.

**Events did not move, and that is the gap.** They still come from the
Hudson Valley source list inside 100 miles of Beacon, so somebody standing in
Bar Harbor gets places and nothing on. Closing it means source discovery for
each new area (`discover.py --overpass --probe`, roughly 7% of venue domains
expose a feed) plus Ticketmaster and Eventbrite sweeps anchored on the new
regions. That is the next real piece of work on coverage.

**2. Better and more broadly accessible filters.** Named alongside coverage as
what the app needs before anyone else could use it.

**First piece done 2026-09-06: the location presets are derived from the
listings** rather than being eight hand-picked Hudson Valley towns. The data had
already outgrown them — the three largest clusters in the file are New York,
Brooklyn and New York (NYC), 808 listings between them, and not one was offered,
nor was anywhere in Connecticut. They now come from where the listings actually
are, so the row widens by itself as coverage moves into the rest of New England
instead of needing editing each time.

**Second piece, 2026-09-09: somewhere to eat, and what kind of food it is.**
`restaurant` and `cafe` had no tag rules at all — a restaurant reached the
directory only by hosting an event — so the Places page could not answer the
question a person actually has at seven on a Tuesday a long way from home. They
are collected now, into their own file, behind a Places scope, with a cuisine
filter over 27 groups read off the tags, an Open-now filter that refuses to
guess, and an Independents-only toggle. The "Kind of place" select turned out
never to have been wired to anything, which is fixed.

**Still to do here:** an honest answer for a reader outside the covered area.
Today someone in Boston gets an empty *events* list rather than being told the
app does not reach them yet, which is the same class of problem the presets had.
The presets themselves now offer the nearest coverage areas, so the location
sheet at least says where the app does reach.

**And the one this trip exposed: the app does not work offline.** There is no
service worker, so a PWA installed on a phone is a blank page in a valley with
no signal — which is exactly where a directory of what is around you is worth
most. Both data files are static and small enough to cache whole.

**3. A driving buddy, 2026-09-28.** From the Maine trip, in Timothy's words:
places "only a short detour from your drive" that would be interesting to stop
at, which "just needs to kind of show up based on a predetermined set of
settings" because a driver cannot be tapping. It is built as `drive.html`:
spoken suggestions with the detour in minutes, settings for what counts and how
far out of the way. Web first, on purpose, to learn what it should do before
deciding whether it earns a native iPhone app. The native app is what would let
it talk over Google Maps and run with the screen off (MapKit, Core Location in
the background); the web page cannot.

**Next on it**, roughly in order: opening hours, so it stops suggesting closed
museums; pulling places live along the route (Overpass, Wikipedia's geosearch)
so it works outside the coverage circles and can say *why* a place is worth it;
and the service worker from the offline item above, which a car in a dead zone
needs more than anyone.

## Deliberately not next

- **Guessed prices.** Automating them is worth building *only if it can be
  genuinely good*. A confidence-scored guess that is sometimes wrong is worse
  than "See listing", because telling someone a $45 event is free is the worst
  error this app can make. Absent a great design, this stays medium priority.
- **Changing the refresh cadence.** Once a week is right for now. The weekly
  refresh has its own scheduled task and its own skill
  (`.claude/skills/proximi-refresh/SKILL.md`); do not duplicate its job.
