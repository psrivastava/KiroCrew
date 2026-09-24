"""Unit tests for the Claude CLI native-session reader.

Covers the projection of ``~/.claude/projects/<slug>/<uuid>.jsonl`` into sidebar
rows: id/cwd/title/timestamp extraction across the content shapes the CLI emits,
cwd-based grouping with the slug fallback, redaction of transcript-derived
strings, skipping of non-transcript files, and the absent-store case.
"""

from __future__ import annotations

import json
from pathlib import Path

from kiro_crew.providers.claude_sessions import (
    claude_projects_root,
    list_claude_sessions,
)


def _write_session(root: Path, slug: str, uuid: str, records: list[dict]) -> Path:
    d = root / ".claude" / "projects" / slug
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{uuid}.jsonl"
    f.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
    return f


def test_absent_store_returns_empty(tmp_path: Path) -> None:
    # No ~/.claude/projects at all -> [] (Claude just has no history), not a raise.
    assert list_claude_sessions(home=tmp_path) == []


def test_projects_root_honors_config_dir(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "custom"))
    assert claude_projects_root() == tmp_path / "custom" / "projects"
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    assert claude_projects_root(home=tmp_path) == tmp_path / ".claude" / "projects"


def test_basic_projection_fields(tmp_path: Path) -> None:
    _write_session(
        tmp_path,
        "-Users-alice-proj",
        "11111111-1111-1111-1111-111111111111",
        [
            {
                "type": "user",
                "content": "fix the build",
                "cwd": "/Users/alice/proj",
                "timestamp": "2026-09-01T10:00:00Z",
                "sessionId": "11111111-1111-1111-1111-111111111111",
            },
            {"type": "assistant", "content": "done", "timestamp": "2026-09-01T10:01:00Z"},
        ],
    )
    rows = list_claude_sessions(home=tmp_path)
    assert len(rows) == 1
    r = rows[0]
    assert r["session_id"] == "11111111-1111-1111-1111-111111111111"
    assert r["key"] == r["session_id"]
    assert r["source"] == "claude-cli"
    assert r["cwd"] == "/Users/alice/proj"
    assert r["title"] == "fix the build"
    assert r["first_timestamp"] == "2026-09-01T10:00:00Z"
    assert r["last_timestamp"] == "2026-09-01T10:01:00Z"


def test_title_from_message_content_list(tmp_path: Path) -> None:
    # The block-list content shape some CLI versions emit.
    _write_session(
        tmp_path,
        "-Users-alice-proj",
        "22222222-2222-2222-2222-222222222222",
        [
            {
                "type": "user",
                "message": {
                    "content": [
                        {"type": "text", "text": "hello "},
                        {"type": "text", "text": "world"},
                    ]
                },
                "cwd": "/Users/alice/proj",
                "timestamp": "2026-09-02T10:00:00Z",
            },
        ],
    )
    rows = list_claude_sessions(home=tmp_path)
    assert rows[0]["title"] == "hello  world"


def test_cwd_fallback_from_slug_when_absent(tmp_path: Path) -> None:
    # No record carries cwd -> fall back to the slugified dir name.
    _write_session(
        tmp_path,
        "-Users-bob-code",
        "33333333-3333-3333-3333-333333333333",
        [{"type": "user", "content": "hi", "timestamp": "2026-09-03T10:00:00Z"}],
    )
    rows = list_claude_sessions(home=tmp_path)
    assert rows[0]["cwd"] == "/Users/bob/code"


def test_empty_and_garbage_files_skipped(tmp_path: Path) -> None:
    d = tmp_path / ".claude" / "projects" / "-Users-alice"
    d.mkdir(parents=True)
    (d / "empty.jsonl").write_text("", encoding="utf-8")
    (d / "garbage.jsonl").write_text("not json\n{also bad\n", encoding="utf-8")
    assert list_claude_sessions(home=tmp_path) == []


def test_grouping_and_newest_first(tmp_path: Path) -> None:
    import os
    import time

    f1 = _write_session(
        tmp_path,
        "-Users-a-one",
        "aaaaaaaa-0000-0000-0000-000000000001",
        [
            {
                "type": "user",
                "content": "one",
                "cwd": "/Users/a/one",
                "timestamp": "2026-09-01T00:00:00Z",
            }
        ],
    )
    f2 = _write_session(
        tmp_path,
        "-Users-a-two",
        "bbbbbbbb-0000-0000-0000-000000000002",
        [
            {
                "type": "user",
                "content": "two",
                "cwd": "/Users/a/two",
                "timestamp": "2026-09-02T00:00:00Z",
            }
        ],
    )
    # Make f2 newer so it sorts first.
    now = time.time()
    os.utime(f1, (now - 100, now - 100))
    os.utime(f2, (now, now))
    rows = list_claude_sessions(home=tmp_path)
    assert [r["cwd"] for r in rows] == ["/Users/a/two", "/Users/a/one"]


def test_redaction_of_title_and_cwd(tmp_path: Path) -> None:
    # A credential-looking token in the title must be scrubbed before it reaches
    # a dashboard surface (same contract as the native session list).
    secret = "ghp_" + "a" * 36
    _write_session(
        tmp_path,
        "-Users-alice-proj",
        "44444444-4444-4444-4444-444444444444",
        [
            {
                "type": "user",
                "content": f"use token {secret} please",
                "cwd": "/Users/alice/proj",
                "timestamp": "2026-09-04T10:00:00Z",
            }
        ],
    )
    rows = list_claude_sessions(home=tmp_path)
    assert secret not in rows[0]["title"]
