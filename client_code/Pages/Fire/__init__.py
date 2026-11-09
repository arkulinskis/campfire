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
BEAT_ALONE_MS = 30000   # heartbeat: how often we tell the server we're here and hear what the circle did
BEAT_COMPANY_MS = 15000  # ... with others by the fire (slow on purpose: it's a campfire, not a chat)
BEAT_HIDDEN_MS = 60000  # ... while the tab is in the background
COUNT_EVERY = 4         # the "N more by other fires" count is asked for every 4th heartbeat
FEED_MS = 12000         # a line of news stays this long (20 s when it asks for a wave back)
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


def names_text(names):
    """["Fox"] -> "Fox"; ["Fox", "Heron", "Owl"] -> "Fox, Heron and Owl"."""
    names = [n for n in names if n]
    if len(names) < 2:
        return "".join(names)
    return ", ".join(names[:-1]) + " and " + names[-1]


def presence_text(others, circle: dict):
    people = circle.get("people") or []
    if people:
        line = "You're %s. %s %s by this fire with you." % (circle.get("name"), names_text([p["name"] for p in people]),
                                                            "is" if len(people) == 1 else "are")
        more = (others or 0) - len(people)
        return line + (" %d more by other fires." % more if more > 0 else "")
    if others is None:
        return ""
    if others == 0:
        return "Nobody else is by a fire right now. It is all yours."
    return "You and %s are by a fire right now." % state.plural(others, "other")


def a_log(label, wet):
    if wet:
        return "a damp branch"
    word = (label or "wood").lower()
    return ("an " if word[:1] in "aeiou" else "a ") + word + " log"


class Fire(FireTemplate):
    """The campfire: you arrive in the dark beside a laid fire, strike a match, then tend it (woods, stir), change the
    place, the sound, the wind, or set it to burn down while you fall asleep. The controls fade away when you sit
    still. Keys: L log, S stir, W wave, M sound, F full screen, P place.

    Others by a fire at the same place sit around yours (circles of up to six, seated by the server: Presence.py).
    What they do comes in slowly with each heartbeat: they wave, or throw a log on (it lands in your fire too)."""

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
        self.beats = 0
        self.circle: dict = {}          # my circle from the last heartbeat ({} = none yet)
        self.since = None
        self.seen_news: dict = {}
        self.wood_labels: dict = {}
        self.wave_back_seat = -1
        self.feed_timer = None
        self.woods_for = None
        self.applied = False
        self.sound_on = True
        self.last_move = 0
        self.idle_timer = None
        self.fallback.visible = False
        self.feed.visible = False
        self.wave_back_button.visible = False
        self.wave_button.visible = False
        self._show_place()
        self._show_lit(fire.available() and fire.is_shared_lit())
        self.wood_panel.add_event_handler("x-add", self._add)
        self.relight_button.visible = False
        state.live(self.status_label)
        state.live(self.feed_label)
        self._move = anvil.js.report_exceptions(self._on_move)
        self._keys = anvil.js.report_exceptions(self._on_key)
        self._idle = anvil.js.report_exceptions(self._go_idle)
        self._hide_feed_cb = anvil.js.report_exceptions(self._hide_feed)
        if window.get("CF_TEST"):   # tests play a second visitor through these (tools/ui/flow.js)
            window.CF_TEST.circle = {"pulse": self._test_pulse, "visitor": self._test_visitor}

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
            self.wood_labels = {w["key"]: w["label"] for w in woods}
            self.wood_panel.items = woods + ([dict(DAMP, key=woods[0]["key"], wet=True)] if woods else [])
        self.status_label.text = status_text(st)
        dead = bool(st.get("lit")) and st.get("power", 0) < 0.05 and st.get("coals", 0) < 0.08
        self.relight_button.visible = dead
        self.stir_button.visible = not dead
        now = window.Date.now()
        every = BEAT_HIDDEN_MS if _DOC.hidden else (BEAT_COMPANY_MS if self._company() else BEAT_ALONE_MS)
        if st.get("lit") and now - self.beat_at > every:
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
        elif name == "wave_to":
            data = event_args.get("data")
            self._wave(int(data) if isinstance(data, (int, float)) else None)

    # ---- the circle: who sits around this fire, and what they did
    def _company(self):
        return bool(self.circle.get("people"))

    def _name(self, seat):
        if self.circle and seat == self.circle.get("seat"):
            return "you"
        for p in self.circle.get("people") or []:
            if p["seat"] == seat:
                return p["name"]
        return None

    def _heartbeat(self):
        self.beats += 1
        count = self.others is None or self.beats % COUNT_EVERY == 1
        r = state.call_quiet("ember_heartbeat", self.sid, self.place, self.since, count)
        if not (isinstance(r, dict) and r.get("ok")):
            return
        if "others" in r:
            self.others = int(r.get("others") or 0)
        self._apply_circle(r.get("circle") or {})
        self.presence_label.text = presence_text(self.others, self.circle)

    def _apply_circle(self, c):
        old = self.circle
        if not c:
            if old:
                self.stage.set_circle(None)
            self.circle, self.since = {}, None
            self._show_company()
            return
        first = not old or old.get("id") != c["id"] or old.get("seat") != c["seat"]
        before = {} if first else {p["seat"]: p["name"] for p in old.get("people") or []}
        now_ = {p["seat"]: p["name"] for p in c.get("people") or []}
        self.circle, self.since = c, c.get("t")
        self.stage.set_circle(c)
        self._show_company()
        if first:
            self.seen_news = {}
            if now_:
                self._say("%s %s by this fire with you. Tap someone to wave."
                          % (names_text(list(now_.values())), "is" if len(now_) == 1 else "are"))
        else:
            came = [n for s, n in now_.items() if before.get(s) != n]
            went = [n for s, n in before.items() if now_.get(s) != n]
            if came:
                self._say("%s sat down by the fire." % names_text(came))
            elif went:
                self._say("%s %s gone." % (names_text(went), "has" if len(went) == 1 else "have"))
        fresh = []
        for n in c.get("news") or []:
            if n["id"] not in self.seen_news and n["seat"] != c["seat"]:
                self.seen_news[n["id"]] = True
                fresh.append(n)
        for i, n in enumerate(fresh[-8:]):   # a little apart, so several things don't happen at once
            self._later(i * 1700, n)

    def _later(self, ms, news):
        def go():
            self._play(news)
        if ms <= 0:
            go()
        else:
            window.setTimeout(anvil.js.report_exceptions(go), ms)

    def _play(self, n):
        who = self._name(n["seat"]) or "Someone"
        kind, to = n.get("kind"), n.get("to")
        self.stage.circle_act(n["seat"], kind, to, n.get("wood"), n.get("wet"))
        if kind == "wave":
            if to is None:
                self._say("%s waves to everyone." % who)
            elif to == self.circle.get("seat"):
                self._say("%s waves to you." % who, wave_back=n["seat"])
            else:
                self._say("%s waves to %s." % (who, self._name(to) or "someone"))
        elif kind == "log":
            self._say("%s puts %s on the fire." % (who, a_log(self.wood_labels.get(n.get("wood")), n.get("wet"))))
        elif kind == "stir":
            self._say("%s stirs the fire." % who)

    def _show_company(self):
        self.wave_button.visible = self._company() and self.hud.visible

    def _say(self, text, wave_back=-1):
        """One line of news at the top. It stays visible even while the controls are faded away."""
        self.feed_label.text = text
        self.feed.visible = True
        self.wave_back_seat = wave_back
        self.wave_back_button.visible = wave_back >= 0
        self.feed.classes["has-action"] = wave_back >= 0
        if self.feed_timer is not None:
            window.clearTimeout(self.feed_timer)
        self.feed_timer = window.setTimeout(self._hide_feed_cb, FEED_MS + (8000 if wave_back >= 0 else 0))

    def _hide_feed(self):
        self.feed_timer = None
        self.feed.visible = False
        self.wave_back_button.visible = False
        self.wave_back_seat = -1

    def _share(self, kind, to=None, wood=None, wet=False):
        """Tell the circle (no-op when nobody else sits here). Returns the error to show, or None."""
        if not self._company():
            return None
        r = state.call_quiet("circle_act", self.sid, kind, to, wood, wet)
        if isinstance(r, dict) and r.get("ok") is False:
            return r.get("error")
        return None

    def _wave(self, seat=None):
        if not self._company():
            return
        name = self._name(seat) if seat is not None else "everyone"
        if not name or name == "you":
            return
        problem = self._share("wave", seat)
        self._say(problem or "You wave to %s." % name)

    @handle("wave_button", "click")
    def wave_button_click(self, **event_args):
        self._wave(None)

    @handle("wave_back_button", "click")
    def wave_back_button_click(self, **event_args):
        if self.wave_back_seat >= 0:
            self._wave(self.wave_back_seat)

    # ---- lighting
    def _show_lit(self, lit):
        self.intro.visible = not lit
        self.hud.visible = lit
        self.page.classes["lit"] = lit
        self._show_company()

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

    # ---- tending (shared with the circle: your log lands in their fires too)
    def _add(self, key, wet=False, label="", **event_args):
        if not self.stage.add_log(key, wet):
            state.toast("The fire is full. Let it burn down a little first.")
        else:
            self._share("log", None, key, bool(wet))

    def _stir(self):
        self.stage.stir()
        self._share("stir")

    @handle("stir_button", "click")
    def stir_button_click(self, **event_args):
        self._stir()

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
            self._apply_circle({})   # a new place, a new circle (the next heartbeat seats you)
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
        if str(target) in ("INPUT", "TEXTAREA", "SELECT") or _dialog_open() or getattr(event, "ctrlKey", False) or getattr(event, "metaKey", False) or getattr(event, "altKey", False):
            return
        k = str(getattr(event, "key", None)).lower()
        if not self.hud.visible:
            return
        if k == "l" and self.wood_panel.items:
            first = list(self.wood_panel.items)[0]
            self._add(first["key"])
        elif k == "s":
            self._stir()
        elif k == "w":
            self._wave(None)
        elif k == "m":
            self.sound_button_click()
        elif k == "f":
            self.full_button_click()
        elif k == "p":
            self._choose_place()

    # ---- test hooks (only with ?cftest=1): a second visitor played through the server, and a heartbeat on demand
    def _test_pulse(self):
        self._heartbeat()
        return {"circle": self.circle, "others": self.others, "sid": self.sid}

    def _test_visitor(self, sid, kind, to=None, wood=None, wet=False):
        if kind == "beat":   # `to` = since (the visitor's last t), for reading the news
            return anvil.server.call("ember_heartbeat", sid, self.place, to, False)
        return anvil.server.call("circle_act", sid, kind, to, wood, wet)
