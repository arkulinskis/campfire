import datetime

from anvil import *

from ._anvil_designer import ShellTemplate
from ... import state

THEMES = ["auto", "light", "dark"]


class Shell(ShellTemplate):
    """The frame around every page: a slim header (the fire, how it works, light/dark) and the footer (feedback,
    Privacy & Terms). The fire page is full-screen: refresh("fire") adds the class "immersive", which hides both.

    Anvil keeps ONE Shell while pages come and go (open_form only swaps the "content" slot when the layout matches),
    so everything that depends on the open page is drawn in refresh(), which router.show() calls after every page
    change."""

    def __init__(self, **properties):
        super().__init__(**properties)
        self.copyright_label.text = "© %d Campfire · Arkvital" % datetime.date.today().year
        self.refresh("")

    def refresh(self, page):
        self.classes["immersive"] = page == "fire"
        self.nav_fire.classes["on"] = page == "fire"
        self.nav_about.classes["on"] = page == "about"
        self._show_theme()

    def theme_click(self, event):
        state.set_theme(event.currentTarget.getAttribute("data-theme-set"))
        self._show_theme()

    def _show_theme(self):
        t = state.theme()
        for name, el in zip(THEMES, [self.theme_auto, self.theme_light, self.theme_dark]):
            el.classes["on"] = name == t
