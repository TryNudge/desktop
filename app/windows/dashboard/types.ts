export type AgentMode = 'guide' | 'go'
export type AgentStatus = 'idle' | 'running' | 'paused' | 'error'

export interface ActivityEntry {
  id: string
  type: 'observation' | 'action' | 'user' | 'system'
  content: string
  timestamp: string
  durationMs?: number
  screenshot?: string
  details?: string
  windowName?: string
}

export interface AgentWindowTarget {
  hwnd: number
  title: string
  processName: string
}

export interface Agent {
  id: string
  name: string
  icon: string | null
  windows: AgentWindowTarget[]
  interval: number
  goal: string
  mode: AgentMode
  status: AgentStatus
  lastActivity: string | null
  createdAt: string
  activityLog: ActivityEntry[]
  hasRun: boolean
}

export interface WindowEntry {
  hwnd: number
  title: string
  process_name: string
  icon_b64: string | null
  rect: { x: number; y: number; w: number; h: number }
}
