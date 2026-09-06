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

**2. Better and more broadly accessible filters.** Named alongside coverage as
what the app needs before anyone else could use it.

## Deliberately not next

- **Guessed prices.** Automating them is worth building *only if it can be
  genuinely good*. A confidence-scored guess that is sometimes wrong is worse
  than "See listing", because telling someone a $45 event is free is the worst
  error this app can make. Absent a great design, this stays medium priority.
- **Changing the refresh cadence.** Once a week is right for now. The weekly
  refresh has its own scheduled task and its own skill
  (`.claude/skills/proximi-refresh/SKILL.md`); do not duplicate its job.
