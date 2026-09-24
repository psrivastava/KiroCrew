"""Read the Claude Code CLI's OWN session store for the sidebar.

CCrew is a UI skin over the ``claude`` CLI, so a conversation the user started
from a bare terminal must be listable here, and one opened here must resume the
SAME native session. Claude Code keeps its transcripts as flat JSONL, one file
per session, grouped in a directory per working directory:

    ~/.claude/projects/<cwd-with-slashes-as-dashes>/<session-uuid>.jsonl

This reader enumerates those files and projects each into a row shaped like the
native ``/api/sessions`` rows the sidebar already renders, tagged
``source="claude-cli"`` so the frontend can group them in their own section.

It is READ-ONLY. Nothing here writes into ``~/.claude`` -- true bidirectionality
comes for free because CCrew drives the real ``claude`` binary against the real
cwd, so a CCrew-created Claude session already lands in this same store. The
UI-side naming / folders / arrangement is a CCrew overlay stored separately and
is never written back (a bare ``claude`` run does not need it).

Only Claude is handled here. Codex's Amazon build keeps sessions in SQLite, which
is unsafe to read/write as a sidebar source, so it is deliberately out of scope.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

# Same import path the native session-list handler uses
# (kiro_crew.dashboard.handlers.session_storage): these are re-exported from the
# security package, not its redaction submodule.
from kiro_crew.security import redact_credentials, redact_exfiltration_urls

logger = logging.getLogger(__name__)

_TITLE_MAX = 80
_SCAN_FILE_LIMIT = 2000  # bound the enumeration on a huge store (cheap metadata scan)


def claude_projects_root(home: Path | None = None) -> Path:
    """The ``projects/`` dir under the Claude Code config home.

    Honors ``CLAUDE_CONFIG_DIR`` the way the CLI itself does; otherwise
    ``~/.claude``. ``home`` overrides the OS home (tests).
    """
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    if override:
        return Path(override).expanduser() / "projects"
    base = home if home is not None else Path.home()
    return base / ".claude" / "projects"


def _redact(text: str) -> str:
    """Scrub a transcript-derived string before it reaches a dashboard surface.

    Title and cwd both originate in user content / the user's filesystem, so
    both pass through the same two scrubbers, in the same order, that the native
    session list uses.
    """
    if not text:
        return text
    cleaned, _ = redact_exfiltration_urls(text)
    cleaned, _ = redact_credentials(cleaned)
    return cleaned


def _extract_title(record: dict[str, Any]) -> str | None:
    """Pull a human title from a single JSONL record, if it carries one.

    A user message is the best title source. The Claude store nests content in a
    couple of shapes across CLI versions (a bare ``content`` string, a
    ``message.content`` string, or a list of ``{"type":"text","text":...}``
    blocks), so handle all three rather than assume one.
    """
    if record.get("type") != "user":
        return None
    content: Any = record.get("content")
    if content is None:
        msg = record.get("message")
        if isinstance(msg, dict):
            content = msg.get("content")
    if isinstance(content, list):
        parts = [
            blk.get("text", "")
            for blk in content
            if isinstance(blk, dict) and blk.get("type") == "text"
        ]
        content = " ".join(p for p in parts if p)
    if isinstance(content, str):
        text = content.strip()
        if text:
            return text[:_TITLE_MAX]
    return None


def _project_one(path: Path) -> dict[str, Any] | None:
    """Project one ``<uuid>.jsonl`` transcript into a sidebar row.

    Reads line by line and stops extracting the title once found, but must read
    to the end for the last timestamp -- the file is one session, typically
    small. Returns ``None`` for an empty/garbage file so it is simply omitted.
    """
    session_id = path.stem
    cwd: str | None = None
    title: str | None = None
    first_ts: str | None = None
    last_ts: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(rec, dict):
                    continue
                ts = rec.get("timestamp")
                if isinstance(ts, str):
                    if first_ts is None:
                        first_ts = ts
                    last_ts = ts
                if cwd is None and isinstance(rec.get("cwd"), str):
                    cwd = rec["cwd"]
                if title is None:
                    title = _extract_title(rec)
    except OSError:
        logger.debug("claude session unreadable: %s", path, exc_info=True)
        return None
    if first_ts is None and title is None and cwd is None:
        return None  # not a real transcript
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    return {
        "key": session_id,
        "session_id": session_id,
        "title": _redact(title or ""),
        # The real absolute working directory the session ran in -- the folder
        # grouping key. Falls back to the slugified dir name via the caller.
        "cwd": _redact(cwd or ""),
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "mtime": mtime,
        "source": "claude-cli",
        "path": str(path),
    }


def _unslug_dir_name(name: str) -> str:
    """Best-effort recover a cwd from a Claude project dir name.

    Claude slugifies the cwd by replacing ``/`` with ``-`` (e.g.
    ``-Users-srivpra-Work-RiverUI``). This is lossy (a real ``-`` in a path is
    indistinguishable from a separator), so it is ONLY a fallback for grouping
    when no record in the file carried an explicit ``cwd``.
    """
    if not name:
        return ""
    return "/" + name.lstrip("-").replace("-", "/")


def list_claude_sessions(home: Path | None = None, limit: int = _SCAN_FILE_LIMIT) -> list[dict]:
    """List the Claude CLI's native sessions, newest first.

    Each row is tagged ``source="claude-cli"`` and carries the session UUID
    (``session_id``), a redacted title, the working directory (``cwd``, used for
    folder grouping), timestamps and mtime. Returns ``[]`` when the store is
    absent -- Claude simply has no history yet -- rather than raising.
    """
    root = claude_projects_root(home)
    if not root.is_dir():
        return []
    rows: list[dict] = []
    try:
        project_dirs = sorted(root.iterdir())
    except OSError:
        logger.debug("claude projects root unreadable: %s", root, exc_info=True)
        return []
    for proj in project_dirs:
        if not proj.is_dir():
            continue
        fallback_cwd = _unslug_dir_name(proj.name)
        try:
            files = list(proj.glob("*.jsonl"))
        except OSError:
            continue
        for f in files:
            row = _project_one(f)
            if row is None:
                continue
            if not row["cwd"]:
                row["cwd"] = _redact(fallback_cwd)
            rows.append(row)
            if len(rows) >= limit:
                break
        if len(rows) >= limit:
            break
    # Newest first by mtime -- matches how the native list is ordered for recency.
    rows.sort(key=lambda r: r.get("mtime") or 0.0, reverse=True)
    return rows
