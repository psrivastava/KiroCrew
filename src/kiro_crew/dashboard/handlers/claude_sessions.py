"""HTTP routes for the Claude CLI's own native sessions (CCrew).

The sidebar lists the ``claude`` CLI's sessions under ``~/.claude`` beside Crew's
own conversations. These four routes read that store, keep CCrew's metadata
overlay for it, open a native session in a Crew slot, and delete one after
confirmation. See ``DEVELOPER.md`` sections 3.3 and 4.
"""

from __future__ import annotations

import asyncio

from aiohttp import web

from kiro_crew.dashboard.state import DashboardState


async def api_claude_sessions(request: web.Request) -> web.Response:
    """GET /api/claude-sessions — list the Claude CLI's OWN native sessions.

    Separate from ``/api/sessions`` (CCrew's own conversations) on purpose: this
    reads the ``claude`` CLI's flat-JSONL store under ``~/.claude/projects`` so
    the sidebar can show a distinct "Claude CLI" grouping. Additive endpoint —
    it does not touch the native list — to keep upstream merges clean.

    Query params:
      - ``limit``: max sessions (default 200, capped at 2000)

    Returns ``{sessions, total}``. Each row carries ``source="claude-cli"``, the
    session UUID (``session_id``), a redacted ``title`` and ``cwd`` (the folder
    grouping key), timestamps, and the CCrew overlay metadata (``pinned``,
    ``tags``, ``color``, and a custom ``title`` when set). The scan is synchronous
    file IO, so it runs off the event loop.
    """
    from kiro_crew.providers.claude_session_overlay import apply_overlay
    from kiro_crew.providers.claude_sessions import list_claude_sessions

    try:
        limit = min(int(request.query.get("limit", "200")), 2000)
    except (TypeError, ValueError):
        limit = 200

    def _read() -> list[dict]:
        return apply_overlay(list_claude_sessions(None, limit))

    rows = await asyncio.to_thread(_read)
    return web.json_response({"sessions": rows, "total": len(rows)})


async def api_claude_session_overlay(request: web.Request) -> web.Response:
    """PATCH /api/claude-sessions/{uuid} — set CCrew overlay metadata.

    Body: any of ``title`` (str, ""=clear), ``pinned`` (bool), ``tags`` (str[]),
    ``color`` (str, ""=clear). These are CCrew-side affordances stored in a
    sidecar keyed by the native UUID; nothing is written into ~/.claude. Returns
    the resulting entry.
    """
    from kiro_crew.providers.claude_session_overlay import OVERLAY_FIELDS, update_entry

    uuid = request.match_info.get("uuid", "")
    if not uuid:
        return web.json_response({"error": "missing uuid"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "body must be an object"}, status=400)
    patch = {k: body[k] for k in OVERLAY_FIELDS if k in body}
    entry = await asyncio.to_thread(update_entry, uuid, patch)
    return web.json_response({"uuid": uuid, "overlay": entry})


async def api_claude_session_open(request: web.Request) -> web.Response:
    """POST /api/claude-sessions/{uuid}/open — attach a CCrew slot to a native claude session.

    Seeds the resume session id of an EXISTING CCrew slot (the client creates a
    fresh slot first, via the normal new-chat flow, with project=cwd) so the slot
    resumes the native claude UUID: the next turn issues session/load and attaches
    to the SAME claude conversation. The native .jsonl and the CCrew slot then
    share one transcript — the round-trip that makes these rows first-class.

    Body: ``slot`` (REQUIRED — the freshly created slot key to bind) and,
    optionally, ``cwd`` (the session's working directory; looked up from the
    session's own transcript when omitted). Returns ``{slot, uuid, cwd}``.
    """
    from kiro_crew.acp.types import PROVIDER_LABEL_CLAUDE
    from kiro_crew.providers.claude_sessions import list_claude_sessions

    state: DashboardState = request.app["state"]
    uuid = request.match_info.get("uuid", "")
    if not uuid:
        return web.json_response({"error": "missing uuid"}, status=400)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "invalid json"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"error": "body must be an object"}, status=400)
    slot = body.get("slot")
    if not isinstance(slot, str) or not slot:
        return web.json_response({"error": "missing slot"}, status=400)
    cwd = body.get("cwd")

    # Resolve the session's cwd from its own transcript when the client did not
    # supply it — the resume must run claude in the SAME directory or the adapter
    # loads a session whose files are elsewhere.
    if not cwd:

        def _find_cwd() -> str:
            for r in list_claude_sessions(None, 2000):
                if r.get("session_id") == uuid:
                    return r.get("cwd") or ""
            return ""

        cwd = await asyncio.to_thread(_find_cwd)

    pool = getattr(state, "sessions", None)
    remember = getattr(pool, "remember_resume_sid", None)
    if remember is None:
        return web.json_response(
            {"error": "resume seeding is not available on this build"}, status=501
        )
    # Seed the slot's resume sid = the native claude UUID, with its cwd and the
    # claude provider label so a provider-switch check does not discard it. The
    # next get_or_create for this slot issues session/load and attaches to the
    # native conversation.
    remember(
        slot,
        uuid,
        provider=PROVIDER_LABEL_CLAUDE,
        cwd=cwd or "",
    )
    return web.json_response({"slot": slot, "uuid": uuid, "cwd": cwd})


async def api_claude_session_delete(request: web.Request) -> web.Response:
    """DELETE /api/claude-sessions/{uuid} — permanently delete a native session.

    DESTRUCTIVE and distinct from archiving (which is the reversible overlay flag
    set via PATCH ``archived``): this unlinks the native ``<uuid>.jsonl`` under
    ``~/.claude`` — the very file a bare ``claude`` terminal reads — and drops the
    CCrew overlay entry so no stale metadata lingers. The path is re-resolved
    server-side from the UUID and containment-checked against the projects root,
    so a crafted uuid cannot steer the unlink elsewhere. The frontend gates this
    behind an explicit confirm.

    Returns ``{uuid, deleted}`` where ``deleted`` is True when a file was removed,
    False when none was found (an already-gone session is not an error).
    """
    from kiro_crew.providers.claude_session_overlay import forget_entry
    from kiro_crew.providers.claude_sessions import delete_claude_session

    uuid = request.match_info.get("uuid", "")
    if not uuid:
        return web.json_response({"error": "missing uuid"}, status=400)

    def _delete() -> bool:
        removed = delete_claude_session(uuid)
        # Drop overlay metadata regardless — if the file is already gone, the
        # sidecar entry for it should not survive either.
        forget_entry(uuid)
        return removed

    deleted = await asyncio.to_thread(_delete)
    return web.json_response({"uuid": uuid, "deleted": deleted})
