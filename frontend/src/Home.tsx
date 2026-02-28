import { useState, useRef, useEffect } from 'react'
import { signOut, updateProfile } from 'firebase/auth'
import { auth } from './firebase'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Barcode, CircleUser, LogOut, UserPen } from 'lucide-react'
import './Home.css'

const API = 'http://localhost:8000'

function Home() {
  const [aiMessage, setAiMessage] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [activePage, setActivePage] = useState<'pantry' | 'perishthreats' | 'ai'>('pantry')

  const navigate = useNavigate()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [editingUsername, setEditingUsername] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [usernameError, setUsernameError] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  const currentUser = auth.currentUser
  const displayName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'User'

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setEditingUsername(false)
        setUsernameError('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function handleSignOut() {
    await signOut(auth)
    navigate('/')
  }

  async function handleChangeUsername() {
    if (!newUsername.trim()) {
      setUsernameError('Username cannot be empty')
      return
    }
    if (currentUser) {
      await updateProfile(currentUser, { displayName: newUsername.trim() })
    }
    setEditingUsername(false)
    setNewUsername('')
    setUsernameError('')
    setDropdownOpen(false)
  }

  async function handleAiSuggest() {
    if (!aiMessage.trim()) return
    setAiLoading(true)
    try {
      const res = await fetch(`${API}/api/llm/${encodeURIComponent(aiMessage)}`, { method: 'POST' })
      const data = await res.json()
      setAiResponse(data.response ?? JSON.stringify(data))
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div className="home">
      {/* Banner */}
      <header className="home-header">
        <div className="home-header-logo">
          <img src="perishless-icon.png" alt="PerishLess" className="logo-icon" />
          <span className="logo-text">PerishLess</span>
        </div>
        <div className="home-header-user" ref={dropdownRef}>
          <span className="home-username">{displayName}</span>
          <CircleUser
            className="home-avatar home-avatar-btn"
            onClick={() => { setDropdownOpen(o => !o); setEditingUsername(false); setUsernameError('') }}
          />

          {dropdownOpen && (
            <div className="home-dropdown">
              {!editingUsername ? (
                <>
                  <button className="home-dropdown-item" onClick={() => { setEditingUsername(true); setNewUsername('') }}>
                    <UserPen size={15} />
                    Change Username
                  </button>
                  <div className="home-dropdown-divider" />
                  <button className="home-dropdown-item home-dropdown-item--danger" onClick={handleSignOut}>
                    <LogOut size={15} />
                    Sign Out
                  </button>
                </>
              ) : (
                <div className="home-dropdown-edit">
                  <p className="home-dropdown-edit-label">New Username</p>
                  <Input
                    autoFocus
                    value={newUsername}
                    onChange={e => setNewUsername(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleChangeUsername()}
                    placeholder="Enter username"
                    className="home-dropdown-edit-input"
                  />
                  {usernameError && <p className="home-dropdown-edit-error">{usernameError}</p>}
                  <div className="home-dropdown-edit-actions">
                    <button className="home-dropdown-edit-save" onClick={handleChangeUsername}>Save</button>
                    <button className="home-dropdown-edit-cancel" onClick={() => { setEditingUsername(false); setUsernameError('') }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Tab bar */}
      <nav className="home-tabs">
        <button className={`home-tab ${activePage === 'pantry' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('pantry')}>
          My Pantry
        </button>
        <button className={`home-tab ${activePage === 'perishthreats' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('perishthreats')}>
          PerishThreats
        </button>
        <button className={`home-tab ${activePage === 'ai' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('ai')}>
          Carry AI Assistant
        </button>
      </nav>

      {/* Page: My Pantry */}
      {activePage === 'pantry' && (
        <>
          <div className="home-search-row">
            <div className="home-search-barcode">
              <Button
                variant="outline"
                className="w-full h-full bg-transparent border-2 border-[#4caf50] text-[#f0f7f0] hover:bg-[rgba(76,175,80,0.15)] hover:text-[#f0f7f0] hover:border-[#e65100]"
              >
                <Barcode className="!w-6 !h-6" />
                <span className="sr-only">Scan barcode</span>
              </Button>
            </div>
            <div className="home-search-input">
              <Input
                placeholder="Type Product Name"
                className="h-full bg-[rgba(255,255,255,0.08)] border-2 border-[#4caf50] text-[#f0f7f0] placeholder:text-[#a8c5a8] focus-visible:ring-[#4caf50]"
              />
            </div>
            <div className="home-search-receipt">
              <Button
                className="w-full h-full bg-[#4caf50] hover:bg-[#43a047] hover:border-[#e65100] border-2 border-transparent text-white"
              >
                Scan Receipt
              </Button>
            </div>
          </div>
          <main className="home-main" />
        </>
      )}

      {/* Page: PerishThreats */}
      {activePage === 'perishthreats' && (
        <main className="home-main">
          <p className="home-page-placeholder">PerishThreats — coming soon</p>
        </main>
      )}

      {/* Page: Carry AI Assistant */}
      {activePage === 'ai' && (
        <main className="home-main home-ai-page">
          <div className="home-ai-chat">
            <Textarea
              placeholder="Ask the AI assistant anything about your food..."
              value={aiMessage}
              onChange={e => setAiMessage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleAiSuggest())}
              rows={3}
              className="bg-[rgba(255,255,255,0.06)] border-2 border-[#4caf50] text-[#f0f7f0] placeholder:text-[#a8c5a8] focus-visible:ring-[#4caf50] resize-none"
            />
            <Button
              onClick={handleAiSuggest}
              disabled={aiLoading}
              className="bg-[#4caf50] hover:bg-[#43a047] border-2 border-transparent hover:border-[#e65100] text-white px-6"
            >
              {aiLoading ? 'Thinking…' : 'Ask'}
            </Button>
            {aiResponse && (
              <div className="home-ai-response-box">
                <p className="home-ai-response">{aiResponse}</p>
              </div>
            )}
          </div>
        </main>
      )}
    </div>
  )
}

export default Home
