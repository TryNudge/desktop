import { useState, useRef, useEffect } from 'react'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useAuth, useWindowEvent } from '../../lib/hooks'
import * as api from '../../lib/tauri'

export default function App() {
  const auth = useAuth()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [researchMode, setResearchMode] = useState(false)
  const [placeholder, setPlaceholder] = useState('Ask Nudge anything...')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!auth.authenticated) {
      setPlaceholder('Sign in first (open Settings)')
    } else {
      setPlaceholder('Ask Nudge anything...')
    }
  }, [auth.authenticated])

  useWindowEvent('tauri://focus', () => {
    setQuery('')
    inputRef.current?.focus()
    auth.refresh()
  })

  const handleKeyDown = async (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      getCurrentWindow().hide()
      return
    }

    if (e.key === 'Enter' && query.trim()) {
      const q = query.trim()

      if (!auth.authenticated) {
        setQuery('')
        setPlaceholder('Sign in first (Ctrl+Shift+N \u2192 Settings)')
        return
      }

      setLoading(true)
      let failed = false

      try {
        await getCurrentWindow().hide()
        await new Promise((r) => setTimeout(r, 500))
        emit('show-loading')
        const response = await api.submitQuery(q, researchMode)

        if (response.response_type === 'answer') {
          // Rust already showed the answer window
        } else if (response.response_type === 'hybrid') {
          await emit('show-plan', {
            app_context: response.app_context,
            steps: response.steps || [],
            scale_factor: response.scale_factor,
            monitor_offset_x: response.monitor_offset_x,
            monitor_offset_y: response.monitor_offset_y,
          })
        } else {
          await emit('show-plan', {
            app_context: response.app_context,
            steps: response.steps || [],
            scale_factor: response.scale_factor,
            monitor_offset_x: response.monitor_offset_x,
            monitor_offset_y: response.monitor_offset_y,
          })
        }
      } catch (err) {
        failed = true
        await emit('dismiss')
        await getCurrentWindow().show()
        setQuery('')
        setPlaceholder(`Error: ${err}`)
      }

      setLoading(false)
      if (!failed) {
        setQuery('')
        setPlaceholder('Ask Nudge anything...')
      }
    }
  }

  return (
    <div className="flex items-center h-screen bg-[rgb(24,24,28)] relative" style={{ gap: '12px', padding: '10px 16px' }}>
      {/* Logo + research toggle */}
      <div className="relative shrink-0 flex items-center cursor-pointer group">
        <img
          src="/nudgekeycap.png"
          alt="Nudge"
          className="w-[30px] h-[30px] rounded-[10px] object-contain shrink-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)] group-hover:drop-shadow-[0_2px_8px_rgba(100,120,255,0.3)] transition-[filter] duration-150"
        />
        <div className="flex items-center overflow-hidden max-w-0 opacity-0 group-hover:max-w-[140px] group-hover:opacity-100 group-hover:ml-2 transition-all duration-200">
          <div className="flex items-center gap-[6px] px-2 py-1 bg-white/[0.04] border border-white/[0.06] rounded-lg whitespace-nowrap">
            <svg className="text-white/35 shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <span className="text-[11px] font-medium text-white/40 select-none">Research</span>
            <label className="relative w-7 h-4 shrink-0">
              <input
                type="checkbox"
                checked={researchMode}
                onChange={(e) => setResearchMode(e.target.checked)}
                className="hidden"
              />
              <span className={`absolute inset-0 rounded-lg cursor-pointer transition-colors duration-200 ${
                researchMode ? 'bg-[rgba(100,120,255,0.4)]' : 'bg-white/10'
              }`}>
                <span className={`absolute w-3 h-3 left-[2px] top-[2px] rounded-full transition-all duration-200 ${
                  researchMode ? 'translate-x-3 bg-[rgba(140,160,255,0.95)]' : 'bg-white/50'
                }`} />
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Input */}
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={loading}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        className="flex-1 bg-transparent border-none outline-none text-white/[0.92] text-[15px] font-normal caret-white/60 tracking-[0.1px] placeholder:text-white/25 placeholder:font-normal disabled:opacity-50 font-[inherit]"
      />

      {/* Hint / Spinner */}
      {loading ? (
        <div className="w-[18px] h-[18px] border-[1.5px] border-white/10 border-t-white/50 rounded-full animate-[spin_0.8s_linear_infinite] shrink-0" />
      ) : (
        <span className="text-[11px] text-white/[0.18] whitespace-nowrap rounded-[6px] bg-white/[0.04] border border-white/[0.04] shrink-0" style={{ padding: '3px 8px' }}>
          Enter &#x21B5;
        </span>
      )}
    </div>
  )
}
