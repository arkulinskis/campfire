"""The app starts here (anvil.yaml: startup module). Campfire has no accounts: set up the Privacy & Terms kit, then
open the page for the address in the browser bar (the fire, or how it works)."""
from . import legal, router

LEGAL_THEME = {"accent": "#b4501a"}  # colours for the Privacy & Terms page (the ember of app.css, dark enough to read)

legal.setup(LEGAL_THEME)
router.start()
