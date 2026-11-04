"""Page addresses: #name/arg1/arg2 -> a page Form (open_form).

Links in templates are plain <a href="#fire">; code calls router.go("about").

    PAGES[name] = browser-tab title
New page: add it to PAGES and to _form().
"""
import anvil
import anvil.js
from anvil.js import window

PAGES = {
    "fire": "Campfire: sit by the fire",
    "about": "How the fire works · Campfire",
}
HOME = "fire"
_r: dict = {"listening": False, "page": ""}


def _form(name):
    """The page's Form class (imported when first needed, so start-up stays quick)."""
    if name == "about":
        from .Pages.About import About
        return About
    from .Pages.Fire import Fire
    return Fire


def parse(hash_text):
    h = (hash_text or "").lstrip("#").lstrip("!").lstrip("/").split("?")[0]
    parts = [window.decodeURIComponent(p) for p in h.split("/") if p]
    return (parts[0] if parts else ""), parts[1:]


def href(name, *args):
    """'#name/arg1/arg2' with every part URL-encoded."""
    return "#" + "/".join([name] + [window.encodeURIComponent(str(a)) for a in args if a not in (None, "")])


def current():
    return _r["page"]


def show():
    """Open the page for the current address."""
    name, args = parse(window.location.hash)
    if name not in PAGES:
        name, args = HOME, []
    window.document.title = PAGES[name]
    window.UI_READY = False
    _r["page"] = name
    page = _form(name)(args=args)
    anvil.open_form(page)
    shell = getattr(page, "layout", None)
    if shell is not None and hasattr(shell, "refresh"):
        shell.refresh(name)  # Anvil reuses the layout between pages: tell it which page is open
    window.scrollTo(0, 0)
    window.UI_READY = True  # tests and screenshots wait for this


def go(name, *args):
    """Go to a page. Same address again = reload the page."""
    target = href(name, *args)
    if window.location.hash == target:
        show()
    else:
        window.location.hash = target


def replace(name, *args):
    """Change the address without opening anything."""
    window.history.replaceState(None, "", href(name, *args))


def _on_hash(event):
    show()


def _on_click(event):
    """In-app links (<a href="#about">) only change the hash. Anvil puts a <base href> in the page, so the browser
    would resolve "#about" against the bare app address and reload the whole app whenever the visitor arrived with
    a query string (?utm_source=..., ?cftest=1)."""
    if event.defaultPrevented or event.button or event.ctrlKey or event.metaKey or event.shiftKey or event.altKey:
        return
    target = event.target
    link = target.closest("a[href^='#']") if target and getattr(target, "closest", None) else None
    if not link or link.getAttribute("target"):
        return
    event.preventDefault()
    window.location.hash = link.getAttribute("href")


def start():
    if not _r["listening"]:
        window.addEventListener("hashchange", anvil.js.report_exceptions(_on_hash))
        window.document.addEventListener("click", anvil.js.report_exceptions(_on_click))
        _r["listening"] = True
    show()
