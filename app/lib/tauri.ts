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
export const showDashboard = () => invoke<void>('show_dashboard')

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

// Agents
export const enumerateWindows = () => invoke<unknown[]>('enumerate_windows')
export const createAgent = (data: {
  name: string
  windows: { hwnd: number; title: string; processName: string }[]
  interval: number
  goal: string
  mode: string
}) => invoke<unknown>('create_agent', data)
export const getAgents = () => invoke<unknown[]>('get_agents')
export const deleteAgent = (id: string) => invoke<void>('delete_agent', { id })
export const updateAgent = (id: string, data: Record<string, unknown>) =>
  invoke<unknown>('update_agent', { id, ...data })
export const startAgent = (id: string) => invoke<void>('start_agent', { id })
export const stopAgent = (id: string) => invoke<void>('stop_agent', { id })
export const sendAgentMessage = (id: string, content: string) =>
  invoke<void>('send_agent_message', { id, content })
