"""Which user turns were spoken, shared between the REST routes and the turn hook.

The desktop half announces a transcript just before it submits it; the ``pre_llm_call`` hook
claims the matching turn and adds the spoken-reply note. State lives in a small file under
HERMES_HOME rather than in memory because the two sides are loaded as separate modules and a
turn may run in a different process from the one serving REST (isolated compute host).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path

# A spoken turn is submitted within moments of being announced; anything older is stale.
MAX_AGE_SECONDS = 120
MAX_ENTRIES = 16


def _path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "cache" / "deepgram-live" / "pending.json"


def _digest(text: str) -> str:
    return hashlib.sha256(" ".join(text.split()).lower().encode("utf-8")).hexdigest()


def _read(path: Path) -> list[dict]:
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    now = time.time()
    return [e for e in entries if isinstance(e, dict) and now - float(e.get("t", 0)) < MAX_AGE_SECONDS]


def _write(path: Path, entries: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(entries[-MAX_ENTRIES:], handle)
    os.replace(tmp, path)


def announce(text: str) -> None:
    """Record that ``text`` is about to arrive as a spoken user turn."""
    path = _path()
    _write(path, [*_read(path), {"h": _digest(text), "t": time.time()}])


def claim(text: str) -> bool:
    """True once for a turn that was announced as spoken."""
    path = _path()
    entries = _read(path)
    digest = _digest(text)
    for index, entry in enumerate(entries):
        if entry.get("h") == digest:
            del entries[index]
            _write(path, entries)
            return True
    return False
