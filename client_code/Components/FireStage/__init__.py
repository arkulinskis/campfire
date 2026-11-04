from anvil import *
import anvil.js
from anvil.js import window

from ._anvil_designer import FireStageTemplate
from ... import fire

_NULL = anvil.js.call(window.Function("return null"))  # None, typed as a JS value (the engine arrives later)


class FireStage(FireStageTemplate):
    """The live campfire. The engine starts when the component is shown and pauses (sound keeps playing) when the
    page goes away; the next page that shows a FireStage picks the same fire up again."""

    def __init__(self, **properties):
        self._place = "forest"
        self._quality = "auto"
        self._engine = _NULL
        self.ok = True
        super().__init__(**properties)

    # ---- properties
    @property
    def place(self):
        return self._place

    @place.setter
    def place(self, value):
        self._place = value if value in fire.PLACE_NAMES else "forest"
        if self._engine is not None and str(self._engine.place) != self._place:
            self._engine.setPlace(self._place)

    @property
    def quality(self):
        return self._quality

    @quality.setter
    def quality(self, value):
        self._quality = value or "auto"
        if self._engine is not None:
            self._engine.setQuality(self._quality)

    # ---- life
    @handle("", "show")
    def form_show(self, **event_args):
        if self._engine is None:
            if not fire.available():
                self.ok = False
                self.raise_event("fire_event", name="unavailable", data="scripts")
                return
            self._engine = fire.start(anvil.js.get_dom_node(self.box), self._place, self._quality,
                                      self._on_state, self._on_event)
            if not self._engine.ok:
                self.ok = False
                self.raise_event("fire_event", name="unavailable", data=str(self._engine.reason))
                return
            if str(self._engine.place) != self._place:
                self._engine.setPlace(self._place)
        else:
            self._engine.pause(False)

    @handle("", "hide")
    def form_hide(self, **event_args):
        if self._engine is not None and self.ok:
            self._engine.pause(True)

    def _on_state(self, st):
        self.raise_event("state_change", state=st)

    def _on_event(self, name, data):
        self.raise_event("fire_event", name=name, data=data)

    # ---- actions (all safe to call before the engine exists: they do nothing)
    def _ready(self):
        return self._engine is not None and self.ok

    def light(self):
        if self._ready():
            self._engine.light()

    def add_log(self, key, wet=False):
        return bool(self._engine.addLog(key, bool(wet))) if self._ready() else False

    def stir(self):
        if self._ready():
            self._engine.stir()

    def set_wind(self, level):
        if self._ready():
            self._engine.setWind(int(level))

    def set_volume(self, which, value):
        if self._ready():
            self._engine.setVolume(which, float(value))

    def set_auto_tend(self, on):
        if self._ready():
            self._engine.setAutoTend(bool(on))

    def set_sleep(self, minutes):
        if self._ready():
            self._engine.setSleep(int(minutes))

    def sound(self, on):
        if self._ready():
            self._engine.sound(bool(on))

    def look(self, amount):
        if self._ready():
            self._engine.look(float(amount))

    def state(self):
        return fire.state(self._engine) if self._ready() else {"ok": False, "lit": False}

    def is_lit(self):
        return bool(self._ready() and self._engine.lit)
