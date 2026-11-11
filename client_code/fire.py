"""The one Python door to the fire engine (theme/assets/cf-*.js, window.CF).

The engine is a JavaScript program (GPU fluid simulation, three.js scene, Web Audio): Python only starts it, sends it
the visitor's choices and reads its state. There is ONE fire per page load (CF.shared): it keeps burning, and
crackling, while the About page is open, and the fire page picks it up again.

    engine = fire.start(dom_node, place, quality, on_state, on_event)   on_state(dict) every second; on_event(name, data)
    fire.state(engine) -> dict      fire.woods(place) -> the place's three woods
"""
import json

import anvil.js
from anvil.js import window

PLACES = [
    {"key": "forest", "name": "Boreal midnight",
     "line": "Spruce and pine, a canvas tent, a brook, crickets and owls, mist in the trees. No moon: the Milky Way is yours."},
    {"key": "snow", "name": "Lakeshore, first snow",
     "line": "A frozen lake under a full moon, birches, the ice singing, wolves far off. Snow comes and goes. Some nights, the northern lights."},
    {"key": "desert", "name": "Desert canyon",
     "line": "Sandstone walls, a dead juniper, coyotes echoing off the rock, lightning far beyond the rim. Still air and the darkest sky."},
]
PLACE_NAMES = {p["key"]: p["name"] for p in PLACES}


def available():
    """False when the browser can't run the engine at all (scripts blocked)."""
    return bool(window.get("CF")) and bool(window.CF.get("shared"))


def to_py(js_value):
    """A JS object/array -> plain Python (one JSON round trip: cheaper than walking a proxy in Skulpt)."""
    return json.loads(window.JSON.stringify(js_value))


def start(node, place, quality, on_state, on_event):
    def _state(js_state):
        on_state(to_py(js_state))

    def _event(name, data=None):
        on_event(str(name), data if isinstance(data, (str, int, float)) or data is None else str(data))

    opts = window.JSON.parse(json.dumps({"place": place, "quality": quality}))
    opts.onState = anvil.js.report_exceptions(_state)
    opts.onEvent = anvil.js.report_exceptions(_event)
    return window.CF.shared(node, opts)


def state(engine):
    return to_py(engine.state())


def is_shared_lit():
    """Was the fire already lit on this page load (back from the About page)?"""
    sh = window.CF.get("_shared") if window.get("CF") else None
    return bool(sh and sh.ok and sh.lit)
