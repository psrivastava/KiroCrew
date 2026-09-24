"""Unit tests for the Claude CLI session metadata overlay.

Covers the CCrew-side sidecar (title/pin/tags/color keyed by native UUID):
validation + coercion, clear-on-empty, atomic persistence round-trip, and the
apply_overlay merge onto session rows (custom-title override, pin sort).
"""

from __future__ import annotations

import pytest

import kiro_crew.providers.claude_session_overlay as ov


@pytest.fixture(autouse=True)
def _isolated_home(tmp_path, monkeypatch):
    # Point config_dir() at a temp dir so the overlay writes nowhere real.
    monkeypatch.setattr(ov, "config_dir", lambda: tmp_path)
    return tmp_path


def test_absent_overlay_is_empty():
    assert ov.load_overlay() == {}


def test_set_and_read_back():
    ov.update_entry(
        "uuid-1", {"title": "My rename", "pinned": True, "tags": ["a", "b"], "color": "#84cc16"}
    )
    data = ov.load_overlay()
    assert data["uuid-1"] == {
        "title": "My rename",
        "pinned": True,
        "tags": ["a", "b"],
        "color": "#84cc16",
    }


def test_clear_fields_with_empty_values():
    ov.update_entry("u", {"title": "T", "pinned": True, "color": "#fff", "tags": ["x"]})
    # Empty string / False / [] clear their fields.
    ov.update_entry("u", {"title": "", "pinned": False, "color": "", "tags": []})
    assert ov.load_overlay().get("u", {}) == {}


def test_partial_update_preserves_other_fields():
    ov.update_entry("u", {"title": "Keep", "pinned": True})
    ov.update_entry("u", {"color": "#123456"})  # touch only color
    entry = ov.load_overlay()["u"]
    assert entry["title"] == "Keep"
    assert entry["pinned"] is True
    assert entry["color"] == "#123456"


def test_coercion_rejects_garbage():
    # Non-dict entry, bad types → dropped, not raised.
    ov.update_entry("u", {"title": 123, "pinned": "yes", "tags": "notalist", "color": 5})
    assert ov.load_overlay().get("u", {}) == {}


def test_tags_and_title_bounded():
    long_title = "x" * 500
    many_tags = [f"t{i}" for i in range(50)]
    ov.update_entry("u", {"title": long_title, "tags": many_tags})
    entry = ov.load_overlay()["u"]
    assert len(entry["title"]) <= ov._TITLE_MAX
    assert len(entry["tags"]) <= ov._TAGS_MAX


def test_apply_overlay_merges_and_sorts():
    ov.update_entry("b", {"pinned": True})
    ov.update_entry("a", {"title": "Renamed A", "color": "#abcdef", "tags": ["z"]})
    rows = [
        {"session_id": "a", "title": "orig A", "mtime": 200.0},
        {"session_id": "b", "title": "orig B", "mtime": 100.0},
        {"session_id": "c", "title": "orig C", "mtime": 300.0},
    ]
    out = ov.apply_overlay(rows)
    by_id = {r["session_id"]: r for r in out}
    # Custom title overrides, original kept as cli_title.
    assert by_id["a"]["title"] == "Renamed A"
    assert by_id["a"]["cli_title"] == "orig A"
    assert by_id["a"]["tags"] == ["z"]
    assert by_id["a"]["color"] == "#abcdef"
    # Overlay-less row gets empty defaults.
    assert by_id["c"]["pinned"] is False
    assert by_id["c"]["tags"] == []
    # Pinned 'b' sorts first despite lowest mtime; rest newest-first.
    assert out[0]["session_id"] == "b"
    assert [r["session_id"] for r in out[1:]] == ["c", "a"]
