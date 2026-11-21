from anvil import *

from ._anvil_designer import LetGoTemplate
from ... import state

MAX_CHARS = 280


class LetGo(LetGoTemplate):
    """Write something down and give it to the fire: the page then throws the paper into the flames, where it
    catches, curls and goes up (FireStage.burn_paper). The words never leave the browser: no server call, no storage.
    Shown with alert(LetGo(), buttons=[], role="app-dialog"); returns the text, or None."""

    def __init__(self, **properties):
        super().__init__(**properties)
        state.set_control_attr(self.note_box, "maxlength", str(MAX_CHARS))
        state.set_control_attr(self.note_box, "autocomplete", "off")
        state.set_control_attr(self.note_box, "rows", "4")
        self._count()

    def _text(self):
        return " ".join(str(self.note_box.text or "").split())[:MAX_CHARS]

    def _count(self):
        self.burn_button.enabled = bool(self._text())

    @handle("note_box", "change")
    def note_box_change(self, **event_args):
        self._count()

    @handle("burn_button", "click")
    def burn_button_click(self, **event_args):
        text = self._text()
        if text:
            self.note_box.text = ""   # nothing lingers in the page either
            self.raise_event("x-close-alert", value=text)

    @handle("close_button", "click")
    def close_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=None)

    @handle("", "show")
    def form_show(self, **event_args):
        state.focus(self.note_box)
