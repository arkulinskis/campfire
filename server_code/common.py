"""Shared server helpers: time, input cleaning, rate limits.

Every other server module imports this as `from . import common as C`.
Campfire has no accounts, so every callable is public: check the input, never trust it, return JSON-friendly values
(dicts, lists, str, numbers, bools, None); expected problems return C.fail("Message the user can read").
"""
import datetime as dt
import re
import typing

import anvil.server


def now():
    return dt.datetime.now(dt.timezone.utc)


def iso(v):
    """date/datetime -> ISO string (datetimes in UTC), anything else unchanged."""
    if isinstance(v, dt.datetime):
        if v.tzinfo is None:
            v = v.replace(tzinfo=dt.timezone.utc)
        return v.astimezone(dt.timezone.utc).isoformat()
    if isinstance(v, dt.date):
        return v.isoformat()
    return v


def fail(message):
    return {"ok": False, "error": message}


def ok(**data):
    data["ok"] = True
    return data


def text(value, limit=200):
    """Clean user text: str, trimmed, single-line, length-capped."""
    s = "" if value is None else str(value)
    return re.sub(r"\s+", " ", s).strip()[:limit]


def rate_limited(key, limit, seconds):
    """True if this browser session already did `key` `limit` times in the last `seconds`."""
    stamp = now()
    store = "rate_" + key
    recent = [t for t in (anvil.server.session.get(store) or [])
              if (stamp - dt.datetime.fromisoformat(t)).total_seconds() < seconds]
    if len(recent) >= limit:
        return True
    typing.cast(dict, anvil.server.session)[store] = recent + [stamp.isoformat()]
    return False
