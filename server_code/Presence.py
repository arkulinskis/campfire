"""Nobody sits by a fire alone: "You and 3 others are by a fire right now."

While the fire burns, the browser calls ember_heartbeat once a minute with a random code made fresh for that page
load (nothing else: no account, no IP address, no cookie). The table `embers` keeps {sid, place, seen}; a code
counts as "by a fire" for 3 minutes after its last heartbeat, and rows older than an hour are deleted.
"""
import datetime as dt
import random
import re

import anvil.server
import anvil.tables.query as q
from anvil.tables import app_tables

from . import common as C

PLACES = ("forest", "snow", "desert")
ALIVE = dt.timedelta(minutes=3)
FORGET = dt.timedelta(hours=1)
SID = re.compile(r"^[A-Za-z0-9-]{8,64}$")


@anvil.server.callable
def ember_heartbeat(sid, place):
    """Say this visitor is by a fire; returns how many OTHER visitors are, and how many in the same place."""
    sid = C.text(sid, 64)
    if not SID.match(sid):
        return C.fail("That isn't a visit code.")
    place = place if place in PLACES else "forest"
    if C.rate_limited("beat", 6, 60):
        return C.fail("Too many heartbeats. Wait a minute.")
    now = C.now()
    row = app_tables.embers.get(sid=sid)
    if row is None:
        app_tables.embers.add_row(sid=sid, place=place, seen=now)
    else:
        row.update(place=place, seen=now)
    others, same = 0, 0
    for r in app_tables.embers.search(seen=q.greater_than(now - ALIVE)):
        if r["sid"] != sid:
            others += 1
            same += 1 if r["place"] == place else 0
    if random.random() < 0.1:
        _forget(now)
    return C.ok(others=others, same_place=same)


def _forget(now):
    for r in app_tables.embers.search(seen=q.less_than(now - FORGET)):
        r.delete()
