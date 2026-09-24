import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Terminal } from 'lucide-react'
import { api } from '../api/client'
import { i18nT } from '../i18n/t'

/**
 * Sidebar section listing the Claude Code CLI's OWN native sessions, grouped by
 * working directory, below C Crew's own sessions.
 *
 * CCrew is a UI skin over the claude CLI, so a conversation started from a bare
 * terminal must be visible here. These come from GET /api/claude-sessions
 * (reader: providers/claude_sessions.py, ~/.claude/projects/<cwd>/<uuid>.jsonl),
 * tagged source="claude-cli". This is a READ-ONLY listing: grouping/arrangement
 * is a CCrew UI overlay, never written back to the native store.
 *
 * Self-contained by design — it renders as one sibling block in ChatSidebar and
 * owns its own query + collapse state, so it does not entangle with the native
 * session-lane rendering. Codex is intentionally excluded (its Amazon build
 * keeps sessions in SQLite, unsafe to mirror as a sidebar source).
 *
 * Resume wiring (open a native session INTO CCrew via METHOD_SESSION_RESUME) is
 * a follow-up; for now this surfaces the sessions and their working dirs.
 */

interface ClaudeSessionRow {
  session_id: string
  key: string
  title: string
  cwd: string
  last_timestamp: string | null
  mtime: number
}

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
  const { data } = useQuery({
    queryKey: ['claude-cli-sessions'],
    queryFn: () => api.claudeSessions(),
    staleTime: 30_000,
  })

  const groups = useMemo(() => {
    const rows = (data?.sessions ?? []) as ClaudeSessionRow[]
    const byCwd = new Map<string, ClaudeSessionRow[]>()
    for (const r of rows) {
      const arr = byCwd.get(r.cwd)
      if (arr) arr.push(r)
      else byCwd.set(r.cwd, [r])
    }
    // Group order: most-recently-active group first.
    return [...byCwd.entries()]
      .map(([cwd, sessions]) => ({ cwd, sessions }))
      .sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0))
  }, [data])

  const total = data?.total ?? 0
  // Nothing to show (no native claude sessions, or the store is absent): render
  // nothing rather than an empty header, so a non-claude user sees no clutter.
  if (total === 0) return null

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
        <div className="mt-1 flex flex-col gap-2">
          {groups.map(g => (
            <div key={g.cwd}>
              <div className="px-1.5 text-[10px] text-muted truncate" title={g.cwd || undefined}>
                {shortCwd(g.cwd)}
              </div>
              {g.sessions.map(s => (
                <div
                  key={s.session_id}
                  className="px-2 py-1.5 rounded-md hover:bg-ok/8 cursor-default flex flex-col gap-0.5"
                  title={s.session_id}
                >
                  <span className="text-[13px] truncate">
                    {s.title || i18nT('components.claudeCliSessions.untitled')}
                  </span>
                  <span className="text-[10px] text-muted truncate">
                    {i18nT('components.claudeCliSessions.via_claude')}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
