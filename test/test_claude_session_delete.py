"""Unit tests for permanently deleting native Claude CLI sessions.

For a native claude session there is NO intermediate archive: "close" is a
confirm-gated permanent delete (``claude_sessions.delete_claude_session``) that
unlinks the native ``.jsonl`` under the projects root and drops the overlay
entry (``claude_session_overlay.forget_entry``).

The delete tests run against a TEMP claude home (via ``CLAUDE_CONFIG_DIR``), so
they never read or mutate a real ``~/.claude`` store.
"""

from __future__ import annotations

import json

import pytest

import kiro_crew.providers.claude_session_overlay as ov
import kiro_crew.providers.claude_sessions as cs


@pytest.fixture(autouse=True)
def _isolated_overlay_home(tmp_path, monkeypatch):
    monkeypatch.setattr(ov, "config_dir", lambda: tmp_path)
    return tmp_path


@pytest.fixture
def claude_home(tmp_path, monkeypatch):
    """A temp claude store with one project dir and two session files."""
    root = tmp_path / "claude_home" / ".claude" / "projects"
    proj = root / "-Users-srivpra-work-CCrew"
    proj.mkdir(parents=True)

    def _write_session(uuid: str, cwd: str, text: str) -> None:
        rec = {
            "type": "user",
            "cwd": cwd,
            "timestamp": "2026-09-24T05:00:00Z",
            "message": {"content": text},
        }
        (proj / f"{uuid}.jsonl").write_text(json.dumps(rec) + "\n", encoding="utf-8")

    _write_session("uuid-keep", "/Users/srivpra/work/CCrew", "keep me")
    _write_session("uuid-del", "/Users/srivpra/work/CCrew", "delete me")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude_home" / ".claude"))
    return tmp_path / "claude_home" / ".claude"


# ---- DELETE (destructive: unlinks the native .jsonl) ---------------------


def test_delete_unlinks_native_file(claude_home):
    target = claude_home / "projects" / "-Users-srivpra-work-CCrew" / "uuid-del.jsonl"
    keep = claude_home / "projects" / "-Users-srivpra-work-CCrew" / "uuid-keep.jsonl"
    assert target.is_file()
    assert cs.delete_claude_session("uuid-del") is True
    assert not target.exists()
    # Only the targeted session goes; siblings are untouched.
    assert keep.is_file()


def test_delete_missing_session_is_false(claude_home):
    assert cs.delete_claude_session("uuid-does-not-exist") is False


def test_delete_rejects_path_traversal(claude_home):
    # A hostile uuid with separators / traversal never resolves to a path.
    assert cs.find_claude_session_path("../../../etc/passwd") is None
    assert cs.find_claude_session_path("..") is None
    assert cs.find_claude_session_path("a/b") is None
    assert cs.delete_claude_session("../../../etc/passwd") is False


def test_find_path_is_contained(claude_home):
    p = cs.find_claude_session_path("uuid-keep")
    assert p is not None
    root = cs.claude_projects_root().resolve()
    assert root in p.parents


def test_forget_entry_drops_overlay():
    ov.update_entry("gone", {"title": "T", "pinned": True})
    assert ov.forget_entry("gone") is True
    assert ov.load_overlay().get("gone") is None
    # Idempotent: forgetting an absent entry is False, not an error.
    assert ov.forget_entry("gone") is False
