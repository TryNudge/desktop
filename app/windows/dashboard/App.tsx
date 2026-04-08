import { useState, useCallback, useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useTauriEvent } from '../../lib/hooks'
import * as api from '../../lib/tauri'
import type { Agent, AgentMode, ActivityEntry } from './types'
import AgentCard from './components/AgentCard'
import AgentForm from './components/AgentForm'
import AgentDetail from './components/AgentDetail'
import ChatsPage from './components/ChatsPage'
import type { Chat, ChatEntry } from './components/ChatsPage'
import SettingsPage from './components/SettingsPage'
import DevConsole from './components/DevConsole'
import type { DevLog } from './components/DevConsole'

type ResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest'
type Page = 'chats' | 'agents' | 'settings' | 'console'

function ResizeHandles() {
  const start = (dir: ResizeDirection) => (e: React.MouseEvent) => {
    e.preventDefault()
    getCurrentWindow().startResizeDragging(dir)
  }
  const edge = 'absolute z-50'
  const sz = 5
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

export default function App() {
  const [page, setPage] = useState<Page>('agents')
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [chats, setChats] = useState<Chat[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [devMode, setDevMode] = useState(false)
  const [devLogs, setDevLogs] = useState<DevLog[]>([])

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) || null

  // Load agents from backend on mount
  useEffect(() => {
    api.getAgents()
      .then((data) => setAgents(data as Agent[]))
      .catch(console.error)
  }, [])

  // Listen for real-time agent activity events
  useTauriEvent<{ agentId: string; entry: ActivityEntry }>('agent-activity', (payload) => {
    setAgents((prev) => prev.map((a) =>
      a.id === payload.agentId
        ? { ...a, activityLog: [...a.activityLog, payload.entry], lastActivity: payload.entry.timestamp }
        : a
    ))
  })

  // Listen for agent status changes
  useTauriEvent<{ agentId: string; status: string }>('agent-status-changed', (payload) => {
    setAgents((prev) => prev.map((a) =>
      a.id === payload.agentId ? { ...a, status: payload.status as Agent['status'] } : a
    ))
  })

  // Listen for dev logs
  useTauriEvent<DevLog>('dev-log', (payload) => {
    setDevLogs((prev) => [...prev.slice(-499), payload]) // cap at 500
  })

  // Listen for icon updates (from first run)
  useTauriEvent<{ agentId: string; icon: string }>('agent-icon-updated', (payload) => {
    setAgents((prev) => prev.map((a) =>
      a.id === payload.agentId ? { ...a, icon: payload.icon } : a
    ))
  })

  const selectAgent = useCallback((id: string | null) => {
    setSelectedAgentId(id)
    if (id) setPage('agents')
  }, [])

  const handleCreateAgent = useCallback(async (data: { name: string; windows: { hwnd: number; title: string; processName: string }[]; interval: number; goal: string; mode: AgentMode }) => {
    try {
      const agent = await api.createAgent(data) as Agent
      setAgents((prev) => [...prev, agent])
      setShowForm(false)
    } catch (e) {
      console.error('Failed to create agent:', e)
    }
  }, [])

  const handleUpdateAgent = useCallback(async (id: string, data: Partial<Agent>) => {
    try {
      await api.updateAgent(id, data as Record<string, unknown>)
      setAgents((prev) => prev.map((a) => a.id === id ? { ...a, ...data } : a))
    } catch (e) {
      console.error('Failed to update agent:', e)
    }
  }, [])

  const handleDeleteAgent = useCallback(async (id: string) => {
    try {
      await api.deleteAgent(id)
      setAgents((prev) => prev.filter((a) => a.id !== id))
      if (selectedAgentId === id) setSelectedAgentId(null)
    } catch (e) {
      console.error('Failed to delete agent:', e)
    }
  }, [selectedAgentId])

  const handleToggleStatus = useCallback(async (id: string) => {
    const agent = agents.find((a) => a.id === id)
    if (!agent) return
    try {
      if (agent.status === 'running') {
        await api.stopAgent(id)
      } else {
        await api.startAgent(id)
      }
      // Status update comes via event listener
    } catch (e) {
      console.error('Failed to toggle agent status:', e)
    }
  }, [agents])

  const handleSendMessage = useCallback(async (id: string, content: string) => {
    try {
      await api.sendAgentMessage(id, content)
      // The event listener will pick up the activity entry
    } catch (e) {
      // Fallback: add locally
      const entry: ActivityEntry = { id: `e-${Date.now()}`, type: 'user', content, timestamp: new Date().toISOString() }
      setAgents((prev) => prev.map((a) =>
        a.id === id ? { ...a, activityLog: [...a.activityLog, entry] } : a
      ))
    }
  }, [])

  const createChat = useCallback(() => {
    const newChat: Chat = { id: `chat-${Date.now().toString(36)}`, title: 'New conversation', entries: [], createdAt: new Date().toISOString() }
    setChats((prev) => [newChat, ...prev])
    setSelectedChatId(newChat.id)
  }, [])

  const sendChatMessage = useCallback((chatId: string, content: string) => {
    const userEntry: ChatEntry = { id: `cm-${Date.now()}`, role: 'user', content, timestamp: new Date().toISOString() }
    const aiEntry: ChatEntry = { id: `cm-${Date.now() + 1}`, role: 'assistant', content: 'I can help with that. Let me look at your screen and figure out the steps.', timestamp: new Date(Date.now() + 500).toISOString() }
    setChats((prev) => prev.map((c) => {
      if (c.id !== chatId) return c
      const updated = { ...c, entries: [...c.entries, userEntry, aiEntry] }
      if (c.entries.length === 0) updated.title = content.slice(0, 40) + (content.length > 40 ? '...' : '')
      return updated
    }))
  }, [])

  const navigateTo = useCallback((p: Page) => {
    setPage(p)
    if (p !== 'agents') setSelectedAgentId(null)
    if (p !== 'chats') setSelectedChatId(null)
  }, [])

  return (
    <div className="h-screen w-screen bg-[rgb(20,20,24)] rounded-2xl overflow-hidden flex flex-col relative">
      <ResizeHandles />

      {/* Title Bar - compact */}
      <div
        className="flex items-center gap-2.5 shrink-0 border-b border-white/[0.06]"
        style={{ padding: '8px 14px', WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <img
          src="/nudgekeycap.png"
          alt="nudge"
          className="w-5 h-5 rounded-md drop-shadow-[0_2px_6px_rgba(0,0,0,0.3)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
        <span className="text-[13px] font-semibold text-white/70 tracking-[-0.2px] leading-none flex-1">nudge</span>

        <button
          onClick={() => getCurrentWindow().minimize()}
          className="w-6 h-6 border-none bg-white/[0.04] rounded-md text-white/25 text-[14px] cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-white/[0.08] hover:text-white/50 leading-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          &#8722;
        </button>
        <button
          onClick={() => getCurrentWindow().hide()}
          className="w-6 h-6 border-none bg-white/[0.04] rounded-md text-white/25 cursor-pointer flex items-center justify-center transition-all duration-150 hover:bg-[rgba(255,60,60,0.15)] hover:text-[rgba(255,100,100,0.9)] leading-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Sidebar */}
        <div className="w-[210px] shrink-0 bg-[rgb(16,16,20)] border-r border-white/[0.06] flex flex-col">
          {/* Nav items */}
          <div className="p-2.5 flex flex-col gap-0.5">
            {/* Chats */}
            <button
              onClick={() => navigateTo('chats')}
              className={`flex items-center gap-2 w-full px-2.5 py-[6px] rounded-lg cursor-pointer border-none transition-all duration-150 font-[inherit] ${
                page === 'chats' && !selectedAgentId ? 'bg-white/[0.05] text-white/60' : 'bg-transparent text-white/30 hover:bg-white/[0.03] hover:text-white/45'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" className="text-current shrink-0">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.8" fill="none" />
              </svg>
              <span className="text-[12px] font-semibold">Chats</span>
              {chats.length > 0 && <span className="ml-auto text-[9px] font-medium text-white/15 bg-white/[0.05] px-1.5 py-[1px] rounded-md">{chats.length}</span>}
            </button>

            {/* Agents */}
            <button
              onClick={() => { navigateTo('agents'); setSelectedAgentId(null) }}
              className={`flex items-center gap-2 w-full px-2.5 py-[6px] rounded-lg cursor-pointer border-none transition-all duration-150 font-[inherit] ${
                page === 'agents' && !selectedAgentId ? 'bg-white/[0.05] text-white/60' : page === 'agents' ? 'bg-transparent text-white/40' : 'bg-transparent text-white/30 hover:bg-white/[0.03] hover:text-white/45'
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" className="text-current shrink-0">
                <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
                <circle cx="10" cy="4" r="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
                <circle cx="4" cy="10" r="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
                <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.2" fill="none" />
              </svg>
              <span className="text-[12px] font-semibold">Agents</span>
              <span className="ml-auto text-[9px] font-medium text-white/15 bg-white/[0.05] px-1.5 py-[1px] rounded-md">{agents.length}</span>
            </button>
          </div>

          {/* Context list: chats or agents depending on page */}
          <div className="flex-1 overflow-y-auto px-2.5 pb-2">
            {page === 'chats' ? (
              <div className="flex flex-col gap-0.5">
                {chats.map((chat) => (
                  <button
                    key={chat.id}
                    onClick={() => { setPage('chats'); setSelectedChatId(chat.id) }}
                    className={`flex items-center gap-2 w-full px-2.5 py-[6px] rounded-lg text-left cursor-pointer border-none transition-all duration-150 font-[inherit] ${
                      selectedChatId === chat.id ? 'bg-white/[0.07] text-white/75' : 'bg-transparent text-white/30 hover:bg-white/[0.03] hover:text-white/45'
                    }`}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" className="text-current shrink-0 opacity-40">
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="2" fill="none" />
                    </svg>
                    <span className="text-[11px] font-medium truncate flex-1">{chat.title}</span>
                  </button>
                ))}
              </div>
            ) : page === 'agents' ? (
              <div className="flex flex-col gap-0.5">
                {agents.map((agent) => {
                  const isSelected = selectedAgentId === agent.id
                  return (
                    <button
                      key={agent.id}
                      onClick={() => selectAgent(agent.id)}
                      className={`flex items-center gap-2 w-full px-2.5 py-[6px] rounded-lg text-left cursor-pointer border-none transition-all duration-150 font-[inherit] ${
                        isSelected ? 'bg-white/[0.07] text-white/75' : 'bg-transparent text-white/30 hover:bg-white/[0.03] hover:text-white/45'
                      }`}
                    >
                      <span className="text-[12px] shrink-0 w-4 text-center leading-none">{agent.icon || '🤖'}</span>
                      <span className="text-[11px] font-medium truncate flex-1">{agent.name}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>

          {/* Sidebar footer - Settings */}
          <div className="border-t border-white/[0.06] p-2.5">
            <button
              onClick={() => navigateTo('settings')}
              className={`flex items-center gap-2 w-full px-2.5 py-[6px] rounded-lg border-none cursor-pointer transition-all duration-150 font-[inherit] ${
                page === 'settings' ? 'bg-white/[0.05] text-white/50' : 'bg-transparent text-white/25 hover:bg-white/[0.03] hover:text-white/40'
              }`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" className="text-current shrink-0">
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
              <span className="text-[11px] font-medium">Settings</span>
            </button>
            {devMode && (
              <button
                onClick={() => navigateTo('console')}
                className={`flex items-center gap-2 w-full px-2.5 py-[6px] rounded-lg border-none cursor-pointer transition-all duration-150 font-[inherit] mt-0.5 ${
                  page === 'console' ? 'bg-white/[0.05] text-white/50' : 'bg-transparent text-white/25 hover:bg-white/[0.03] hover:text-white/40'
                }`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" className="text-current shrink-0">
                  <rect x="2" y="3" width="20" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  <path d="M7 15l3-3-3-3M13 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="text-[11px] font-medium">Console</span>
                {devLogs.length > 0 && <span className="ml-auto text-[9px] font-medium text-white/15 bg-white/[0.05] px-1.5 py-[1px] rounded-md">{devLogs.length}</span>}
              </button>
            )}
          </div>
        </div>

        {/* Main area */}
        {page === 'console' && devMode ? (
          <DevConsole logs={devLogs} onClear={() => setDevLogs([])} />
        ) : page === 'chats' ? (
          <ChatsPage
            chats={chats}
            selectedChatId={selectedChatId}
            onSelectChat={setSelectedChatId}
            onNewChat={createChat}
            onSendMessage={sendChatMessage}
          />
        ) : page === 'settings' ? (
          <SettingsPage devMode={devMode} onToggleDevMode={setDevMode} />
        ) : selectedAgent ? (
          <AgentDetail
            agent={selectedAgent}
            onBack={() => setSelectedAgentId(null)}
            onUpdate={(data) => handleUpdateAgent(selectedAgent.id, data)}
            onDelete={() => handleDeleteAgent(selectedAgent.id)}
            onToggleStatus={() => handleToggleStatus(selectedAgent.id)}
            onSendMessage={(msg) => handleSendMessage(selectedAgent.id, msg)}
          />
        ) : (
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center justify-between shrink-0" style={{ padding: '18px 24px 14px' }}>
              <h2 className="text-[16px] font-bold text-white/90 tracking-[-0.3px] leading-none">Your Agents</h2>
              <button
                onClick={() => { setShowForm(true) }}
                className="group flex items-center gap-1.5 px-3.5 py-[6px] rounded-lg border border-white/[0.08] bg-white/[0.03] text-[12px] font-semibold text-white/50 cursor-pointer transition-all duration-200 font-[inherit] hover:bg-[rgba(122,0,180,0.08)] hover:border-[rgba(122,0,180,0.2)] hover:text-[rgba(190,5,198,0.9)]"
              >
                <svg width="11" height="11" viewBox="0 0 13 13" className="text-current">
                  <line x1="6.5" y1="2" x2="6.5" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <line x1="2" y1="6.5" x2="11" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                New Agent
              </button>
            </div>
            <div className="flex-1 overflow-y-auto" style={{ padding: '0 24px 24px' }}>
              {agents.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-3">
                    <span className="text-[24px]">🤖</span>
                  </div>
                  <h3 className="text-[14px] font-semibold text-white/35 mb-1">No agents yet</h3>
                  <p className="text-[12px] text-white/18 max-w-[260px] leading-[1.5] mb-4">Create an agent to watch your windows and provide guidance or take actions.</p>
                  <button
                    onClick={() => { setShowForm(true) }}
                    className="flex items-center gap-1.5 px-4 py-[7px] rounded-lg border-none text-[12px] font-semibold cursor-pointer transition-all duration-200 font-[inherit] bg-[rgba(122,0,180,0.15)] text-[rgba(190,5,198,0.9)] hover:bg-[rgba(122,0,180,0.25)]"
                  >
                    Create your first agent
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {agents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      isSelected={selectedAgentId === agent.id}
                      onSelect={() => selectAgent(agent.id)}
                      onToggleStatus={(e) => { e.stopPropagation(); handleToggleStatus(agent.id) }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {showForm && (
        <AgentForm
          onSave={handleCreateAgent}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  )
}
