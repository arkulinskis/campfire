"""Keep the circle kind: the filter for the only text anyone can send (a chosen name, a three-word message).

clean_words(text) -> (words, None) or (None, "a message the visitor can read")
clean_name(text)  -> (name, None)  or (None, "...")

What it stops: swearing and slurs (English, plus the common French, Spanish and Russian ones written in Latin
letters), sexual words, threats ("kill yourself"), links, email addresses and phone numbers. It sees through the
usual disguises: capitals, accents, l33t (sh1t, $hit), repeated letters (fuuuck), dots or spaces between letters
(f.u.c.k, f u c k). Words are only matched whole, except a short list of roots that never occur inside harmless
words (so "Scunthorpe", "therapist", "torpedo" and "fire retardant" pass).

Only Latin letters (with accents), digits and a little punctuation are allowed: the filter can't read other scripts.
"""
import re
import unicodedata

# roots that are never part of a harmless word: matched anywhere inside a word
ROOTS = ("fuck", "fck", "fvck", "phuck", "shit", "nigg", "fagg", "bitch", "whore", "twat",
         "motherf", "dildo", "pussy", "jizz", "molest", "pedophil", "paedophil", "porn", "hitler",
         "blyat", "pizd", "pidor", "pidar", "yeban", "encul", "salope", "connard", "pendej", "mierd", "cabron",
         "kurwa", "asshole", "arsehole", "bollock", "bellend", "nazi", "onlyfans", "xxx")
# whole words only
WORDS = {
    "ass", "arse", "asses", "dick", "dicks", "dik", "cock", "cocks", "cum", "cumming", "tit", "tits", "titty",
    "titties", "boob", "boobs", "nude", "nudes", "naked", "sex", "sexy", "horny", "penis", "vagina", "anal", "anus",
    "slut", "sluts", "slutty", "hoe", "hoes", "thot", "piss", "pissed", "bastard", "bastards", "bugger",
    "prick", "pricks", "knob", "rape", "raped", "raping", "rapes", "rapist", "rapists", "nsfw", "milf", "milfs",
    "bdsm", "orgasm", "semen", "spunk", "cunt", "cunts", "cunty", "fuk", "fuker", "fukin", "fuking", "wank",
    "wanker", "wankers", "wanking", "retard", "retards", "retarded", "pedo", "pedos", "paedo", "paedos",
    "fag", "fags", "dyke", "dykes", "tranny", "trannies", "kike", "kikes", "spic", "spics", "chink", "chinks", "gook",
    "gooks", "wetback", "coon", "coons", "darkie", "paki", "pakis", "negro", "negroes", "nig", "nigs",
    "lesbo", "spaz", "kys", "stfu", "gtfo", "blowjob", "handjob", "hentai", "incest", "suicide",
    "terrorist", "heil", "kkk", "nazis", "jihad", "idiot", "idiots", "moron", "morons", "loser", "losers",
    "merde", "putain", "pute", "putes", "couille", "couilles", "nique", "niquer", "batard", "chier",
    "puta", "putas", "puto", "coño", "cono", "joder", "polla", "verga", "culo", "chinga", "chingar", "marica",
    "suka", "suki", "hui", "huy", "huj", "hujnya", "mudak", "gandon", "zhopa", "eblan", "pidr", "ebal", "ebat",
}
# whole phrases (after normalising, words joined by single spaces)
PHRASES = ("kill yourself", "kill urself", "kill ur self", "kill your self", "go die", "hang yourself",
           "neck yourself", "end yourself", "white power", "sieg heil", "dot com", "send nudes")
RESERVED = {"you", "everyone", "someone", "nobody", "admin", "administrator", "moderator", "mod", "campfire",
            "system", "staff", "support", "anvil", "official", "owner", "host"}

LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "@": "a",
                      "$": "s", "!": "i", "|": "i", "+": "t", "€": "e", "£": "l"})
ALLOWED = re.compile(r"^[A-Za-z0-9À-ÖØ-öø-ÿĀ-žƀ-ɏ'’.,!?\-\s]+$")
LINK = re.compile(r"(https?|www\.|\.(com|net|org|io|ru|ca|co|me|ly|gg|app|xyz|info|tv)\b|@|\[at\]|\(at\))", re.I)
MAX_WORDS = 3
WORD_LEN = 18
MSG_LEN = 48
NAME_MIN, NAME_LEN = 2, 16


def _plain(s):
    """Lower case, accents off, l33t undone."""
    s = unicodedata.normalize("NFKD", s.replace("’", "'"))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.lower().translate(LEET)


def _squeeze(w):
    """Repeated letters down to one (fuuuck -> fuck) and to two (for words like 'boob' that need them)."""
    one = re.sub(r"(.)\1+", r"\1", w)
    two = re.sub(r"(.)\1{2,}", r"\1\1", w)
    return {w, one, two}


def _tokens(s):
    """Words of letters only. Runs of single letters (f u c k, f.u.c.k, f-u-c-k) are joined into one word."""
    raw = re.findall(r"[a-z]+", s)
    out, run = [], ""
    for t in raw:
        if len(t) == 1:
            run += t
            continue
        if run:
            out.append(run)
            run = ""
        out.append(t)
    if run:
        out.append(run)
    return out


def is_rude(text):
    """True when the text holds anything the filter stops."""
    s = _plain(text or "")
    if LINK.search(text or "") or LINK.search(s):
        return True
    if re.search(r"\d[\d\s().-]{4,}\d", text or ""):   # phone numbers and other long numbers
        return True
    toks = _tokens(s)
    joined = " ".join(toks)
    if any(re.search(r"\b%s\b" % re.escape(p), joined) for p in PHRASES):
        return True
    squashed = "".join(toks)   # also catches "fu ck" split into short pieces (not "this hit": long words stay apart)
    short = len(toks) > 1 and all(len(t) <= 3 for t in toks)
    for i, tok in enumerate(toks + ([squashed] if short else [])):
        whole = i < len(toks)   # the joined pieces are only checked for roots
        for w in _squeeze(tok):
            if any(r in w for r in ROOTS):
                return True
            if whole and (w in WORDS or (w.endswith("s") and w[:-1] in WORDS)):
                return True
    return False


def clean_words(text):
    """A message for the circle: one to three words. Returns (words, None) or (None, why not)."""
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if not s:
        return None, "Type up to three words first."
    words = s.split(" ")
    if len(words) > MAX_WORDS:
        return None, "Three words at most. Fire likes it short."
    if len(s) > MSG_LEN or any(len(w) > WORD_LEN for w in words):
        return None, "Those words are too long for the fire."
    if not ALLOWED.match(s):
        return None, "Letters, numbers and a little punctuation only."
    if not re.search(r"[A-Za-zÀ-ɏ]", s):
        return None, "Say it with at least one letter."
    if is_rude(s):
        return None, "Let's keep the circle kind. Try other words."
    return s, None


def clean_name(text):
    """A name for the circle: 2 to 16 letters, one or two words. Returns (name, None) or (None, why not)."""
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(s) < NAME_MIN:
        return None, "A name needs at least two letters."
    if len(s) > NAME_LEN:
        return None, "Sixteen letters at most."
    if len(s.split(" ")) > 2:
        return None, "One or two words, please."
    if not re.match(r"^[A-Za-zÀ-ÖØ-öø-ÿĀ-žƀ-ɏ'’\- ]+$", s):
        return None, "Letters only (a space, a hyphen or an apostrophe are fine)."
    if _plain(s).replace(" ", "") in RESERVED or _plain(s) in RESERVED:
        return None, "That name is taken by the fire. Pick another."
    if is_rude(s):
        return None, "Let's keep the circle kind. Pick another name."
    return s[:1].upper() + s[1:], None
