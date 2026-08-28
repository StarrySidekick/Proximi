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


def commit_count():
    try:
        out = subprocess.run(['git', 'rev-list', '--count', 'HEAD'],
                             capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip()) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
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
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    json.dump({'build': build, 'label': f'v{build}',
               'builtAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')},
              open(args.out, 'w'), indent=2)
    open(args.out, 'a').write('\n')
    print(f'version: v{build} → {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
