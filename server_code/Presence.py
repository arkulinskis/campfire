"""Nobody sits by a fire alone: circles of up to six people around the same fire.

While the fire burns, the browser calls ember_heartbeat every 15-60 s with a random code made fresh for that page
load (nothing else: no account, no IP address, no cookie). The table `embers` keeps {sid, place, seen}; a code
counts as "by a fire" for 3 minutes after its last heartbeat, and rows older than an hour are deleted.

Circles: everyone at the same place (forest / snow / desert) is seated in a circle of at most SEATS people (the
fullest circle with a free seat, else a new one), gets a seat number and an animal name nobody else in that circle
has. Seats fill in FILL order, so two people sit across the fire from each other. The browser draws the others
sitting around its own fire.

Slow sharing, not chat: circle_act records a wave (to everyone or to one seat), a log put on the fire (which wood,
damp or not) or a stir in `circle_news`; the others' browsers pick it up with their next heartbeat (the reply holds
the news since the `since` they send) and play it: the person waves, or throws that log into everyone's fire.
News is deleted after NEWS_KEEP. There is no free text anywhere.
"""
import datetime as dt
import hashlib
import random
import re

import anvil.server
import anvil.tables.query as q
from anvil.tables import app_tables

from . import common as C

PLACES = ("forest", "snow", "desert")
WOODS = {"forest": ("pine", "birch", "maple"), "snow": ("birch", "spruce", "ash"), "desert": ("mesquite", "juniper", "pinon")}
ALIVE = dt.timedelta(minutes=3)
FORGET = dt.timedelta(hours=1)
NEWS_KEEP = dt.timedelta(minutes=10)
OVERLAP = dt.timedelta(seconds=20)   # news is re-sent for this long (the browser skips ids it has seen): nothing slips through
SID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
SEATS = 6
FILL = (0, 3, 1, 4, 2, 5)          # the second person sits across the fire, then the gaps fill in
NAMES = ("Fox", "Heron", "Wren", "Otter", "Lynx", "Owl", "Moth", "Hare", "Raven", "Elk", "Marten", "Loon",
         "Badger", "Finch", "Crane", "Beaver", "Marmot", "Kestrel")
KINDS = ("wave", "log", "stir")


def _look(sid):
    """A number the browser turns into a look (blanket colour, skin, hat). Made from the code, so it never changes
    during a visit, and the code itself is never sent to anyone else."""
    return int(hashlib.sha256(sid.encode("utf-8")).hexdigest()[:6], 16) % 100000


def _ms(t):
    return int(t.timestamp() * 1000)


def _alive_in(circle, now):
    return [r for r in app_tables.embers.search(circle=circle, seen=q.greater_than(now - ALIVE))]


def _join(row, place, now):
    """Seat this visitor in the fullest circle at this place that still has room (or a new circle)."""
    for _ in range(3):   # two people taking the same seat at the same moment: the later one picks again
        circles = {}
        for r in app_tables.embers.search(place=place, seen=q.greater_than(now - ALIVE)):
            if r["sid"] != row["sid"] and r["circle"] and r["seat"] is not None:
                circles.setdefault(r["circle"], {})[int(r["seat"])] = r["name"]
        open_ = [c for c in circles if len(circles[c]) < SEATS]
        if open_:
            cid = max(open_, key=lambda c: (len(circles[c]), c))
            taken = circles[cid]
        else:
            cid, taken = "c-%s-%08x" % (place, random.getrandbits(32)), {}
        seat = next(s for s in FILL if s not in taken)
        free_names = [n for n in NAMES if n not in taken.values()]
        row.update(circle=cid, seat=seat, name=random.choice(free_names), joined=now)
        clash = [r for r in _alive_in(cid, now) if r["sid"] != row["sid"] and r["seat"] == seat]
        if not any((r["joined"] or now, r["sid"]) < (now, row["sid"]) for r in clash):
            return
    row.update(circle=None, seat=None, name=None)   # very busy moment: try again on the next heartbeat


def _circle(row, now, since):
    """What this visitor's browser needs: who sits where, and what happened since `since` (ms)."""
    if not row["circle"]:
        return None
    people = [{"seat": int(r["seat"]), "name": r["name"], "look": _look(r["sid"])}
              for r in _alive_in(row["circle"], now) if r["sid"] != row["sid"] and r["seat"] is not None]
    people.sort(key=lambda p: p["seat"])
    news = []
    if since:
        try:
            after = dt.datetime.fromtimestamp(float(since) / 1000, dt.timezone.utc) - OVERLAP
        except (TypeError, ValueError, OverflowError, OSError):
            after = now - OVERLAP
        after = max(after, now - NEWS_KEEP, row["joined"] or now)   # nothing from before I sat down
        for n in app_tables.circle_news.search(circle=row["circle"], at=q.greater_than_or_equal_to(after)):
            if n["seat"] == row["seat"]:
                continue   # my own news
            news.append({"id": n["nid"], "seat": int(n["seat"]), "kind": n["kind"],
                         "to": None if n["to_seat"] is None else int(n["to_seat"]), "wood": n["wood"] or "",
                         "wet": bool(n["wet"]), "at": _ms(n["at"])})
        news.sort(key=lambda n: n["at"])
    return {"id": row["circle"], "seat": int(row["seat"]), "name": row["name"], "people": people, "news": news[-30:],
            "t": _ms(now)}


@anvil.server.callable
def ember_heartbeat(sid, place, since=None, count=True):
    """Say this visitor is by a fire. Returns how many OTHER visitors are (when `count`), and this visitor's circle:
    {id, seat, name, people: [{seat, name, look}], news: [...], t}. Pass the last reply's `t` as `since`."""
    sid = C.text(sid, 64)
    if not SID.match(sid):
        return C.fail("That isn't a visit code.")
    place = place if place in PLACES else "forest"
    if C.rate_limited("beat", 12, 60):
        return C.fail("Too many heartbeats. Wait a minute.")
    now = C.now()
    row = app_tables.embers.get(sid=sid)
    if row is None:
        row = app_tables.embers.add_row(sid=sid, place=place, seen=now)
        stale = True
    else:
        stale = row["seen"] is None or row["seen"] < now - ALIVE or row["place"] != place
        row.update(place=place, seen=now)
    if stale or not row["circle"]:
        _join(row, place, now)
        since = None   # a new seat: no old news
    out = {"circle": _circle(row, now, since)}
    if count:
        others, same = 0, 0
        for r in app_tables.embers.search(seen=q.greater_than(now - ALIVE)):
            if r["sid"] != sid:
                others += 1
                same += 1 if r["place"] == place else 0
        out.update(others=others, same_place=same)
    if random.random() < 0.1:
        _forget(now)
    return C.ok(**out)


@anvil.server.callable
def circle_act(sid, kind, to=None, wood=None, wet=False):
    """Share something with this visitor's circle: a wave (to everyone, or `to` one seat), a log (`wood` of this place,
    `wet` for a damp branch) or a stir. Nothing else can be sent: there is no text."""
    sid = C.text(sid, 64)
    if not SID.match(sid):
        return C.fail("That isn't a visit code.")
    if kind not in KINDS:
        return C.fail("Only waves, logs and stirring are shared.")
    if C.rate_limited("act", 20, 60):
        return C.fail("Easy now. Give the fire a minute.")
    now = C.now()
    row = app_tables.embers.get(sid=sid)
    if row is None or not row["circle"] or row["seen"] is None or row["seen"] < now - ALIVE:
        return C.fail("You're not sitting in a circle right now.")
    to_seat = None
    if kind == "wave" and to is not None:
        try:
            to_seat = int(to)
        except (TypeError, ValueError):
            return C.fail("Wave to whom?")
        if to_seat not in range(SEATS) or to_seat == row["seat"]:
            return C.fail("Wave to whom?")
    woods = WOODS.get(row["place"], WOODS["forest"])
    if kind == "log" and wood not in woods:
        return C.fail("That wood doesn't grow here.")
    nid = "%x%04x" % (_ms(now), random.getrandbits(16))
    app_tables.circle_news.add_row(circle=row["circle"], nid=nid, seat=row["seat"], kind=kind, to_seat=to_seat,
                                   wood=wood if kind == "log" else None, wet=bool(wet) if kind == "log" else False,
                                   at=now)
    return C.ok(id=nid)


def _forget(now):
    for r in app_tables.embers.search(seen=q.less_than(now - FORGET)):
        r.delete()
    for n in app_tables.circle_news.search(at=q.less_than(now - NEWS_KEEP)):
        n.delete()
