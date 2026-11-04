from anvil import *

from ._anvil_designer import SettingsTemplate
from ... import state

DEFAULTS = {"fire": 0.9, "night": 0.7, "wind": 1, "quality": "auto", "tend": False}


def load():
    """The visitor's saved settings (this browser only)."""
    saved = state.store_get("settings", {}) or {}
    return dict(DEFAULTS, **{k: v for k, v in dict(saved).items() if k in DEFAULTS})


def apply(stage, s):
    stage.set_volume("fire", s["fire"])
    stage.set_volume("night", s["night"])
    stage.set_wind(s["wind"])
    stage.set_auto_tend(s["tend"])
    if stage.quality != s["quality"]:
        stage.quality = s["quality"]


class Settings(SettingsTemplate):
    """Sound, wind, the sleep timer, auto-tending and picture quality. Every change applies at once and is saved in
    this browser. Shown with alert(Settings(stage=...), buttons=[], role="app-dialog")."""

    def __init__(self, stage, **properties):
        self.stage = stage
        self.s = load()
        super().__init__(**properties)
        self.dom_nodes["fire_vol"].value = str(int(self.s["fire"] * 100))
        self.dom_nodes["night_vol"].value = str(int(self.s["night"] * 100))
        self.tend_box.checked = bool(self.s["tend"])
        self.sleep_left = int(stage.state().get("sleepLeft") or 0)
        self._draw()

    def _draw(self):
        for v, el in ((0, self.wind_0), (1, self.wind_1), (2, self.wind_2)):
            el.classes["on"] = self.s["wind"] == v
        for v, el in (("auto", self.q_auto), ("high", self.q_high), ("medium", self.q_medium), ("low", self.q_low)):
            el.classes["on"] = self.s["quality"] == v
        left = self.sleep_left
        pick = 0 if not left else min((20, 45, 90), key=lambda m: abs(m - left))
        for v, el in ((0, self.sleep_0), (20, self.sleep_20), (45, self.sleep_45), (90, self.sleep_90)):
            el.classes["on"] = pick == v
        q = self.stage.state().get("quality") or "medium"
        self.quality_note.text = "Now drawing at %s quality. Lighter pictures save battery." % {
            "high": "the finest", "medium": "balanced", "low": "light"}.get(q, q)

    def _save(self):
        state.store_set("settings", self.s)

    def vol_input(self, event):
        which = event.currentTarget.getAttribute("data-which")
        v = max(0, min(100, int(float(event.currentTarget.value)))) / 100.0
        self.s[which] = v
        self.stage.set_volume(which, v)
        self._save()

    def wind_click(self, event):
        self.s["wind"] = int(event.currentTarget.getAttribute("data-v"))
        self.stage.set_wind(self.s["wind"])
        self._save()
        self._draw()

    def sleep_click(self, event):
        minutes = int(event.currentTarget.getAttribute("data-v"))
        self.sleep_left = minutes
        self.stage.set_sleep(minutes)
        if minutes:
            self.s["tend"] = False
            self.tend_box.checked = False
            self.stage.set_auto_tend(False)
            self._save()
            state.toast("Sleep well. The fire will burn down over %d minutes." % minutes)
        self._draw()

    def quality_click(self, event):
        self.s["quality"] = event.currentTarget.getAttribute("data-v")
        self.stage.quality = self.s["quality"]
        self._save()
        self._draw()

    @handle("tend_box", "change")
    def tend_box_change(self, **event_args):
        self.s["tend"] = bool(self.tend_box.checked)
        self.stage.set_auto_tend(self.s["tend"])
        self._save()

    @handle("close_button", "click")
    def close_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=None)

    @handle("done_button", "click")
    def done_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=None)

    def links_click(self, event):
        """A link in the footer (how it works, feedback, Privacy & Terms) closes the dialog so the page behind can open."""
        if event.target.closest("a, button"):
            self.raise_event("x-close-alert", value=None)
