import { useState, useRef, useEffect, useCallback } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { signOut, updateProfile } from 'firebase/auth'
import { useAuth, auth } from './AuthContext'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Barcode, CircleUser, LogOut, UserPen, X, Upload, SendHorizonal, CheckCheck, Receipt, HeartHandshake } from 'lucide-react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import type { Result, Exception } from '@zxing/library'
import './Home.css'

const API = 'http://localhost:8000'

// Configure marked once at module level
marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}

function Home() {
  const navigate = useNavigate()
  const { user: currentUser, uuid } = useAuth()

  const [aiMessage, setAiMessage] = useState('')
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [carryFlying, setCarryFlying] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [activePage, setActivePage] = useState<'pantry' | 'perishthreats' | 'ai'>('pantry')

  // Pantry items
  const [pantryItems, setPantryItems] = useState<any[]>([])
  const [pantryLoading, setPantryLoading] = useState(false)
  const [sortCol, setSortCol] = useState<'name' | 'expiry' | 'tags' | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [consumingItems, setConsumingItems] = useState<Set<string>>(new Set())
  const [hoveredItem, setHoveredItem] = useState<Record<string, unknown> | null>(null)
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  function handleSort(col: 'name' | 'expiry' | 'tags') {
    if (sortCol !== col) {
      setSortCol(col)
      setSortDir('asc')
    } else if (sortDir === 'asc') {
      setSortDir('desc')
    } else {
      setSortCol(null)
      setSortDir('asc')
    }
  }

  function sortIcon(col: 'name' | 'expiry' | 'tags') {
    if (sortCol !== col) return <span className="sort-icon sort-icon--inactive">⇅</span>
    return <span className="sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  // PerishThreats
  interface PerishThreat {
    meal_type?: string
    description?: string
    image_url?: string
    youtube_url?: string
    ingredients?: Array<{ name: string; image_url?: string; expiry_date?: any; in_inventory?: boolean }>
  }
  const [perishThreats, setPerishThreats] = useState<PerishThreat[]>([])
  const [threatsLoading, setThreatsLoading] = useState(false)
  const [ptInstructions, setPtInstructions] = useState('')
  const [collapsedThreats, setCollapsedThreats] = useState<Set<number>>(new Set())

  function toggleThreat(i: number) {
    setCollapsedThreats(prev => {
      const next = new Set(prev)
      if (next.has(i)) { next.delete(i) } else { next.add(i) }
      return next
    })
  }

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ name: string; image_url?: string }[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults([])
      setSearchOpen(false)
      setSearchLoading(false)
      return
    }

    const controller = new AbortController()
    let cancelled = false

    // Tier-1: fast local autocomplete at 250ms
    const fastTimer = setTimeout(async () => {
      if (cancelled) return
      setSearchLoading(true)
      setSearchOpen(true)
      try {
        const res = await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}&limit=10`, { signal: controller.signal })
        const data = await res.json()
        if (!cancelled) {
          const results: { name: string; image_url?: string }[] = data.results ?? []
          setSearchResults(results)
          setSearchOpen(results.length > 0)
        }
      } catch { /* aborted */ }
    }, 250)

    // Tier-2: broader product search at 500ms — merges with / replaces fast results
    const slowTimer = setTimeout(async () => {
      if (cancelled) return
      try {
        const res = await fetch(`${API}/api/searchItem/${encodeURIComponent(q)}`, { signal: controller.signal })
        const data = await res.json()
        if (!cancelled) {
          const fresh: { name: string; image_url?: string }[] = data.results ?? []
          if (fresh.length > 0) {
            // Merge: keep any fast results not already in the broader set
            setSearchResults(prev => {
              const names = new Set(fresh.map(r => r.name.toLowerCase()))
              const extras = prev.filter(r => !names.has(r.name.toLowerCase()))
              return [...fresh, ...extras].slice(0, 15)
            })
            setSearchOpen(true)
          }
        }
      } catch { /* aborted */ }
      finally { if (!cancelled) setSearchLoading(false) }
    }, 500)

    return () => {
      cancelled = true
      clearTimeout(fastTimer)
      clearTimeout(slowTimer)
      controller.abort()
      setSearchLoading(false)
    }
  }, [searchQuery])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, aiLoading])

  const fetchPantryItems = useCallback(async () => {
    if (!uuid) return
    setPantryLoading(true)
    try {
      const res = await fetch(`${API}/api/items/${uuid}`)
      const data = await res.json()
      setPantryItems(Array.isArray(data) ? data : [])
    } catch {
      console.error('Failed to fetch pantry items')
    } finally {
      setPantryLoading(false)
    }
  }, [uuid])

  useEffect(() => {
    if (activePage === 'pantry') fetchPantryItems()
  }, [activePage, fetchPantryItems])

  const fetchPerishThreats = useCallback(async () => {
    if (!uuid) return
    setThreatsLoading(true)
    try {
      const res = await fetch(`${API}/api/perishthreats/${uuid}`)
      const data = await res.json()
      setPerishThreats(Array.isArray(data) ? data : [])
      setCollapsedThreats(new Set())
    } catch {
      console.error('Failed to fetch perishthreats')
    } finally {
      setThreatsLoading(false)
    }
  }, [uuid])

  const regeneratePerishThreats = useCallback(async () => {
    if (!uuid || threatsLoading) return
    setThreatsLoading(true)
    try {
      const res = await fetch(`${API}/api/perishthreats/${uuid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions: ptInstructions.trim() || null, count: 2 }),
      })
      const data = await res.json()
      setPerishThreats(Array.isArray(data) ? data : [])
      setCollapsedThreats(new Set())
    } catch {
      console.error('Failed to regenerate perishthreats')
    } finally {
      setThreatsLoading(false)
    }
  }, [uuid, ptInstructions, threatsLoading])

  useEffect(() => {
    if (activePage === 'perishthreats') fetchPerishThreats()
  }, [activePage, fetchPerishThreats])

  // Profile dropdown
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [editingUsername, setEditingUsername] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [usernameError, setUsernameError] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Barcode scanner modal
  const [barcodeModalOpen, setBarcodeModalOpen] = useState(false)
  const [barcodeStatus, setBarcodeStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle')
  const [barcodeMessage, setBarcodeMessage] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const animFrameRef = useRef<number>(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const detectedRef = useRef(false)
  const scanControlsRef = useRef<IScannerControls | null>(null)

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    scanControlsRef.current?.stop()
    scanControlsRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    detectedRef.current = false
  }, [])

  const closeModal = useCallback(() => {
    stopCamera()
    setBarcodeModalOpen(false)
  }, [stopCamera])

  const submitBarcodeImage = useCallback(async (file: File) => {
    closeModal()
    if (!uuid) {
      setBarcodeStatus('error')
      setBarcodeMessage('Not signed in.')
      return
    }
    setBarcodeStatus('submitting')
    setBarcodeMessage('Looking up item…')
    try {
      const form = new FormData()
      form.append('image', file)
      const res = await fetch(`${API}/api/items/${uuid}/barcode`, { method: 'POST', body: form })
      const data = await res.json()
      if (data.status === 'success') {
        setBarcodeStatus('success')
        setBarcodeMessage('Item added to your pantry!')
        fetchPantryItems()
      } else {
        setBarcodeStatus('error')
        setBarcodeMessage(data.message ?? 'Could not find product.')
      }
    } catch {
      setBarcodeStatus('error')
      setBarcodeMessage('Network error — please try again.')
    } finally {
      setTimeout(() => setBarcodeStatus('idle'), 4000)
    }
  }, [closeModal, uuid, fetchPantryItems])

  useEffect(() => {
    if (!barcodeModalOpen) return
    let cancelled = false

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        startScanning()
      } catch (err) {
        console.error('Camera error:', err)
      }
    }

    async function startScanning() {
      const video = videoRef.current
      if (!video) return

      // Wait until video is actually playing
      await new Promise<void>(resolve => {
        if (video.readyState >= 2) { resolve(); return }
        video.addEventListener('canplay', () => resolve(), { once: true })
      })
      if (cancelled) return

      const codeReader = new BrowserMultiFormatReader()
      try {
        const controls = await codeReader.decodeFromVideoElement(
          video,
          (result: Result | undefined, _err: Exception | undefined, ctl: IScannerControls) => {
            if (!result || detectedRef.current) return
            detectedRef.current = true
            ctl.stop()
            scanControlsRef.current = null

            // Capture a still from the video and send it to the backend
            const canvas = canvasRef.current!
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
            canvas.getContext('2d')!.drawImage(video, 0, 0)
            canvas.toBlob(blob => {
              if (blob) submitBarcodeImage(new File([blob], 'barcode-scan.jpg', { type: 'image/jpeg' }))
            }, 'image/jpeg', 0.92)
          }
        )
        if (!cancelled) scanControlsRef.current = controls
        else controls.stop()
      } catch (err) {
        console.error('ZXing scanning error:', err)
      }
    }

    startCamera()
    return () => { cancelled = true; stopCamera() }
  }, [barcodeModalOpen, stopCamera, submitBarcodeImage])

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    stopCamera()
    submitBarcodeImage(file)
  }

  function captureFrame() {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2 || detectedRef.current) return
    detectedRef.current = true
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')!.drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      if (blob) submitBarcodeImage(new File([blob], 'barcode-capture.jpg', { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.92)
  }

  useEffect(() => {
    if (!barcodeModalOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space') { e.preventDefault(); captureFrame() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  // captureFrame is stable (refs only) — intentionally omitted from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barcodeModalOpen])

  // Expiry status helper
  function getExpiryStatus(expiryRaw: any): { label: string; cls: string; days: number | null } {
    if (!expiryRaw) return { label: 'No Date', cls: 'expiry-unknown', days: null }
    const date = new Date(typeof expiryRaw === 'object' && '_seconds' in expiryRaw
      ? expiryRaw._seconds * 1000
      : expiryRaw)
    if (isNaN(date.getTime())) return { label: 'No Date', cls: 'expiry-unknown', days: null }
    const now = Date.now()
    const diffDays = (date.getTime() - now) / 86_400_000
    const d = Math.ceil(diffDays)
    if (diffDays < 0)  return { label: 'Expired',       cls: 'expiry-expired', days: d }
    if (diffDays < 3)  return { label: 'Expiring Soon', cls: 'expiry-soon',    days: d }
    if (diffDays < 7)  return { label: 'This Week',     cls: 'expiry-week',    days: d }
    return { label: 'Fresh', cls: 'expiry-fresh', days: d }
  }

  function getYouTubeEmbedUrl(url: string): string | null {
    // Standard watch URL or short URL with a real video ID
    const idMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
    if (idMatch) return `https://www.youtube.com/embed/${idMatch[1]}`
    // YouTube search results URL — convert to embeddable search playlist
    const searchMatch = url.match(/youtube\.com\/results\?search_query=([^&]+)/)
    if (searchMatch) return `https://www.youtube.com/embed?listType=search&list=${searchMatch[1]}`
    return null
  }

  async function handleConsume(itemId: string) {
    if (!uuid) return
    setConsumingItems(prev => new Set(prev).add(itemId))
    setTimeout(async () => {
      try {
        await fetch(`${API}/api/items/${uuid}/${itemId}?consumed=true`, { method: 'DELETE' })
        fetchPantryItems()
      } catch {
        console.error('Failed to consume item')
      } finally {
        setConsumingItems(prev => { const n = new Set(prev); n.delete(itemId); return n })
      }
    }, 420)
  }

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
    const msg = aiMessage.trim()
    if (!msg || aiLoading) return
    const wasEmpty = chatMessages.length === 0
    setChatMessages(m => [...m, { role: 'user', content: msg }])
    setAiMessage('')
    setAiLoading(true)
    if (wasEmpty) {
      setCarryFlying(true)
      setTimeout(() => setCarryFlying(false), 500)
    }
    try {
      const res = await fetch(`${API}/api/lm/${uuid}/${encodeURIComponent(msg)}`, { method: 'POST' })
      const data = await res.json()
      setChatMessages(m => [...m, { role: 'assistant', content: data.response ?? JSON.stringify(data) }])
    } catch {
      setChatMessages(m => [...m, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
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
          Defeat PerishThreats
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
                onClick={() => { setBarcodeStatus('idle'); setBarcodeModalOpen(true) }}
              >
                <Barcode className="!w-6 !h-6" />
                <span>Scan Barcode</span>
              </Button>
            </div>
            <div className="home-search-input" ref={searchRef}>
              <Input
                placeholder="Type Product Name"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                className="h-full bg-[rgba(255,255,255,0.08)] border-2 border-[#4caf50] text-[#f0f7f0] placeholder:text-[#a8c5a8] focus-visible:ring-[#4caf50]"
              />
              {searchOpen && (
                <ul className="search-dropdown">
                  {searchLoading && (
                    <li className="search-dropdown-state">Searching…</li>
                  )}
                  {!searchLoading && searchResults.length === 0 && (
                    <li className="search-dropdown-state">No results found</li>
                  )}
                  {searchResults.map((item, i) => (
                    <li
                      key={i}
                      className="search-dropdown-item"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => { setSearchQuery(item.name); setSearchOpen(false) }}
                    >
                      <div className="search-dropdown-img-wrap">
                        {item.image_url
                          ? <img src={item.image_url} alt={item.name} className="search-dropdown-img" />
                          : <div className="search-dropdown-img-placeholder" />}
                      </div>
                      <span className="search-dropdown-name">{item.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="home-search-receipt">
              <Button
                className="w-full h-full bg-[#4caf50] hover:bg-[#43a047] hover:border-[#e65100] border-2 border-transparent text-white"
              >
                <Receipt className="!w-5 !h-5" />
                Scan Receipt
              </Button>
            </div>
          </div>
          <main className="home-main">
            {pantryLoading && <p className="home-page-placeholder">Loading pantry…</p>}
            {!pantryLoading && pantryItems.length === 0 && (
              <p className="home-page-placeholder">No items in your pantry yet. Scan a barcode to add one!</p>
            )}
            {!pantryLoading && pantryItems.length > 0 && (() => {
              // Build a stable sorted copy without mutating state
              const sorted = [...pantryItems].sort((a, b) => {
                if (!sortCol) return 0
                let av = 0, bv = 0
                let as_ = '', bs_ = ''
                if (sortCol === 'name') {
                  as_ = (a.name ?? '').toLowerCase()
                  bs_ = (b.name ?? '').toLowerCase()
                } else if (sortCol === 'expiry') {
                  const ad = getExpiryStatus(a.expiry_date).days
                  const bd = getExpiryStatus(b.expiry_date).days
                  av = ad ?? Infinity
                  bv = bd ?? Infinity
                } else if (sortCol === 'tags') {
                  const firstTag = (item: Record<string, unknown>) => {
                    if (item.category && item.category !== 'Unknown') return String(item.category).toLowerCase()
                    return ''
                  }
                  as_ = firstTag(a)
                  bs_ = firstTag(b)
                }
                const cmp = sortCol === 'expiry'
                  ? av - bv
                  : as_ < bs_ ? -1 : as_ > bs_ ? 1 : 0
                return sortDir === 'asc' ? cmp : -cmp
              })
              return (
              <div className="pantry-table-wrap">
                <table className="pantry-table">
                  <thead>
                    <tr>
                      <th className="sortable-th" onClick={() => handleSort('name')}>Name {sortIcon('name')}</th>
                      <th className="sortable-th" onClick={() => handleSort('expiry')}>Expiration Status {sortIcon('expiry')}</th>
                      <th className="sortable-th" onClick={() => handleSort('tags')}>Tags {sortIcon('tags')}</th>
                      <th>Consume</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(item => {
                      const expiry = getExpiryStatus(item.expiry_date)
                      // Build tags
                      const tags: { label: string; cls: string; icon?: React.ReactNode }[] = []
                      if (item.category && item.category !== 'Unknown')
                        tags.push({ label: item.category, cls: 'tag-category' })
                      if (item.nutriscore_grade && item.nutriscore_grade !== 'Unknown')
                        tags.push({ label: `Nutri-${item.nutriscore_grade}`, cls: `tag-nutri tag-nutri-${item.nutriscore_grade.toLowerCase()}` })
                      if (item.can_donate === true)
                        tags.push({ label: 'Donatable', cls: 'tag-donate', icon: <HeartHandshake size={12} style={{ marginRight: '0.25em', verticalAlign: 'middle' }} /> })
                      if (item.vegan_match != null && item.vegan_match >= 75)
                        tags.push({ label: 'Vegan', cls: 'tag-vegan' })
                      else if (item.vegetarian_match != null && item.vegetarian_match >= 75)
                        tags.push({ label: 'Vegetarian', cls: 'tag-vegan' })
                      return (
                        <tr
                          key={item.item_id}
                          className={consumingItems.has(item.item_id) ? 'row-consuming' : ''}
                          onMouseEnter={e => { setHoveredItem(item); setHoverPos({ x: e.clientX, y: e.clientY }) }}
                          onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}
                          onMouseLeave={() => setHoveredItem(null)}
                        >
                          <td className="pt-name-cell">
                            {item.image_url && (
                              <img src={item.image_url} alt={item.name} className="pt-thumb" />
                            )}
                            <span>{item.name}</span>
                          </td>
                          <td>
                            <span className={`pt-expiry-badge ${expiry.cls}`}>
                              {expiry.label}
                              {expiry.days !== null && expiry.days > 0 && (
                                <span className="pt-expiry-days">~{expiry.days}d</span>
                              )}
                            </span>
                          </td>
                          <td className="pt-tags-cell">
                            {tags.map((t, i) => (
                              <span key={i} className={`pt-tag ${t.cls}`}>{t.icon}{t.label}</span>
                            ))}
                            {tags.length === 0 && <span className="pt-tag-empty">—</span>}
                          </td>
                          <td>
                            <button
                              className={`pt-consume-btn${consumingItems.has(item.item_id) ? ' pt-consume-btn--active' : ''}`}
                              title="Mark as consumed"
                              disabled={consumingItems.has(item.item_id)}
                              onClick={() => handleConsume(item.item_id)}
                            >
                              <CheckCheck size={15} />
                              Consume
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              )
            })()}
          </main>

          {/* Barcode submission status */}
          {barcodeStatus !== 'idle' && (
            <div className={`bc-status bc-status--${barcodeStatus}`}>
              {barcodeStatus === 'submitting' && <span className="bc-status-spinner" />}
              {barcodeStatus === 'success' && <span>✓</span>}
              {barcodeStatus === 'error' && <span>✕</span>}
              {barcodeMessage}
            </div>
          )}
        </>
      )}

      {/* Barcode Scanner Modal */}
      {barcodeModalOpen && (
        <div className="bc-overlay" onClick={e => { if (e.target === e.currentTarget) closeModal() }}>
          <div className="bc-modal">
            <button className="bc-close" onClick={closeModal} aria-label="Close">
              <X size={20} />
            </button>

            <h2 className="bc-title">Scan Barcode</h2>

            <div className="bc-viewport">
              <video ref={videoRef} className="bc-video" muted playsInline />
              <canvas ref={canvasRef} className="bc-canvas-hidden" />
              <div className="bc-scanner-overlay">
                <div className="bc-scan-region">
                  <span className="bc-corner bc-corner--tl" />
                  <span className="bc-corner bc-corner--tr" />
                  <span className="bc-corner bc-corner--bl" />
                  <span className="bc-corner bc-corner--br" />
                  <div className="bc-scan-line" />
                </div>
              </div>
            </div>
            <p className="bc-hint">Point your camera at a barcode — it will be scanned automatically</p>

            <button className="bc-capture-btn" onClick={captureFrame}>
              <span className="bc-capture-ring" />
              Take Photo
              <span className="bc-capture-key">Space</span>
            </button>

            <div className="bc-divider"><span>or</span></div>
            <button className="bc-upload-btn" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} />
              Upload file instead
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="bc-file-input"
              onChange={handleFileUpload}
            />
          </div>
        </div>
      )}

      {/* Page: PerishThreats */}
      {activePage === 'perishthreats' && (
        <main className="home-main pt-page">
          {/* Regenerate toolbar */}
          <div className="pt-regen-bar">
            <input
              className="pt-regen-input"
              placeholder="Custom instructions (e.g. vegetarian, spicy, Italian…)"
              value={ptInstructions}
              onChange={e => setPtInstructions(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && regeneratePerishThreats()}
              disabled={threatsLoading}
            />
            <button
              className="pt-regen-btn"
              onClick={regeneratePerishThreats}
              disabled={threatsLoading}
            >
              {threatsLoading ? 'Generating…' : '⟳ Regenerate'}
            </button>
          </div>
          {threatsLoading && (
            <div className="pt-loading">
              <img src="perishless-icon.png" alt="Loading" className="pt-loading-logo" />
              <p className="pt-loading-text">Seeking Out PerishThreats…</p>
            </div>
          )}
          {!threatsLoading && perishThreats.length === 0 && (
            <div className="pt-empty">
              <p>No suggestions yet — add items to your pantry to receive personalised meal ideas!</p>
            </div>
          )}
          {!threatsLoading && perishThreats.map((threat: any, i: number) => {
            const embedUrl = threat.youtube_url ? getYouTubeEmbedUrl(threat.youtube_url) : null
            const collapsed = collapsedThreats.has(i)
            return (
              <div key={i} className={`pt-threat-card${collapsed ? ' pt-threat-card--collapsed' : ''}`}>
                <button className="pt-threat-header" onClick={() => toggleThreat(i)}>
                  <span className="pt-threat-meal-type">{threat.meal_type ?? 'Meal Suggestion'}</span>
                  {threat.description && !collapsed && (
                    <span className="pt-threat-desc">{threat.description}</span>
                  )}
                  <span className="pt-threat-chevron">{collapsed ? '▸' : '▾'}</span>
                </button>
                {!collapsed && <div className="pt-threat-body">
                  <div className="pt-threat-img-col">
                    {threat.image_url
                      ? <img src={threat.image_url} alt={threat.meal_type} className="pt-threat-img" />
                      : <div className="pt-threat-img-placeholder">No Image</div>}
                  </div>

                  {/* Middle: YouTube embed */}
                  <div className="pt-threat-video-col">
                    {embedUrl
                      ? (
                        <iframe
                          className="pt-threat-video"
                          src={embedUrl}
                          title={threat.meal_type}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      ) : (
                        <div className="pt-threat-video-placeholder">
                          <span>No video available</span>
                        </div>
                      )}
                  </div>

                  {/* Right: ingredients */}
                  <div className="pt-threat-ing-col">
                    <p className="pt-threat-ing-title">Ingredients</p>
                    <ul className="pt-threat-ing-list">
                      {(threat.ingredients ?? []).map((ing: any, j: number) => {
                        const exp = getExpiryStatus(ing.expiry_date)
                        return (
                          <li key={j} className="pt-threat-ing-item">
                            <div className="pt-threat-ing-left">
                              {ing.image_url && (
                                <img src={ing.image_url} alt={ing.name} className="pt-threat-ing-img" />
                              )}
                              <span className="pt-threat-ing-name">{ing.name}</span>
                            </div>
                            {ing.in_inventory === false
                              ? <span className="pt-card-ing-expiry expiry-unknown">Unstocked</span>
                              : <span className={`pt-card-ing-expiry ${exp.cls}`}>
                                  {exp.label}
                                  {exp.days !== null && exp.days > 0 && (
                                    <span className="pt-expiry-days">~{exp.days}d</span>
                                  )}
                                </span>
                            }
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </div>}
              </div>
            )
          })}
        </main>
      )}

      {/* Page: Carry AI Assistant */}
      {activePage === 'ai' && (
        <main className="home-main chat-page">
          {/* Flying icon overlay — lives outside the scroll container so overflow doesn't clip it */}
          {carryFlying && (
            <img src="carry-icon.png" aria-hidden alt="" className="carry-flying-icon" />
          )}

          <div className="chat-messages">
            {chatMessages.length === 0 && !aiLoading && (
              <div className="chat-empty">
                <img src="carry-icon.png" alt="Carry" className="carry-center-icon" />
                <p>Ask Carry anything about your food, recipes, or reducing waste.</p>
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`chat-bubble-wrap chat-bubble-wrap--${msg.role}`}>
                {msg.role === 'assistant' ? (
                  <>
                    <img src="carry-icon.png" alt="Carry" className="carry-icon" />
                    <div
                      className="chat-bubble chat-bubble--assistant chat-bubble--md"
                      dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                    />
                  </>
                ) : (
                  <div className="chat-bubble chat-bubble--user">{msg.content}</div>
                )}
              </div>
            ))}
            {aiLoading && (
              <div className="chat-bubble-wrap chat-bubble-wrap--assistant">
                <img
                  src="carry-icon.png"
                  alt="Carry"
                  className={`carry-icon${carryFlying ? ' carry-icon--hidden' : ' carry-icon--spinning'}`}
                />
                <div className="chat-bubble chat-bubble--assistant chat-typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="chat-input-row">
            <Textarea
              placeholder="Message Carry…"
              value={aiMessage}
              onChange={e => setAiMessage(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleAiSuggest())}
              rows={1}
              className="chat-input bg-[rgba(255,255,255,0.06)] border-2 border-[#4caf50] text-[#f0f7f0] placeholder:text-[#a8c5a8] focus-visible:ring-[#4caf50] resize-none"
            />
            <Button
              onClick={handleAiSuggest}
              disabled={aiLoading || !aiMessage.trim()}
              className="bg-[#4caf50] hover:bg-[#43a047] border-2 border-transparent hover:border-[#e65100] text-white px-4 self-stretch"
            >
              <SendHorizonal size={18} />
            </Button>
          </div>
        </main>
      )}

      {/* Pantry item hover tooltip */}
      {hoveredItem && (() => {
        const item = hoveredItem as Record<string, string | number | boolean | null | undefined>
        const expiry = getExpiryStatus(item.expiry_date)
        const vw = window.innerWidth
        const vh = window.innerHeight
        const tipW = 560, tipH = 320
        const left = hoverPos.x + 16 + tipW > vw ? hoverPos.x - tipW - 8 : hoverPos.x + 16
        const top  = hoverPos.y + 16 + tipH > vh ? hoverPos.y - tipH - 8 : hoverPos.y + 16
        return (
          <div className="item-tooltip" style={{ left, top }} onMouseEnter={() => setHoveredItem(null)}>
            {/* Header row: image + name */}
            <div className="item-tooltip-header">
              {item.image_url && (
                <img src={String(item.image_url)} alt={String(item.name)} className="item-tooltip-img" />
              )}
              <p className="item-tooltip-name">{String(item.name ?? '')}</p>
            </div>
            {/* Two-column stats */}
            <div className="item-tooltip-body">
              <div className="item-tooltip-grid">
                {item.category && item.category !== 'Unknown' && (
                  <><span className="item-tooltip-label">Category</span><span>{String(item.category)}</span></>
                )}
                <span className="item-tooltip-label">Expiry</span>
                <span className={`item-tooltip-expiry ${expiry.cls}`}>{expiry.label}{expiry.days !== null && expiry.days > 0 ? ` (~${expiry.days}d)` : ''}</span>
                {item.nutriscore_grade && item.nutriscore_grade !== 'Unknown' && (
                  <><span className="item-tooltip-label">Nutri-Score</span><span className={`item-tooltip-nutri tag-nutri-${String(item.nutriscore_grade).toLowerCase()}`}>{String(item.nutriscore_grade).toUpperCase()}</span></>
                )}
                {item.nova_processing_level != null && (
                  <><span className="item-tooltip-label">NOVA Level</span><span>{String(item.nova_processing_level)} / 4</span></>
                )}
                {item.ecoscore != null && (
                  <><span className="item-tooltip-label">Eco-Score</span><span>{String(item.ecoscore)} / 100</span></>
                )}
                {item.additives_count != null && (
                  <><span className="item-tooltip-label">Additives</span><span>{String(item.additives_count)}</span></>
                )}
                {item.can_donate === true && (
                  <><span className="item-tooltip-label">Donatable</span><span style={{ color: '#90caf9' }}>✓</span></>
                )}
              </div>
              <div className="item-tooltip-grid">
                {item.vegan_match != null && (
                  <><span className="item-tooltip-label">Vegan</span><span>{String(item.vegan_match)}%</span></>
                )}
                {item.vegetarian_match != null && (
                  <><span className="item-tooltip-label">Vegetarian</span><span>{String(item.vegetarian_match)}%</span></>
                )}
                {item.low_fat_match != null && (
                  <><span className="item-tooltip-label">Low Fat</span><span>{String(item.low_fat_match)}%</span></>
                )}
                {item.low_sugar_match != null && (
                  <><span className="item-tooltip-label">Low Sugar</span><span>{String(item.low_sugar_match)}%</span></>
                )}
                {item.low_salt_match != null && (
                  <><span className="item-tooltip-label">Low Salt</span><span>{String(item.low_salt_match)}%</span></>
                )}
                {item.contains_meat != null && (
                  <><span className="item-tooltip-label">Contains Meat</span><span>{item.contains_meat ? 'Yes' : 'No'}</span></>
                )}
                {item.contains_dairy != null && (
                  <><span className="item-tooltip-label">Contains Dairy</span><span>{item.contains_dairy ? 'Yes' : 'No'}</span></>
                )}
              </div>
            </div>
            {/* Full-width text sections */}
            {item.allergens && item.allergens !== 'Unknown' && (
              <div className="item-tooltip-section">
                <span className="item-tooltip-label">Allergens</span>
                <p className="item-tooltip-text">{String(item.allergens)}</p>
              </div>
            )}
            {item.ingredients_text && item.ingredients_text !== 'Unknown' && (
              <div className="item-tooltip-section">
                <span className="item-tooltip-label">Ingredients</span>
                <p className="item-tooltip-text item-tooltip-text--clamp">{String(item.ingredients_text)}</p>
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

export default Home

