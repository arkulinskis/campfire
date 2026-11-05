"""Server tests against the strict mock of Anvil (tools/testing/mock).

    python tools/testing/test_server.py          -> prints ALL OK, or the first failure

call(name, ...) runs a server function the way the browser does: by name, with require_user enforced,
and the reply must be JSON (a datetime or a row in a reply fails here, like it would break the page).
Add tests for every new server function: the happy path, bad input, and someone who isn't allowed.
"""
import datetime as dt
import importlib
import json
import os
import pathlib
import shutil
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
_tmp = pathlib.Path(tempfile.mkdtemp())
shutil.copytree(PROJECT / "server_code", _tmp / "app")
(_tmp / "app" / "__init__.py").write_text("")
os.environ["ANVIL_APP_YAML"] = str(PROJECT / "anvil.yaml")  # the mock's tables follow the app's own schema
sys.path[:0] = [str(HERE / "mock"), str(_tmp)]
import anvil.server  # noqa: E402
import anvil.users  # noqa: E402
from anvil.tables import app_tables as T  # noqa: E402

M = {p.stem: importlib.import_module("app." + p.stem) for p in sorted((PROJECT / "server_code").glob("*.py"))}
now = dt.datetime.now(dt.timezone.utc)


def call(name, *args):
    r = anvil.server.call(name, *args)
    json.dumps(r)  # strict: must be JSON-able
    return r


def as_user(row):
    anvil.users.CURRENT[0] = row
    anvil.server.session.use(row.get_id() if row is not None else None)


def denied(name, *args):
    try:
        call(name, *args)
    except anvil.server.PermissionDenied:
        return True
    return False


def ok(r, msg=""):
    assert isinstance(r, dict) and r.get("ok"), (msg, r)
    return r


def bad(r, msg=""):
    assert isinstance(r, dict) and r.get("ok") is False and r.get("error"), (msg, r)
    return r


# ---------------------------------------------------------------------------------- presence ("others by a fire")
def visit(sid):
    anvil.server.session.use(sid)  # every visitor is their own browser session


visit("a")
r = ok(call("ember_heartbeat", "aaaaaaaa-1111", "forest"))
assert r["others"] == 0 and r["same_place"] == 0, r
visit("b")
r = ok(call("ember_heartbeat", "bbbbbbbb-2222", "snow"))
assert r["others"] == 1 and r["same_place"] == 0, r
visit("c")
r = ok(call("ember_heartbeat", "cccccccc-3333", "snow"))
assert r["others"] == 2 and r["same_place"] == 1, r
visit("a")
r = ok(call("ember_heartbeat", "aaaaaaaa-1111", "snow"))   # same visitor again: updated, not added
assert r["others"] == 2 and r["same_place"] == 2, r
assert len(list(T.embers.search())) == 3
assert T.embers.get(sid="aaaaaaaa-1111")["place"] == "snow"
# an unknown place becomes the forest; codes must look like codes
visit("d")
ok(call("ember_heartbeat", "dddddddd-4444", "moon"))
assert T.embers.get(sid="dddddddd-4444")["place"] == "forest"
bad(call("ember_heartbeat", "x", "forest"), "too short")
bad(call("ember_heartbeat", "<script>alert(1)</script>", "forest"), "not a code")
bad(call("ember_heartbeat", None, "forest"), "missing")
# old visitors stop counting after 3 minutes and are forgotten after an hour
T.embers.get(sid="bbbbbbbb-2222")["seen"] = now - dt.timedelta(minutes=5)
T.embers.get(sid="cccccccc-3333")["seen"] = now - dt.timedelta(hours=2)
visit("e")
r = ok(call("ember_heartbeat", "eeeeeeee-5555", "forest"))
assert r["others"] == 2, r   # a and d only
M["Presence"]._forget(M["common"].now())
assert T.embers.get(sid="cccccccc-3333") is None and T.embers.get(sid="bbbbbbbb-2222") is not None
# one browser can't flood the table
visit("flood")
results = [call("ember_heartbeat", "ffffffff-%04d" % i, "forest") for i in range(14)]
assert any(isinstance(x, dict) and x.get("ok") is False for x in results), "heartbeats are rate limited"

# ---------------------------------------------------------------------------------- circles of six around one fire
for r in list(T.embers.search()):
    r.delete()
P = M["Presence"]


def beat(sid, place="desert", since=None, count=True):
    visit("s-" + sid)
    return ok(call("ember_heartbeat", "%s-0000-circle" % sid, place, since, count))


first = beat("p01")["circle"]
assert first["seat"] == 0 and first["people"] == [] and first["name"] in P.NAMES and first["news"] == [], first
second = beat("p02")["circle"]
assert second["id"] == first["id"] and second["seat"] == 3, "the second person sits across the fire: %r" % second
assert [p["seat"] for p in second["people"]] == [0] and second["people"][0]["name"] == first["name"]
assert "sid" not in json.dumps(second) and "p01-0000" not in json.dumps(second), "visit codes never reach others"
assert isinstance(second["people"][0]["look"], int)
seats = [beat("p%02d" % i)["circle"]["seat"] for i in range(3, 7)]
assert seats == [1, 4, 2, 5], seats
full = beat("p06")["circle"]
assert len(full["people"]) == 5 and full["id"] == first["id"]
names = [p["name"] for p in full["people"]] + [full["name"]]
assert len(set(names)) == 6, "names are unique in a circle: %r" % names
seventh = beat("p07")["circle"]
assert seventh["id"] != first["id"] and seventh["seat"] == 0 and seventh["people"] == [], "a full circle: the 7th starts a new one"
eighth = beat("p08")["circle"]
assert eighth["id"] == seventh["id"] and eighth["seat"] == 3
# hundreds: never more than six in a circle
for i in range(9, 40):
    beat("q%02d" % i, "snow", count=False)
sizes = {}
for r in T.embers.search(place="snow"):
    sizes[r["circle"]] = sizes.get(r["circle"], 0) + 1
assert max(sizes.values()) <= 6 and sum(sizes.values()) == 31 and len(sizes) == 6, sizes
for c in sizes:
    seats_in = [r["seat"] for r in T.embers.search(circle=c)]
    assert len(set(seats_in)) == len(seats_in), "one person per seat"
r = beat("q09", "snow", count=False)
assert "others" not in r, "count=False skips the expensive count"
# another place = another circle
moved = beat("p02", "forest")["circle"]
assert moved["id"] != first["id"] and moved["people"] == []
back = beat("p02", "desert")["circle"]
assert back["id"] == first["id"] and back["seat"] == 3, "the free seat across the fire again: %r" % back

# ---------------------------------------------------------------------------------- slow sharing: waves, logs, stirs
t0 = beat("p01")["circle"]["t"]
visit("s-p03")
ok(call("circle_act", "p03-0000-circle", "wave"))                       # to everyone
ok(call("circle_act", "p03-0000-circle", "wave", 0))                    # to seat 0
ok(call("circle_act", "p03-0000-circle", "log", None, "juniper", False))
ok(call("circle_act", "p03-0000-circle", "log", None, "mesquite", True))
ok(call("circle_act", "p03-0000-circle", "stir"))
bad(call("circle_act", "p03-0000-circle", "say", None, None), "only waves, logs, stirs")
bad(call("circle_act", "p03-0000-circle", "log", None, "birch"), "birch doesn't grow in the desert")
bad(call("circle_act", "p03-0000-circle", "wave", 9), "no seat 9")
bad(call("circle_act", "p03-0000-circle", "wave", "<b>"), "seat must be a number")
bad(call("circle_act", "p03-0000-circle", "wave", 1), "can't wave to yourself (p03 sits in seat 1)")
bad(call("circle_act", "zzzzzzzz-nobody", "wave"), "not in a circle")
bad(call("circle_act", "x", "wave"), "not a code")
news = beat("p01", since=t0)["circle"]["news"]
kinds = [(n["kind"], n["seat"], n["to"], n["wood"], n["wet"]) for n in news]
assert kinds == [("wave", 1, None, "", False), ("wave", 1, 0, "", False), ("log", 1, None, "juniper", False),
                 ("log", 1, None, "mesquite", True), ("stir", 1, None, "", False)], kinds
assert len({n["id"] for n in news}) == 5
mine = beat("p03", since=t0)["circle"]["news"]
assert mine == [], "your own news doesn't come back to you"
other_circle = beat("p07", since=t0)["circle"]["news"]
assert other_circle == [], "news stays in its circle"
newcomer = beat("p09-new", since=None)["circle"]
assert newcomer["news"] == [], "a newcomer gets no old news"
# acts are rate limited
visit("s-p04")
spam = [call("circle_act", "p04-0000-circle", "stir") for _ in range(25)]
assert any(x.get("ok") is False for x in spam), "acts are rate limited"
# someone who left: gone from the circle after 3 minutes, and their seat is free again
T.embers.get(sid="p04-0000-circle")["seen"] = now - dt.timedelta(minutes=4)
left = beat("p01", count=False)["circle"]
assert all(p["seat"] != 4 for p in left["people"]), left["people"]
again = beat("p10", count=False)["circle"]
assert again["id"] == first["id"] and again["seat"] == 4, again
# old news is deleted after ten minutes
for n in T.circle_news.search():
    n["at"] = now - dt.timedelta(minutes=11)
P._forget(M["common"].now())
assert len(list(T.circle_news.search())) == 0

# ---------------------------------------------------------------------------------- Privacy & Terms (no accounts: nobody to record)
if "legal_server" in M:
    as_user(None)
    st = call("legal_state")
    assert st["signedIn"] is False and st["version"]
    bad(call("legal_accept", st["version"], "page"), "nobody is signed in")

# ---------------------------------------------------------------------------------- schema check (App Board): names only, never data
r = anvil.server.ENDPOINTS["/schema-check"](tables="embers,no_such_table")
json.dumps(r)
assert "sid" in r["tables"]["embers"] and r["tables"]["no_such_table"] is None, r

# ---------------------------------------------------------------------------------- every callable is public on purpose
# Campfire has no accounts. Every callable must be listed here, so a new one gets a second look.
PUBLIC = {"ember_heartbeat", "circle_act", "legal_state", "legal_accept"}
for name in sorted(anvil.server.CALLABLES):
    assert name in PUBLIC, "%s is a new public callable: check its input and add it to PUBLIC in test_server.py" % name

print("ALL OK (%d server functions)" % len(anvil.server.CALLABLES))
