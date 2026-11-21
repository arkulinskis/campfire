from anvil import *
from anvil.js import window

from ._anvil_designer import CircleTemplate
from ... import state

GESTURES = ("wave", "nod", "clap", "laugh", "stars", "stretch", "warm")
MAX_WORDS = 3


def word_count(text):
    return len([w for w in str(text or "").split() if w])


class Circle(CircleTemplate):
    """What you can do with your circle: a gesture (wave, nod, clap, laugh, point at the stars, stretch, warm your
    hands), three words that rise out of everyone's fire, and your name. Shown with
    alert(Circle(name=..., company=..., say=fn, rename=fn, question=..., invite=link), buttons=[], role="app-dialog").
    A gesture closes it and returns the gesture's key (the page plays and shares it); say(text) and rename(name) are
    the page's own functions and return an error to show here, or None. `question` = tonight's question
    (questions.py); `invite` = the link that seats a friend in this circle ("" hides the invite)."""

    def __init__(self, name="", company=False, say=None, rename=None, question="", invite="", **properties):
        self._say_fn = say
        self._rename_fn = rename
        self._invite = invite or ""
        super().__init__(**properties)
        self.name_box.text = name or ""
        self.question_label.text = question or ""
        self.question_label.visible = bool(question)
        self.invite_button.visible = bool(self._invite)
        self.invite_field.visible = False
        if not self._invite:
            self.invite_note.text = "Sit down first: an invitation leads to your circle."
        state.set_control_attr(self.invite_box, "readonly", "readonly")
        self.alone_note.visible = not company
        for key in GESTURES:
            getattr(self, key + "_g").enabled = bool(company)
        state.set_control_attr(self.say_box, "maxlength", "48")
        state.set_control_attr(self.say_box, "autocomplete", "off")
        state.set_control_attr(self.name_box, "maxlength", "16")
        state.set_control_attr(self.name_box, "autocomplete", "nickname")
        state.live(self.say_count)
        self._count()

    # ---- gestures: close and let the page do it
    def _gesture(self, key):
        self.raise_event("x-close-alert", value=key)

    @handle("wave_g", "click")
    def wave_g_click(self, **event_args):
        self._gesture("wave")

    @handle("nod_g", "click")
    def nod_g_click(self, **event_args):
        self._gesture("nod")

    @handle("clap_g", "click")
    def clap_g_click(self, **event_args):
        self._gesture("clap")

    @handle("laugh_g", "click")
    def laugh_g_click(self, **event_args):
        self._gesture("laugh")

    @handle("stars_g", "click")
    def stars_g_click(self, **event_args):
        self._gesture("stars")

    @handle("stretch_g", "click")
    def stretch_g_click(self, **event_args):
        self._gesture("stretch")

    @handle("warm_g", "click")
    def warm_g_click(self, **event_args):
        self._gesture("warm")

    # ---- an invitation: the phone's share sheet, else the clipboard, else the link to copy by hand
    @handle("invite_button", "click")
    def invite_button_click(self, **event_args):
        link = self._invite
        if not link:
            return
        nav = window.navigator
        if nav.get("share"):
            try:
                nav.share({"title": "Campfire", "text": "Come and sit by the fire with me.", "url": link})
                self.invite_note.text = "Sent. Your friend sits down in this circle if a seat is free."
                return
            except Exception as e:
                if "AbortError" in str(e):   # they closed the share sheet
                    return
        try:
            nav.clipboard.writeText(link)
            self.invite_note.text = "Link copied. Send it to a friend: it works while someone sits by this fire."
            return
        except Exception:
            pass
        self.invite_box.text = link
        self.invite_field.visible = True
        self.invite_note.text = "Copy this link and send it to a friend."
        state.focus(self.invite_box)
        state.control(self.invite_box).select()

    # ---- three words
    def _count(self):
        n = word_count(self.say_box.text)
        if n == 0:
            self.say_count.text = "Up to 3 words"
        elif n <= MAX_WORDS:
            self.say_count.text = "%d of 3 words" % n
        else:
            self.say_count.text = "%d words: three at most" % n
        self.say_button.enabled = 0 < n <= MAX_WORDS

    @handle("say_box", "change")
    def say_box_change(self, **event_args):
        self.say_error.visible = False
        self._count()

    @handle("say_box", "pressed_enter")
    def say_box_pressed_enter(self, **event_args):
        if self.say_button.enabled:
            self.say_button_click()

    @handle("say_button", "click")
    def say_button_click(self, **event_args):
        text = " ".join(str(self.say_box.text or "").split())
        if not text or self._say_fn is None:
            return
        self.say_button.enabled = False
        problem = self._say_fn(text)
        if problem:
            self.say_error.text = problem
            self.say_error.visible = True
            self.say_button.enabled = True
            state.focus(self.say_box)
            return
        self.raise_event("x-close-alert", value=None)

    # ---- your name
    @handle("name_box", "change")
    def name_box_change(self, **event_args):
        self.name_error.visible = False

    @handle("name_box", "pressed_enter")
    def name_box_pressed_enter(self, **event_args):
        self.name_button_click()

    @handle("name_button", "click")
    def name_button_click(self, **event_args):
        name = " ".join(str(self.name_box.text or "").split())
        if not name or self._rename_fn is None:
            return
        problem = self._rename_fn(name)
        if problem:
            self.name_error.text = problem
            self.name_error.visible = True
            return
        self.name_note.text = "Saved. The others will see it in a moment."

    @handle("close_button", "click")
    def close_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=None)

    @handle("", "show")
    def form_show(self, **event_args):
        state.focus(self.say_box)
