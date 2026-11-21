"""Tonight's question: one gentle question a night for every circle, answered (if at all) in three words.

Around real fires, night talk turns to stories (Wiessner, PNAS 2014: 81% of firelight talk among the Ju/'hoansi was
stories). A circle of strangers with three words each needs a nudge to get there. The question is the same for
everyone that night (picked by the UTC day number), so a circle shares it without the server.
"""
import time

QUESTIONS = (
    "A smell from your childhood?",
    "The best meal you ever had?",
    "A place you felt at home?",
    "Someone you'd invite here?",
    "A sound you miss?",
    "What made you smile today?",
    "Your favourite kind of weather?",
    "A song for this fire?",
    "Where would you wake up tomorrow?",
    "A small thing you're grateful for?",
    "The first thing you'd cook here?",
    "A star you know by name?",
    "An animal you'd like to see tonight?",
    "Something you learned this year?",
    "A book that stayed with you?",
    "Your best summer, in three words?",
    "A tradition you love?",
    "What does home sound like?",
    "A kindness you still remember?",
    "Where were you happiest?",
    "A view you'll never forget?",
    "Something you'd tell your younger self?",
    "Your favourite time of night?",
    "A trip you'd take again?",
    "What helps you fall asleep?",
    "A word that makes you feel calm?",
    "Something you made with your hands?",
    "The best advice you were given?",
    "A taste of where you grew up?",
    "What's waiting for you tomorrow?",
    "A friend you'd want here now?",
    "Your favourite season, and why?",
    "A dream you still remember?",
    "Something beautiful you saw lately?",
    "What would you name this fire?",
    "A game you played as a child?",
    "A colour that feels like tonight?",
    "Where's the darkest sky you've seen?",
    "Something you're looking forward to?",
    "A story your family tells?",
    "The best gift you ever gave?",
    "A place you'd like to see snow?",
    "What does a good day look like?",
    "A sound that means summer?",
    "Something that always cheers you up?",
)


def tonight(now=None):
    """Tonight's question (the same for everyone on one UTC day)."""
    day = int((time.time() if now is None else now) // 86400)
    return QUESTIONS[(day * 7 + 3) % len(QUESTIONS)]
