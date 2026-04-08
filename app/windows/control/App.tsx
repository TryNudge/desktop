import { useState, useCallback, useRef } from 'react'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow, currentMonitor, LogicalPosition } from '@tauri-apps/api/window'
import { useKeybinds, formatShortcut, useTauriEvent } from '../../lib/hooks'
import * as api from '../../lib/tauri'
import type { StepPlan } from '../../lib/types'

export default function App() {
  const keybinds = useKeybinds()
  const [stepCount, setStepCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const currentInstruction = useRef('')

  const nextHint = formatShortcut(keybinds.next_step)
  const dismissHint = formatShortcut(keybinds.dismiss)

  const positionSelf = useCallback(async () => {
    const win = getCurrentWindow()
    const monitor = await currentMonitor()
    if (monitor) {
      const sf = monitor.scaleFactor || 1
      const mx = monitor.position.x / sf
      const my = monitor.position.y / sf
      const mw = monitor.size.width / sf
      const mh = monitor.size.height / sf
      await win.setPosition(new LogicalPosition(mx + mw - 500, my + mh - 100))
    }
    await win.show()
  }, [])

  useTauriEvent<StepPlan>('show-plan', (plan) => {
    setStepCount((c) => c + 1)
    currentInstruction.current = plan.steps[0]?.instruction || ''
    setLoading(false)
    positionSelf()
  })

  const handleNext = useCallback(async () => {
    if (loading) return
    setLoading(true)

    emit('dismiss', {})
    await new Promise((r) => setTimeout(r, 400))
    emit('show-loading')

    try {
      const plan = await api.nextStep(currentInstruction.current)
      setStepCount((c) => c + 1)
      currentInstruction.current = plan.steps[0]?.instruction || ''
      setLoading(false)
      emit('show-plan', plan)
    } catch (err) {
      console.error('next_step failed:', err)
      emit('dismiss')
      setLoading(false)
    }
  }, [loading])

  const handleDismiss = useCallback(() => {
    emit('dismiss', {})
    emit('dismiss-answer', {})
    setStepCount(0)
    getCurrentWindow().hide()
  }, [])

  useTauriEvent('global-next-step', handleNext)
  useTauriEvent('global-dismiss', handleDismiss)

  return (
    <div
      className="flex items-center h-screen bg-[rgb(24,24,28)] select-none"
      style={{ gap: '8px', padding: '8px 14px' }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleNext()
        if (e.key === 'Escape') handleDismiss()
      }}
      tabIndex={0}
    >
      {/* Step badge */}
      <div className="inline-flex items-center bg-[rgba(43,43,43,0.5)] border border-white/[0.08] rounded-full text-[12px] font-semibold text-white/70 tracking-[0.3px] whitespace-nowrap" style={{ gap: '5px', padding: '4px 10px 4px 8px' }}>
        <div className={`w-[6px] h-[6px] bg-white/45 rounded-full ${loading ? 'animate-[dot-pulse_1s_ease-in-out_infinite]' : ''}`} />
        <span>Step {stepCount}</span>
      </div>

      {/* Divider */}
      <div className="w-px h-5 bg-white/[0.06]" />

      {/* Next button */}
      <button
        onClick={handleNext}
        disabled={loading}
        className="border border-white/[0.12] rounded-[10px] text-[12px] font-semibold cursor-pointer transition-all duration-150 tracking-[0.2px] font-[inherit] bg-[rgba(43,43,43,0.9)] text-white/[0.88] hover:bg-[rgba(60,60,60,0.95)] hover:border-white/[0.18] hover:-translate-y-px hover:shadow-[0_4px_12px_rgba(0,0,0,0.3)] active:translate-y-0 disabled:bg-[rgba(43,43,43,0.4)] disabled:border-white/5 disabled:text-white/30 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
        style={{ padding: '6px 14px' }}
      >
        {loading ? 'Analyzing...' : 'Next step'}
        <span className="inline-block text-[10px] text-white/25 bg-white/[0.06] rounded font-medium" style={{ padding: '1px 5px', marginLeft: '5px' }}>
          {loading ? '\u21A9' : nextHint}
        </span>
      </button>

      {/* Dismiss button */}
      <button
        onClick={handleDismiss}
        className="border border-white/[0.06] rounded-[10px] text-[12px] font-semibold cursor-pointer transition-all duration-150 tracking-[0.2px] font-[inherit] bg-transparent text-white/35 hover:bg-[rgba(255,60,60,0.1)] hover:border-[rgba(255,80,80,0.2)] hover:text-[rgba(255,120,120,0.8)]"
        style={{ padding: '6px 14px' }}
      >
        Done
        <span className="inline-block text-[10px] text-white/25 bg-white/[0.06] rounded font-medium" style={{ padding: '1px 5px', marginLeft: '5px' }}>
          {dismissHint}
        </span>
      </button>
    </div>
  )
}
