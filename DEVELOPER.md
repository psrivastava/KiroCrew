# CCrew — Developer Guide (fork divergences & design)

> **What this file is.** CCrew is a downstream fork of [KiroCrew](https://github.com/kirodotdev/KiroCrew)
> re-skinned as a **UI over the `claude` and `codex` CLIs**. This document records
> everything this fork adds or changes on top of upstream, why, and the design
> approach — so a reviewer can understand the delta at a glance, and so the fork
> can be re-based on future upstream pulls without re-deriving intent.
>
> **Branch:** `ccrew-claude-codex` · **Fork base:** upstream commit `64f3b5811`
> (`fix(test): drop the stale 501-until-diag premise from test_mcp_debug (#12865)`).

---

## 1. Guiding principles

1. **Additive over invasive.** Prefer new files (a launcher, a component, a
   provider module, endpoints) over edits to shared upstream code, so
   `git pull upstream` stays conflict-free. Where an edit to a shared file is
   unavoidable, keep it minimal and localized.
2. **Never touch upstream's own data stores.** CCrew reads `~/.claude` but never
   writes into it. CCrew-side concepts (titles, pins, tags, colors) live in a
   **separate sidecar** under CCrew's own data home.
3. **Run alongside an installed KiroCrew, not on top of it.** Distinct profile,
   data home, and port so the two never collide.
4. **Honor the upstream contracts.** i18n catalog parity (all 12 locales +
   en-XA), `lucide-inline` icons, design tokens (no literal colors), React Query
   for fetching, `ErrorNotice` for errors, no user-facing hardcoded English.

---

## 2. Runtime / packaging divergences

| Area | Upstream | CCrew | Where |
|---|---|---|---|
| Launcher | `kirocrew gateway` | `./ccrew.sh` — forces `KIROCREW_PROFILE=standalone`, `KIROCREW_HOME=~/.ccrew`, `KIROCREW_PORT=5490` | `ccrew.sh` (new, additive) |
| Profile | inherited | **forced** `standalone` (OSS fork has no enterprise companion; a non-standalone marker fails closed at boot) | `ccrew.sh` |
| Data home | `~/.kiro/crew` | `~/.ccrew` (isolated sessions/config/memory) | `ccrew.sh` |
| Port | 5476 | 5490 | `ccrew.sh` |
| Desktop app | "Kiro Crew" | **"C Crew"**, appId `com.ccrew.app`, forces standalone in the packaged gateway, `CCREW_ALLOW_UNAUTH_VOICE=1` to pass the ffmpeg voice-decoder gate (irrelevant to a claude/codex skin) | `packaging/build-desktop.sh`, electron config |
| Branding | "Kiro Crew" wordmark | **"C CREW"** wordmark via `dashboard.bot_name` in `~/.ccrew/config.json` (the `/api/branding` endpoint reads `dashboard.bot_name`, NOT `agent.bot_name`) | config only |

CLI credentials (`~/.claude`, `~/.codex`, kiro-cli's) live **outside** the data
home, so isolating `KIROCREW_HOME` does not re-prompt any login — both apps share
the same CLI sign-ins.

---

## 3. UI features added

### 3.1 Lime glyph tint
The sidebar ghost glyph is a raster `logo.png` (purple), so it can't be recolored
by a token. A `.ccrew-logo-tint` CSS class hue-rotates it to lime on both glyph
`<img>` sites. Reversible, no new asset.
- `website/src/index.css` (`.ccrew-logo-tint`), applied in `website/src/App.tsx`.

### 3.2 Active-backend chip
The chat only ever showed the **agent-spec name** ("default") — never the ACP
**backend** (claude / codex / kiro), which lived only in Developer → Agent
Backend. These are two independent axes, which is why switching the backend never
changed the "default" label. The `BackendChip` sits beside the agent label in the
composer shelf, names the live backend, turns green (`--ok`) when a CLI backend is
driving, and click-navigates to `/developer?tab=agent-backend`.
- `website/src/components/BackendChip.tsx`; wired in `ChatInput` (in `App.tsx`).

### 3.3 Claude CLI sessions in the sidebar (first-class)
A dedicated, self-contained sidebar section listing the claude CLI's **own**
native sessions (started from a bare terminal), grouped by working directory,
below CCrew's own sessions. Rows are clickable, scrollable, and carry CCrew
overlay metadata + a context menu.
- Frontend: `website/src/components/ClaudeCliSessions.tsx` (rendered by
  `ChatSidebar`).
- **Not** merged into CCrew's own history/"Older Sessions" list — that is a
  CCrew-history-only data source (Redux `s.chat.history`, `closed=true` tabs) and
  has no knowledge of native `.jsonl` files.

---

## 4. Backend added (all additive modules + endpoints)

### 4.1 Native session reader
`src/kiro_crew/providers/claude_sessions.py` — enumerates
`~/.claude/projects/<slug>/<uuid>.jsonl` (honoring `CLAUDE_CONFIG_DIR`), projects
each into a sidebar row shaped like the native `/api/sessions` rows, redacts
titles/cwd through the same scrubbers the native list uses. **Read-only** for
listing. Codex is deliberately excluded (its Amazon build keeps sessions in
SQLite, unsafe to mirror as a sidebar source).

### 4.2 Metadata overlay (CCrew sidecar)
`src/kiro_crew/providers/claude_session_overlay.py` —
`<config_dir>/claude_session_overlay.json`, keyed by native UUID, holding
`title` / `pinned` / `tags` / `color`. Atomic tmp+rename write; tolerant reads
(corrupt file → empty overlay). `apply_overlay` merges onto rows (custom title
overrides, original kept as `cli_title`; pinned sorts first). `forget_entry`
drops an entry when the native session is deleted. **Never written into
`~/.claude`.** There is deliberately NO `archived` flag (see §4.4).

### 4.3 Resume-open (the round-trip that makes rows first-class)
`POST /api/claude-sessions/{uuid}/open` seeds a freshly-created CCrew slot's
resume sid = the native UUID (+ cwd + claude provider label) via
`SessionPool.remember_resume_sid`. The next `get_or_create` for that slot issues
ACP `session/load`, attaching to the **same** claude conversation — the native
`.jsonl` and the CCrew slot then share one transcript (true bidirectionality).
- Seam chain: `client.set_resume_session_id` → `session/load` (when
  `_can_load_session`); `session_allocation.py` pulls the resume sid from
  `session_map`; `SessionPool.remember_resume_sid` wraps `session_map.set`.

### 4.4 Close = confirm-gated delete (no archive)
Regular CCrew sessions distinguish close (archive to history) from delete
(permanent). A native claude session has NO CCrew history lane to be archived
into, so that distinction collapses: **for a CLI session, "close" IS a
confirm-gated permanent delete.** There is deliberately no intermediate archive
state (decided after weighing it — an "Archived" subsection would have duplicated
the concept of the existing CCrew-only "Older Sessions" section without being
able to share it).
- **Delete** = **permanent** unlink of the native `.jsonl`
  (`claude_sessions.delete_claude_session` + `overlay.forget_entry`), via
  `DELETE /api/claude-sessions/{uuid}`, path re-resolved server-side from the UUID
  and containment-checked against the projects root (no traversal). UI-gated
  behind an inline confirm because it destroys the user's own claude data.
- The regular-session `_close_slot` (archive to CCrew history) and
  `_delete_history_session` (permanent CCrew-transcript unlink) do **not** apply
  to a native claude session, which has no CCrew transcript/history record.

### 4.5 Endpoints & routes
Handlers in `src/kiro_crew/dashboard/handlers/sessions.py`, registered in
`src/kiro_crew/dashboard/routes/system.py`:
- `GET  /api/claude-sessions` — list (reader + overlay merge)
- `PATCH  /api/claude-sessions/{uuid}` — set overlay (title/pin/tags/color)
- `POST /api/claude-sessions/{uuid}/open` — seed resume sid onto a slot
- `DELETE /api/claude-sessions/{uuid}` — permanent native delete + overlay forget

---

## 5. Tests

- `test/test_claude_session_overlay.py` — overlay validation/coercion, clear-on-
  empty, atomic round-trip, `apply_overlay` merge/sort.
- `test/test_claude_session_delete.py` — permanent native delete against a
  **temp** `CLAUDE_CONFIG_DIR`, path-traversal rejection, containment,
  `forget_entry`.
- `test/test_claude_sessions.py` — reader.

Frontend verification: `tsc`, `eslint`, `vite build`, and the i18n catalog-parity
suite (must stay all-locales-green).

---

## 6. Constraints a future change must respect

- **i18n is all-or-nothing.** A new key must land in `en.manual.json` (for
  programmatic labels with no source literal) AND all 11 translation locales +
  `en-XA`. Avoid `{{count}}` in a flat key — it triggers plural-forms parity
  needing `_one`/`_other` per locale. Cheapest path: reuse an existing key (brand
  nouns like Claude/Codex are untranslated proper nouns).
- **`dashboard.bot_name` drives the wordmark**, not `agent.bot_name`.
- **Icons:** `lucide-react` + `className="lucide-inline"`, never `size={N}` in
  new code (a couple of shelf siblings use `size` as a local exception).
- **Colors:** design tokens only (`--ok`, `--danger`, `--accent`, …).
- **Big files:** `ClaudeCliSessions.tsx` is self-contained on purpose — keep CLI-
  session logic there rather than surgically editing the ~9600-line `ChatSidebar`.
- **Never delete native `~/.claude` files except through the confirm-gated
  delete endpoint**, which re-resolves the path server-side.

---

## 7. Open / pending

- **Live round-trip verification:** the resume-open wiring is unit-safe but the
  end-to-end "click a CLI row → attaches to the same claude conversation" needs a
  live `./ccrew.sh` turn to confirm.
- **Phase 2 permission mapping:** Normal/Reads/Trust/YOLO → CLI, needs a live turn.

---

## 8. Build & run

```bash
# Dev gateway (http://127.0.0.1:5490)
./ccrew.sh

# Rebuild frontend only, then stage into the backend static dir
cd website && npm run build
cd .. && rm -rf src/kiro_crew/static/dist && cp -R website/dist src/kiro_crew/static/dist

# Desktop .app + DMG (from a terminal; needs Node 22 on PATH)
PATH="$HOME/.local/share/mise/installs/node/22.23.2/bin:$PATH" \
  UNIVERSAL=0 CCREW_ALLOW_UNAUTH_VOICE=1 bash packaging/build-desktop.sh
# → website/electron/dist/mac-arm64/

# Backend tests for the CLI-session feature
.venv/bin/python -m pytest test/test_claude_session*.py -q
```
