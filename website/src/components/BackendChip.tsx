import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Cpu } from 'lucide-react'
import { api } from '../api/client'
import { i18nT } from '../i18n/t'

/**
 * Composer-shelf chip showing which ACP backend (Claude / Codex / Kiro CLI) is
 * driving sessions right now, sitting beside the agent-label button.
 *
 * CCrew is a UI skin over the claude & codex CLIs, so "which agent am I using?"
 * must be answerable at a glance. The shelf already shows the agent-SPEC name
 * (often "default"), which is a different axis and never reflects the backend —
 * that gap is exactly what confused the operator. This chip reads the real
 * `agent.acp_backend` config value and names it, right next to that agent label.
 *
 * Clicking deep-links to Developer > Agent Backend (`?tab=agent-backend`), the
 * existing switcher, rather than duplicating its install-probe/switch logic
 * here. Styled to match the sibling shelf buttons (borderless, transparent),
 * with the accent reserved for an active CLI backend so it reads as "on".
 *
 * i18n: reuses the existing `agentBackendTab.agent_backend` label for the
 * tooltip/aria and shows the backend id (a proper noun — Claude/Codex/Kiro,
 * not translated) as the visible text, so no new catalog keys are needed.
 */

const LABELS: Record<string, string> = {
  '': 'Kiro',
  claude: 'Claude',
  codex: 'Codex',
  kas: 'KAS',
}

function backendLabel(id: string): string {
  return LABELS[id] ?? id
}

export default function BackendChip({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate()
  const { data } = useQuery<{ agent?: { acp_backend?: string } }>({
    queryKey: ['kirocrewConfig'],
    queryFn: () => api.kirocrewConfig(),
    staleTime: 30_000,
  })
  // Undefined config read (loading / error) is NOT the same as the Kiro
  // default: painting "Kiro" on an unknown read would mislabel an active
  // Claude/Codex session. Show a neutral placeholder until it resolves.
  const backend = data?.agent?.acp_backend
  const label = backend === undefined ? '…' : backendLabel(backend)
  // The non-default backends are the ones CCrew exists to drive; give them the
  // accent so the active CLI reads as "on". Kiro (the empty default) stays muted.
  const isCli = backend === 'claude' || backend === 'codex'
  const tip = i18nT('pages.developer.agentBackendTab.agent_backend')

  return (
    <button
      type="button"
      onClick={() => navigate('/developer?tab=agent-backend')}
      title={`${tip}: ${label}`}
      aria-label={`${tip}: ${label}`}
      className={`inline-flex items-center gap-1.5 h-7 min-w-0 text-[12px] px-2.5 rounded-md bg-transparent border-none cursor-pointer transition-colors hover:bg-[color-mix(in_srgb,var(--bg-elevated)_84%,var(--text))] ${
        isCli ? 'text-ok hover:text-ok' : 'text-muted hover:text-text'
      }`}
      data-testid="composer-backend-chip"
    >
      <Cpu size={13} className="shrink-0 opacity-70" aria-hidden="true" />
      {!compact && <span className="truncate max-w-[90px]">{label}</span>}
    </button>
  )
}
