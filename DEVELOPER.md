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
| Desktop app | "Kiro Crew" | **"CCrew"** (spaceless — avoids the electron-builder `CFBundleName` helper-app pitfall), appId `com.ccrew.app`. Built with `CCREW=1` (see §2.1) which bakes its own identity so it runs side-by-side with an installed KiroCrew. `CCREW_ALLOW_UNAUTH_VOICE=1` passes the ffmpeg voice-decoder gate (irrelevant to a claude/codex skin) | `packaging/build-desktop.sh`, electron config |
| Branding | "Kiro Crew" wordmark | **"CCREW"** wordmark (`bot_name` "CCrew", uppercased by the wordmark) via `dashboard.bot_name` in `~/.ccrew/config.json` (the `/api/branding` endpoint reads `dashboard.bot_name`, NOT `agent.bot_name`) | config only |

CLI credentials (`~/.claude`, `~/.codex`, kiro-cli's) live **outside** the data
home, so isolating `KIROCREW_HOME` does not re-prompt any login — both apps share
the same CLI sign-ins.

### 2.1 Desktop app identity (`CCREW=1`) — side-by-side coexistence

The dev launcher `./ccrew.sh` sets `KIROCREW_HOME`/`KIROCREW_PORT` as env vars,
but a **double-clicked `.app` inherits no shell env**. So the packaged CCrew app
must carry its own identity, or macOS treats it as the installed KiroCrew and
just fronts the running instance instead of launching (Electron keys
`requestSingleInstanceLock()` + `userData` off `app.name`, so a shared name = a
shared lock).

`CCREW=1 bash packaging/build-desktop.sh` fixes this by baking a runtime marker
into the packaged `app/package.json` (`electron-builder -c.extraMetadata.ccrew=true`).
At boot, `website/electron/ccrew-identity.js` reads that marker (env
`KIROCREW_CCREW=1` overrides it for a dev source run) and switches three axes so
the two apps never collide:

| Axis | KiroCrew | CCrew | Seam |
|---|---|---|---|
| `app.name` (→ lock + userData) | "Kiro Crew" | "CCrew" | `main.js` (`ccrewAppName()`) |
| Default data home | `~/.kiro/crew` | `~/.ccrew` | `home-dir.js` (`canonicalHome`) |
| Default gateway port | 5476 | 5490 | `main.js` (`resolvePort`) |
| Windows AppUserModelID | `com.amazon.kiro.crew` | `com.ccrew.app` | `main.js` |

An explicit `KIROCREW_HOME` override still wins over the CCrew default. A plain
source run or a hypothetical upstream desktop build has neither the baked flag
nor the env, so every KiroCrew default is untouched — the change is additive.

**Python-package caveat (not fixed, by design):** the fork still declares its pip
distribution as `name = "kirocrew"` (`pyproject.toml`), identical to upstream, so
`pip install`-ing the fork into a **shared** environment evicts-and-replaces
upstream KiroCrew ("Uninstalling kirocrew-0.8.0…"). This is harmless for the
packaged app (its gateway installs into an **isolated** bundled venv under
`backend-dist/`) and keeps the fork trivially mergeable. Always install the fork
into its own venv; a full `ccrew` distribution rename is possible but
merge-hostile and deferred.


### 2.2 Claude backend: skip Crew's seatbelt on macOS (sandbox nesting)

**Symptom:** every Claude turn failed with "connection failed — retry"; the
gateway log showed `sandbox initialization failed: Operation not permitted` /
`Failed to spawn child process (os error 22)`.

**Root cause:** Claude Code 2.1.29x force-enables its OWN macOS `sandbox-exec`
seatbelt around the process `claude-agent-acp` spawns. Crew ALSO wrapped that
spawn in Crew's seatbelt, because the Claude backend was not treated as carrying
its own OS sandbox. **macOS forbids nesting `sandbox-exec`** — the inner
`sandbox_apply` returns EPERM (`os error 22`) — so the child died before the
model. Reproduced directly: a trivial permissive `sandbox-exec` profile around
`claude` EPERMs; bare `claude` runs fine.

**Fix (PR #4):** on macOS, skip Crew's seatbelt for a harness that carries its
own non-nestable OS sandbox, and let that sandbox own the isolation.

| Seam | What it does |
|---|---|
| `ACP_BACKENDS_SKIP_CREW_SEATBELT_MACOS` | New capability set, `{claude}` only; `agent_sdk/backends.py`, re-exported via `acp_backends.py` + `acp/types.py` |
| `wrap_argv` / `wrap_argv_async` | New `skip_crew_seatbelt_macos` param; a **darwin-only** branch env-scrubs and returns WITHOUT the seatbelt |
| `acp/client.py` | Passes the flag by set membership at the Claude spawn |

Deliberately a **separate** set from `ACP_BACKENDS_INTERNAL_SANDBOX` (harness-
parity H6, one set per capability): that set carries the Windows no-backend
exception and is gated on kiro-cli's own `settings.json` sandbox key — neither
applies to Claude, and reusing it would silently grant Claude the Windows
exception it never earned.

**Tradeoff (accepted):** skipping Crew's seatbelt also drops Crew's credential
mask (`extra_hidden_dirs`) for that spawn — the skip holds even WITH hidden dirs,
because re-applying a seatbelt is the exact nesting EPERM, and a failed SEL audit
degrades to env-scrub rather than falling back to the seatbelt. Isolation of
`~/.aws` etc. then rests on Claude Code's own sandbox. The backend card states
this via the existing "Crew sandbox stands down" note (no new i18n key).

Inert off macOS: Linux namespace isolation and the Windows no-backend policy are
unchanged.

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
- **Never wrap a harness that carries its own OS sandbox in Crew's seatbelt on
  macOS** — nesting `sandbox-exec` fails EPERM (§2.2). "Carries its own OS
  sandbox" is a distinct capability (`ACP_BACKENDS_SKIP_CREW_SEATBELT_MACOS`),
  NOT the kiro-cli flag `ACP_BACKENDS_INTERNAL_SANDBOX` (which also grants a
  Windows no-backend exception). Add a new harness to the skip set only after
  confirming it really runs its own OS-level sandbox.
- **Electron identity must be pinned before the FIRST `app.getPath("userData")`.**
  `app.name` resolves + caches userData and the single-instance lock key on first
  read, deriving the name from the packaged `package.json` `name`
  (`kirocrew-desktop`), NOT `CFBundleName`. Setting `app.name` later cannot
  repoint it. `main.js` calls `app.setName()` + `app.setPath("userData", …)` at
  the very top; keep any new path/identity resolver below that pin.

---

## 7. Open / pending

- **Live round-trip verification:** the resume-open wiring is unit-safe but the
  end-to-end "click a CLI row → attaches to the same claude conversation" needs a
  live `./ccrew.sh` turn to confirm.
- **Phase 2 permission mapping:** Normal/Reads/Trust/YOLO → CLI, needs a live turn.
- **Icon/favicon recolor:** the sidebar glyph is tinted in the DOM via CSS
  `hue-rotate` (§3.1); the browser favicon (`/logo.png`) and desktop `.app`/Dock
  icon (`icon.icns`) are raster assets that filter never reaches, so they stay
  the upstream purple. Recoloring them is a raster edit (`scripts/ccrew-tint-icons.py`
  applies the same matrix) pending a settled brand hue — `hue-rotate(110deg)`
  resolves to orange-red, not the "lime" the CSS comment claims.

**Resolved:**
- Desktop app side-by-side coexistence with an installed KiroCrew (PR #3, live-
  verified). The `CCREW=1` identity flag (§2.1) gives the packaged app its own
  name/home/port — but the load-bearing fix was pinning `app.setName()` +
  `app.setPath("userData", <appData>/CCrew)` at the TOP of `main.js`, before the
  first `app.getPath("userData")` caches the lock/userData under the shared
  `kirocrew-desktop` name (see §6). Double-clicking `CCrew.app` no longer fronts a
  running KiroCrew.
- Claude backend "connection failed — retry" on macOS (PR #4, live-verified) — the
  sandbox-nesting fix in §2.2.

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
  UNIVERSAL=0 CCREW=1 CCREW_ALLOW_UNAUTH_VOICE=1 bash packaging/build-desktop.sh
# → website/electron/dist/mac-arm64/

# Backend tests for the CLI-session feature
.venv/bin/python -m pytest test/test_claude_session*.py -q
```

### 8.1 Build & share the desktop app package

Full build → signed-free `.app` + distributable `.dmg`, then hand it to a
teammate. Run from a terminal (NOT the sandboxed agent — electron-builder's
node-module scan trips on the masked `~/.kiro/crew/scratch` path there):

```bash
cd /Users/srivpra/work/CCrew

# 1. Build the package (host arch only; drop UNIVERSAL=0 for a universal build).
#    CCREW=1 bakes the CCrew identity (name/home/port) into the packaged app.
PATH="$HOME/.local/share/mise/installs/node/22.23.2/bin:$PATH" \
  UNIVERSAL=0 CCREW=1 CCREW_ALLOW_UNAUTH_VOICE=1 bash packaging/build-desktop.sh

# 2. Artifacts land here:
ls -lh website/electron/dist/mac-arm64/
#   CCrew.app                 ← drag to /Applications to run locally
#   CCrew-0.8.0-arm64.dmg     ← the shareable installer
#   CCrew-0.8.0-arm64.zip     ← alt archive (same app, zipped)
```

**Install locally** (recommended: `ditto`, not `cp -R`, to avoid a nested
`.app`; overwrite any prior copy, then launch from `/Applications`):

```bash
osascript -e 'quit app "CCrew"' 2>/dev/null || true
ditto "website/electron/dist/mac-arm64/CCrew.app" "/Applications/CCrew.app"
open -a "CCrew"
```

**Share with a teammate** — send the `.dmg`. They double-click it and drag
`CCrew.app` to `/Applications`. It is **not code-signed or notarized**
(`CSC_IDENTITY_AUTO_DISCOVERY=false`, `notarize:false`), so on first launch macOS
Gatekeeper blocks it; the recipient clears it once with either:

```bash
# after copying CCrew.app out of the DMG to /Applications:
xattr -dr com.apple.quarantine "/Applications/CCrew.app"
```

or **System Settings → Privacy & Security → "Open Anyway"** on the first
blocked launch. Because CCrew has its own bundle id (`com.ccrew.app`), name,
data home (`~/.ccrew`) and port (5490), it installs and runs **side by side**
with an installed KiroCrew — neither replaces the other.
