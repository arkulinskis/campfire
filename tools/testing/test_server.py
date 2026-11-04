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
results = [call("ember_heartbeat", "ffffffff-%04d" % i, "forest") for i in range(8)]
assert any(isinstance(x, dict) and x.get("ok") is False for x in results), "heartbeats are rate limited"

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
PUBLIC = {"ember_heartbeat", "legal_state", "legal_accept"}
for name in sorted(anvil.server.CALLABLES):
    assert name in PUBLIC, "%s is a new public callable: check its input and add it to PUBLIC in test_server.py" % name

print("ALL OK (%d server functions)" % len(anvil.server.CALLABLES))
