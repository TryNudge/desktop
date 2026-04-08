import { useState, useEffect, useRef, useCallback } from 'react'
import { getCurrentWindow, availableMonitors, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { useTauriEvent } from '../../lib/hooks'
import type { StepPlan, Step } from '../../lib/types'

const CURSOR_SIZE = 48

function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3) }
function easeOutBack(t: number) { const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2) }
function bezierPoint(t: number, p0: number, cp: number, p1: number) { const u = 1 - t; return u * u * p0 + 2 * u * t * cp + t * t * p1 }

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cursorImgRef = useRef<HTMLImageElement>(null)
  const captionRef = useRef<HTMLDivElement>(null)

  const planRef = useRef<StepPlan | null>(null)
  const currentStepIdxRef = useRef(0)
  const cursorPos = useRef({ x: 0, y: 0 })
  const startPos = useRef({ x: 0, y: 0 })
  const animProgressRef = useRef(0)
  const animatingRef = useRef(false)
  const windowOffset = useRef({ x: 0, y: 0 })
  const cursorLoadedRef = useRef(false)
  const globalTimeRef = useRef(0)
  const pulsPhaseRef = useRef(0)
  const lastTimeRef = useRef(0)
  const cursorScaleRef = useRef(0)
  const animFrameRef = useRef<number>(0)

  const [captionVisible, setCaptionVisible] = useState(false)
  const [captionStep, setCaptionStep] = useState('Step 1')
  const [captionText, setCaptionText] = useState('')
  const [captionPos, setCaptionPos] = useState({ x: 0, y: 0 })
  const [loading, setLoading] = useState(false)

  // Resize canvas
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = window.innerWidth
        canvas.height = window.innerHeight
      }
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  // Load cursor image
  useEffect(() => {
    const img = cursorImgRef.current
    if (!img) return
    if (img.complete && img.naturalWidth > 0) {
      cursorLoadedRef.current = true
    } else {
      img.onload = () => { cursorLoadedRef.current = true }
    }
  }, [])

  const drawCursor = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number, scale: number, alpha: number) => {
    const img = cursorImgRef.current
    if (!cursorLoadedRef.current || !img) return

    const floatY = animatingRef.current ? 0 : Math.sin(globalTimeRef.current * 1.8) * 3

    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(x, y + floatY)
    ctx.scale(scale, scale)
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)'
    ctx.shadowBlur = 10
    ctx.shadowOffsetX = 2
    ctx.shadowOffsetY = 4
    ctx.drawImage(img, -CURSOR_SIZE * 0.15, -CURSOR_SIZE * 0.1, CURSOR_SIZE, CURSOR_SIZE)
    ctx.restore()
  }, [])

  const drawTargetIndicator = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number, phase: number) => {
    const t = phase % 1
    const r = 4 + t * 18
    const alpha = 0.18 * (1 - t)

    ctx.beginPath()
    ctx.arc(x + CURSOR_SIZE * 0.25, y + CURSOR_SIZE * 0.3, r, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(43, 43, 43, ${alpha})`
    ctx.lineWidth = 1
    ctx.stroke()
  }, [])

  const positionCaption = useCallback((step: Step) => {
    const plan = planRef.current
    const el = captionRef.current
    if (!plan || !el) return

    const sf = plan.scale_factor
    const ox = plan.monitor_offset_x - windowOffset.current.x
    const oy = plan.monitor_offset_y - windowOffset.current.y
    const tx = step.target.x * sf + ox
    const ty = step.target.y * sf + oy

    // Temporarily make visible off-screen to measure
    el.style.visibility = 'hidden'
    el.style.left = '0px'
    el.style.top = '0px'
    setCaptionVisible(true)

    requestAnimationFrame(() => {
      const rect = el.getBoundingClientRect()
      const pad = 24
      const W = window.innerWidth
      const H = window.innerHeight
      const zone = 65

      const candidates = [
        { cx: tx + zone + 16, cy: ty - rect.height / 2 },
        { cx: tx - rect.width - zone - 16, cy: ty - rect.height / 2 },
        { cx: tx - rect.width / 2, cy: ty - rect.height - zone - 16 },
        { cx: tx - rect.width / 2, cy: ty + zone + 40 },
      ]

      let best = candidates[0]
      let bestScore = -Infinity
      for (const pos of candidates) {
        let score = 0
        pos.cx = Math.max(pad, Math.min(pos.cx, W - rect.width - pad))
        pos.cy = Math.max(pad, Math.min(pos.cy, H - rect.height - pad))
        const overlapX = tx >= pos.cx && tx <= pos.cx + rect.width
        const overlapY = ty >= pos.cy && ty <= pos.cy + rect.height
        if (overlapX && overlapY) score -= 1000
        if (pos === candidates[0]) score += 10
        if (score > bestScore) { bestScore = score; best = pos }
      }

      setCaptionPos({ x: best.cx, y: best.cy })
      el.style.visibility = 'visible'
    })
  }, [])

  const animate = useCallback((timestamp: number) => {
    const plan = planRef.current
    const canvas = canvasRef.current
    if (!plan || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dt = lastTimeRef.current ? (timestamp - lastTimeRef.current) / 1000 : 0
    lastTimeRef.current = timestamp
    globalTimeRef.current += dt

    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const step = plan.steps[currentStepIdxRef.current]
    if (!step) return

    const sf = plan.scale_factor
    const ox = plan.monitor_offset_x - windowOffset.current.x
    const oy = plan.monitor_offset_y - windowOffset.current.y
    const tx = step.target.x * sf + ox
    const ty = step.target.y * sf + oy

    if (animatingRef.current) {
      animProgressRef.current = Math.min(animProgressRef.current + dt * 2.2, 1)
      const t = easeOutCubic(animProgressRef.current)
      const cpX = (startPos.current.x + tx) / 2
      const cpY = Math.min(startPos.current.y, ty) - 60
      cursorPos.current.x = bezierPoint(t, startPos.current.x, cpX, tx)
      cursorPos.current.y = bezierPoint(t, startPos.current.y, cpY, ty)
      cursorScaleRef.current = easeOutBack(Math.min(animProgressRef.current * 3.5, 1))

      if (animProgressRef.current >= 1) {
        animatingRef.current = false
        cursorPos.current.x = tx
        cursorPos.current.y = ty
        cursorScaleRef.current = 1
      }
    }

    if (!animatingRef.current) {
      pulsPhaseRef.current += dt * 0.7
      drawTargetIndicator(ctx, cursorPos.current.x, cursorPos.current.y, pulsPhaseRef.current)
    }

    drawCursor(
      ctx,
      cursorPos.current.x,
      cursorPos.current.y,
      cursorScaleRef.current,
      animatingRef.current ? Math.min(animProgressRef.current * 2, 1) : 1,
    )

    animFrameRef.current = requestAnimationFrame(animate)
  }, [drawCursor, drawTargetIndicator])

  const showStep = useCallback((idx: number) => {
    const plan = planRef.current
    const canvas = canvasRef.current
    if (!plan || idx >= plan.steps.length || !canvas) return

    currentStepIdxRef.current = idx
    const step = plan.steps[idx]

    setCaptionStep(`Step ${step.step_number}`)
    setCaptionText(step.instruction)

    startPos.current.x = cursorPos.current.x || canvas.width / 2
    startPos.current.y = cursorPos.current.y || canvas.height / 2
    animatingRef.current = true
    animProgressRef.current = 0
    cursorScaleRef.current = 0

    setCaptionVisible(false)
    setTimeout(() => positionCaption(step), 350)

    lastTimeRef.current = 0
    cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = requestAnimationFrame(animate)
    emit('step-update', { current: idx + 1, total: plan.steps.length, instruction: step.instruction })
  }, [animate, positionCaption])

  // show-loading
  useTauriEvent('show-loading', async () => {
    const win = getCurrentWindow()
    const monitors = await availableMonitors()
    if (monitors.length > 0) {
      const mon = monitors[0]
      const sf = mon.scaleFactor || 1
      windowOffset.current.x = mon.position.x
      windowOffset.current.y = mon.position.y
      await win.setPosition(new LogicalPosition(mon.position.x / sf, mon.position.y / sf))
      await win.setSize(new LogicalSize(mon.size.width / sf, mon.size.height / sf))
    }
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }
    setCaptionVisible(false)
    setLoading(true)
    await win.show()
  })

  // show-plan
  useTauriEvent<StepPlan>('show-plan', async (plan) => {
    setLoading(false)
    planRef.current = plan
    const win = getCurrentWindow()
    const monitors = await availableMonitors()
    if (monitors.length > 0) {
      let targetMon = monitors[0]
      for (const mon of monitors) {
        if (mon.position.x === plan.monitor_offset_x && mon.position.y === plan.monitor_offset_y) {
          targetMon = mon
          break
        }
      }
      const sf = targetMon.scaleFactor || 1
      windowOffset.current.x = targetMon.position.x
      windowOffset.current.y = targetMon.position.y
      await win.setPosition(new LogicalPosition(targetMon.position.x / sf, targetMon.position.y / sf))
      await win.setSize(new LogicalSize(targetMon.size.width / sf, targetMon.size.height / sf))
    }
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    cursorPos.current.x = (canvas?.width ?? window.innerWidth) / 2
    cursorPos.current.y = (canvas?.height ?? window.innerHeight) / 2
    await win.show()
    showStep(0)
  })

  // next-step
  useTauriEvent('next-step', () => {
    if (planRef.current && currentStepIdxRef.current < planRef.current.steps.length - 1) {
      showStep(currentStepIdxRef.current + 1)
    }
  })

  // dismiss
  useTauriEvent('dismiss', () => {
    planRef.current = null
    const canvas = canvasRef.current
    if (canvas) {
      const ctx = canvas.getContext('2d')
      ctx?.clearRect(0, 0, canvas.width, canvas.height)
    }
    setCaptionVisible(false)
    setLoading(false)
    cancelAnimationFrame(animFrameRef.current)
    getCurrentWindow().hide()
  })

  // show-answer dismisses loading
  useTauriEvent('show-answer', () => {
    setLoading(false)
    if (!planRef.current) {
      getCurrentWindow().hide()
    }
  })

  return (
    <>
      {/* Hidden cursor image source */}
      <img ref={cursorImgRef} src="/nudge_cursor.png" className="hidden" />

      {/* Canvas */}
      <canvas ref={canvasRef} className="absolute top-0 left-0" />

      {/* Loading bar */}
      {loading && (
        <div className="absolute top-0 left-0 w-full z-[100] pointer-events-none">
          <div className="absolute left-0 w-full top-0 h-[2.5px] origin-center bg-[linear-gradient(90deg,transparent_0%,#7a00b4_15%,#be05c6_30%,#ee3e1e_50%,#f16f08_70%,#f7c709_85%,transparent_100%)] shadow-[0_0_16px_rgba(190,5,198,0.3),0_0_8px_rgba(241,111,8,0.2)] animate-[loading-expand_2s_cubic-bezier(0.16,1,0.3,1)_infinite]" />
          <div className="absolute left-0 w-full top-1 h-px origin-center bg-[linear-gradient(90deg,transparent_0%,rgba(122,0,180,0.3)_20%,rgba(238,62,30,0.4)_50%,rgba(247,199,9,0.3)_80%,transparent_100%)] animate-[loading-expand_2s_cubic-bezier(0.16,1,0.3,1)_0.2s_infinite]" />
        </div>
      )}

      {/* Caption bubble */}
      <div
        ref={captionRef}
        className={`absolute max-w-[400px] min-w-[180px] pointer-events-none z-10 transition-all duration-350 ease-out ${
          captionVisible
            ? 'opacity-100 translate-y-0 scale-100'
            : 'opacity-0 translate-y-[6px] scale-[0.98]'
        }`}
        style={{ left: `${captionPos.x}px`, top: `${captionPos.y}px` }}
      >
        <div className="bg-[rgba(24,24,28,0.88)] border border-white/[0.08] rounded-2xl px-[18px] py-[14px] backdrop-blur-[32px] backdrop-saturate-[1.4] shadow-[0_16px_48px_rgba(0,0,0,0.55),0_0_0_0.5px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.05)]">
          <div className="flex items-center gap-2 mb-[10px]">
            <div className="inline-flex items-center gap-[5px] px-[10px] pl-2 py-[3px] bg-[rgba(43,43,43,0.6)] border border-white/10 rounded-full text-[11px] font-bold text-white/75 tracking-[0.3px]">
              <div className="w-[6px] h-[6px] bg-white/50 rounded-full animate-[badge-pulse_2.5s_ease-in-out_infinite]" />
              <span>{captionStep}</span>
            </div>
          </div>
          <div className="text-white/[0.92] text-sm leading-[1.6] font-normal font-[inherit]">
            {captionText}
          </div>
        </div>
      </div>
    </>
  )
}
