from anvil import *

from ._anvil_designer import PlaceCardTemplate
from ... import state


class PlaceCard(PlaceCardTemplate):
    """One campsite in the place picker: {key, name, line, here}. The picture comes from CSS (data-place)."""

    def __init__(self, **properties):
        super().__init__(**properties)
        here = bool(self.item.get("here"))
        state.set_attr(self.card, "data-place", self.item["key"])
        state.set_attr(self.art, "aria-label", "The fire at " + self.item["name"])
        self.card.classes["on"] = here
        self.go_button.text = "You are here" if here else "Go here"
        self.go_button.enabled = not here
        state.set_control_attr(self.go_button, "aria-label", ("You are at " if here else "Go to ") + self.item["name"])
        state.set_control_attr(self.go_button, "data-key", self.item["key"])

    @handle("go_button", "click")
    def go_button_click(self, **event_args):
        if self.parent is not None:
            self.parent.raise_event("x-pick", key=self.item["key"])
