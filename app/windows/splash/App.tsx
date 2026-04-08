import { useState, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getVersion } from '@tauri-apps/api/app'
import { useKeybinds, formatShortcut, useTauriEvent } from '../../lib/hooks'
import * as api from '../../lib/tauri'

const LAST_SLIDE = 5

function Kbd({ shortcut }: { shortcut: string }) {
  return (
    <div className="flex gap-1">
      {shortcut.split('+').map((part, i) => (
        <kbd
          key={i}
          className="inline-flex items-center justify-center min-w-7 h-[26px] px-[7px] bg-white/[0.08] border border-white/10 rounded-[6px] text-[11px] font-semibold text-white/70 font-[inherit]"
        >
          {formatShortcut(part)}
        </kbd>
      ))}
    </div>
  )
}

function StepIndicator({ active, total }: { active: number; total: number }) {
  return (
    <div className="flex gap-[6px] mt-5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-[6px] rounded-full transition-all duration-300 ${
            i === active ? 'w-[18px] bg-white/60 rounded-[3px]' : 'w-[6px] bg-white/10'
          }`}
        />
      ))}
    </div>
  )
}

export default function App() {
  const [currentSlide, setCurrentSlide] = useState(0)
  const [version, setVersion] = useState('')
  const [signinState, setSigninState] = useState<'default' | 'waiting'>('default')
  const [signinUrl, setSigninUrl] = useState('#')
  const keybinds = useKeybinds()

  useEffect(() => {
    getVersion().then((v) => setVersion(`v${v}`))
  }, [])

  // Check if already authenticated on load
  useEffect(() => {
    api.getAuthState().then((state) => {
      if (state.authenticated) getCurrentWindow().hide()
    }).catch(() => {})
  }, [])

  useTauriEvent('auth-success', () => {
    setCurrentSlide(1)
    setSigninState('default')
  })

  const goTo = (index: number) => setCurrentSlide(index)

  const handleSignIn = async () => {
    try {
      const url = await api.login()
      setSigninState('waiting')
      setSigninUrl(url)
    } catch (e) {
      console.error(e)
    }
  }

  const handleNext = () => {
    if (currentSlide === LAST_SLIDE) {
      getCurrentWindow().hide()
      api.showDashboard().catch(console.error)
    } else {
      goTo(currentSlide + 1)
    }
  }

  const handleBack = () => {
    if (currentSlide > 1) goTo(currentSlide - 1)
  }

  return (
    <div className="w-full h-full bg-[rgb(18,18,22)] border border-white/[0.06] rounded-[20px] flex flex-col relative overflow-hidden">
      {/* Gradient glow */}
      <div className="absolute -top-[20%] left-1/2 -translate-x-1/2 w-[200px] h-[200px] bg-[radial-gradient(circle,rgba(190,5,198,0.06)_0%,rgba(122,0,180,0.03)_50%,transparent_75%)] blur-[30px] pointer-events-none" />

      {/* Slides */}
      <div className="flex-1 min-h-0 relative z-[1]">
        {/* Slide 0: Sign In */}
        <Slide active={currentSlide === 0}>
          <img src="/nudgekeycap.png" alt="Nudge" className="w-16 h-16 rounded-2xl object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.4)] mb-4" />
          <h2 className="text-2xl font-bold text-white/95 tracking-[-0.3px] mb-2">Nudge</h2>
          {signinState === 'default' ? (
            <>
              <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
                AI-powered desktop navigation.<br />Sign in to get started.
              </p>
              <div className="flex flex-col gap-[10px] w-full max-w-[260px] mt-7">
                <button
                  onClick={handleSignIn}
                  className="w-full py-[11px] px-5 border-none rounded-xl bg-white/[0.93] text-black text-sm font-semibold cursor-pointer transition-all duration-150 font-[inherit] hover:bg-white hover:-translate-y-px hover:shadow-[0_4px_16px_rgba(255,255,255,0.1)] active:translate-y-0"
                >
                  Sign In
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
                Opened in your browser.<br />Complete sign in to continue.
              </p>
              <a
                href={signinUrl}
                className="inline-block mt-4 text-xs text-white/30 no-underline transition-colors duration-150 hover:text-white/60 hover:underline"
              >
                Open manually
              </a>
            </>
          )}
        </Slide>

        {/* Slide 1: Welcome */}
        <Slide active={currentSlide === 1}>
          <img src="/nudgekeycap.png" alt="Nudge" className="w-16 h-16 rounded-2xl object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.4)] mb-4" />
          <h2 className="text-2xl font-bold text-white/95 tracking-[-0.3px] mb-2">Welcome to Nudge</h2>
          <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
            Let's walk through how it works. It only takes a moment.
          </p>
          <StepIndicator active={0} total={4} />
        </Slide>

        {/* Slide 2: Open Nudge */}
        <Slide active={currentSlide === 2}>
          <h2 className="text-2xl font-bold text-white/95 tracking-[-0.3px] mb-2">Open Nudge</h2>
          <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
            Press this shortcut anywhere to bring up the Nudge input bar.
          </p>
          <div className="flex flex-col gap-4 mt-6 w-full max-w-[280px]">
            <div className="flex items-center justify-between px-[14px] py-[10px] bg-white/[0.03] border border-white/[0.06] rounded-xl">
              <span className="text-[13px] text-white/50 font-medium">Open Nudge</span>
              <Kbd shortcut={keybinds.open_nudge} />
            </div>
          </div>
          <StepIndicator active={0} total={4} />
        </Slide>

        {/* Slide 3: Ask anything */}
        <Slide active={currentSlide === 3}>
          <h2 className="text-2xl font-bold text-white/95 tracking-[-0.3px] mb-2">Ask Anything</h2>
          <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
            Type what you need help with. Nudge will guide you step by step.
          </p>
          <div className="mt-6 w-full max-w-[320px] flex items-center gap-[10px] px-[14px] py-[10px] bg-[rgb(24,24,28)] border border-white/[0.06] rounded-[14px]">
            <img src="/nudgekeycap.png" alt="" className="w-[26px] h-[26px] rounded-lg object-contain" />
            <span className="flex-1 text-sm text-white/25 text-left">How do I merge cells in Excel?</span>
            <div className="w-[1.5px] h-[18px] bg-white/40 rounded-[1px] -ml-1 animate-[blink_1.2s_step-end_infinite]" />
          </div>
          <p className="mt-[10px] text-[11px] text-white/20 italic">Hover the logo to enable Research mode</p>
          <StepIndicator active={1} total={4} />
        </Slide>

        {/* Slide 4: Follow the Steps */}
        <Slide active={currentSlide === 4}>
          <h2 className="text-2xl font-bold text-white/95 tracking-[-0.3px] mb-2">Follow the Steps</h2>
          <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
            Nudge highlights where to click. Use these shortcuts to navigate.
          </p>
          <div className="flex flex-col gap-4 mt-6 w-full max-w-[280px]">
            <div className="flex items-center justify-between px-[14px] py-[10px] bg-white/[0.03] border border-white/[0.06] rounded-xl">
              <span className="text-[13px] text-white/50 font-medium">Next step</span>
              <Kbd shortcut={keybinds.next_step} />
            </div>
            <div className="flex items-center justify-between px-[14px] py-[10px] bg-white/[0.03] border border-white/[0.06] rounded-xl">
              <span className="text-[13px] text-white/50 font-medium">Dismiss</span>
              <Kbd shortcut={keybinds.dismiss} />
            </div>
          </div>
          <StepIndicator active={2} total={4} />
        </Slide>

        {/* Slide 5: System tray */}
        <Slide active={currentSlide === 5}>
          <div className="mb-6">
            <div className="relative inline-flex flex-col items-end">
              <div className="flex items-center gap-[10px] px-[14px] py-2 bg-white/5 border border-white/[0.06] rounded-[10px]">
                <span className="w-4 h-4 rounded bg-white/[0.08]" />
                <span className="w-4 h-4 rounded bg-white/[0.08]" />
                <span className="w-4 h-4 bg-transparent flex items-center justify-center">
                  <img src="/nudgekeycap.png" alt="" className="w-4 h-4 rounded-[3px] object-contain" />
                </span>
                <span className="w-4 h-4 rounded bg-white/[0.08]" />
              </div>
              <div className="mt-1 bg-[rgb(38,38,42)] border border-white/[0.08] rounded-lg py-1">
                <div className="px-[14px] py-[6px] text-xs text-white/60 text-left">Settings</div>
                <div className="px-[14px] py-[6px] text-xs text-[rgba(255,100,100,0.5)] text-left">Quit</div>
              </div>
            </div>
          </div>
          <h2 className="text-2xl font-bold text-white/95 tracking-[-0.3px] mb-2">Find Nudge in Your Tray</h2>
          <p className="text-[13px] text-white/35 max-w-[300px]" style={{ lineHeight: '1.6' }}>
            Nudge runs quietly in the system tray.<br />Right-click the icon to open settings or quit.
          </p>
          <StepIndicator active={3} total={4} />
        </Slide>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between relative z-[1]" style={{ padding: '20px 36px 24px' }}>
        {currentSlide === 0 ? (
          <>
            <div />
            <div />
          </>
        ) : (
          <>
            <button
              onClick={handleBack}
              className={`px-5 py-[9px] border border-white/[0.06] rounded-[10px] bg-transparent text-white/35 text-[13px] font-semibold cursor-pointer transition-all duration-150 font-[inherit] hover:bg-white/[0.03] hover:text-white/50 ${
                currentSlide <= 1 ? 'invisible' : ''
              }`}
            >
              Back
            </button>
            <button
              onClick={handleNext}
              className="px-5 py-[9px] border-none rounded-[10px] bg-white/[0.93] text-black text-[13px] font-semibold cursor-pointer transition-all duration-150 font-[inherit] hover:bg-white hover:-translate-y-px hover:shadow-[0_4px_16px_rgba(255,255,255,0.1)] active:translate-y-0"
            >
              {currentSlide === LAST_SLIDE ? 'Get Started' : 'Next'}
            </button>
          </>
        )}
      </div>

      {/* Version */}
      <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-white/[0.08] z-[1]">
        {version}
      </span>
    </div>
  )
}

function Slide({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (!active) return null
  return (
    <div className="flex flex-col items-center justify-center h-full text-center" style={{ padding: '30px 36px 0' }}>
      {children}
    </div>
  )
}
