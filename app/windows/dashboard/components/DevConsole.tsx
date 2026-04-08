import { useRef, useEffect } from 'react'

export interface DevLog {
  source: string
  level: string
  message: string
  timestamp: string
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400/80',
  warn: 'text-amber-400/70',
  info: 'text-blue-400/50',
  debug: 'text-white/25',
}

const SOURCE_COLORS: Record<string, string> = {
  agent: 'text-[rgba(190,5,198,0.6)]',
  sidecar: 'text-emerald-400/50',
  platform: 'text-blue-400/40',
  nudge: 'text-white/35',
}

function formatTs(ts: string): string {
  // ts is millis since epoch
  const ms = parseInt(ts, 10)
  if (isNaN(ms)) return ts
  const d = new Date(ms)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}

export default function DevConsole({
  logs,
  onClear,
}: {
  logs: DevLog[]
  onClear: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0 border-b border-white/[0.06]" style={{ padding: '10px 20px' }}>
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" className="text-white/30">
            <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
            <path d="M7 15l3-3-3-3M13 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <h2 className="text-[14px] font-semibold text-white/70 leading-none">Dev Console</h2>
          <span className="text-[10px] text-white/15 bg-white/[0.04] px-1.5 py-[1px] rounded-md">{logs.length}</span>
        </div>
        <button
          onClick={onClear}
          className="text-[10px] text-white/20 hover:text-white/40 bg-transparent border-none cursor-pointer font-[inherit] transition-colors duration-150"
        >
          Clear
        </button>
      </div>

      {/* Log entries */}
      <div className="flex-1 overflow-y-auto font-mono" style={{ padding: '8px 16px' }}>
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[11px] text-white/12">No logs yet. Start an agent to see output.</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2 py-[2px] hover:bg-white/[0.02] transition-colors duration-75" style={{ fontSize: '11px', lineHeight: '1.6' }}>
                <span className="text-white/12 shrink-0 w-[85px] text-right">{formatTs(log.timestamp)}</span>
                <span className={`shrink-0 w-[60px] font-semibold uppercase text-[9px] leading-[1.8] ${SOURCE_COLORS[log.source] || 'text-white/25'}`}>{log.source}</span>
                <span className={`shrink-0 w-[36px] font-semibold uppercase text-[9px] leading-[1.8] ${LEVEL_COLORS[log.level] || 'text-white/25'}`}>{log.level}</span>
                <span className={`flex-1 min-w-0 break-all ${
                  log.level === 'error' ? 'text-red-400/60' :
                  log.level === 'warn' ? 'text-amber-400/50' :
                  log.level === 'debug' ? 'text-white/20' : 'text-white/40'
                }`}>{log.message}</span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </div>
  )
}
