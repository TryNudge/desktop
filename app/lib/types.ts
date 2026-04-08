// Mirrors Rust types from src-tauri/src/lib.rs

export interface BBox {
  x: number
  y: number
  w: number
  h: number
}

export interface StepTarget {
  description: string
  element_name: string
  x: number
  y: number
  bbox: BBox | null
  confidence: number
}

export interface Step {
  step_number: number
  instruction: string
  target: StepTarget
  action_type: string
  action_detail: string
}

export interface StepPlan {
  app_context: string
  steps: Step[]
  scale_factor: number
  monitor_offset_x: number
  monitor_offset_y: number
}

export interface AnswerPayload {
  title: string
  content: string
  copyable_text: string
  _has_steps?: boolean
}

export interface NudgeResponse {
  response_type: 'answer' | 'steps' | 'hybrid'
  app_context: string
  answer?: AnswerPayload
  steps?: Step[]
  session_id: string
  scale_factor: number
  monitor_offset_x: number
  monitor_offset_y: number
}

export interface AuthState {
  authenticated: boolean
  email: string | null
  plan: string | null
}

export interface Keybinds {
  open_nudge: string
  next_step: string
  dismiss: string
}

export interface UpdateInfo {
  available: boolean
  version: string | null
  notes: string | null
}
