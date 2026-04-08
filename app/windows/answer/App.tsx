import { useState, useEffect, useRef, useCallback } from 'react'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTauriEvent, useWindowEvent } from '../../lib/hooks'
import * as api from '../../lib/tauri'
import type { AnswerPayload } from '../../lib/types'

type ResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest'

function ResizeHandles() {
  const start = (dir: ResizeDirection) => (e: React.MouseEvent) => {
    e.preventDefault()
    getCurrentWindow().startResizeDragging(dir)
  }

  const edge = 'absolute z-50'
  const sz = 5 // handle thickness in px

  return (
    <>
      <div className={edge} style={{ top: 0, left: sz, right: sz, height: sz, cursor: 'ns-resize' }} onMouseDown={start('North')} />
      <div className={edge} style={{ bottom: 0, left: sz, right: sz, height: sz, cursor: 'ns-resize' }} onMouseDown={start('South')} />
      <div className={edge} style={{ left: 0, top: sz, bottom: sz, width: sz, cursor: 'ew-resize' }} onMouseDown={start('West')} />
      <div className={edge} style={{ right: 0, top: sz, bottom: sz, width: sz, cursor: 'ew-resize' }} onMouseDown={start('East')} />
      <div className={edge} style={{ top: 0, left: 0, width: sz, height: sz, cursor: 'nwse-resize' }} onMouseDown={start('NorthWest')} />
      <div className={edge} style={{ top: 0, right: 0, width: sz, height: sz, cursor: 'nesw-resize' }} onMouseDown={start('NorthEast')} />
      <div className={edge} style={{ bottom: 0, left: 0, width: sz, height: sz, cursor: 'nesw-resize' }} onMouseDown={start('SouthWest')} />
      <div className={edge} style={{ bottom: 0, right: 0, width: sz, height: sz, cursor: 'nwse-resize' }} onMouseDown={start('SouthEast')} />
    </>
  )
}

function renderMarkdown(text: string): string {
  if (!text) return ''
  let html = text

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_: string, _lang: string, code: string) => {
    const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<pre><code>${escaped.trimEnd()}</code></pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Unordered lists
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>')
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>')

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')

  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>')
  html = html.replace(/([^>])\n([^<])/g, '$1<br>$2')

  if (!html.match(/^<(h[1-3]|pre|ul|ol|blockquote|p)/)) {
    html = '<p>' + html + '</p>'
  }

  return html
}

interface ThreadEntry {
  type: 'answer' | 'user' | 'thinking' | 'error'
  content: string
}

export default function App() {
  const [title, setTitle] = useState('Answer')
  const [thread, setThread] = useState<ThreadEntry[]>([])
  const [copyText, setCopyText] = useState('')
  const [hasSteps, setHasSteps] = useState(false)
  const [copied, setCopied] = useState(false)
  const [followup, setFollowup] = useState('')
  const [followupLoading, setFollowupLoading] = useState(false)
  const followupRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    })
  }, [])

  const showAnswer = useCallback((payload: AnswerPayload) => {
    setTitle(payload.title || 'Answer')
    setThread([{ type: 'answer', content: payload.content || '' }])
    setCopyText(payload.copyable_text || payload.content || '')
    setHasSteps(payload._has_steps || false)
    setCopied(false)
    setFollowup('')
    setFollowupLoading(false)
  }, [])

  const loadPendingAnswer = useCallback(async () => {
    try {
      const answer = await api.getPendingAnswer()
      if (answer) showAnswer(answer)
    } catch (e) {
      console.error('[answer] failed to get pending answer:', e)
    }
  }, [showAnswer])

  useTauriEvent<AnswerPayload>('show-answer', showAnswer)

  useWindowEvent('tauri://focus', () => {
    loadPendingAnswer()
    followupRef.current?.focus()
  })

  useEffect(() => {
    const handler = () => {
      if (!document.hidden) {
        loadPendingAnswer()
        followupRef.current?.focus()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [loadPendingAnswer])

  useEffect(() => { loadPendingAnswer() }, [loadPendingAnswer])

  useTauriEvent('dismiss-answer', () => {
    getCurrentWindow().hide()
  })

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (e) {
      console.error('copy failed:', e)
    }
  }

  const handleFollowup = async (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      getCurrentWindow().hide()
      return
    }

    if (e.key === 'Enter' && followup.trim()) {
      const query = followup.trim()
      setFollowup('')
      setFollowupLoading(true)

      // Add user message + thinking indicator
      setThread((prev) => [
        ...prev,
        { type: 'user', content: query },
        { type: 'thinking', content: 'Thinking...' },
      ])
      scrollToBottom()

      try {
        const response = await api.submitFollowup(query)

        if (response.response_type === 'answer' || response.response_type === 'hybrid') {
          const answerData = response.answer || { title: '', content: '', copyable_text: '' }
          setHasSteps(response.response_type === 'hybrid' && (response.steps?.length ?? 0) > 0)
          setCopyText(answerData.copyable_text || answerData.content || '')

          // Replace thinking with actual answer
          setThread((prev) => [
            ...prev.filter((e) => e.type !== 'thinking'),
            { type: 'answer', content: answerData.content || '' },
          ])

          if (response.response_type === 'hybrid' && response.steps && response.steps.length > 0) {
            await emit('show-plan', {
              app_context: response.app_context,
              steps: response.steps,
              scale_factor: response.scale_factor,
              monitor_offset_x: response.monitor_offset_x,
              monitor_offset_y: response.monitor_offset_y,
            })
          }
        } else if (response.response_type === 'steps') {
          // Remove thinking, hide window, show overlay
          setThread((prev) => prev.filter((e) => e.type !== 'thinking'))
          await getCurrentWindow().hide()
          await emit('show-plan', {
            app_context: response.app_context,
            steps: response.steps,
            scale_factor: response.scale_factor,
            monitor_offset_x: response.monitor_offset_x,
            monitor_offset_y: response.monitor_offset_y,
          })
        }
      } catch (err) {
        setThread((prev) => [
          ...prev.filter((e) => e.type !== 'thinking'),
          { type: 'error', content: String(err) },
        ])
      }

      setFollowupLoading(false)
      scrollToBottom()
      followupRef.current?.focus()
    }
  }

  return (
    <div className="relative flex flex-col h-screen bg-[rgb(24,24,28)] overflow-hidden">
      <ResizeHandles />
      {/* Title bar */}
      <div className="flex items-center justify-between bg-white/[0.02] border-b border-white/[0.06] shrink-0" style={{ padding: '10px 14px', WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex items-center min-w-0" style={{ gap: '10px' }}>
          <img src="/nudgekeycap.png" alt="Nudge" className="w-[22px] h-[22px] rounded-[6px] object-contain shrink-0" />
          <span className="text-[13px] font-semibold text-white/70 whitespace-nowrap overflow-hidden text-ellipsis">{title}</span>
        </div>
        <div className="flex items-center shrink-0" style={{ gap: '6px', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {hasSteps && (
            <button
              onClick={() => getCurrentWindow().hide()}
              className="px-[10px] py-1 border border-white/[0.12] rounded-lg bg-[rgba(43,43,43,0.9)] text-white/80 text-[11px] font-semibold cursor-pointer transition-all duration-150 font-[inherit] hover:bg-[rgba(60,60,60,0.95)] hover:border-white/[0.18]"
            >
              Show Steps
            </button>
          )}
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1 px-[10px] py-1 border rounded-lg text-[11px] font-medium cursor-pointer transition-all duration-150 font-[inherit] ${
              copied
                ? 'border-[rgba(80,200,120,0.3)] text-[rgba(80,200,120,0.8)] bg-[rgba(43,43,43,0.5)]'
                : 'border-white/[0.08] text-white/50 bg-[rgba(43,43,43,0.5)] hover:bg-[rgba(43,43,43,0.8)] hover:border-white/15 hover:text-white/80'
            }`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
            </svg>
            <span>{copied ? 'Copied!' : 'Copy'}</span>
          </button>
          <button
            onClick={() => emit('dismiss-answer')}
            className="w-6 h-6 flex items-center justify-center border-none rounded-[6px] bg-transparent text-white/25 text-base cursor-pointer transition-all duration-150 hover:bg-[rgba(255,60,60,0.15)] hover:text-[rgba(255,120,120,0.9)]"
          >
            &times;
          </button>
        </div>
      </div>

      {/* Thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ padding: '16px 18px' }}>
        <div className="relative" style={{ paddingLeft: '20px' }}>
          {/* Vertical connecting line */}
          {thread.length > 1 && (
            <div
              className="absolute left-[4px] bg-white/[0.08] rounded-full"
              style={{ top: '10px', bottom: '10px', width: '1.5px' }}
            />
          )}

          {thread.map((entry, i) => (
            <div key={i} className="relative" style={{ paddingBottom: i < thread.length - 1 ? '16px' : '0' }}>
              {/* Dot */}
              <div
                className={`absolute rounded-full ${
                  entry.type === 'user'
                    ? 'bg-white/40'
                    : entry.type === 'thinking'
                    ? 'bg-white/20'
                    : entry.type === 'error'
                    ? 'bg-[rgba(255,100,100,0.6)]'
                    : 'bg-white/25'
                }`}
                style={{ left: '-20px', top: entry.type === 'user' ? '5px' : '6px', width: '9px', height: '9px' }}
              />

              {entry.type === 'user' ? (
                <div className="text-[12.5px] font-medium text-white/50" style={{ lineHeight: '1.5' }}>
                  {entry.content}
                </div>
              ) : entry.type === 'thinking' ? (
                <div className="text-[13px] italic animate-[shimmer_1.5s_ease-in-out_infinite]" style={{ lineHeight: '1.5', backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.45) 50%, rgba(255,255,255,0.2) 100%)', backgroundSize: '200% 100%', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  {entry.content}
                </div>
              ) : entry.type === 'error' ? (
                <div className="text-[13px] text-[rgba(255,100,100,0.8)]" style={{ lineHeight: '1.5' }}>
                  Error: {entry.content}
                </div>
              ) : (
                <div
                  className="answer-content text-white/[0.88] text-[13.5px] tracking-[0.1px]"
                  style={{ lineHeight: '1.65' }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Follow-up bar */}
      <div className="flex items-center border-t border-white/[0.06] bg-white/[0.02] shrink-0" style={{ gap: '8px', padding: '10px 14px' }}>
        <input
          ref={followupRef}
          type="text"
          value={followup}
          onChange={(e) => setFollowup(e.target.value)}
          onKeyDown={handleFollowup}
          placeholder="Ask a follow-up..."
          disabled={followupLoading}
          spellCheck={false}
          autoComplete="off"
          className="flex-1 bg-transparent border-none outline-none text-white/[0.88] text-[13px] font-normal caret-white/60 placeholder:text-white/20 placeholder:font-normal disabled:opacity-50 font-[inherit]"
        />
        {followupLoading ? (
          <div className="w-4 h-4 border-[1.5px] border-white/10 border-t-white/50 rounded-full animate-[spin_0.8s_linear_infinite] shrink-0" />
        ) : (
          <span className="text-[10px] text-white/15 whitespace-nowrap px-[6px] py-[2px] rounded bg-white/[0.04] border border-white/[0.04] shrink-0">
            Enter &#x21B5;
          </span>
        )}
      </div>
    </div>
  )
}
