from anvil import *
import anvil.js
import anvil.server
from anvil.js import window

from ._anvil_designer import FireTemplate
from ... import fire, state
from ...Dialogs import Settings as settings_mod
from ...Dialogs.Places import Places
from ...Dialogs.Settings import Settings

IDLE_MS = 4500          # the controls fade away when you sit still this long
BEAT_MS = 60000         # "others by a fire" refresh
DAMP = {"label": "Damp branch", "note": "hisses, steams and smokes before it catches"}


def status_text(st):
    """One quiet line about how the fire is doing."""
    if not st.get("lit"):
        return ""
    p, coals, logs, burning = st.get("power", 0), st.get("coals", 0), st.get("logs", 0), st.get("burning", 0)
    mins = st.get("minutes", 0)
    tail = (" · %s by the fire" % state.plural(mins, "minute")) if mins else ""
    if st.get("sleepLeft"):
        return "Burning down. Sleep well." + tail
    if p < 0.05 and coals < 0.08:
        return "The fire has gone out. Strike a match to start again."
    if p < 0.12:
        return ("Down to glowing coals. A log would still catch." if coals > 0.15 else "Nearly out. Add a log soon.") + tail
    if logs > burning:
        return "A new log is catching." + tail
    if p > 1.1:
        return "Burning well." + tail
    if p > 0.45:
        return "A steady fire." + tail
    return "Burning low. It could use another log." + tail


_DOC = anvil.js.call(window.Function("return document"))  # the document, typed as a plain JS value


def _html():
    """The <html> element (always there)."""
    return _DOC.documentElement


def _dialog_open():
    """A dialog or the Privacy & Terms page is showing (Anvil keeps closed dialogs in the page, so look for a visible one)."""
    for el in _DOC.querySelectorAll(".anvil-modal"):
        if el.getBoundingClientRect().width > 0:
            return True
    kit = window.get("LegalKit")
    return bool(kit and kit.get("isOpen") and kit.isOpen())


def presence_text(others):
    if others is None:
        return ""
    if others == 0:
        return "Nobody else is by a fire right now. It is all yours."
    return "You and %s are by a fire right now." % state.plural(others, "other")


class Fire(FireTemplate):
    """The campfire: you arrive in the dark beside a laid fire, strike a match, then tend it (woods, stir), change the
    place, the sound, the wind, or set it to burn down while you fall asleep. The controls fade away when you sit
    still. Keys: L log, S stir, M sound, F full screen, P place."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
        place = state.store_get("place", "forest")
        self.place = place if place in fire.PLACE_NAMES else "forest"
        self.settings = settings_mod.load()
        self.stage.quality = self.settings["quality"]
        self.stage.place = self.place
        self.sid = self._new_sid()
        self.others = None
        self.beat_at = 0
        self.woods_for = None
        self.applied = False
        self.sound_on = True
        self.last_move = 0
        self.idle_timer = None
        self.fallback.visible = False
        self._show_place()
        self._show_lit(fire.available() and fire.is_shared_lit())
        self.wood_panel.add_event_handler("x-add", self._add)
        self.relight_button.visible = False
        state.live(self.status_label)
        self._move = anvil.js.report_exceptions(self._on_move)
        self._keys = anvil.js.report_exceptions(self._on_key)
        self._idle = anvil.js.report_exceptions(self._go_idle)

    @staticmethod
    def _new_sid():
        try:
            return str(window.crypto.randomUUID())
        except Exception:
            return "s-%d-%d" % (int(window.Date.now()), int(window.Math.random() * 1e9))

    # ---- page life
    @handle("", "show")
    def form_show(self, **event_args):
        for ev in ("pointermove", "pointerdown", "touchstart"):
            window.document.addEventListener(ev, self._move, {"passive": True})
        window.document.addEventListener("keydown", self._keys)
        self._wake()

    @handle("", "hide")
    def form_hide(self, **event_args):
        for ev in ("pointermove", "pointerdown", "touchstart"):
            window.document.removeEventListener(ev, self._move)
        window.document.removeEventListener("keydown", self._keys)
        if self.idle_timer is not None:
            window.clearTimeout(self.idle_timer)
        _html().classList.remove("cf-idle")

    # ---- the engine talks back
    @handle("stage", "state_change")
    def stage_state_change(self, **event_args):
        st = event_args.get("state") or {}
        if not self.applied:   # the engine is running: give it the saved settings once
            self.applied = True
            settings_mod.apply(self.stage, self.settings)
        if st.get("place") and st["place"] != self.woods_for:
            self.woods_for = st["place"]
            woods = st.get("woods") or []
            self.wood_panel.items = woods + ([dict(DAMP, key=woods[0]["key"], wet=True)] if woods else [])
        self.status_label.text = status_text(st)
        dead = bool(st.get("lit")) and st.get("power", 0) < 0.05 and st.get("coals", 0) < 0.08
        self.relight_button.visible = dead
        self.stir_button.visible = not dead
        now = window.Date.now()
        if st.get("lit") and now - self.beat_at > BEAT_MS:
            self.beat_at = now
            self._heartbeat()

    @handle("stage", "fire_event")
    def stage_fire_event(self, **event_args):
        name = event_args.get("name")
        if name == "unavailable":
            self.fallback.visible = True
            self.intro.visible = False
            self.hud.visible = False
        elif name == "slept":
            state.toast("Goodnight. The fire has burned down.")

    def _heartbeat(self):
        r = state.call_quiet("ember_heartbeat", self.sid, self.place)
        if isinstance(r, dict) and r.get("ok"):
            self.others = int(r.get("others") or 0)
            self.presence_label.text = presence_text(self.others)

    # ---- lighting
    def _show_lit(self, lit):
        self.intro.visible = not lit
        self.hud.visible = lit
        self.page.classes["lit"] = lit

    @handle("match_button", "click")
    def match_button_click(self, **event_args):
        self.stage.light()
        self._show_lit(True)
        self.beat_at = 0
        self._wake()
        state.focus(self.stir_button)

    @handle("relight_button", "click")
    def relight_button_click(self, **event_args):
        self.stage.light()
        self.relight_button.visible = False
        self.stir_button.visible = True
        state.focus(self.stir_button)

    # ---- tending
    def _add(self, key, wet=False, label="", **event_args):
        if not self.stage.add_log(key, wet):
            state.toast("The fire is full. Let it burn down a little first.")

    @handle("stir_button", "click")
    def stir_button_click(self, **event_args):
        self.stage.stir()

    # ---- place
    def _show_place(self):
        name = fire.PLACE_NAMES[self.place]
        self.place_kicker.text = name
        self.place_button.text = name
        _html().setAttribute("data-place", self.place)

    def _choose_place(self):
        key = alert(Places(current=self.place), buttons=[], role="app-dialog", large=True, dismissible=True)
        if key and key != self.place:
            self.place = key
            state.store_set("place", key)
            self.stage.place = key
            self._show_place()
            self.beat_at = 0

    @handle("place_button", "click")
    def place_button_click(self, **event_args):
        self._choose_place()

    @handle("intro_place_button", "click")
    def intro_place_button_click(self, **event_args):
        self._choose_place()

    # ---- sound, settings, full screen
    @handle("sound_button", "click")
    def sound_button_click(self, **event_args):
        self.sound_on = not self.sound_on
        self.stage.sound(self.sound_on)
        self.sound_button.text = "Sound on" if self.sound_on else "Sound off"
        self.sound_button.role = ["btn", "btn-icon", "cf-glass", "ic-volume" if self.sound_on else "ic-mute"]
        state.set_control_attr(self.sound_button, "aria-pressed", "true" if self.sound_on else "false")

    @handle("settings_button", "click")
    def settings_button_click(self, **event_args):
        alert(Settings(stage=self.stage), buttons=[], role="app-dialog", dismissible=True)
        self.settings = settings_mod.load()

    @handle("full_button", "click")
    def full_button_click(self, **event_args):
        doc = _DOC
        if doc.get("fullscreenElement"):
            doc.exitFullscreen()
        elif doc.documentElement.get("requestFullscreen"):
            doc.documentElement.requestFullscreen()

    # ---- the controls fade when you sit still; keys
    def _wake(self):
        _html().classList.remove("cf-idle")
        if self.idle_timer is not None:
            window.clearTimeout(self.idle_timer)
        self.idle_timer = window.setTimeout(self._idle, IDLE_MS)

    def _go_idle(self):
        self.idle_timer = None
        if self.hud.visible and not _dialog_open():
            _html().classList.add("cf-idle")

    def _on_move(self, event):
        now = window.Date.now()
        if now - self.last_move > 350:
            self.last_move = now
            self._wake()

    def _on_key(self, event):
        self._wake()
        target = getattr(event.target, "tagName", "") or ""
        if str(target) in ("INPUT", "TEXTAREA", "SELECT") or _dialog_open() or event.ctrlKey or event.metaKey or event.altKey:
            return
        k = str(event.key).lower()
        if not self.hud.visible:
            return
        if k == "l" and self.wood_panel.items:
            first = list(self.wood_panel.items)[0]
            self._add(first["key"])
        elif k == "s":
            self.stage.stir()
        elif k == "m":
            self.sound_button_click()
        elif k == "f":
            self.full_button_click()
        elif k == "p":
            self._choose_place()
