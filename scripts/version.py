#!/usr/bin/env python3
"""Stamp the build number the site displays.

Pushing is the deploy here — GitHub Pages serves the branch directly — so the
number people see should count pushes, and the closest honest proxy is the
commit count. Run this immediately before committing: the commit about to be
made is counted, so the number in the file matches the commit that carries it.

  python3 scripts/version.py [--out data/version.json]
"""

import argparse, json, os, subprocess, sys
from datetime import datetime, timezone


def is_shallow():
    try:
        out = subprocess.run(['git', 'rev-parse', '--is-shallow-repository'],
                             capture_output=True, text=True, timeout=10)
        return out.stdout.strip() == 'true'
    except (OSError, subprocess.SubprocessError):
        return False


def commit_count():
    try:
        out = subprocess.run(['git', 'rev-list', '--count', 'HEAD'],
                             capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip()) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def previous_build(path):
    """The build number already on disk, if there is one."""
    try:
        return int(json.load(open(path)).get('build'))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/version.json')
    args = ap.parse_args()

    n = commit_count()
    if n is None:
        print('version: no git history reachable — leaving the file alone', file=sys.stderr)
        return 0

    # +1 because the commit that ships this file has not been made yet.
    build = n + 1

    # The commit count is only an honest proxy for "how many pushes" when the
    # clone has all of them. A shallow clone counts what it was given: this
    # ran in one with --depth 74 behind a v91 site and produced v75, happily,
    # with a zero exit — a build number walking backwards, which is the one
    # thing a build number must never do. The site reads this file to know
    # whether it is out of date, so going back makes every client think it
    # already has the newest version. Refuse, and say the fix.
    # Equal is fine — running this twice before one commit should be a no-op,
    # not a failure. Only going backwards is the bug.
    before = previous_build(args.out)
    if before is not None and build < before:
        print(f'version: computed v{build} but the file already says v{before}. '
              f'{"The clone is shallow — run: git fetch --unshallow" if is_shallow() else "Is HEAD behind origin?"}',
              file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'build': build, 'label': f'v{build}',
               'builtAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')},
              open(args.out, 'w'), indent=2)
    open(args.out, 'a').write('\n')
    print(f'version: v{build} → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
