from anvil import *

from ._anvil_designer import WoodButtonTemplate
from ... import state


class WoodButton(WoodButtonTemplate):
    """One kind of wood in the tray: {key, label, note, wet}. A press asks the page to put that log on the fire."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.wood_button.role = ["btn", "cf-wood", "ic-log"] + (["cf-wet"] if self.item.get("wet") else [])
        state.set_control_attr(self.wood_button, "aria-label", "Add %s: %s" % (self.item["label"].lower(), self.item["note"]))
        state.set_control_attr(self.wood_button, "data-key", self.item["key"] + ("-wet" if self.item.get("wet") else ""))

    @handle("wood_button", "click")
    def wood_button_click(self, **event_args):
        if self.parent is not None:
            self.parent.raise_event("x-add", key=self.item["key"], wet=bool(self.item.get("wet")), label=self.item["label"])
