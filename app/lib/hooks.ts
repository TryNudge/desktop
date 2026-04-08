import { useEffect, useRef, useState, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import * as api from './tauri'
import type { AuthState, Keybinds } from './types'

/**
 * Listen to a Tauri event with automatic cleanup on unmount.
 */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const unlisten = listen<T>(event, (e) => handlerRef.current(e.payload))
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [event])
}

/**
 * Listen to a Tauri window event (e.g. 'tauri://focus') with automatic cleanup.
 */
export function useWindowEvent(event: string, handler: () => void) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const win = getCurrentWindow()
    const unlisten = win.listen(event, () => handlerRef.current())
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [event])
}

/**
 * Auth state management.
 */
export function useAuth() {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    email: null,
    plan: null,
  })

  const refresh = useCallback(async () => {
    try {
      const s = await api.getAuthState()
      setState(s)
    } catch (e) {
      console.error('auth check error:', e)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useTauriEvent('auth-success', refresh)

  return { ...state, refresh, login: api.login, logout: api.logout }
}

/**
 * Keybind state management.
 */
export function useKeybinds() {
  const [keybinds, setKeybinds] = useState<Keybinds>({
    open_nudge: 'ctrl+shift+n',
    next_step: 'ctrl+shift+arrowright',
    dismiss: 'ctrl+shift+arrowleft',
  })

  useEffect(() => {
    api.getKeybinds().then(setKeybinds).catch(console.error)
  }, [])

  return keybinds
}

/**
 * Shared display map for rendering keybind labels.
 */
const DISPLAY_MAP: Record<string, string> = {
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  super: 'Super',
  arrowright: '\u2192',
  arrowleft: '\u2190',
  arrowup: '\u2191',
  arrowdown: '\u2193',
  enter: '\u21B5',
  escape: 'Esc',
  backspace: '\u232B',
  delete: 'Del',
  tab: 'Tab',
  space: 'Space',
}

export function formatShortcut(shortcut: string): string {
  return shortcut
    .split('+')
    .map((p) => DISPLAY_MAP[p] || p.toUpperCase())
    .join('+')
}

/**
 * Map keyboard key names to Tauri shortcut format.
 */
export const KEY_MAP: Record<string, string> = {
  Control: 'ctrl',
  Shift: 'shift',
  Alt: 'alt',
  Meta: 'super',
  ArrowRight: 'arrowright',
  ArrowLeft: 'arrowleft',
  ArrowUp: 'arrowup',
  ArrowDown: 'arrowdown',
  Enter: 'enter',
  Escape: 'escape',
  Backspace: 'backspace',
  Delete: 'delete',
  Tab: 'tab',
  Space: 'space',
  ' ': 'space',
}
