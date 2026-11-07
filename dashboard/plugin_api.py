"""REST routes for the desktop live-voice plugin, mounted at ``/api/plugins/deepgram-live``.

The Deepgram API key never reaches the desktop renderer: each socket the renderer opens is
authorised with a short-lived token minted here (``POST /v1/auth/grant``). Deepgram only checks
the token during the WebSocket handshake, so a 30 second token is enough for a long session.
"""

from __future__ import annotations

import importlib.util
import logging
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

GRANT_URL = "https://api.deepgram.com/v1/auth/grant"
TOKEN_TTL_SECONDS = 30

DEFAULTS: dict[str, Any] = {
    # An Aura voice (aura-2-…) or a Flux voice (flux-…). Flux voices speak on /v2/speak.
    "voice": "aura-2-thalia-en",
    # The language the user speaks: en-GB, en-US, fr, de, … or "multi" for any. It picks the
    # listening model: English has its own, every other language uses the multilingual one.
    "language": "en-GB",
    # Only when "language" is empty: the listening model as it is.
    "listen_model": "flux-general-en",
    # How lively a Flux voice sounds, -2 (calm) to 2 (animated). Aura voices ignore it.
    "expressivity": 0,
    # Confidence at which the listening model calls the user's turn finished; lower answers sooner, higher
    # tolerates mid-sentence pauses.
    "eot_threshold": 0.7,
    # Silence that ends a turn regardless of confidence.
    "eot_timeout_ms": 3000,
    # Confidence for the early end of turn, for clients that start work before the turn is final
    # (Brah). It must not be above eot_threshold. The desktop half does not use it.
    "eager_eot_threshold": 0.5,
    # Write spoken numbers as digits: "25", "10 pm", "3D".
    "numerals": True,
    "speed": 1.0,
    "keyterms": ["Hermes"],
    # Hand the long-lived key to the renderer when the key cannot mint tokens (it lacks the
    # Member role). Off by default: with it on, the key is held in the app's memory.
    "allow_key_fallback": False,
    # Ask Deepgram to keep audio and text out of its Model Improvement Program. On by default.
    "mip_opt_out": True,
}


def _load_voice_state():
    path = Path(__file__).resolve().parent.parent / "voice_state.py"
    spec = importlib.util.spec_from_file_location("hermes_deepgram_live_voice_state", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


voice_state = _load_voice_state()


def _settings() -> dict[str, Any]:
    from hermes_cli.config import load_config

    section = load_config().get("deepgram_live")
    merged = dict(DEFAULTS)
    if isinstance(section, dict):
        merged.update({key: value for key, value in section.items() if key in DEFAULTS and value is not None})
    return merged


# The languages Flux hears. It tells when a turn ends. Every other language, and "multi" (any
# language), goes to Nova-3, where a second of quiet ends a turn.
FLUX_LANGUAGES = {"en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"}


def _listening(settings: dict[str, Any]) -> tuple[str, str, str | None]:
    """The listening engine (flux or nova), the model and the language hint."""
    language = str(settings.get("language") or "").strip()
    if not language:
        return "flux", str(settings["listen_model"]), None
    base = language.split("-")[0].lower()
    if base == "en":
        return "flux", "flux-general-en", None
    if base in FLUX_LANGUAGES:
        return "flux", "flux-general-multi", base
    return "nova", "nova-3", None if language == "multi" else language


def _api_key() -> str:
    from hermes_cli.config import get_env_value

    return (get_env_value("DEEPGRAM_API_KEY") or "").strip()


@router.get("/status")
def status() -> dict[str, Any]:
    """Non-secret readiness and the session settings the desktop half connects with."""
    settings = _settings()
    available = bool(_api_key())
    listen_engine, listen_model, language_hint = _listening(settings)
    return {
        "available": available,
        "reason": None if available else "DEEPGRAM_API_KEY is not set in the Hermes .env",
        **{key: settings[key] for key in ("voice", "language", "eot_threshold", "eot_timeout_ms", "eager_eot_threshold", "numerals", "speed", "expressivity", "keyterms", "mip_opt_out")},
        "listen_engine": listen_engine,
        "listen_model": listen_model,
        "language_hint": language_hint,
    }


@router.post("/auth")
def auth() -> dict[str, Any]:
    """A credential for one WebSocket handshake: ``scheme`` + ``value`` are the two
    ``Sec-WebSocket-Protocol`` entries the browser sends."""
    key = _api_key()
    if not key:
        raise HTTPException(status_code=503, detail="DEEPGRAM_API_KEY is not set in the Hermes .env")
    try:
        response = httpx.post(
            GRANT_URL, headers={"Authorization": f"Token {key}"}, json={"ttl_seconds": TOKEN_TTL_SECONDS}, timeout=10)
    except httpx.HTTPError as exc:
        logger.warning("deepgram-live: token grant request failed: %s", exc)
        raise HTTPException(status_code=502, detail="Could not reach Deepgram to mint a token") from exc
    if response.status_code == 200:
        body = response.json()
        token = str(body.get("access_token") or "")
        if token:
            return {"scheme": "bearer", "value": token, "expires_in": int(body.get("expires_in") or TOKEN_TTL_SECONDS)}
    logger.warning("deepgram-live: token grant rejected (HTTP %s)", response.status_code)
    if response.status_code == 403 and _settings()["allow_key_fallback"]:
        return {"scheme": "token", "value": key, "expires_in": 0}
    if response.status_code == 403:
        raise HTTPException(
            status_code=403,
            detail="This Deepgram key cannot mint tokens. Create a key with the Member role, "
                   "or set deepgram_live.allow_key_fallback: true in config.yaml.")
    raise HTTPException(status_code=502, detail=f"Deepgram token grant failed (HTTP {response.status_code})")


class SpokenTurn(BaseModel):
    text: str


@router.post("/turn")
def turn(body: SpokenTurn) -> dict[str, bool]:
    """Announce a transcript that is about to be submitted, so its turn gets the spoken-reply note."""
    if body.text.strip():
        voice_state.announce(body.text)
    return {"ok": True}


# A Deepgram voice id (aura-2-thalia-en, flux-colin-en) and a language code (en-GB, fr, multi).
VOICE_ID = re.compile(r"^(aura(-2)?|flux)-[a-z0-9]+(-[a-z0-9]+)*$")
LANGUAGE_CODE = re.compile(r"^(multi|[a-z]{2,3}(-[A-Za-z0-9]{2,4})?)$")


class VoiceSettings(BaseModel):
    voice: str | None = None
    language: str | None = None
    expressivity: int | None = None
    keyterms: list[str] | None = None


# Deepgram takes up to 100 key terms; each one is a word or a short phrase.
MAX_KEYTERMS = 100
MAX_KEYTERM_LENGTH = 50


@router.post("/settings")
def save_settings(body: VoiceSettings) -> dict[str, Any]:
    """Save the voice, the language, the expressivity and the key terms in config.yaml, so every
    client of this host (the desktop, Brah, the phone) hears and speaks the same way. Returns the
    new status."""
    change: dict[str, Any] = {}
    if body.voice is not None:
        if not VOICE_ID.match(body.voice):
            raise HTTPException(status_code=400, detail="That is not a Deepgram voice.")
        change["voice"] = body.voice
    if body.language is not None:
        if not LANGUAGE_CODE.match(body.language):
            raise HTTPException(status_code=400, detail="That is not a language code.")
        change["language"] = body.language
    if body.expressivity is not None:
        if not -2 <= body.expressivity <= 2:
            raise HTTPException(status_code=400, detail="Expressivity runs from -2 to 2.")
        change["expressivity"] = body.expressivity
    if body.keyterms is not None:
        terms: list[str] = []
        for term in (" ".join(raw.split()) for raw in body.keyterms):
            if term and term.lower() not in {known.lower() for known in terms}:
                terms.append(term)
        if len(terms) > MAX_KEYTERMS or any(len(term) > MAX_KEYTERM_LENGTH for term in terms):
            raise HTTPException(
                status_code=400, detail=f"Use at most {MAX_KEYTERMS} key terms of at most {MAX_KEYTERM_LENGTH} characters.")
        change["keyterms"] = terms
    if not change:
        raise HTTPException(status_code=400, detail="Nothing to change.")

    from hermes_cli.config import load_config, save_config

    config = load_config()
    section = dict(config.get("deepgram_live") or {})
    section.update(change)
    config["deepgram_live"] = section
    save_config(config)
    return status()
