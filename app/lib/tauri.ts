import { invoke } from '@tauri-apps/api/core'
import type {
  AuthState,
  Keybinds,
  NudgeResponse,
  StepPlan,
  AnswerPayload,
  UpdateInfo,
} from './types'

// Auth
export const login = () => invoke<string>('login')
export const logout = () => invoke<void>('logout')
export const getAuthState = () => invoke<AuthState>('get_auth_state')
export const setAuthToken = (token: string) =>
  invoke<void>('set_auth_token', { token })

// Query
export const submitQuery = (query: string, researchMode: boolean) =>
  invoke<NudgeResponse>('submit_query', { query, researchMode })
export const nextStep = (completedInstruction: string) =>
  invoke<StepPlan>('next_step', { completedInstruction })
export const submitFollowup = (query: string) =>
  invoke<NudgeResponse>('submit_followup', { query })
export const getPendingAnswer = () =>
  invoke<AnswerPayload | null>('get_pending_answer')

// Window
export const showInput = () => invoke<void>('show_input')

// Keybinds
export const getKeybinds = () => invoke<Keybinds>('get_keybinds')
export const setKeybind = (action: string, shortcut: string) =>
  invoke<void>('set_keybind', { action, shortcut })
export const pauseShortcuts = () => invoke<void>('pause_shortcuts')
export const resumeShortcuts = () => invoke<void>('resume_shortcuts')

// Updates
export const checkForUpdate = () => invoke<UpdateInfo>('check_for_update')
export const installUpdate = () => invoke<void>('install_update')

// Grounding
export const setGrounding = (settings: string) =>
  invoke<void>('set_grounding', { settings })
