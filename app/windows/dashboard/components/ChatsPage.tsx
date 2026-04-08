import { useState, useRef, useEffect } from 'react'

interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  steps?: { instruction: string; completed: boolean }[]
}

interface Chat {
  id: string
  title: string
  entries: ChatEntry[]
  createdAt: string
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function ChatsPage({
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onSendMessage,
}: {
  chats: Chat[]
  selectedChatId: string | null
  onSelectChat: (id: string | null) => void
  onNewChat: () => void
  onSendMessage: (chatId: string, msg: string) => void
}) {
  const selectedChat = chats.find((c) => c.id === selectedChatId) || null

  if (!selectedChat) {
    return (
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center justify-between shrink-0" style={{ padding: '18px 24px 14px' }}>
          <h2 className="text-[16px] font-bold text-white/90 tracking-[-0.3px] leading-none">Chats</h2>
          <button
            onClick={onNewChat}
            className="group flex items-center gap-1.5 px-3.5 py-[6px] rounded-lg border border-white/[0.08] bg-white/[0.03] text-[12px] font-semibold text-white/50 cursor-pointer transition-all duration-200 font-[inherit] hover:bg-[rgba(122,0,180,0.08)] hover:border-[rgba(122,0,180,0.2)] hover:text-[rgba(190,5,198,0.9)]"
          >
            <svg width="11" height="11" viewBox="0 0 13 13" className="text-current">
              <line x1="6.5" y1="2" x2="6.5" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="2" y1="6.5" x2="11" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ padding: '0 24px 24px' }}>
          {chats.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center mb-3">
                <svg width="22" height="22" viewBox="0 0 24 24" className="text-white/10">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
              </div>
              <h3 className="text-[14px] font-semibold text-white/35 mb-1">No chats yet</h3>
              <p className="text-[12px] text-white/18 max-w-[260px] leading-[1.5] mb-4">
                Start a chat to ask Nudge anything. You can also use Ctrl+Shift+N.
              </p>
              <button
                onClick={onNewChat}
                className="flex items-center gap-1.5 px-4 py-[7px] rounded-lg border-none text-[12px] font-semibold cursor-pointer transition-all duration-200 font-[inherit] bg-[rgba(122,0,180,0.15)] text-[rgba(190,5,198,0.9)] hover:bg-[rgba(122,0,180,0.25)]"
              >
                Start a chat
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {chats.map((chat) => (
                <button
                  key={chat.id}
                  onClick={() => onSelectChat(chat.id)}
                  className="flex items-center gap-3 w-full px-3.5 py-2.5 rounded-xl text-left cursor-pointer border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/[0.08] transition-all duration-150 font-[inherit]"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" className="text-white/20 shrink-0">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" fill="none" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] font-medium text-white/70 truncate">{chat.title}</div>
                    <div className="text-[10px] text-white/20 mt-0.5">{chat.entries.length} messages</div>
                  </div>
                  <span className="text-[9px] text-white/15 shrink-0">{formatTime(chat.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return <ChatView chat={selectedChat} onBack={() => onSelectChat(null)} onSend={(msg) => onSendMessage(selectedChat.id, msg)} />
}

function ChatView({ chat, onSend }: { chat: Chat; onBack: () => void; onSend: (msg: string) => void }) {
  const [message, setMessage] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chat.entries.length])

  const handleSend = () => {
    const text = message.trim()
    if (!text) return
    onSend(text)
    setMessage('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {chat.entries.map((entry) => (
          <div key={entry.id}>
            {entry.role === 'user' ? (
              /* User message - full width dark bar */
              <div className="border-b border-white/[0.04] bg-white/[0.02]" style={{ padding: '14px 24px' }}>
                <p className="text-[13px] text-white/80 leading-[1.6] font-medium">{entry.content}</p>
              </div>
            ) : (
              /* Assistant response - plain text below */
              <div className="border-b border-white/[0.04]" style={{ padding: '16px 24px' }}>
                <p className="text-[13px] text-white/60 leading-[1.7] whitespace-pre-wrap">{entry.content}</p>
                {entry.steps && (
                  <div className="mt-3 flex flex-col gap-2">
                    {entry.steps.map((step, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <div className={`w-[16px] h-[16px] rounded-full border flex items-center justify-center shrink-0 mt-[2px] ${
                          step.completed ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-white/[0.04] border-white/[0.1]'
                        }`}>
                          {step.completed && (
                            <svg width="8" height="8" viewBox="0 0 10 10"><path d="M2 5L4.5 7.5L8 3" stroke="rgba(52,211,153,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
                          )}
                        </div>
                        <span className={`text-[13px] leading-[1.5] ${step.completed ? 'text-white/30 line-through' : 'text-white/55'}`}>{step.instruction}</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* Three dot menu hint */}
                <div className="flex justify-end mt-1">
                  <button className="text-white/10 hover:text-white/30 bg-transparent border-none cursor-pointer transition-colors duration-150 p-1">
                    <svg width="14" height="4" viewBox="0 0 14 4">
                      <circle cx="2" cy="2" r="1.2" fill="currentColor" />
                      <circle cx="7" cy="2" r="1.2" fill="currentColor" />
                      <circle cx="12" cy="2" r="1.2" fill="currentColor" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input bar - fixed at bottom */}
      <div className="shrink-0 border-t border-white/[0.06]" style={{ padding: '12px 20px' }}>
        <div className="flex items-center bg-[rgb(28,28,32)] border border-white/[0.08] rounded-xl" style={{ padding: '10px 14px', gap: '10px' }}>
          <img
            src="/nudgekeycap.png"
            alt="Attach"
            className="w-[24px] h-[24px] rounded-[7px] object-contain shrink-0 drop-shadow-[0_2px_4px_rgba(0,0,0,0.3)] cursor-pointer hover:drop-shadow-[0_2px_8px_rgba(100,120,255,0.3)] transition-[filter] duration-150 opacity-60 hover:opacity-100"
            title="Add images or documents"
          />
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Nudge anything..."
            spellCheck={false}
            autoComplete="off"
            autoFocus
            className="flex-1 bg-transparent border-none outline-none text-white/[0.85] text-[13px] font-normal caret-white/60 tracking-[0.1px] placeholder:text-white/20 font-[inherit]"
          />
          {message.trim() ? (
            <button onClick={handleSend} className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md bg-white/[0.08] border-none text-white/50 hover:text-white/80 hover:bg-white/[0.12] cursor-pointer transition-all duration-150">
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6H11M7 2L11 6L7 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
            </button>
          ) : (
            <span className="text-[10px] text-white/[0.12] whitespace-nowrap rounded-md bg-white/[0.03] border border-white/[0.04] shrink-0" style={{ padding: '2px 6px' }}>Enter &#x21B5;</span>
          )}
        </div>
      </div>
    </div>
  )
}

export type { Chat, ChatEntry }
