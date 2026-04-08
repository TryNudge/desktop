import { useState, useEffect, useCallback } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getVersion } from '@tauri-apps/api/app'
import { useAuth, useKeybinds, formatShortcut, KEY_MAP, useTauriEvent } from '../../lib/hooks'
import * as api from '../../lib/tauri'
import type { UpdateInfo } from '../../lib/types'

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="relative w-10 h-[22px] shrink-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="opacity-0 w-0 h-0"
      />
      <span
        className={`absolute inset-0 rounded-[11px] cursor-pointer transition-colors duration-200 ${
          checked ? 'bg-[rgba(43,43,43,0.9)]' : 'bg-white/10'
        }`}
      >
        <span
          className={`absolute w-4 h-4 left-[3px] top-[3px] rounded-full transition-all duration-200 ${
            checked ? 'translate-x-[18px] bg-white' : 'bg-white/50'
          }`}
        />
      </span>
    </label>
  )
}

function KeybindButton({ action, display, onRecorded }: {
  action: string
  display: string
  onRecorded: () => void
}) {
  const [recording, setRecording] = useState(false)
  const [label, setLabel] = useState(display)

  useEffect(() => {
    setLabel(display)
  }, [display])

  const startRecording = useCallback(async () => {
    setRecording(true)
    setLabel('Press keys...')
    try { await api.pauseShortcuts() } catch {}
  }, [])

  useEffect(() => {
    if (!recording) return

    const handler = async (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()

      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return

      if (e.key === 'Escape') {
        setRecording(false)
        setLabel(display)
        try { await api.resumeShortcuts() } catch {}
        return
      }

      if (!e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return

      const parts: string[] = []
      if (e.ctrlKey) parts.push('ctrl')
      if (e.shiftKey) parts.push('shift')
      if (e.altKey) parts.push('alt')
      if (e.metaKey) parts.push('super')
      parts.push(KEY_MAP[e.key] || e.key.toLowerCase())

      const shortcut = parts.join('+')

      try {
        await api.setKeybind(action, shortcut)
        setLabel(formatShortcut(shortcut))
        setRecording(false)
        onRecorded()
        try { await api.resumeShortcuts() } catch {}
      } catch (err) {
        setLabel(String(err).slice(0, 30))
        setRecording(false)
        setTimeout(() => setLabel(display), 1500)
        try { await api.resumeShortcuts() } catch {}
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, action, display, onRecorded])

  return (
    <button
      onClick={(e) => { e.preventDefault(); startRecording() }}
      className={`px-3 py-[5px] border rounded-lg font-semibold text-xs min-w-[80px] text-center cursor-pointer transition-all duration-150 font-[inherit] ${
        recording
          ? 'bg-[rgba(80,120,255,0.15)] border-[rgba(80,120,255,0.4)] text-[rgba(180,200,255,0.9)] animate-[pulse-border_1.5s_ease-in-out_infinite]'
          : 'bg-[rgba(0,0,0,0.3)] border-white/10 text-white/60 hover:bg-white/[0.06] hover:border-white/[0.18] hover:text-white/80'
      }`}
    >
      {label}
    </button>
  )
}

export default function App() {
  const auth = useAuth()
  const keybinds = useKeybinds()
  const [version, setVersion] = useState('')
  const [uia, setUia] = useState(true)
  const [ocr, setOcr] = useState(true)
  const [saveStatus, setSaveStatus] = useState('Settings auto-save')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ available: false, version: null, notes: null })
  const [updateDesc, setUpdateDesc] = useState('Checking for updates...')
  const [updating, setUpdating] = useState(false)
  const [keybindVersion, setKeybindVersion] = useState(0)

  useEffect(() => {
    getVersion().then((v) => setVersion(`v${v}`))
  }, [])

  // Check for updates
  useEffect(() => {
    api.checkForUpdate().then((info) => {
      setUpdateInfo(info)
      if (info.available) {
        setUpdateDesc(info.notes || 'A new version is ready to install.')
      } else {
        setUpdateDesc("You\u2019re on the latest version.")
      }
    }).catch(() => {
      setUpdateDesc('Could not check for updates.')
    })
  }, [])

  // Listen for auth-success from deep link
  useTauriEvent('auth-success', () => auth.refresh())

  const showSaved = () => {
    setSaveStatus('Saved')
    setTimeout(() => setSaveStatus('Settings auto-save'), 1500)
  }

  const updateGrounding = (newUia: boolean, newOcr: boolean) => {
    api.setGrounding(JSON.stringify({ uia: newUia, ocr: newOcr })).catch(console.error)
    showSaved()
  }

  const handleUpdate = async () => {
    setUpdating(true)
    setUpdateDesc('Downloading update...')
    try {
      await api.installUpdate()
    } catch (e) {
      setUpdateDesc(`Update failed: ${e}`)
      setUpdating(false)
    }
  }

  return (
    <div className="bg-[rgb(20,20,24)] overflow-hidden h-screen flex flex-col text-white/90 font-[inherit]">
      {/* Title bar */}
      <div className="flex items-center gap-3 shrink-0" style={{ padding: '16px 20px 12px', WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <img src="/nudgekeycap.png" alt="Nudge" className="w-7 h-7 rounded-lg" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties} />
        <h1 className="text-[16px] font-bold flex-1 tracking-[-0.3px] leading-none">Nudge</h1>
        <span className="text-[11px] text-white/25 font-medium">{version}</span>
        <button
          onClick={() => getCurrentWindow().hide()}
          className="w-7 h-7 border-none bg-white/5 rounded-lg text-white/40 text-[14px] cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-[rgba(255,60,60,0.15)] hover:text-[rgba(255,100,100,0.9)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          &times;
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '0 20px 20px' }}>
        {/* Account */}
        <Section title="Account">
          <Card>
            {auth.authenticated ? (
              <ToggleRow
                label={auth.email || 'Signed in'}
                desc={auth.plan === 'pro' ? 'Pro plan' : 'Free plan'}
                right={
                  <button
                    onClick={async () => { await api.logout().catch(console.error); auth.refresh() }}
                    className="bg-transparent text-white/50 border border-white/15 rounded-lg px-3 py-[6px] text-xs cursor-pointer font-[inherit]"
                  >
                    Sign Out
                  </button>
                }
              />
            ) : (
              <ToggleRow
                label="Not signed in"
                desc="Sign in to use cloud features"
                right={
                  <button
                    onClick={() => api.login().catch(console.error)}
                    className="bg-white/90 text-black border-none rounded-lg px-4 py-[6px] text-xs font-semibold cursor-pointer"
                  >
                    Sign In
                  </button>
                }
              />
            )}
          </Card>
        </Section>

        {/* Grounding */}
        <Section title="Grounding">
          <Card>
            <ToggleRow
              label="UI Automation"
              desc="Pixel-perfect for native apps"
              right={
                <ToggleSwitch checked={uia} onChange={(v) => { setUia(v); updateGrounding(v, ocr) }} />
              }
            />
            <ToggleRow
              label="OCR Text Match"
              desc="Find text labels on screen"
              last
              right={
                <ToggleSwitch checked={ocr} onChange={(v) => { setOcr(v); updateGrounding(uia, v) }} />
              }
            />
          </Card>
        </Section>

        {/* Keybinds */}
        <Section title="Keybinds">
          <Card>
            <ToggleRow
              label="Open Nudge"
              right={
                <KeybindButton
                  key={`open_nudge_${keybindVersion}`}
                  action="open_nudge"
                  display={formatShortcut(keybinds.open_nudge)}
                  onRecorded={() => { showSaved(); setKeybindVersion((v) => v + 1) }}
                />
              }
            />
            <ToggleRow
              label="Next Step"
              right={
                <KeybindButton
                  key={`next_step_${keybindVersion}`}
                  action="next_step"
                  display={formatShortcut(keybinds.next_step)}
                  onRecorded={() => { showSaved(); setKeybindVersion((v) => v + 1) }}
                />
              }
            />
            <ToggleRow
              label="Dismiss"
              last
              right={
                <KeybindButton
                  key={`dismiss_${keybindVersion}`}
                  action="dismiss"
                  display={formatShortcut(keybinds.dismiss)}
                  onRecorded={() => { showSaved(); setKeybindVersion((v) => v + 1) }}
                />
              }
            />
          </Card>
        </Section>

        {/* Updates */}
        <Section title="Updates">
          <Card>
            <ToggleRow
              label={updateInfo.available ? `v${updateInfo.version} available` : version}
              desc={updateDesc}
              last
              right={
                updateInfo.available ? (
                  <button
                    onClick={handleUpdate}
                    disabled={updating}
                    className="bg-[rgba(80,120,255,0.15)] text-[rgba(160,180,255,0.9)] border border-[rgba(80,120,255,0.3)] rounded-lg px-[14px] py-[6px] text-xs font-semibold cursor-pointer font-[inherit] disabled:opacity-50"
                  >
                    {updating ? 'Updating...' : 'Update'}
                  </button>
                ) : undefined
              }
            />
          </Card>
        </Section>

        <div className={`text-[11px] text-center py-2 transition-opacity duration-300 ${
          saveStatus === 'Saved' ? 'text-[rgba(120,220,120,0.6)]' : 'text-white/30'
        }`}>
          {saveStatus}
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] font-bold text-white/35 uppercase tracking-[1px] mb-[10px]">{title}</div>
      {children}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-[14px]" style={{ padding: '14px 16px' }}>
      {children}
    </div>
  )
}

function ToggleRow({ label, desc, right, last }: {
  label: string
  desc?: string
  right?: React.ReactNode
  last?: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        last ? '' : 'border-b border-white/[0.04]'
      }`}
      style={{ padding: '10px 0' }}
    >
      <div>
        <div className="text-[13px] font-medium leading-normal">{label}</div>
        {desc && <div className="text-[11px] text-white/30 leading-normal" style={{ marginTop: '2px' }}>{desc}</div>}
      </div>
      {right}
    </div>
  )
}
