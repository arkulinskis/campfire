from anvil import *

from ._anvil_designer import AboutTemplate


class About(AboutTemplate):
    """How the fire works: the simulation, the light, the wood, the sound, the three places, things to try, questions
    and the research it stands on. Static copy; the fire keeps burning (and crackling) in the background."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
