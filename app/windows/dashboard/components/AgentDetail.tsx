import { useState, useRef, useEffect, Component } from 'react'
import type { Agent, AgentMode, AgentWindowTarget, ActivityEntry, WindowEntry } from '../types'
import * as api from '../../../lib/tauri'
import GradientSpinner from './GradientSpinner'

const INTERVALS = [
  { value: 5, label: '5s' },
  { value: 10, label: '10s' },
  { value: 15, label: '15s' },
  { value: 30, label: '30s' },
  { value: 60, label: '60s' },
]

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Main component ──────────────────────────────────────────────────────────

function AgentDetailInner({
  agent,
  onBack,
  onUpdate,
  onDelete,
  onToggleStatus,
  onSendMessage,
}: {
  agent: Agent
  onBack: () => void
  onUpdate: (data: Partial<Agent>) => void
  onDelete: () => void
  onToggleStatus: () => void
  onSendMessage: (msg: string) => void
}) {
  const [message, setMessage] = useState('')
  const logEndRef = useRef<HTMLDivElement>(null)
  const isRunning = agent.status === 'running'

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [agent.activityLog.length])

  const handleSend = () => {
    const text = message.trim()
    if (!text) return
    onSendMessage(text)
    setMessage('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Agent header bar */}
      <div className="flex items-center gap-2.5 shrink-0 border-b border-white/[0.06]" style={{ padding: '12px 20px' }}>
        <button
          onClick={onBack}
          className="w-6 h-6 flex items-center justify-center rounded-md bg-transparent border-none text-white/30 hover:text-white/60 hover:bg-white/[0.05] cursor-pointer transition-all duration-150"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </button>
        <span className="text-[16px] shrink-0 leading-none">{agent.icon || '🤖'}</span>
        <h2 className="text-[14px] font-semibold text-white/85 truncate flex-1 leading-none">{agent.name}</h2>
        {isRunning && <GradientSpinner size={14} />}
        {isRunning ? (
          <span
            className="text-[11px] font-semibold bg-clip-text text-transparent bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite]"
            style={{ backgroundImage: 'linear-gradient(90deg, #7a00b4, #be05c6, #ee3e1e, #f16f08, #f7c709, #7a00b4)' }}
          >
            Running
          </span>
        ) : (
          <span className="text-[11px] font-medium text-white/25">
            {agent.status === 'error' ? 'Error' : 'Idle'}
          </span>
        )}

        {/* Start / Stop */}
        {isRunning ? (
          <button
            onClick={onToggleStatus}
            className="w-7 h-7 flex items-center justify-center rounded-md bg-white/[0.05] border border-white/[0.08] text-white/40 hover:bg-[rgba(255,60,60,0.1)] hover:text-[rgba(255,100,100,0.8)] hover:border-[rgba(255,60,60,0.2)] cursor-pointer transition-all duration-150 ml-1"
            title="Stop agent"
          >
            <svg width="10" height="10" viewBox="0 0 8 8"><rect width="8" height="8" rx="1" fill="currentColor" /></svg>
          </button>
        ) : (
          <button
            onClick={onToggleStatus}
            className="px-3 py-[4px] rounded-md text-[11px] font-semibold cursor-pointer border transition-all duration-150 font-[inherit] ml-1 bg-[rgba(122,0,180,0.1)] border-[rgba(122,0,180,0.2)] text-[rgba(190,5,198,0.9)] hover:bg-[rgba(122,0,180,0.18)]"
          >
            Start
          </button>
        )}
      </div>

      {/* Content: log + config sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Activity log */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {agent.activityLog.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <p className="text-[12px] text-white/15 leading-[1.5]">
                  {isRunning ? 'Waiting for agent activity...' : 'Start the agent to see activity here.'}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {agent.activityLog.map((entry) => (
                  <ActivityItem key={entry.id} entry={entry} />
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>

          {/* Nudge-style input bar */}
          <div className="shrink-0 px-4 pb-4 pt-1">
            <div className="flex items-center bg-[rgb(24,24,28)] border border-white/[0.06] rounded-[14px]" style={{ gap: '10px', padding: '8px 14px' }}>
              {/* Logo button for attachments */}
              <div className="relative shrink-0 flex items-center cursor-pointer group">
                <img
                  src="/nudgekeycap.png"
                  alt="Attach"
                  className="w-[26px] h-[26px] rounded-[8px] object-contain shrink-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)] group-hover:drop-shadow-[0_2px_8px_rgba(100,120,255,0.3)] transition-[filter] duration-150"
                  title="Add images or documents"
                />
              </div>

              {/* Input */}
              <input
                type="text"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Send a message to this agent..."
                spellCheck={false}
                autoComplete="off"
                className="flex-1 bg-transparent border-none outline-none text-white/[0.85] text-[13px] font-normal caret-white/60 tracking-[0.1px] placeholder:text-white/20 placeholder:font-normal font-[inherit]"
              />

              {/* Send hint */}
              {message.trim() ? (
                <button
                  onClick={handleSend}
                  className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-white/[0.08] border-none text-white/50 hover:text-white/80 hover:bg-white/[0.12] cursor-pointer transition-all duration-150"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12">
                    <path d="M1 6H11M7 2L11 6L7 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </button>
              ) : (
                <span className="text-[10px] text-white/[0.15] whitespace-nowrap rounded-md bg-white/[0.03] border border-white/[0.04] shrink-0" style={{ padding: '2px 6px' }}>
                  Enter &#x21B5;
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Config sidebar */}
        <ConfigPanel agent={agent} onUpdate={onUpdate} onDelete={onDelete} />
      </div>
    </div>
  )
}

// ── Activity log entry ──────────────────────────────────────────────────────

function ActivityItem({ entry }: { entry: ActivityEntry }) {
  const [expanded, setExpanded] = useState(false)

  const iconColor = {
    observation: 'text-blue-400/50',
    action: 'text-amber-400/50',
    user: 'text-[rgba(190,5,198,0.5)]',
    system: 'text-white/20',
  }[entry.type]

  const icon = {
    observation: (
      <svg width="12" height="12" viewBox="0 0 12 12" className={iconColor}>
        <circle cx="6" cy="6" r="4" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <circle cx="6" cy="6" r="1.5" fill="currentColor" />
      </svg>
    ),
    action: (
      <svg width="12" height="12" viewBox="0 0 12 12" className={iconColor}>
        <path d="M2 6L5 9L10 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    ),
    user: (
      <svg width="12" height="12" viewBox="0 0 12 12" className={iconColor}>
        <path d="M1 11C1 8.5 3 7 6 7C9 7 11 8.5 11 11" stroke="currentColor" strokeWidth="1.2" fill="none" />
        <circle cx="6" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
      </svg>
    ),
    system: (
      <svg width="12" height="12" viewBox="0 0 12 12" className={iconColor}>
        <circle cx="6" cy="6" r="1" fill="currentColor" />
      </svg>
    ),
  }[entry.type]

  return (
    <div className="group flex gap-2.5 py-1.5">
      {/* Timeline dot */}
      <div className="shrink-0 w-5 flex flex-col items-center pt-[3px]">
        {icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <p className={`text-[12px] leading-[1.55] flex-1 ${
            entry.type === 'user' ? 'text-white/70' : entry.type === 'system' ? 'text-white/25 italic' : 'text-white/55'
          }`}>
            {entry.content}
          </p>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[9px] text-white/15">{formatTime(entry.timestamp)}</span>
          {entry.windowName && (
            <span className="text-[9px] text-white/12">{entry.windowName}</span>
          )}
          {entry.durationMs != null && (
            <span className="text-[9px] text-white/12">{entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`}</span>
          )}
          {entry.details && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[9px] text-white/20 hover:text-white/40 bg-transparent border-none cursor-pointer font-[inherit] transition-colors duration-150"
            >
              {expanded ? 'Hide details' : 'Show details'}
            </button>
          )}
        </div>

        {/* Expandable details */}
        {expanded && entry.details && (
          <div className="mt-1.5 px-2.5 py-2 bg-black/20 border border-white/[0.04] rounded-lg">
            <pre className="text-[10px] text-white/30 leading-[1.5] whitespace-pre-wrap font-[inherit] m-0">{entry.details}</pre>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Config sidebar ──────────────────────────────────────────────────────────

function ConfigPanel({
  agent,
  onUpdate,
  onDelete,
}: {
  agent: Agent
  onUpdate: (data: Partial<Agent>) => void
  onDelete: () => void
}) {
  const [editName, setEditName] = useState(agent.name)
  const [editWindows, setEditWindows] = useState<AgentWindowTarget[]>(agent.windows ?? [])
  const [editInterval, setEditInterval] = useState(agent.interval)
  const [editGoal, setEditGoal] = useState(agent.goal)
  const [editMode, setEditMode] = useState<AgentMode>(agent.mode)
  const [windowDropdownOpen, setWindowDropdownOpen] = useState(false)
  const [availableWindows, setAvailableWindows] = useState<WindowEntry[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEditName(agent.name)
    setEditWindows(agent.windows ?? [])
    setEditInterval(agent.interval)
    setEditGoal(agent.goal)
    setEditMode(agent.mode)
  }, [agent.id, agent.name, agent.windows, agent.interval, agent.goal, agent.mode])

  useEffect(() => {
    if (windowDropdownOpen && availableWindows.length === 0) {
      api.enumerateWindows()
        .then((w) => setAvailableWindows(w as WindowEntry[]))
        .catch(console.error)
    }
  }, [windowDropdownOpen, availableWindows.length])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setWindowDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const isWinSelected = (w: WindowEntry) => editWindows.some((s) => s.title === w.title)

  const toggleWindow = (w: WindowEntry) => {
    setEditWindows((prev) =>
      prev.some((s) => s.title === w.title)
        ? prev.filter((s) => s.title !== w.title)
        : [...prev, { hwnd: w.hwnd, title: w.title, processName: w.process_name }]
    )
  }

  const removeWindow = (title: string) => {
    setEditWindows((prev) => prev.filter((s) => s.title !== title))
  }

  const hasChanges =
    editName !== agent.name ||
    JSON.stringify(editWindows) !== JSON.stringify(agent.windows ?? []) ||
    editInterval !== agent.interval ||
    editGoal !== agent.goal ||
    editMode !== agent.mode

  const handleSave = () => {
    onUpdate({
      name: editName.trim() || agent.name,
      windows: editWindows,
      interval: editInterval,
      goal: editGoal.trim() || agent.goal,
      mode: editMode,
    })
  }

  return (
    <div className="w-[240px] shrink-0 border-l border-white/[0.06] bg-[rgb(18,18,22)] overflow-y-auto">
      <div className="px-4 py-3 flex flex-col gap-3">
        <div className="text-[10px] font-bold text-white/25 uppercase tracking-[0.5px]">Configuration</div>

        {/* Name */}
        <Field label="Name">
          <input
            type="text"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="w-full px-2 py-[5px] bg-white/[0.04] border border-white/[0.08] rounded-md text-[11px] text-white/80 outline-none transition-colors duration-150 focus:border-white/[0.18] font-[inherit]"
          />
        </Field>

        {/* Windows */}
        <Field label="Watching">
          <div ref={dropdownRef}>
            <button
              onClick={() => setWindowDropdownOpen(!windowDropdownOpen)}
              className="w-full px-2 py-[5px] bg-white/[0.04] border border-white/[0.08] rounded-md text-[11px] text-left cursor-pointer transition-colors duration-150 hover:border-white/[0.12] font-[inherit] flex items-center justify-between"
            >
              <span className={editWindows.length ? 'text-white/50' : 'text-white/20'}>
                {editWindows.length ? `${editWindows.length} selected` : 'Select...'}
              </span>
              <svg width="8" height="8" viewBox="0 0 12 12" className={`text-white/20 transition-transform duration-150 ${windowDropdownOpen ? 'rotate-180' : ''}`}>
                <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
            {windowDropdownOpen && (
              <div className="mt-1 bg-[rgb(28,28,32)] border border-white/[0.08] rounded-md py-0.5 shadow-[0_8px_32px_rgba(0,0,0,0.5)] max-h-[120px] overflow-y-auto">
                {availableWindows.map((w) => (
                  <div key={w.hwnd} onClick={() => toggleWindow(w)} className="flex items-center gap-1.5 px-2 py-[4px] cursor-pointer hover:bg-white/[0.04] transition-colors duration-100">
                    <div className={`w-3 h-3 rounded-[2px] border flex items-center justify-center transition-all duration-150 ${
                      isWinSelected(w) ? 'bg-[rgba(122,0,180,0.25)] border-[rgba(190,5,198,0.5)]' : 'bg-white/[0.04] border-white/[0.1]'
                    }`}>
                      {isWinSelected(w) && (
                        <svg width="7" height="7" viewBox="0 0 10 10"><path d="M2 5L4.5 7.5L8 3" stroke="rgba(190,5,198,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
                      )}
                    </div>
                    {w.icon_b64 && <img src={`data:image/png;base64,${w.icon_b64}`} alt="" className="w-3 h-3 rounded-[1px] object-contain shrink-0" />}
                    <span className="text-[10px] text-white/50 truncate">{w.title}</span>
                  </div>
                ))}
              </div>
            )}
            {editWindows.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {editWindows.map((w) => (
                  <span key={w.title} className="inline-flex items-center gap-0.5 px-1.5 py-[1px] bg-white/[0.04] border border-white/[0.06] rounded text-[9px] text-white/35">
                    {w.title.length > 20 ? w.title.slice(0, 20) + '...' : w.title}
                    <button onClick={() => removeWindow(w.title)} className="text-white/20 hover:text-white/50 bg-transparent border-none cursor-pointer text-[9px] p-0 leading-none font-[inherit]">&times;</button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Field>

        {/* Interval */}
        <Field label="Interval">
          <div className="flex gap-0.5">
            {INTERVALS.map((i) => (
              <button
                key={i.value}
                onClick={() => setEditInterval(i.value)}
                className={`flex-1 py-[4px] rounded text-[9px] font-semibold border cursor-pointer transition-all duration-150 font-[inherit] ${
                  editInterval === i.value
                    ? 'bg-white/[0.08] border-white/[0.12] text-white/60'
                    : 'bg-transparent border-white/[0.06] text-white/25 hover:text-white/40'
                }`}
              >
                {i.label}
              </button>
            ))}
          </div>
        </Field>

        {/* Goal */}
        <Field label="Goal / Prompt">
          <textarea
            value={editGoal}
            onChange={(e) => setEditGoal(e.target.value)}
            rows={4}
            className="w-full px-2 py-[5px] bg-white/[0.04] border border-white/[0.08] rounded-md text-[11px] text-white/70 outline-none transition-colors duration-150 focus:border-white/[0.18] font-[inherit] resize-none leading-[1.5]"
          />
        </Field>

        {/* Mode */}
        <Field label="Mode">
          <div className="flex bg-white/[0.04] rounded-md p-[2px]">
            <button
              onClick={() => setEditMode('guide')}
              className={`flex-1 py-[4px] rounded text-[10px] font-semibold cursor-pointer border-none transition-all duration-200 font-[inherit] ${
                editMode === 'guide'
                  ? 'bg-white/[0.08] text-white/70 shadow-[0_1px_3px_rgba(0,0,0,0.3)]'
                  : 'bg-transparent text-white/25 hover:text-white/40'
              }`}
            >
              Guide
            </button>
            <button
              onClick={() => setEditMode('go')}
              className={`flex-1 py-[4px] rounded text-[10px] font-semibold cursor-pointer border-none transition-all duration-200 font-[inherit] ${
                editMode === 'go'
                  ? 'bg-[rgba(238,62,30,0.12)] text-[rgba(247,199,9,0.8)] shadow-[0_1px_3px_rgba(0,0,0,0.3)]'
                  : 'bg-transparent text-white/25 hover:text-white/40'
              }`}
            >
              Go
            </button>
          </div>
        </Field>

        {/* Actions */}
        <div className="flex items-center justify-between pt-1 border-t border-white/[0.04]">
          <button
            onClick={onDelete}
            className="text-[10px] text-white/15 hover:text-red-400/70 cursor-pointer bg-transparent border-none font-[inherit] transition-colors duration-150"
          >
            Delete
          </button>
          {hasChanges && (
            <button
              onClick={handleSave}
              className="px-2.5 py-[4px] rounded-md border-none text-[10px] font-semibold cursor-pointer transition-all duration-150 font-[inherit] bg-[rgba(122,0,180,0.15)] text-[rgba(190,5,198,0.9)] hover:bg-[rgba(122,0,180,0.25)]"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[9px] font-semibold text-white/25 uppercase tracking-[0.5px] mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}

// ── Error boundary ──────────────────────────────────────────────────────────

export default function AgentDetail(props: Parameters<typeof AgentDetailInner>[0]) {
  return (
    <AgentDetailErrorBoundary onBack={props.onBack}>
      <AgentDetailInner {...props} />
    </AgentDetailErrorBoundary>
  )
}

class AgentDetailErrorBoundary extends Component<
  { children: React.ReactNode; onBack: () => void },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onBack: () => void }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[AgentDetail] render error:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center text-center p-8">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-3">
            <svg width="20" height="20" viewBox="0 0 24 24" className="text-red-400/60">
              <path d="M12 2L22 20H2L12 2Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
              <line x1="12" y1="10" x2="12" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <circle cx="12" cy="17" r="0.5" fill="currentColor" />
            </svg>
          </div>
          <h3 className="text-[14px] font-semibold text-white/50 mb-1">Something went wrong</h3>
          <p className="text-[12px] text-white/25 max-w-[300px] leading-[1.5] mb-1">
            {this.state.error.message}
          </p>
          <p className="text-[10px] text-white/12 max-w-[300px] leading-[1.4] mb-4 font-mono">
            {this.state.error.stack?.split('\n').slice(0, 3).join('\n')}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ error: null })}
              className="px-3 py-[6px] rounded-lg border border-white/[0.08] bg-white/[0.03] text-[12px] font-medium text-white/50 cursor-pointer font-[inherit] hover:bg-white/[0.06]"
            >
              Try Again
            </button>
            <button
              onClick={this.props.onBack}
              className="px-3 py-[6px] rounded-lg border-none bg-[rgba(122,0,180,0.12)] text-[12px] font-medium text-[rgba(190,5,198,0.9)] cursor-pointer font-[inherit] hover:bg-[rgba(122,0,180,0.2)]"
            >
              Back to Agents
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
