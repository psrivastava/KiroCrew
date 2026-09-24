import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Cpu } from 'lucide-react'
import { api } from '../api/client'
import { i18nT } from '../i18n/t'

/**
 * Composer-footer chip showing which ACP backend (Claude / Codex / Kiro CLI)
 * is driving sessions right now, and linking to the switcher.
 *
 * CCrew is a UI skin over the claude & codex CLIs, so "which agent am I using?"
 * must be answerable at a glance. The chat UI already shows the agent-SPEC name
 * (often "default"), which is a different axis and never reflects the backend —
 * that gap is exactly what confused the operator. This chip reads the real
 * `agent.acp_backend` config value and names it.
 *
 * Clicking deep-links to Developer > Agent Backend (`?tab=agent-backend`), the
 * existing switcher, rather than duplicating its install-probe/switch logic
 * here. Additive component; it does not modify the approval picker beside it.
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
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 h-7 text-[12px] font-semibold cursor-pointer transition-colors ${
        isCli
          ? 'border-ok/45 text-ok bg-ok/10 hover:bg-ok/15'
          : 'border-border text-muted hover:text-text hover:bg-accent/8'
      }`}
      data-testid="composer-backend-chip"
    >
      <Cpu className="lucide-inline" aria-hidden="true" />
      {!compact && <span className="truncate max-w-[90px]">{label}</span>}
    </button>
  )
}
