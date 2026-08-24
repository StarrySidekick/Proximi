"""Minimal iCalendar reader.

Only what event feeds actually use — no RRULE expansion, no VALARM, no
attendees. Feeds in the wild are frequently malformed, so every field is
optional and a bad VEVENT is skipped rather than raising.
"""

import re
from datetime import datetime, date, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:                                    # pragma: no cover
    ZoneInfo = None


def unfold(text):
    """RFC 5545 folds long lines by starting the continuation with a space."""
    return re.sub(r'\r?\n[ \t]', '', text.replace('\r\n', '\n'))


def unescape(v):
    out, i = [], 0
    while i < len(v):
        if v[i] == '\\' and i + 1 < len(v):
            nxt = v[i + 1]
            out.append({'n': '\n', 'N': '\n', ',': ',', ';': ';', '\\': '\\'}.get(nxt, nxt))
            i += 2
        else:
            out.append(v[i])
            i += 1
    return ''.join(out)


def parse_dt(value, params):
    """Return (datetime, is_all_day). Naive local times are attached to TZID."""
    tzid = params.get('TZID')
    value = value.strip()

    if params.get('VALUE') == 'DATE' or re.fullmatch(r'\d{8}', value):
        d = datetime.strptime(value[:8], '%Y%m%d')
        if tzid and ZoneInfo:
            try:
                d = d.replace(tzinfo=ZoneInfo(tzid))
            except Exception:
                pass
        return d, True

    m = re.fullmatch(r'(\d{8}T\d{6})(Z)?', value)
    if not m:
        return None, False
    d = datetime.strptime(m.group(1), '%Y%m%dT%H%M%S')

    if m.group(2):                      # trailing Z means UTC
        return d.replace(tzinfo=timezone.utc), False
    if tzid and ZoneInfo:
        try:
            return d.replace(tzinfo=ZoneInfo(tzid)), False
        except Exception:
            pass
    return d, False                     # floating: caller applies a default zone


def parse(text, default_tz='America/New_York'):
    """Yield dicts for each VEVENT in an iCalendar document."""
    events, cur = [], None
    zone = ZoneInfo(default_tz) if ZoneInfo else None

    for line in unfold(text).split('\n'):
        line = line.rstrip()
        if line == 'BEGIN:VEVENT':
            cur = {}
            continue
        if line == 'END:VEVENT':
            if cur is not None and cur.get('start') and cur.get('summary'):
                events.append(cur)
            cur = None
            continue
        if cur is None or ':' not in line:
            continue

        head, _, value = line.partition(':')
        bits = head.split(';')
        name = bits[0].upper()
        params = {}
        for b in bits[1:]:
            k, _, v = b.partition('=')
            params[k.upper()] = v.strip('"')

        if name == 'SUMMARY':
            cur['summary'] = unescape(value).strip()
        elif name == 'DESCRIPTION':
            cur['description'] = unescape(value).strip()
        elif name == 'LOCATION':
            cur['location'] = unescape(value).strip()
        elif name == 'URL':
            cur['url'] = value.strip()
        elif name == 'ORGANIZER':
            # "CN=Some Org:mailto:…" — the common name is the useful half.
            cur['organizer'] = (params.get('CN') or '').strip() or None
        elif name == 'UID':
            cur['uid'] = value.strip()
        elif name == 'CATEGORIES':
            cur['categories'] = [c.strip() for c in unescape(value).split(',') if c.strip()]
        elif name == 'RRULE':
            cur['rrule'] = value.strip()
        elif name in ('DTSTART', 'DTEND'):
            dt, allday = parse_dt(value, params)
            if dt is None:
                continue
            if dt.tzinfo is None and zone:
                dt = dt.replace(tzinfo=zone)
            cur['start' if name == 'DTSTART' else 'end'] = dt
            if name == 'DTSTART':
                cur['all_day'] = allday

    return events


def future_only(events, now=None, grace_hours=0):
    """Keep events that have not finished yet.

    An all-day entry counts as running to the end of its day, so today's
    all-day listings are not dropped at 00:01.
    """
    now = now or datetime.now(timezone.utc)
    keep = []
    for e in events:
        end = e.get('end') or e['start']
        if e.get('all_day') and not e.get('end'):
            end = end + timedelta(days=1)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if end >= now - timedelta(hours=grace_hours):
            keep.append(e)
    return keep
