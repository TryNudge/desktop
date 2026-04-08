import type { Agent } from '../types'
import GradientSpinner from './GradientSpinner'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function AgentCard({
  agent,
  isSelected,
  onSelect,
  onToggleStatus,
}: {
  agent: Agent
  isSelected: boolean
  onSelect: () => void
  onToggleStatus: (e: React.MouseEvent) => void
}) {
  const isRunning = agent.status === 'running'

  return (
    <div
      onClick={onSelect}
      className={`relative rounded-xl overflow-hidden cursor-pointer transition-all duration-150 border ${
        isSelected
          ? 'border-white/[0.12] bg-white/[0.04]'
          : 'border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.035] hover:border-white/[0.08]'
      }`}
    >
      {/* Gradient top-border pulse for running agents */}
      {isRunning && (
        <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden">
          <div
            className="absolute inset-0 origin-center animate-[gradient-pulse-out_2.5s_ease-out_infinite]"
            style={{ background: 'linear-gradient(90deg, transparent, #7a00b4, #be05c6, #ee3e1e, #f16f08, #f7c709, transparent)' }}
          />
        </div>
      )}

      <div className="px-3.5 py-2.5 flex items-center gap-3">
        {/* Agent icon */}
        <span className="text-[16px] shrink-0 w-6 text-center leading-none">{agent.icon || '🤖'}</span>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-white/85 truncate leading-none">{agent.name}</h3>
            {isRunning && <GradientSpinner size={12} />}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            {agent.windows.map((w) => (
              <span key={typeof w === 'string' ? w : w.title} className="text-[10px] text-white/25 font-medium">{typeof w === 'string' ? w : w.title}</span>
            ))}
            {agent.windows.length > 0 && <span className="text-[10px] text-white/12">&middot;</span>}
            <span className="text-[10px] text-white/15">{agent.interval}s</span>
            {agent.lastActivity && (
              <>
                <span className="text-[10px] text-white/12">&middot;</span>
                <span className="text-[10px] text-white/15">{timeAgo(agent.lastActivity)}</span>
              </>
            )}
          </div>
        </div>

        {/* Mode badge */}
        <span className={`text-[10px] font-semibold px-1.5 py-[1px] rounded-md shrink-0 ${
          agent.mode === 'go'
            ? 'bg-[rgba(238,62,30,0.1)] text-[rgba(247,199,9,0.7)]'
            : 'bg-white/[0.04] text-white/25'
        }`}>
          {agent.mode === 'go' ? 'GO' : 'GUIDE'}
        </span>

        {/* Stop / Start icon button */}
        {isRunning ? (
          <button
            onClick={onToggleStatus}
            className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md bg-white/[0.05] border border-white/[0.08] text-white/35 hover:bg-[rgba(255,60,60,0.12)] hover:text-[rgba(255,100,100,0.8)] hover:border-[rgba(255,60,60,0.2)] transition-all duration-150 cursor-pointer"
            title="Stop agent"
          >
            <svg width="8" height="8" viewBox="0 0 8 8"><rect width="8" height="8" rx="1" fill="currentColor" /></svg>
          </button>
        ) : (
          <button
            onClick={onToggleStatus}
            className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md bg-white/[0.05] border border-white/[0.08] text-white/30 hover:bg-[rgba(122,0,180,0.1)] hover:text-[rgba(190,5,198,0.8)] hover:border-[rgba(122,0,180,0.2)] transition-all duration-150 cursor-pointer"
            title="Start agent"
          >
            <svg width="8" height="10" viewBox="0 0 8 10"><path d="M0 0L8 5L0 10V0Z" fill="currentColor" /></svg>
          </button>
        )}
      </div>
    </div>
  )
}
