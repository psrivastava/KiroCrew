"""CCrew-side metadata overlay for native Claude CLI sessions.

The claude CLI stores its sessions as bare JSONL under ``~/.claude/projects``
with no room for CCrew concepts (a custom title, pin, tags, color). CCrew is a
UI skin over that CLI, so those affordances live HERE, in a sidecar keyed by the
native session UUID, under CCrew's own data home (``config_dir()``):

    <config_dir>/claude_session_overlay.json
    { "<uuid>": {"title": str, "pinned": bool, "tags": [str], "color": str}, ... }

This is a pure OVERLAY: it is never written back into ``~/.claude`` (a bare
``claude`` run has nowhere to read it, and keeping upstream's store untouched is
deliberate), and it enriches the sidebar row without altering the conversation.
The native transcript remains the source of truth for the session itself.

Atomic tmp+rename write, mirroring session_map's durability pattern. Reads
tolerate a missing/corrupt file by returning an empty overlay rather than
raising — a lost overlay costs cosmetics, never a session.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

from kiro_crew.config.paths import config_dir

logger = logging.getLogger(__name__)

OVERLAY_FILENAME = "claude_session_overlay.json"

# Bounds so a hand-edited or hostile overlay cannot bloat a row or the file.
_TITLE_MAX = 200
_TAG_MAX = 40
_TAGS_MAX = 16
# Colors are a fixed CCrew palette (hex) or the empty string (no color). A free
# string is stored as-is but capped, so a bad value degrades to an ignored style.
_COLOR_MAX = 32


def overlay_path() -> Path:
    return config_dir() / OVERLAY_FILENAME


def _coerce_entry(raw: Any) -> dict[str, Any] | None:
    """Validate + normalize one overlay entry; None if nothing usable."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    title = raw.get("title")
    if isinstance(title, str) and title.strip():
        out["title"] = title.strip()[:_TITLE_MAX]
    if raw.get("pinned") is True:
        out["pinned"] = True
    tags = raw.get("tags")
    if isinstance(tags, list):
        clean = [t.strip()[:_TAG_MAX] for t in tags if isinstance(t, str) and t.strip()]
        if clean:
            out["tags"] = clean[:_TAGS_MAX]
    color = raw.get("color")
    if isinstance(color, str) and color.strip():
        out["color"] = color.strip()[:_COLOR_MAX]
    return out or None


def load_overlay() -> dict[str, dict[str, Any]]:
    """Read the whole overlay map (uuid -> metadata). Empty on absence/corruption."""
    p = overlay_path()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for uuid, entry in raw.items():
        if not isinstance(uuid, str):
            continue
        coerced = _coerce_entry(entry)
        if coerced is not None:
            out[uuid] = coerced
    return out


def _write_overlay(data: dict[str, dict[str, Any]]) -> None:
    """Atomic tmp+rename write of the overlay map."""
    p = overlay_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".overlay-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, str(p))
    except OSError:
        logger.warning("failed to write claude session overlay", exc_info=True)
        try:
            os.unlink(tmp)
        except OSError:
            pass


def update_entry(uuid: str, patch: dict[str, Any]) -> dict[str, Any]:
    """Merge *patch* into the overlay entry for *uuid*; return the stored entry.

    A field set to ``None`` (or, for a string, ``""``) CLEARS it, so the UI can
    un-rename / un-color. ``pinned: False`` and ``tags: []`` clear likewise.
    Returns the resulting (validated) entry, which may be empty.
    """
    data = load_overlay()
    current = dict(data.get(uuid, {}))
    for k, v in patch.items():
        if k not in ("title", "pinned", "tags", "color"):
            continue
        if v is None or (isinstance(v, str) and not v.strip()) or v is False or v == []:
            current.pop(k, None)
        else:
            current[k] = v
    coerced = _coerce_entry(current)
    if coerced is None:
        data.pop(uuid, None)
        result: dict[str, Any] = {}
    else:
        data[uuid] = coerced
        result = coerced
    _write_overlay(data)
    return result


def apply_overlay(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge overlay metadata onto session rows (from claude_sessions.list_*).

    Adds ``pinned``/``tags``/``color`` and, when the overlay carries a custom
    ``title``, overrides the transcript-derived one (keeping the original as
    ``cli_title`` so the UI can show provenance if it wants). Pinned rows sort
    to the front, newest-first within each partition.
    """
    overlay = load_overlay()
    for r in rows:
        entry = overlay.get(r.get("session_id", ""))
        if not entry:
            r["pinned"] = False
            r["tags"] = []
            r["color"] = ""
            continue
        if entry.get("title"):
            r["cli_title"] = r.get("title", "")
            r["title"] = entry["title"]
        r["pinned"] = bool(entry.get("pinned"))
        r["tags"] = list(entry.get("tags", []))
        r["color"] = entry.get("color", "")
    rows.sort(key=lambda r: (0 if r.get("pinned") else 1, -(r.get("mtime") or 0.0)))
    return rows
