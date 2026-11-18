from anvil import *

from ._anvil_designer import AboutTemplate

# The app's video on the Addanapp YouTube channel (APP_MAKER/youtube/manifest.json), shown in the Watch section.
YT_VIDEO = "rpmM41EGe1o"


class About(AboutTemplate):
    """How the fire works: the simulation, the light, the wood, the sound, the three places, things to try, questions
    and the research it stands on, plus the Watch section (the YouTube video). Static copy; the fire keeps burning (and
    crackling) in the background."""

    def __init__(self, args=(), **properties):
        super().__init__(**properties)
        self.dom_nodes["yt_cover"].addEventListener("click", self._play)

    def _play(self, event):
        """Swap the video's cover for YouTube's player (privacy-enhanced); nothing loads from YouTube before this click."""
        self.dom_nodes["yt_frame"].innerHTML = (
            '<iframe src="https://www.youtube-nocookie.com/embed/' + YT_VIDEO + '?autoplay=1&rel=0&playsinline=1" '
            'title="Campfire video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen '
            'referrerpolicy="strict-origin-when-cross-origin"></iframe>')
