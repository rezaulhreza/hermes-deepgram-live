"""REST routes for the desktop live-voice plugin, mounted at ``/api/plugins/deepgram-live``.

The Deepgram API key never reaches the desktop renderer: each socket the renderer opens is
authorised with a short-lived token minted here (``POST /v1/auth/grant``). Deepgram only checks
the token during the WebSocket handshake, so a 30 second token is enough for a long session.
"""

from __future__ import annotations

import importlib.util
import logging
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
    "voice": "aura-2-thalia-en",
    "listen_model": "flux-general-en",
    # Confidence at which the listening model calls the user's turn finished; lower answers sooner, higher
    # tolerates mid-sentence pauses.
    "eot_threshold": 0.7,
    # Silence that ends a turn regardless of confidence.
    "eot_timeout_ms": 3000,
    "speed": 1.0,
    "keyterms": ["Hermes"],
    # Hand the long-lived key to the renderer when the key cannot mint tokens (it lacks the
    # Member role). Off by default: with it on, the key is held in the app's memory.
    "allow_key_fallback": False,
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


def _api_key() -> str:
    from hermes_cli.config import get_env_value

    return (get_env_value("DEEPGRAM_API_KEY") or "").strip()


@router.get("/status")
def status() -> dict[str, Any]:
    """Non-secret readiness and the session settings the desktop half connects with."""
    settings = _settings()
    available = bool(_api_key())
    return {
        "available": available,
        "reason": None if available else "DEEPGRAM_API_KEY is not set in the Hermes .env",
        **{key: settings[key] for key in ("voice", "listen_model", "eot_threshold", "eot_timeout_ms", "speed", "keyterms")},
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
