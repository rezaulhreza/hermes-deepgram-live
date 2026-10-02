"""Deepgram live voice: the agent half.

The desktop half owns the microphone, the Deepgram sockets and playback. This half only makes
a spoken turn answerable aloud: it adds a per-turn note to the model input (never the system
prompt, so the prompt cache is untouched) for turns the desktop announced as spoken.
"""

from __future__ import annotations

import logging

from . import voice_state

logger = logging.getLogger(__name__)

SPOKEN_TURN_NOTE = (
    "[Note: this message came from a live spoken conversation. The text is a speech transcript "
    "and may contain mis-hearings or hesitations; go with the most likely intent. Your reply is "
    "read aloud word for word by a text-to-speech voice, so write plain conversational "
    "sentences: no markdown, no lists, no code blocks, no emoji, and do not read out URLs or "
    "file paths character by character. Keep it short, a few sentences unless asked for detail. "
    "Before each tool call, first say one short natural sentence about what you are about to do "
    "(for example: I'm checking the logs now), so the listener hears progress while you work. "
    "Do not claim an action succeeded before it actually did.]"
)


def _spoken_turn_note(user_message=None, **_kwargs):
    if not isinstance(user_message, str) or not user_message.strip():
        return None
    try:
        spoken = voice_state.claim(user_message)
    except Exception as exc:  # noqa: BLE001 - a broken cache file must not fail the turn
        logger.debug("deepgram-live: spoken-turn lookup failed: %s", exc)
        return None
    return {"context": SPOKEN_TURN_NOTE} if spoken else None


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", _spoken_turn_note)
