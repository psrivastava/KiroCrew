import { useMemo, useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Terminal, Pencil, Pin, Tag, Copy, FolderOpen, Palette, Trash2 } from 'lucide-react'
import { api } from '../api/client'
import { i18nT } from '../i18n/t'
import { useAppDispatch } from '../store'
import { createSlot, switchSlot } from '../store/chatSlice'

/**
 * Sidebar section listing the Claude Code CLI's OWN native sessions, grouped by
 * working directory, below C Crew's own sessions.
 *
 * CCrew is a UI skin over the claude CLI, so a conversation started from a bare
 * terminal must be visible AND openable here. Rows come from
 * GET /api/claude-sessions (reader: providers/claude_sessions.py, merged with
 * the CCrew overlay: providers/claude_session_overlay.py). Clicking a row opens
 * it: create a fresh CCrew slot with project=cwd, seed its resume sid = the
 * native UUID (POST .../open), then switch to it — the slot resumes the SAME
 * claude conversation via session/load. The native .jsonl and the CCrew slot
 * then share one transcript.
 *
 * Per-session metadata (rename, pin, tags, color) is a CCrew OVERLAY, never
 * written back into ~/.claude (a bare claude run has nowhere to read it).
 *
 * Close vs delete: for a native claude session there is NO intermediate archive.
 * A foreign .jsonl has no CCrew history lane to be archived into, so "close" IS
 * a confirm-gated permanent delete — DELETE /api/claude-sessions/{uuid} unlinks
 * the native .jsonl (the same file a bare claude terminal reads) and drops the
 * overlay entry. The regular-session close (archive to CCrew history) does not
 * apply here; the delete is gated behind an inline confirm because it destroys
 * the user's own claude data.
 *
 * Codex is intentionally excluded (its Amazon build keeps sessions in SQLite).
 */

interface ClaudeSessionRow {
  session_id: string
  key: string
  title: string
  cli_title?: string
  cwd: string
  last_timestamp: string | null
  mtime: number
  pinned?: boolean
  tags?: string[]
  color?: string
}

/** CCrew's session color palette (matches the regular row color picker). */
const COLORS = ['', '#c9a9a6', '#d8a657', '#c9a227', '#7a9a3f', '#3f9d6f', '#3f8a9d', '#3f5a7a']

/** Shorten an absolute cwd for a group header: ~ for home, tail for depth. */
function shortCwd(cwd: string): string {
  if (!cwd) return i18nT('components.claudeCliSessions.unknown_dir')
  const home = cwd.match(/^\/Users\/[^/]+/) || cwd.match(/^\/home\/[^/]+/)
  let out = cwd
  if (home) out = '~' + cwd.slice(home[0].length)
  const parts = out.split('/').filter(Boolean)
  if (parts.length > 3) return (out.startsWith('~') ? '~/…/' : '/…/') + parts.slice(-2).join('/')
  return out
}

export default function ClaudeCliSessions() {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState<{ uuid: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const dispatch = useAppDispatch()
  const qc = useQueryClient()
  const menuRef = useRef<HTMLDivElement>(null)

  const { data } = useQuery({
    queryKey: ['claude-cli-sessions'],
    queryFn: () => api.claudeSessions(),
    staleTime: 30_000,
  })

  // Dismiss the context menu on any outside click / escape.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) { setMenu(null); setConfirmDelete(null) }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); setConfirmDelete(null) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menu])

  const rows = useMemo(() => (data?.sessions ?? []) as ClaudeSessionRow[], [data])
  const groups = useMemo(() => {
    const byCwd = new Map<string, ClaudeSessionRow[]>()
    for (const r of rows) {
      const arr = byCwd.get(r.cwd)
      if (arr) arr.push(r)
      else byCwd.set(r.cwd, [r])
    }
    return [...byCwd.entries()]
      .map(([cwd, sessions]) => ({ cwd, sessions }))
      .sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0))
  }, [rows])

  const total = data?.total ?? 0
  if (total === 0) return null

  const refresh = () => qc.invalidateQueries({ queryKey: ['claude-cli-sessions'] })

  async function openSession(row: ClaudeSessionRow) {
    if (busy) return
    setBusy(row.session_id)
    try {
      // Create a fresh CCrew slot rooted at the session's own cwd, then seed its
      // resume sid = the native UUID and switch to it.
      const created = await dispatch(createSlot({ project: row.cwd || undefined, activate: false })).unwrap()
      await api.claudeSessionOpen(row.session_id, created.key, row.cwd || undefined)
      dispatch(switchSlot({ key: created.key, announceOnMissing: true }))
    } catch {
      // Best-effort; a failed open leaves the (empty) slot for the user to reuse.
    } finally {
      setBusy(null)
    }
  }

  async function patchOverlay(uuid: string, patch: { title?: string; pinned?: boolean; tags?: string[]; color?: string }) {
    try { await api.claudeSessionOverlay(uuid, patch) } finally { refresh() }
  }

  async function deleteSession(uuid: string) {
    setMenu(null)
    setConfirmDelete(null)
    setBusy(uuid)
    try { await api.claudeSessionDelete(uuid) } finally { setBusy(null); refresh() }
  }

  function startRename(row: ClaudeSessionRow) {
    setMenu(null)
    setRenaming(row.session_id)
    setRenameText(row.title || '')
  }
  async function commitRename(uuid: string) {
    const t = renameText.trim()
    setRenaming(null)
    await patchOverlay(uuid, { title: t })
  }

  return (
    <div className="px-2 pt-2" data-testid="claude-cli-sessions">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full px-1.5 py-1 rounded-md text-[11px] font-semibold uppercase tracking-[.06em] text-muted hover:text-text bg-transparent border-none cursor-pointer"
        aria-expanded={open}
      >
        <ChevronRight className={`lucide-inline transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <Terminal className="lucide-inline text-ok" aria-hidden="true" />
        <span className="truncate">{i18nT('components.claudeCliSessions.heading')}</span>
      </button>

      {open && (
        // Scroll container: a busy claude user can have dozens of sessions, so
        // cap the height and let this list scroll independently of the sidebar.
        <div className="mt-1 flex flex-col gap-2 max-h-[38vh] overflow-y-auto pr-0.5">
          {groups.map(g => (
            <div key={g.cwd}>
              <div className="px-1.5 text-[10px] text-muted truncate" title={g.cwd || undefined}>
                {shortCwd(g.cwd)}
              </div>
              {g.sessions.map(s => (
                <div
                  key={s.session_id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openSession(s)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(s) } }}
                  onContextMenu={e => { e.preventDefault(); setConfirmDelete(null); setMenu({ uuid: s.session_id, x: e.clientX, y: e.clientY }) }}
                  className={`group px-2 py-1.5 rounded-md hover:bg-ok/8 cursor-pointer flex items-center gap-1.5 ${busy === s.session_id ? 'opacity-60' : ''}`}
                  title={s.session_id}
                >
                  {s.color ? (
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} aria-hidden="true" />
                  ) : null}
                  {s.pinned ? <Pin className="lucide-inline text-accent shrink-0" aria-hidden="true" /> : null}
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    {renaming === s.session_id ? (
                      <input
                        autoFocus
                        aria-label={i18nT('components.claudeCliSessions.rename')}
                        value={renameText}
                        onChange={e => setRenameText(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onBlur={() => commitRename(s.session_id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); commitRename(s.session_id) }
                          if (e.key === 'Escape') { e.preventDefault(); setRenaming(null) }
                        }}
                        className="text-[13px] bg-transparent border border-border rounded px-1 py-0.5 text-text"
                      />
                    ) : (
                      <span className="text-[13px] truncate">
                        {s.title || i18nT('components.claudeCliSessions.untitled')}
                      </span>
                    )}
                    <span className="text-[10px] text-muted truncate">
                      {i18nT('components.claudeCliSessions.via_claude')}
                    </span>
                    {s.tags && s.tags.length > 0 && (
                      <span className="flex flex-wrap gap-1 mt-0.5">
                        {s.tags.map(tag => (
                          <span key={tag} className="text-[10px] px-1 rounded bg-accent/12 text-accent truncate max-w-[80px]">{tag}</span>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {menu && (() => {
        const row = rows.find(r => r.session_id === menu.uuid)
        if (!row) return null
        const isConfirming = confirmDelete === row.session_id
        return (
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[190px] rounded-lg border border-border bg-bg-elevated shadow-lg py-1 text-[13px]"
            style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 300) }}
          >
            <MenuItem icon={<FolderOpen className="lucide-inline" />} label={i18nT('components.claudeCliSessions.open')} onClick={() => { setMenu(null); openSession(row) }} />
            <MenuItem icon={<Pencil className="lucide-inline" />} label={i18nT('components.claudeCliSessions.rename')} onClick={() => startRename(row)} />
            <MenuItem icon={<Pin className="lucide-inline" />} label={row.pinned ? i18nT('components.claudeCliSessions.unpin') : i18nT('components.claudeCliSessions.pin')} onClick={() => { setMenu(null); patchOverlay(row.session_id, { pinned: !row.pinned }) }} />
            <div className="px-3 py-1.5 flex items-center gap-1.5">
              <Palette className="lucide-inline text-muted" aria-hidden="true" />
              <span className="flex items-center gap-1">
                {COLORS.map(c => (
                  <button
                    key={c || 'none'}
                    type="button"
                    aria-label={c ? i18nT('components.claudeCliSessions.set_color', { color: c }) : i18nT('components.claudeCliSessions.no_color')}
                    title={c ? i18nT('components.claudeCliSessions.set_color', { color: c }) : i18nT('components.claudeCliSessions.no_color')}
                    onClick={() => { setMenu(null); patchOverlay(row.session_id, { color: c }) }}
                    className={`w-3.5 h-3.5 rounded-full border ${row.color === c ? 'border-text' : 'border-border'} ${!c ? 'bg-transparent' : ''}`}
                    style={c ? { background: c } : undefined}
                  />
                ))}
              </span>
            </div>
            <div className="my-1 border-t border-border" />
            <MenuItem icon={<Copy className="lucide-inline" />} label={i18nT('components.claudeCliSessions.copy_path')} onClick={() => { setMenu(null); navigator.clipboard?.writeText(row.cwd || '') }} />
            <MenuItem icon={<Tag className="lucide-inline" />} label={i18nT('components.claudeCliSessions.copy_id')} onClick={() => { setMenu(null); navigator.clipboard?.writeText(row.session_id) }} />
            <div className="my-1 border-t border-border" />
            {isConfirming ? (
              <div className="px-3 py-1.5 flex flex-col gap-1.5">
                <span className="text-[11px] text-muted leading-snug">{i18nT('components.claudeCliSessions.delete_confirm')}</span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => deleteSession(row.session_id)}
                    className="flex-1 px-2 py-1 rounded bg-danger/15 text-danger hover:bg-danger/25 border-none cursor-pointer text-[12px] font-medium"
                  >
                    {i18nT('components.claudeCliSessions.delete_confirm_yes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(null)}
                    className="flex-1 px-2 py-1 rounded bg-transparent text-muted hover:text-text border border-border cursor-pointer text-[12px]"
                  >
                    {i18nT('components.claudeCliSessions.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirmDelete(row.session_id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left bg-transparent border-none cursor-pointer text-danger hover:bg-danger/8"
              >
                <span className="shrink-0" aria-hidden="true"><Trash2 className="lucide-inline" /></span>
                <span className="truncate">{i18nT('components.claudeCliSessions.delete')}</span>
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 text-left bg-transparent border-none cursor-pointer text-text hover:bg-accent/8"
    >
      <span className="text-muted shrink-0" aria-hidden="true">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
