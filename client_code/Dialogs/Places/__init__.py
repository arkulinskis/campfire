from anvil import *

from ._anvil_designer import PlacesTemplate
from ... import fire, state


class Places(PlacesTemplate):
    """Pick a campsite. Shown with alert(Places(current=...), buttons=[], role="app-dialog"); returns the key or None."""

    def __init__(self, current, **properties):
        self.current = current
        super().__init__(**properties)
        self.place_panel.items = [dict(p, here=p["key"] == self.current) for p in fire.PLACES]
        self.place_panel.add_event_handler("x-pick", self._pick)

    def _pick(self, key, **event_args):
        self.raise_event("x-close-alert", value=key)

    @handle("close_button", "click")
    def close_button_click(self, **event_args):
        self.raise_event("x-close-alert", value=None)

    @handle("", "show")
    def form_show(self, **event_args):
        key = next((p["key"] for p in fire.PLACES if p["key"] != self.current), None)
        state.refocus(self.place_panel, key)
