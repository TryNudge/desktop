import { useState, useEffect, useRef } from 'react'
import type { AgentMode, AgentWindowTarget, WindowEntry } from '../types'
import * as api from '../../../lib/tauri'

const INTERVALS = [
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '60 seconds' },
]

export default function AgentForm({
  onSave,
  onCancel,
}: {
  onSave: (data: { name: string; windows: AgentWindowTarget[]; interval: number; goal: string; mode: AgentMode }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [selectedWindows, setSelectedWindows] = useState<AgentWindowTarget[]>([])
  const [interval, setInterval] = useState(10)
  const [goal, setGoal] = useState('')
  const [mode, setMode] = useState<AgentMode>('guide')
  const [windowDropdownOpen, setWindowDropdownOpen] = useState(false)
  const [availableWindows, setAvailableWindows] = useState<WindowEntry[]>([])
  const [loadingWindows, setLoadingWindows] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Fetch real windows when dropdown opens
  useEffect(() => {
    if (windowDropdownOpen && availableWindows.length === 0) {
      setLoadingWindows(true)
      api.enumerateWindows()
        .then((windows) => setAvailableWindows(windows as WindowEntry[]))
        .catch(() => {})
        .finally(() => setLoadingWindows(false))
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

  const isSelected = (w: WindowEntry) => selectedWindows.some((s) => s.hwnd === w.hwnd)

  const toggleWindow = (w: WindowEntry) => {
    setSelectedWindows((prev) =>
      prev.some((s) => s.hwnd === w.hwnd)
        ? prev.filter((s) => s.hwnd !== w.hwnd)
        : [...prev, { hwnd: w.hwnd, title: w.title, processName: w.process_name }]
    )
  }

  const removeWindow = (hwnd: number) => {
    setSelectedWindows((prev) => prev.filter((s) => s.hwnd !== hwnd))
  }

  const canSave = name.trim() && selectedWindows.length > 0 && goal.trim()

  const handleSubmit = () => {
    if (!canSave) return
    onSave({ name: name.trim(), windows: selectedWindows, interval, goal: goal.trim(), mode })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onCancel} />

      <div className="relative w-[460px] max-h-[560px] bg-[rgb(22,22,26)] border border-white/[0.08] rounded-2xl shadow-[0_24px_80px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-white/[0.06]">
          <h2 className="text-[16px] font-bold text-white/90 leading-none">New Agent</h2>
          <p className="text-[12px] text-white/25 mt-1.5">Configure what this agent watches and how it responds.</p>
        </div>

        {/* Form body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
          {/* Name */}
          <div>
            <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.5px] mb-1.5">Agent Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., UI Review Agent"
              className="w-full px-3 py-[9px] bg-white/[0.04] border border-white/[0.08] rounded-xl text-[13px] text-white/90 placeholder:text-white/20 outline-none transition-colors duration-150 focus:border-white/[0.18] font-[inherit]"
            />
          </div>

          {/* Watch Windows */}
          <div ref={dropdownRef}>
            <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.5px] mb-1.5">Watch Windows</label>
            <button
              onClick={() => setWindowDropdownOpen(!windowDropdownOpen)}
              className="w-full px-3 py-[9px] bg-white/[0.04] border border-white/[0.08] rounded-xl text-[13px] text-left cursor-pointer transition-colors duration-150 hover:border-white/[0.12] font-[inherit] flex items-center justify-between"
            >
              <span className={selectedWindows.length ? 'text-white/60' : 'text-white/20'}>
                {selectedWindows.length
                  ? `${selectedWindows.length} window${selectedWindows.length > 1 ? 's' : ''} selected`
                  : 'Select windows to watch...'}
              </span>
              <svg width="12" height="12" viewBox="0 0 12 12" className={`text-white/25 transition-transform duration-150 ${windowDropdownOpen ? 'rotate-180' : ''}`}>
                <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>

            {windowDropdownOpen && (
              <div className="mt-1.5 bg-[rgb(28,28,32)] border border-white/[0.08] rounded-xl py-1 shadow-[0_8px_32px_rgba(0,0,0,0.5)] max-h-[200px] overflow-y-auto">
                {loadingWindows ? (
                  <div className="px-3 py-4 text-center text-[12px] text-white/25">Scanning windows...</div>
                ) : availableWindows.length === 0 ? (
                  <div className="px-3 py-4 text-center text-[12px] text-white/25">No windows found</div>
                ) : (
                  availableWindows.map((w) => (
                    <div
                      key={w.hwnd}
                      onClick={() => toggleWindow(w)}
                      className="flex items-center gap-2.5 px-3 py-[7px] cursor-pointer hover:bg-white/[0.04] transition-colors duration-100"
                    >
                      <div className={`w-[15px] h-[15px] rounded-[4px] border flex items-center justify-center transition-all duration-150 ${
                        isSelected(w)
                          ? 'bg-[rgba(122,0,180,0.25)] border-[rgba(190,5,198,0.5)]'
                          : 'bg-white/[0.04] border-white/[0.1]'
                      }`}>
                        {isSelected(w) && (
                          <svg width="9" height="9" viewBox="0 0 10 10">
                            <path d="M2 5L4.5 7.5L8 3" stroke="rgba(190,5,198,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                          </svg>
                        )}
                      </div>
                      {w.icon_b64 && (
                        <img src={`data:image/png;base64,${w.icon_b64}`} alt="" className="w-4 h-4 rounded-[2px] object-contain shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-white/60 truncate">{w.title}</div>
                        <div className="text-[10px] text-white/20">{w.process_name}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {selectedWindows.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {selectedWindows.map((w) => {
                  const entry = availableWindows.find((aw) => aw.hwnd === w.hwnd)
                  return (
                    <span
                      key={w.hwnd}
                      className="inline-flex items-center gap-1 px-2 py-[2px] bg-white/[0.05] border border-white/[0.06] rounded-md text-[11px] text-white/50"
                    >
                      {entry?.icon_b64 && (
                        <img src={`data:image/png;base64,${entry.icon_b64}`} alt="" className="w-3 h-3 rounded-[1px] object-contain" />
                      )}
                      {w.title.length > 30 ? w.title.slice(0, 30) + '...' : w.title}
                      <button
                        onClick={() => removeWindow(w.hwnd)}
                        className="text-white/25 hover:text-white/60 bg-transparent border-none cursor-pointer text-[11px] p-0 leading-none font-[inherit]"
                      >
                        &times;
                      </button>
                    </span>
                  )
                })}
              </div>
            )}
          </div>

          {/* Interval */}
          <div>
            <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.5px] mb-1.5">Screenshot Interval</label>
            <select
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              className="w-full px-3 py-[9px] bg-white/[0.04] border border-white/[0.08] rounded-xl text-[13px] text-white/70 outline-none transition-colors duration-150 focus:border-white/[0.18] font-[inherit] cursor-pointer appearance-none"
              style={{ backgroundImage: 'none' }}
            >
              {INTERVALS.map((i) => (
                <option key={i.value} value={i.value} className="bg-[rgb(28,28,32)] text-white/80">{i.label}</option>
              ))}
            </select>
          </div>

          {/* Goal */}
          <div>
            <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.5px] mb-1.5">Goal / Prompt</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="e.g., Watch my Claude Code and browser, give feedback on UI changes as I implement them"
              rows={3}
              className="w-full px-3 py-[9px] bg-white/[0.04] border border-white/[0.08] rounded-xl text-[13px] text-white/90 placeholder:text-white/20 outline-none transition-colors duration-150 focus:border-white/[0.18] font-[inherit] resize-none leading-[1.55]"
            />
          </div>

          {/* Mode */}
          <div>
            <label className="block text-[11px] font-semibold text-white/40 uppercase tracking-[0.5px] mb-1.5">Agent Mode</label>
            <div className="flex bg-white/[0.04] rounded-xl p-[3px]">
              <button onClick={() => setMode('guide')} className={`flex-1 py-[8px] rounded-[10px] text-[12px] font-semibold cursor-pointer border-none transition-all duration-200 font-[inherit] ${mode === 'guide' ? 'bg-white/[0.1] text-white/80 shadow-[0_1px_4px_rgba(0,0,0,0.3)]' : 'bg-transparent text-white/30 hover:text-white/50'}`}>Guide / Instruct</button>
              <button onClick={() => setMode('go')} className={`flex-1 py-[8px] rounded-[10px] text-[12px] font-semibold cursor-pointer border-none transition-all duration-200 font-[inherit] ${mode === 'go' ? 'bg-[rgba(238,62,30,0.12)] text-[rgba(247,199,9,0.9)] shadow-[0_1px_4px_rgba(0,0,0,0.3)]' : 'bg-transparent text-white/30 hover:text-white/50'}`}>Go Mode</button>
            </div>
            {mode === 'go' && (
              <p className="text-[11px] text-[rgba(247,199,9,0.5)] mt-1.5 flex items-center gap-1">
                <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0"><path d="M6 1L11 10H1L6 1Z" stroke="currentColor" strokeWidth="1" fill="none" /><line x1="6" y1="4.5" x2="6" y2="7" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /><circle cx="6" cy="8.2" r="0.5" fill="currentColor" /></svg>
                Agent will perform actions automatically on your behalf
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/[0.06] flex items-center justify-end gap-2.5">
          <button onClick={onCancel} className="px-4 py-[8px] rounded-xl border border-white/[0.08] bg-transparent text-white/40 text-[13px] font-semibold cursor-pointer transition-all duration-150 hover:bg-white/[0.04] hover:text-white/60 font-[inherit]">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={!canSave}
            className="px-5 py-[8px] rounded-xl border-none text-[13px] font-semibold cursor-pointer transition-all duration-150 font-[inherit] disabled:opacity-30 disabled:cursor-not-allowed bg-[rgba(122,0,180,0.2)] text-[rgba(190,5,198,0.95)] hover:bg-[rgba(122,0,180,0.3)] disabled:hover:bg-[rgba(122,0,180,0.2)]"
          >
            Create Agent
          </button>
        </div>
      </div>
    </div>
  )
}
