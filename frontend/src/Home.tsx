import { useState, useRef, useEffect, useCallback } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { signOut, updateProfile } from 'firebase/auth'
import { useAuth, auth } from './AuthContext'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Barcode, CircleUser, LogOut, UserPen, X, Upload, SendHorizonal, CheckCheck, Receipt, HeartHandshake, Package, Palette, Mic, Square, Volume2, VolumeX } from 'lucide-react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import type { IScannerControls } from '@zxing/browser'
import type { Result, Exception } from '@zxing/library'
import './Home.css'

const API = import.meta.env.VITE_API_BASE_URL?.trim() || (import.meta.env.DEV ? 'http://localhost:8000' : '')

// Configure marked once at module level
marked.setOptions({ breaks: true, gfm: true })

function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } })
}

type FirestoreTimestamp = { _seconds: number; _nanoseconds?: number }
type ExpiryValue = string | number | Date | FirestoreTimestamp | null | undefined

interface PantryItem {
  item_id: string
  name?: string
  category?: string | null
  image_url?: string | null
  expiry_date?: ExpiryValue
  nutriscore_grade?: string | null
  can_donate?: boolean | null
  vegan_match?: number | null
  vegetarian_match?: number | null
  low_fat_match?: number | null
  low_sugar_match?: number | null
  low_salt_match?: number | null
  contains_meat?: boolean | null
  contains_dairy?: boolean | null
  allergens?: string | null
  ingredients_text?: string | null
  nova_processing_level?: number | null
  ecoscore?: number | null
  additives_count?: number | null
  [key: string]: unknown
}

interface PerishThreatIngredient {
  name: string
  image_url?: string
  expiry_date?: ExpiryValue
  in_inventory?: boolean
}

function Home() {
  const navigate = useNavigate()
  const { user: currentUser, uuid, loading: authLoading } = useAuth()

  const [aiMessage, setAiMessage] = useState('')
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [aiLoading, setAiLoading] = useState(false)
  const [autoSpeakEnabled, setAutoSpeakEnabled] = useState(() => localStorage.getItem('chat-auto-speak') === '1')
  const [carryFlying, setCarryFlying] = useState(false)
  const [dailyMoodEnabled, setDailyMoodEnabled] = useState(() => {
    const stored = localStorage.getItem('daily-mood-enabled')
    return stored === null ? true : stored === '1'
  })
  const [moodModalOpen, setMoodModalOpen] = useState(false)
  const [moodScore, setMoodScore] = useState(5)
  const [moodPhase, setMoodPhase] = useState<'input' | 'loading' | 'response' | 'error'>('input')
  const [moodQuote, setMoodQuote] = useState('')
  const [moodError, setMoodError] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const [activePage, setActivePage] = useState<'pantry' | 'perishthreats' | 'health' | 'ai'>('pantry')

  // Pantry items
  const [pantryItems, setPantryItems] = useState<PantryItem[]>([])
  const [pantryLoading, setPantryLoading] = useState(false)
  const [sortCol, setSortCol] = useState<'name' | 'expiry' | 'tags' | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [consumingItems, setConsumingItems] = useState<Set<string>>(new Set())
  const [hoveredItem, setHoveredItem] = useState<PantryItem | null>(null)
  const [devourOverlay, setDevourOverlay] = useState(false)
  const [devourMeal, setDevourMeal] = useState('')
  const [throwAwayOverlay, setThrowAwayOverlay] = useState(false)
  const [throwAwayMeal, setThrowAwayMeal] = useState('')
  const [cbMode, setCbMode] = useState(() => localStorage.getItem('cb-mode') === '1')
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  // Manual add modal
  const [manualAddOpen, setManualAddOpen] = useState(false)
  const [manualAddName, setManualAddName] = useState('')
  const [manualAddExpiry, setManualAddExpiry] = useState('')
  const [manualAddCategory, setManualAddCategory] = useState('')
  const [manualAddLoading, setManualAddLoading] = useState(false)
  const [manualAddError, setManualAddError] = useState('')
  const [addingItems, setAddingItems] = useState<Set<string>>(new Set())

  // Open manual add modal and prefill an optional item name.
  function openManualAdd(name = '') {
    setManualAddName(name)
    setManualAddExpiry('')
    setManualAddCategory('')
    setManualAddError('')
    setManualAddOpen(true)
    setSearchOpen(false)
  }

  // Submit a manually entered pantry item to the backend.
  async function handleManualAdd() {
    if (!uuid || !manualAddName.trim()) return
    setManualAddLoading(true)
    setManualAddError('')
    try {
      const res = await fetch(`${API}/api/items/${uuid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: manualAddName.trim(),
          category: manualAddCategory.trim() || null,
          expiry_date: manualAddExpiry || null,
        }),
      })
      const data = await res.json()
      if (data.status === 'success') {
        setManualAddOpen(false)
        setSearchQuery('')
        fetchPantryItems()
      } else {
        setManualAddError(data.message ?? 'Failed to add item')
      }
    } catch {
      setManualAddError('Network error — please try again')
    } finally {
      setManualAddLoading(false)
    }
  }

  // Add an item directly from search/autocomplete without opening the manual modal.
  async function addItemDirect(name: string, image_url?: string, barcode?: string) {
    if (!uuid || !name.trim()) return
    setAddingItems(prev => new Set(prev).add(name))
    setSearchOpen(false)
    setSearchQuery('')
    try {
      const res = await fetch(`${API}/api/items/${uuid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), image_url: image_url ?? null, barcode: barcode ?? null }),
      })
      const data = await res.json()
      if (data.status === 'success') {
        fetchPantryItems()
      } else {
        // Fall back to manual modal if the direct add fails
        openManualAdd(name)
      }
    } catch {
      openManualAdd(name)
    } finally {
      setAddingItems(prev => { const s = new Set(prev); s.delete(name); return s })
    }
  }

  // Toggle sorting state for a pantry table column.
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

  // Render the sort icon for the currently active sort column.
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
    ingredients?: PerishThreatIngredient[]
  }
  interface FavoritedRecipe extends PerishThreat {
    favorite_id: string
    recipe_signature?: string
    favorited_at?: unknown
  }
  interface HealthImpactHit {
    item_id?: string
    name: string
    reason: string
  }
  const [perishThreats, setPerishThreats] = useState<PerishThreat[]>([])
  const [threatsLoading, setThreatsLoading] = useState(false)
  const [ptInstructions, setPtInstructions] = useState('')
  const [collapsedThreats, setCollapsedThreats] = useState<Set<number>>(new Set())
  const [healthMentalHits, setHealthMentalHits] = useState<HealthImpactHit[]>([])
  const [healthPhysicalHits, setHealthPhysicalHits] = useState<HealthImpactHit[]>([])
  const [healthCollapsedMental, setHealthCollapsedMental] = useState<Set<string>>(new Set())
  const [healthCollapsedPhysical, setHealthCollapsedPhysical] = useState<Set<string>>(new Set())
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState('')
  const [healthProgress, setHealthProgress] = useState({ processed: 0, total: 0 })
  const [favoriteRecipesOpen, setFavoriteRecipesOpen] = useState(false)
  const [favoriteRecipesLoading, setFavoriteRecipesLoading] = useState(false)
  const [favoriteRecipesError, setFavoriteRecipesError] = useState('')
  const [favoriteRecipes, setFavoriteRecipes] = useState<FavoritedRecipe[]>([])
  const [collapsedFavoriteRecipes, setCollapsedFavoriteRecipes] = useState<Set<string>>(new Set())
  const [favoritePending, setFavoritePending] = useState<Set<string>>(new Set())

  // Expand or collapse a PerishThreat card by index.
  function toggleThreat(i: number) {
    setCollapsedThreats(prev => {
      const next = new Set(prev)
      if (next.has(i)) { next.delete(i) } else { next.add(i) }
      return next
    })
  }

  // Build a stable signature for a recipe to support favorite toggling.
  function recipeSignature(recipe: PerishThreat): string {
    const meal = (recipe.meal_type ?? '').trim().toLowerCase()
    const yt = (recipe.youtube_url ?? '').trim().toLowerCase()
    const ingredients = (recipe.ingredients ?? [])
      .map(ing => (ing?.name ?? '').trim().toLowerCase())
      .filter(Boolean)
      .sort()
      .join(',')
    return `${meal}|${yt}|${ingredients}`
  }

  // Check if a recipe is already in the user's favorites list.
  function isRecipeFavorited(recipe: PerishThreat): boolean {
    const sig = recipeSignature(recipe)
    return favoriteRecipes.some(r => (r.recipe_signature ?? '') === sig)
  }

  // Toggle expanded state for a favorited recipe card in the modal.
  function toggleFavoriteRecipeCollapse(id: string) {
    setCollapsedFavoriteRecipes(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Fetch all favorited recipes for the signed-in user.
  const fetchFavoriteRecipes = useCallback(async () => {
    if (!uuid) return
    setFavoriteRecipesLoading(true)
    setFavoriteRecipesError('')
    try {
      const res = await fetch(`${API}/api/favorites/${uuid}`)
      const raw = await res.text()
      let data: { status?: string; message?: string; results?: FavoritedRecipe[] } = {}
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        data = { status: 'error', message: raw || `Server error (${res.status})`, results: [] }
      }

      if (!res.ok || data.status !== 'success') {
        setFavoriteRecipesError(data.message ?? 'Failed to load favorited recipes.')
        setFavoriteRecipes([])
        setCollapsedFavoriteRecipes(new Set())
        return
      }

      const results = Array.isArray(data.results) ? data.results : []
      setFavoriteRecipes(results)
      setCollapsedFavoriteRecipes(new Set(results.map(r => r.favorite_id)))
    } catch {
      setFavoriteRecipesError('Network error — please try again.')
      setFavoriteRecipes([])
      setCollapsedFavoriteRecipes(new Set())
    } finally {
      setFavoriteRecipesLoading(false)
    }
  }, [uuid])

  // Favorite or unfavorite a recipe and sync local UI state.
  async function toggleFavoriteRecipe(recipe: PerishThreat) {
    if (!uuid) return
    const signature = recipeSignature(recipe)
    if (!signature || favoritePending.has(signature)) return

    const currentlyFavorited = isRecipeFavorited(recipe)
    setFavoritePending(prev => new Set(prev).add(signature))
    try {
      if (currentlyFavorited) {
        const res = await fetch(`${API}/api/favorites/${uuid}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature, recipe }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.status !== 'success') throw new Error(data.message ?? 'Failed to unfavorite')
        setFavoriteRecipes(prev => prev.filter(r => (r.recipe_signature ?? '') !== signature))
      } else {
        const res = await fetch(`${API}/api/favorites/${uuid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signature, recipe }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || data.status !== 'success' || !data.item) throw new Error(data.message ?? 'Failed to favorite')
        setFavoriteRecipes(prev => {
          const without = prev.filter(r => (r.recipe_signature ?? '') !== signature)
          return [data.item as FavoritedRecipe, ...without]
        })
        setCollapsedFavoriteRecipes(prev => {
          const next = new Set(prev)
          next.add((data.item as FavoritedRecipe).favorite_id)
          return next
        })
      }
    } catch (err) {
      console.error('Failed to toggle favorite recipe', err)
    } finally {
      setFavoritePending(prev => { const next = new Set(prev); next.delete(signature); return next })
    }
  }

  // Open the favorites modal and load current favorites.
  function openFavoriteRecipesModal() {
    setDropdownOpen(false)
    setFavoriteRecipesOpen(true)
    fetchFavoriteRecipes()
  }

  // Close the favorites modal.
  function closeFavoriteRecipesModal() {
    setFavoriteRecipesOpen(false)
  }

  useEffect(() => {
    if (!favoriteRecipesOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeFavoriteRecipesModal()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [favoriteRecipesOpen])

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ name: string; image_url?: string; barcode?: string }[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchActiveIdx, setSearchActiveIdx] = useState(0)
  const [searchListening, setSearchListening] = useState(false)
  const [chatListening, setChatListening] = useState(false)
  const [chatSpeakingIdx, setChatSpeakingIdx] = useState<number | null>(null)
  const [defeatSuccessMessage, setDefeatSuccessMessage] = useState('')
  const searchRef = useRef<HTMLDivElement>(null)
  const searchRecorderRef = useRef<MediaRecorder | null>(null)
  const chatRecorderRef = useRef<MediaRecorder | null>(null)
  const searchStreamRef = useRef<MediaStream | null>(null)
  const chatStreamRef = useRef<MediaStream | null>(null)
  const currentSpeechAudioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults([])
      setSearchActiveIdx(0)
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
        const res = await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}&limit=5`, { signal: controller.signal })
        const data = await res.json()
        if (!cancelled) {
          const results: { name: string; image_url?: string; barcode?: string }[] = data.results ?? []
          setSearchResults(results)
          setSearchActiveIdx(0)
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
          const fresh: { name: string; image_url?: string; barcode?: string }[] = data.results ?? []
          if (fresh.length > 0) {
            // Merge: keep any fast results not already in the broader set
            setSearchResults(prev => {
              const names = new Set(fresh.map(r => r.name.toLowerCase()))
              const extras = prev.filter(r => !names.has(r.name.toLowerCase()))
              return [...fresh, ...extras].slice(0, 5)
            })
            setSearchActiveIdx(0)
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

  // Lazily fetch images for search results that have a barcode but no image yet
  useEffect(() => {
    const missing = searchResults.filter(r => r.barcode && !r.image_url)
    if (missing.length === 0) return
    let cancelled = false
    missing.forEach(item => {
      fetch(`${API}/api/image/${encodeURIComponent(item.barcode!)}`)
        .then(r => r.json())
        .then(data => {
          if (cancelled || !data.image_url) return
          setSearchResults(prev =>
            prev.map(r => r.barcode === item.barcode && !r.image_url
              ? { ...r, image_url: data.image_url }
              : r
            )
          )
        })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [searchResults])

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

  // Load pantry items for the authenticated user.
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
    if (activePage !== 'pantry' || authLoading || !uuid) return

    // Initial fetch + one short retry to handle auth/backend race on first visit
    fetchPantryItems()
    const retryTimer = window.setTimeout(() => {
      fetchPantryItems()
    }, 900)

    return () => window.clearTimeout(retryTimer)
  }, [activePage, authLoading, uuid, fetchPantryItems])

  // Fetch PerishThreat recipe suggestions for current pantry contents.
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

  // Regenerate PerishThreat suggestions with optional custom instructions.
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

  useEffect(() => {
    if (authLoading || !uuid || !dailyMoodEnabled) return
    const today = new Date().toISOString().slice(0, 10)
    const lastKey = `daily-mood-last-${uuid}`
    if (localStorage.getItem(lastKey) === today) return

    localStorage.setItem(lastKey, today)
    setMoodScore(5)
    setMoodQuote('')
    setMoodError('')
    setMoodPhase('input')
    setMoodModalOpen(true)
  }, [authLoading, uuid, dailyMoodEnabled])

  // Enable or disable the daily mood prompt feature.
  function toggleDailyMoodEnabled() {
    setDailyMoodEnabled(prev => {
      const next = !prev
      localStorage.setItem('daily-mood-enabled', next ? '1' : '0')
      if (!next) setMoodModalOpen(false)
      return next
    })
  }

  // Close the daily mood modal.
  function closeMoodModal() {
    setMoodModalOpen(false)
  }

  useEffect(() => {
    if (!moodModalOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMoodModal()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [moodModalOpen])

  // Submit today's mood score and request a motivational quote.
  async function submitMoodScore() {
    if (!uuid || moodPhase === 'loading') return
    setMoodPhase('loading')
    setMoodError('')
    setMoodQuote('')
    try {
      const res = await fetch(`${API}/api/moodQuote/${uuid}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score: moodScore }),
      })
      const raw = await res.text()
      let data: { status?: string; quote?: string; message?: string } = {}
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        data = { status: 'error', message: raw || `Server error (${res.status})` }
      }

      if (!res.ok || data.status !== 'success') {
        setMoodError(data.message ?? 'Could not generate your quote.')
        setMoodQuote(data.quote ?? '')
        setMoodPhase('error')
        return
      }

      setMoodQuote(data.quote ?? '')
      setMoodPhase('response')
    } catch {
      setMoodError('Network error — please try again.')
      setMoodPhase('error')
    }
  }

  // Merge health impact hits by stable key to avoid duplicate entries.
  const mergeHealthHits = useCallback((prev: HealthImpactHit[], incoming: HealthImpactHit[]): HealthImpactHit[] => {
    const byKey = new Map<string, HealthImpactHit>()
    prev.forEach(hit => {
      const key = (hit.item_id && hit.item_id.trim()) || hit.name.toLowerCase()
      byKey.set(key, hit)
    })
    incoming.forEach(hit => {
      const key = (hit.item_id && hit.item_id.trim()) || hit.name.toLowerCase()
      if (!key) return
      byKey.set(key, hit)
    })
    return Array.from(byKey.values())
  }, [])

  useEffect(() => {
    if (activePage !== 'health' || !uuid) return

    let cancelled = false

    async function loadHealthImpacts() {
      setHealthLoading(true)
      setHealthError('')
      setHealthProgress({ processed: 0, total: pantryItems.length })
      setHealthMentalHits([])
      setHealthPhysicalHits([])
      setHealthCollapsedMental(new Set())
      setHealthCollapsedPhysical(new Set())

      let offset = 0
      const limit = 10

      try {
        while (!cancelled) {
          const res = await fetch(`${API}/api/healthImpacts/${uuid}?offset=${offset}&limit=${limit}`)
          const raw = await res.text()
          let data: {
            status?: string
            message?: string
            batch?: { offset?: number; size?: number; total?: number; next_offset?: number | null; done?: boolean }
            mental?: HealthImpactHit[]
            physical?: HealthImpactHit[]
          } = {}
          try {
            data = raw ? JSON.parse(raw) : {}
          } catch {
            data = { status: 'error', message: raw || `Server error (${res.status})` }
          }

          if (!res.ok || data.status !== 'success') {
            throw new Error(data.message ?? `Failed to load health impacts (${res.status})`)
          }

          const batch = data.batch ?? {}
          const mental: HealthImpactHit[] = Array.isArray(data.mental) ? data.mental : []
          const physical: HealthImpactHit[] = Array.isArray(data.physical) ? data.physical : []

          if (!cancelled) {
            setHealthMentalHits(prev => mergeHealthHits(prev, mental))
            setHealthPhysicalHits(prev => mergeHealthHits(prev, physical))
            setHealthProgress({
              processed: (batch.offset ?? offset) + (batch.size ?? 0),
              total: batch.total ?? pantryItems.length,
            })
          }

          if (batch.done === true) break

          const nextOffset = batch.next_offset
          if (typeof nextOffset !== 'number' || nextOffset <= offset) break
          offset = nextOffset
        }
      } catch (err) {
        if (!cancelled) {
          setHealthError(err instanceof Error ? err.message : 'Failed to load health impacts.')
        }
      } finally {
        if (!cancelled) setHealthLoading(false)
      }
    }

    loadHealthImpacts()
    return () => { cancelled = true }
  }, [activePage, uuid, pantryItems.length, mergeHealthHits])

  // Profile dropdown
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [editingUsername, setEditingUsername] = useState(false)
  const [newUsername, setNewUsername] = useState('')
  const [usernameError, setUsernameError] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyItems, setHistoryItems] = useState<Record<string, unknown>[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Open the history modal and fetch consumed/trashed entries.
  async function openHistoryModal() {
    if (!uuid) return
    setDropdownOpen(false)
    setHistoryOpen(true)
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const res = await fetch(`${API}/api/history/${uuid}`)
      const raw = await res.text()
      let data: { status?: string; message?: string; results?: Record<string, unknown>[] } = {}
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        data = { status: 'error', message: raw || `Server error (${res.status})`, results: [] }
      }
      if (!res.ok || data.status !== 'success') {
        setHistoryError(data.message ?? 'Failed to load history.')
        setHistoryItems([])
        return
      }
      setHistoryItems(Array.isArray(data.results) ? data.results : [])
    } catch {
      setHistoryError('Network error — please try again.')
      setHistoryItems([])
    } finally {
      setHistoryLoading(false)
    }
  }

  // Close the history modal.
  function closeHistoryModal() {
    setHistoryOpen(false)
  }

  useEffect(() => {
    if (!historyOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeHistoryModal()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [historyOpen])

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

  // Receipt scanner modal
  const [receiptModalOpen, setReceiptModalOpen] = useState(false)
  const [receiptPhase, setReceiptPhase] = useState<'idle' | 'scanning' | 'results' | 'error'>('idle')
  const [receiptItems, setReceiptItems] = useState<string[]>([])
  const [receiptError, setReceiptError] = useState('')
  const receiptFileRef = useRef<HTMLInputElement>(null)
  const receiptDragRef = useRef<HTMLDivElement>(null)

  // Open the receipt scanner modal and reset transient state.
  function openReceiptModal() {
    setReceiptPhase('idle')
    setReceiptItems([])
    setReceiptError('')
    setReceiptModalOpen(true)
  }

  // Upload and process a receipt image through the scanReceipt endpoint.
  async function handleReceiptFile(file: File) {
    if (!uuid) return
    setReceiptPhase('scanning')
    setReceiptItems([])
    setReceiptError('')
    try {
      const form = new FormData()
      form.append('image', file)
      const res = await fetch(`${API}/api/scanReceipt/${uuid}`, { method: 'POST', body: form })
      const raw = await res.text()
      let data: { status?: string; message?: string; items?: string[] } = {}
      try {
        data = raw ? JSON.parse(raw) : {}
      } catch {
        data = { message: raw || `Server error (${res.status})` }
      }

      if (!res.ok) {
        setReceiptError(data.message ?? `Receipt scan failed (${res.status}).`)
        setReceiptPhase('error')
        return
      }

      if (data.status === 'success' && Array.isArray(data.items) && data.items.length > 0) {
        setReceiptItems(data.items)
        setReceiptPhase('results')
        fetchPantryItems()
      } else {
        setReceiptError(data.message ?? 'No food items found in the receipt.')
        setReceiptPhase('error')
      }
    } catch {
      setReceiptError('Network error — please try again.')
      setReceiptPhase('error')
    }
  }

  // Handle receipt file input selection.
  function handleReceiptInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleReceiptFile(file)
    e.target.value = ''
  }

  // Handle drag-and-drop receipt uploads.
  function handleReceiptDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (file) handleReceiptFile(file)
  }

  // Stop scanner stream, controls, and animation loop.
  const stopCamera = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    scanControlsRef.current?.stop()
    scanControlsRef.current = null
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    detectedRef.current = false
  }, [])

  // Close barcode modal after cleaning up camera resources.
  const closeModal = useCallback(() => {
    stopCamera()
    setBarcodeModalOpen(false)
  }, [stopCamera])

  // Submit a barcode image and add the resolved product to pantry.
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

  // Handle manual barcode image upload from file picker.
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    stopCamera()
    submitBarcodeImage(file)
  }

  // Capture the current camera frame and submit it as a barcode image.
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
  // Convert raw expiry data into a labeled UI status badge.
  function getExpiryStatus(expiryRaw: ExpiryValue): { label: string; cls: string; days: number | null } {
    if (!expiryRaw) return { label: 'No Date', cls: 'expiry-unknown', days: null }
    const date = new Date(typeof expiryRaw === 'object' && expiryRaw !== null && '_seconds' in expiryRaw
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

  // Normalize YouTube links into embeddable iframe URLs.
  function getYouTubeEmbedUrl(url: string): string | null {
    // Standard watch URL or short URL with a real video ID
    const idMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/)
    if (idMatch) return `https://www.youtube.com/embed/${idMatch[1]}`
    // YouTube search results URL — convert to embeddable search playlist
    const searchMatch = url.match(/youtube\.com\/results\?search_query=([^&]+)/)
    if (searchMatch) return `https://www.youtube.com/embed?listType=search&list=${searchMatch[1]}`
    return null
  }

  // Derive a compact category tag from a health-impact reason sentence.
  function getHealthReasonTag(reason: string): string {
    const text = reason.toLowerCase()
    const tags: Array<{ keys: string[]; label: string }> = [
      { keys: ['empty calories', 'empty calorie', 'alcohol'], label: 'Empty Calories' },
      { keys: ['sugar', 'glucose', 'syrup', 'sweetener'], label: '↑ Sugar' },
      { keys: ['salt', 'sodium'], label: '↑ Sodium' },
      { keys: ['fat', 'saturated'], label: '↑ Saturated Fat' },
      { keys: ['additive', 'preservative', 'emulsifier', 'colorant'], label: '↑ Additives' },
      { keys: ['processed', 'nova'], label: 'Ultra-Processed' },
      { keys: ['caffeine'], label: '↑ Caffeine' },
      { keys: ['allergen', 'allergy'], label: 'Allergen Risk' },
      { keys: ['sleep'], label: 'Sleep Disruption' },
      { keys: ['mood'], label: 'Mood Volatility' },
      { keys: ['inflammation', 'inflammatory'], label: 'Inflammation Risk' },
      { keys: ['gi', 'digest', 'gut'], label: 'Digestive Stress' },
    ]

    const matched = tags.find(tag => tag.keys.some(k => text.includes(k)))
    if (matched) return matched.label

    const cleaned = reason
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join(' ')
    return cleaned ? `↑ ${cleaned}` : '↑ Health Risk'
  }

  // Consume a pantry item with optimistic UI removal and rollback on failure.
  async function handleConsume(itemId: string) {
    if (!uuid) return
    const item = pantryItems.find(p => p.item_id === itemId)
    setDevourMeal(item?.name ?? 'Item')
    setDevourOverlay(true)
    setConsumingItems(prev => new Set(prev).add(itemId))
    const prevPantry = pantryItems
    setTimeout(async () => {
      try {
        setPantryItems(prev => prev.filter(p => p.item_id !== itemId))
        const res = await fetch(`${API}/api/items/${uuid}/${itemId}?consumed=true`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Delete failed')
      } catch {
        console.error('Failed to consume item')
        setPantryItems(prevPantry)
      } finally {
        setConsumingItems(prev => { const n = new Set(prev); n.delete(itemId); return n })
      }
    }, 420)
  }

  // Trash an expired pantry item with optimistic UI removal and rollback on failure.
  async function handleThrowAway(itemId: string) {
    if (!uuid) return
    const item = pantryItems.find(p => p.item_id === itemId)
    setThrowAwayMeal(item?.name ?? 'Item')
    setThrowAwayOverlay(true)
    setConsumingItems(prev => new Set(prev).add(itemId))
    const prevPantry = pantryItems
    setTimeout(async () => {
      try {
        setPantryItems(prev => prev.filter(p => p.item_id !== itemId))
        const res = await fetch(`${API}/api/items/${uuid}/${itemId}?consumed=false`, { method: 'DELETE' })
        if (!res.ok) throw new Error('Delete failed')
      } catch {
        console.error('Failed to throw away item')
        setPantryItems(prevPantry)
      } finally {
        setConsumingItems(prev => { const n = new Set(prev); n.delete(itemId); return n })
      }
    }, 420)
  }

  // Consume all in-inventory ingredients used by a defeated PerishThreat recipe.
  async function handleDevourRecipe(threat: PerishThreat) {
    if (!uuid) return
    setDevourMeal(threat.meal_type ?? 'Recipe')
    setDevourOverlay(true)
    // For favorited recipes, always use all listed ingredients (stored in_inventory flags can go stale).
    const isFavoritedRecipe = Object.prototype.hasOwnProperty.call(threat as Record<string, unknown>, 'favorite_id')
    const inInventoryNames = (threat.ingredients ?? [])
      .filter(ing => isFavoritedRecipe || ing.in_inventory !== false)
      .map(ing => ing.name.trim().toLowerCase())
    const toConsume = pantryItems.filter(item =>
      inInventoryNames.includes((item.name ?? '').trim().toLowerCase())
    )
    const consumedIds = new Set(toConsume.map(item => item.item_id))
    const prevPantry = pantryItems

    // Optimistic local cache update: remove consumed items immediately without full refetch
    setPantryItems(prev => prev.filter(item => !consumedIds.has(item.item_id)))

    // Fire all DELETEs concurrently; if any fail, restore only failed items from snapshot
    const results = await Promise.allSettled(
      toConsume.map(item =>
        fetch(`${API}/api/items/${uuid}/${item.item_id}?consumed=true`, { method: 'DELETE' })
      )
    )

    const failedIds = new Set<string>()
    results.forEach((result, idx) => {
      if (result.status === 'rejected' || (result.status === 'fulfilled' && !result.value.ok)) {
        failedIds.add(toConsume[idx].item_id)
      }
    })

    if (failedIds.size > 0) {
      const failedItems = prevPantry.filter(item => failedIds.has(item.item_id))
      setPantryItems(prev => {
        const existing = new Set(prev.map(item => item.item_id))
        const toRestore = failedItems.filter(item => !existing.has(item.item_id))
        return [...prev, ...toRestore]
      })
    }

    const movedCount = toConsume.length - failedIds.size
    if (movedCount > 0) {
      const msg = `${movedCount} ingredient${movedCount === 1 ? '' : 's'} moved to history.`
      setDefeatSuccessMessage(msg)
      window.setTimeout(() => setDefeatSuccessMessage(''), 2600)
    }
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

  // Sign out the current user and return to the landing page.
  async function handleSignOut() {
    await signOut(auth)
    navigate('/')
  }

  // Update the current Firebase display name from the profile dropdown.
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

  // Send a chat message to Carry and append the assistant response.
  async function sendAiMessage(messageOverride?: string) {
    const msg = (messageOverride ?? aiMessage).trim()
    if (!msg || aiLoading) return
    if (!uuid) return
    const wasEmpty = chatMessages.length === 0
    setChatMessages(m => [...m, { role: 'user', content: msg }])
    if (!messageOverride) setAiMessage('')
    setAiLoading(true)
    if (wasEmpty) {
      setCarryFlying(true)
      setTimeout(() => setCarryFlying(false), 500)
    }
    try {
      const res = await fetch(`${API}/api/lm/${uuid}/${encodeURIComponent(msg)}`, { method: 'POST' })
      const data = await res.json()
      const assistantContent = data.response ?? JSON.stringify(data)
      let assistantIdx = -1
      setChatMessages(m => {
        assistantIdx = m.length
        return [...m, { role: 'assistant', content: assistantContent }]
      })
      if (autoSpeakEnabled && assistantIdx >= 0) {
        window.setTimeout(() => { void speakAssistantMessage(assistantContent, assistantIdx) }, 0)
      }
    } catch {
      setChatMessages(m => [...m, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    } finally {
      setAiLoading(false)
    }
  }

  // Handle click/enter submission from the chat composer.
  async function handleAiSuggest() {
    await sendAiMessage()
  }

  // Toggle microphone capture and transcribe speech via backend STT endpoint.
  async function toggleSpeechInput(target: 'search' | 'chat') {
    const isSearch = target === 'search'
    const isListening = isSearch ? searchListening : chatListening
    const recorderRef = isSearch ? searchRecorderRef : chatRecorderRef
    const streamRef = isSearch ? searchStreamRef : chatStreamRef
    const setListening = isSearch ? setSearchListening : setChatListening

    if (isListening) {
      recorderRef.current?.stop()
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      const chunks: Blob[] = []

      streamRef.current = stream
      recorderRef.current = recorder
      setListening(true)

      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.push(e.data)
      }

      recorder.onstop = () => {
        setListening(false)
        streamRef.current?.getTracks().forEach(track => track.stop())
        streamRef.current = null
        recorderRef.current = null

        const blob = new Blob(chunks, { type: 'audio/webm' })
        if (!blob.size) return

        void (async () => {
          try {
            const form = new FormData()
            form.append('audio', blob, 'speech.webm')
            const res = await fetch(`${API}/api/stt`, { method: 'POST', body: form })
            const data = await res.json().catch(() => ({}))
            if (!res.ok || data.status !== 'success' || !data.text) return

            const transcript = String(data.text).trim()
            if (!transcript) return

            if (isSearch) {
              setSearchQuery(transcript)
              setSearchOpen(true)
            } else {
              setAiMessage(transcript)
              await sendAiMessage(transcript)
            }
          } catch {
            // Ignore STT failures silently to avoid noisy UX.
          }
        })()
      }

      recorder.onerror = () => {
        setListening(false)
        streamRef.current?.getTracks().forEach(track => track.stop())
        streamRef.current = null
        recorderRef.current = null
      }

      recorder.start()
    } catch {
      setListening(false)
    }
  }

  // Read assistant responses aloud via backend TTS endpoint.
  async function speakAssistantMessage(text: string, idx: number) {
    if (!text.trim()) return

    if (chatSpeakingIdx === idx) {
      currentSpeechAudioRef.current?.pause()
      currentSpeechAudioRef.current = null
      setChatSpeakingIdx(null)
      return
    }

    currentSpeechAudioRef.current?.pause()
    currentSpeechAudioRef.current = null
    setChatSpeakingIdx(idx)

    try {
      const res = await fetch(`${API}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.status !== 'success' || !data.audio_base64) {
        setChatSpeakingIdx(null)
        return
      }

      const mime = String(data.mime_type || 'audio/mpeg')
      const audio = new Audio(`data:${mime};base64,${data.audio_base64}`)
      currentSpeechAudioRef.current = audio
      audio.onended = () => {
        if (chatSpeakingIdx === idx) setChatSpeakingIdx(null)
      }
      audio.onerror = () => {
        if (chatSpeakingIdx === idx) setChatSpeakingIdx(null)
      }
      await audio.play()
    } catch {
      setChatSpeakingIdx(null)
    }
  }

  useEffect(() => {
    const searchRecorder = searchRecorderRef.current
    const chatRecorder = chatRecorderRef.current
    const searchStream = searchStreamRef.current
    const chatStream = chatStreamRef.current
    const speechAudio = currentSpeechAudioRef.current

    return () => {
      searchRecorder?.stop()
      chatRecorder?.stop()
      searchStream?.getTracks().forEach(track => track.stop())
      chatStream?.getTracks().forEach(track => track.stop())
      speechAudio?.pause()
      currentSpeechAudioRef.current = null
    }
  }, [])

  // Match a health-impact hit back to its pantry item for detail rendering.
  function findPantryItemForHit(hit: HealthImpactHit) {
    return pantryItems.find(item =>
      (hit.item_id && item.item_id === hit.item_id) ||
      String(item.name ?? '').toLowerCase() === hit.name.toLowerCase()
    )
  }

  // Toggle expanded state for a mental-health hit card.
  function toggleHealthMental(key: string) {
    setHealthCollapsedMental(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Toggle expanded state for a physical-health hit card.
  function toggleHealthPhysical(key: string) {
    setHealthCollapsedPhysical(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Render the reusable pantry detail content block used by multiple UI surfaces.
  function renderPantryDetailContent(item: PantryItem) {
    const expiry = getExpiryStatus(item.expiry_date)
    return (
      <>
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
      </>
    )
  }

  return (
    <div className={`home${cbMode ? ' home--cb' : ''}`}>
      {/* Banner */}
      <header className="home-header">
        <button
          className="cb-toggle-btn"
          title={cbMode ? 'Switch to default colours' : 'Switch to colorblind-friendly colours'}
          onClick={() => setCbMode(m => { const next = !m; localStorage.setItem('cb-mode', next ? '1' : '0'); return next })}
        >
          <Palette size={16} />
          <span>{cbMode ? 'Default' : 'CB Mode'}</span>
        </button>
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
                  <button className="home-dropdown-item" onClick={openHistoryModal}>
                    <Receipt size={15} />
                    History
                  </button>
                  <button className="home-dropdown-item" onClick={openFavoriteRecipesModal}>
                    <span>⭐</span>
                    Favorited Recipes
                  </button>
                  <button className="home-dropdown-item" onClick={toggleDailyMoodEnabled}>
                    <span>{dailyMoodEnabled ? '☀️' : '🌙'}</span>
                    Daily Mood Prompt: {dailyMoodEnabled ? 'On' : 'Off'}
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
        <button className={`home-tab ${activePage === 'pantry' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('pantry')} data-hint="View and manage your food inventory">
          My Pantry
        </button>
        <button className={`home-tab ${activePage === 'perishthreats' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('perishthreats')} data-hint="See items nearing expiry and AI meal suggestions">
          Defeat PerishThreats
        </button>
        <button className={`home-tab ${activePage === 'health' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('health')} data-hint="AI analysis of potential mental and physical health risks">
          Health Impacts
        </button>
        <button className={`home-tab ${activePage === 'ai' ? 'home-tab--active' : ''}`} onClick={() => setActivePage('ai')} data-hint="Chat with Carry the chatbot to learn more about your pantry">
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
                onKeyDown={e => {
                  if (!searchOpen) return
                  const total = searchResults.length + (searchQuery.trim() ? 1 : 0)
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSearchActiveIdx(i => Math.min(i + 1, total - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSearchActiveIdx(i => Math.max(i - 1, 0))
                  } else if (e.key === 'Enter') {
                    e.preventDefault()
                    if (searchActiveIdx < searchResults.length) {
                      addItemDirect(searchResults[searchActiveIdx].name, searchResults[searchActiveIdx].image_url, searchResults[searchActiveIdx].barcode)
                    } else if (searchQuery.trim()) {
                      openManualAdd(searchQuery.trim())
                    }
                  } else if (e.key === 'Escape') {
                    setSearchOpen(false)
                  }
                }}
                className="h-full pr-12 bg-[rgba(255,255,255,0.08)] border-2 border-[#4caf50] text-[#f0f7f0] placeholder:text-[#a8c5a8] focus-visible:ring-[#4caf50]"
              />
              <button
                className={`search-voice-btn${searchListening ? ' search-voice-btn--active' : ''}`}
                type="button"
                onClick={() => toggleSpeechInput('search')}
                title={searchListening ? 'Stop listening' : 'Speak item name'}
                aria-label={searchListening ? 'Stop listening' : 'Speak item name'}
              >
                {searchListening ? <Square size={14} /> : <Mic size={16} />}
              </button>
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
                      className={`search-dropdown-item${searchActiveIdx === i ? ' search-dropdown-item--active' : ''}`}
                      onMouseDown={e => e.preventDefault()}
                    >
                      <div
                        className="search-dropdown-left"
                        onClick={() => { setSearchQuery(item.name); setSearchOpen(false) }}
                      >
                        <div className="search-dropdown-img-wrap">
                          {item.image_url
                            ? <img src={item.image_url} alt={item.name} className="search-dropdown-img" />
                            : <div className="search-dropdown-img-placeholder"><Package size={16} /></div>}
                        </div>
                        <span className="search-dropdown-name">{item.name}</span>
                      </div>
                      <button
                        className="search-dropdown-add-btn"
                        onMouseDown={e => e.preventDefault()}
                        onClick={() => addItemDirect(item.name, item.image_url, item.barcode)}
                        disabled={addingItems.has(item.name)}
                        title="Add to pantry"
                      >{addingItems.has(item.name) ? '…' : '+ Add'}</button>
                    </li>
                  ))}
                  {searchQuery.trim() && (
                    <li
                      className={`search-dropdown-manual${searchActiveIdx === searchResults.length ? ' search-dropdown-item--active' : ''}`}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => openManualAdd(searchQuery.trim())}
                    >
                      ＋ Add &ldquo;{searchQuery.trim()}&rdquo; manually…
                    </li>
                  )}
                </ul>
              )}
            </div>
            <div className="home-search-receipt">
              <Button
                className="w-full h-full bg-[#4caf50] hover:bg-[#43a047] hover:border-[#e65100] border-2 border-transparent text-white"
                onClick={openReceiptModal}
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
                      <th>Devour</th>
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
                        tags.push({ label: 'Donatable', cls: 'tag-donate', icon: <HeartHandshake size={12} /> })
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
                            {item.image_url
                              ? <img src={item.image_url} alt={item.name} className="pt-thumb" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).nextElementSibling?.classList.add('pt-thumb-placeholder--visible') }} />
                              : null}
                            <div className={`pt-thumb-placeholder${item.image_url ? '' : ' pt-thumb-placeholder--visible'}`}><Package size={20} /></div>
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
                            {expiry.label === 'Expired' ? (
                              <button
                                className={`pt-throw-btn${consumingItems.has(item.item_id) ? ' pt-throw-btn--active' : ''}`}
                                title="Throw away expired item"
                                disabled={consumingItems.has(item.item_id)}
                                onClick={() => handleThrowAway(item.item_id)}
                              >
                                🗑️ Throw Away
                              </button>
                            ) : (
                              <button
                                className={`pt-consume-btn${consumingItems.has(item.item_id) ? ' pt-consume-btn--active' : ''}`}
                                title="Mark as consumed"
                                disabled={consumingItems.has(item.item_id)}
                                onClick={() => handleConsume(item.item_id)}
                              >
                                <CheckCheck size={15} />
                                Devour
                              </button>
                            )}
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

      {/* Receipt Scanner Modal */}
      {receiptModalOpen && (
        <div className="bc-overlay" onClick={e => { if (e.target === e.currentTarget) setReceiptModalOpen(false) }}>
          <div className="bc-modal rc-modal">
            <button className="bc-close" onClick={() => setReceiptModalOpen(false)} aria-label="Close">
              <X size={20} />
            </button>

            <h2 className="bc-title">Scan Receipt</h2>

            {/* Idle / drag-and-drop upload zone */}
            {(receiptPhase === 'idle' || receiptPhase === 'error') && (
              <>
                <div
                  ref={receiptDragRef}
                  className="rc-dropzone"
                  onClick={() => receiptFileRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); receiptDragRef.current?.classList.add('rc-dropzone--drag') }}
                  onDragLeave={() => receiptDragRef.current?.classList.remove('rc-dropzone--drag')}
                  onDrop={e => { receiptDragRef.current?.classList.remove('rc-dropzone--drag'); handleReceiptDrop(e) }}
                >
                  <Receipt size={36} className="rc-dropzone-icon" />
                  <p className="rc-dropzone-label">Drop a receipt photo here</p>
                  <p className="rc-dropzone-sub">or click to choose a file</p>
                </div>
                {receiptPhase === 'error' && (
                  <p className="rc-error">{receiptError}</p>
                )}
                <input
                  ref={receiptFileRef}
                  type="file"
                  accept="image/*"
                  className="bc-file-input"
                  onChange={handleReceiptInputChange}
                />
              </>
            )}

            {/* Scanning spinner */}
            {receiptPhase === 'scanning' && (
              <div className="rc-scanning">
                <span className="rc-spinner" />
                <p className="rc-scanning-label">Reading receipt…</p>
                <p className="rc-scanning-sub">OCR + AI are extracting your items</p>
              </div>
            )}

            {/* Results */}
            {receiptPhase === 'results' && (
              <div className="rc-results">
                <p className="rc-results-header">
                  <CheckCheck size={16} />
                  {receiptItems.length} item{receiptItems.length !== 1 ? 's' : ''} added to your pantry!
                </p>
                <ul className="rc-results-list">
                  {receiptItems.map((name, i) => (
                    <li key={i} className="rc-results-item">
                      <Package size={13} />
                      {name}
                    </li>
                  ))}
                </ul>
                <div className="rc-results-actions">
                  <button className="rc-scan-again-btn" onClick={() => { setReceiptPhase('idle'); setReceiptItems([]) }}>
                    Scan Another
                  </button>
                  <button className="rc-done-btn" onClick={() => setReceiptModalOpen(false)}>
                    Done
                  </button>
                </div>
              </div>
            )}
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
          {!threatsLoading && perishThreats.map((threat, i) => {
            const embedUrl = threat.youtube_url ? getYouTubeEmbedUrl(threat.youtube_url) : null
            const collapsed = collapsedThreats.has(i)
            const favorited = isRecipeFavorited(threat)
            const favSig = recipeSignature(threat)
            const favoriting = favoritePending.has(favSig)
            return (
              <div key={i} className={`pt-threat-card${collapsed ? ' pt-threat-card--collapsed' : ''}`}>
                <button className="pt-threat-header" onClick={() => toggleThreat(i)}>
                  <span className="pt-threat-meal-type">{threat.meal_type ?? 'Meal Suggestion'}</span>
                  {threat.description && !collapsed && (
                    <span className="pt-threat-desc">{threat.description}</span>
                  )}
                  <span
                    className={`pt-favorite-star${favorited ? ' pt-favorite-star--active' : ''}${favoriting ? ' pt-favorite-star--pending' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={favorited ? 'Unfavorite recipe' : 'Favorite recipe'}
                    title={favorited ? 'Unfavorite recipe' : 'Favorite recipe'}
                    onClick={e => { e.stopPropagation(); toggleFavoriteRecipe(threat) }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleFavoriteRecipe(threat)
                      }
                    }}
                  >
                    ⭐
                  </span>
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
                      {(threat.ingredients ?? []).map((ing, j) => {
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
                    <button
                      className="pt-defeat-btn"
                      onClick={e => { e.stopPropagation(); handleDevourRecipe(threat) }}
                    >
                      ⚔ Defeat!
                    </button>
                  </div>
                </div>}
              </div>
            )
          })}
        </main>
      )}

      {/* Page: Health Impacts */}
      {activePage === 'health' && (
        <main className="home-main health-page">
          <div className="health-header">
            <div>
              <h2 className="health-title">AI Ingredient Screening</h2>
            </div>
            <div className="health-progress-wrap">
              {healthLoading && <span className="health-progress-spinner" />}
              <span className="health-progress-text">
                {healthProgress.total > 0
                  ? `${Math.min(healthProgress.processed, healthProgress.total)}/${healthProgress.total} analyzed`
                  : 'Analyzing…'}
              </span>
            </div>
          </div>

          {healthError && <p className="health-error">{healthError}</p>}

          {!healthError && !healthLoading && healthMentalHits.length === 0 && healthPhysicalHits.length === 0 && (
            <p className="pt-empty">No notable negative mental or physical health risks detected in your pantry items.</p>
          )}

          {!healthError && (healthLoading || healthMentalHits.length > 0 || healthPhysicalHits.length > 0) && (
            <div className="health-columns">
              <section className="health-col health-col--mental">
                <h3 className="health-col-title">🧠 Mental Health</h3>
                {healthMentalHits.length === 0 && !healthLoading ? (
                  <p className="health-col-empty">No flagged items.</p>
                ) : (
                  <div className="health-list">
                    {healthMentalHits.map((hit, idx) => {
                      const key = (hit.item_id && hit.item_id.trim()) || `${hit.name.toLowerCase()}-${idx}`
                      const collapsed = !healthCollapsedMental.has(key)
                      const matched = findPantryItemForHit(hit)
                      return (
                        <div key={`mental-${key}`} className={`health-item-card${collapsed ? ' health-item-card--collapsed' : ''}`}>
                          <button className="health-item-header" onClick={() => toggleHealthMental(key)}>
                            <span className="health-item-name">{hit.name}</span>
                            <span className="health-item-header-meta">
                              <span className="health-item-flag" title={hit.reason}>{getHealthReasonTag(hit.reason)}</span>
                              <span className="health-item-chevron">{collapsed ? '▸' : '▾'}</span>
                            </span>
                          </button>
                          {!collapsed && (
                            <div className="health-item-body">
                              <p className="health-item-summary">{hit.reason}</p>
                              {matched ? (
                                <div className="health-item-details">
                                                  {renderPantryDetailContent(matched)}
                                </div>
                              ) : (
                                <p className="health-item-details-empty">No additional pantry details available.</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              <section className="health-col health-col--physical">
                <h3 className="health-col-title">💪 Physical Health</h3>
                {healthPhysicalHits.length === 0 && !healthLoading ? (
                  <p className="health-col-empty">No flagged items.</p>
                ) : (
                  <div className="health-list">
                    {healthPhysicalHits.map((hit, idx) => {
                      const key = (hit.item_id && hit.item_id.trim()) || `${hit.name.toLowerCase()}-${idx}`
                      const collapsed = !healthCollapsedPhysical.has(key)
                      const matched = findPantryItemForHit(hit)
                      return (
                        <div key={`physical-${key}`} className={`health-item-card${collapsed ? ' health-item-card--collapsed' : ''}`}>
                          <button className="health-item-header" onClick={() => toggleHealthPhysical(key)}>
                            <span className="health-item-name">{hit.name}</span>
                            <span className="health-item-header-meta">
                              <span className="health-item-flag" title={hit.reason}>{getHealthReasonTag(hit.reason)}</span>
                              <span className="health-item-chevron">{collapsed ? '▸' : '▾'}</span>
                            </span>
                          </button>
                          {!collapsed && (
                            <div className="health-item-body">
                              <p className="health-item-summary">{hit.reason}</p>
                              {matched ? (
                                <div className="health-item-details">
                                  {renderPantryDetailContent(matched)}
                                </div>
                              ) : (
                                <p className="health-item-details-empty">No additional pantry details available.</p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
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
                    <div className="chat-assistant-content">
                      <div
                        className="chat-bubble chat-bubble--assistant chat-bubble--md"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                      />
                      <button
                        type="button"
                        className={`chat-voice-read-btn${chatSpeakingIdx === i ? ' chat-voice-read-btn--active' : ''}`}
                        onClick={() => speakAssistantMessage(msg.content, i)}
                        title={chatSpeakingIdx === i ? 'Stop speaking' : 'Read aloud'}
                        aria-label={chatSpeakingIdx === i ? 'Stop speaking' : 'Read aloud'}
                      >
                        {chatSpeakingIdx === i ? <Square size={13} /> : <Volume2 size={14} />}
                      </button>
                    </div>
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
              type="button"
              onClick={() => setAutoSpeakEnabled(prev => {
                const next = !prev
                localStorage.setItem('chat-auto-speak', next ? '1' : '0')
                return next
              })}
              className={`chat-auto-speak-btn${autoSpeakEnabled ? ' chat-auto-speak-btn--active' : ''}`}
              title={autoSpeakEnabled ? 'Auto-Speak: On' : 'Auto-Speak: Off'}
            >
              {autoSpeakEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
            </Button>
            <Button
              type="button"
              onClick={() => toggleSpeechInput('chat')}
              className={`chat-voice-input-btn${chatListening ? ' chat-voice-input-btn--active' : ''}`}
            >
              {chatListening ? <Square size={16} /> : <Mic size={16} />}
            </Button>
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

      {/* Manual Add Modal */}
      {manualAddOpen && (
        <div className="manual-add-backdrop" onClick={() => setManualAddOpen(false)}>
          <div className="manual-add-modal" onClick={e => e.stopPropagation()}>
            <button className="manual-add-close" onClick={() => setManualAddOpen(false)} aria-label="Close add item modal">
              <X size={18} />
            </button>
            <h2 className="manual-add-title">Add Item to Pantry</h2>
            <div className="manual-add-fields">
              <label className="manual-add-label">Item Name *
                <input
                  className="manual-add-input"
                  value={manualAddName}
                  onChange={e => setManualAddName(e.target.value)}
                  placeholder="e.g. Sourdough Bread"
                  autoFocus
                />
              </label>
              <label className="manual-add-label">Expiry Date
                <input
                  type="date"
                  className="manual-add-input"
                  value={manualAddExpiry}
                  onChange={e => setManualAddExpiry(e.target.value)}
                />
              </label>
              <label className="manual-add-label">Category
                <input
                  className="manual-add-input"
                  value={manualAddCategory}
                  onChange={e => setManualAddCategory(e.target.value)}
                  placeholder="e.g. dairy, vegetables…"
                />
              </label>
            </div>
            {manualAddError && <p className="manual-add-error">{manualAddError}</p>}
            <div className="manual-add-actions">
              <button className="manual-add-cancel" onClick={() => setManualAddOpen(false)} disabled={manualAddLoading}>Cancel</button>
              <button
                className="manual-add-submit"
                onClick={handleManualAdd}
                disabled={manualAddLoading || !manualAddName.trim()}
              >
                {manualAddLoading ? 'Adding…' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Daily Mood Modal */}
      {moodModalOpen && (
        <div className="mood-backdrop" onClick={e => { if (e.target === e.currentTarget) closeMoodModal() }}>
          <div className="mood-modal">
            <button className="mood-close" onClick={closeMoodModal} aria-label="Close mood modal">
              <X size={20} />
            </button>

            <h2 className="mood-title">Daily Check-In</h2>

            <div className="mood-carry-row">
              <img
                src="carry-icon.png"
                alt="Carry"
                className={`mood-carry-icon${moodPhase === 'loading' ? ' carry-icon--spinning' : ''}`}
              />
              <div className="mood-bubble">
                {moodPhase === 'loading'
                  ? 'Thinking of something uplifting for you…'
                  : moodPhase === 'response'
                    ? (moodQuote || 'You’ve got this — one step at a time today.')
                    : moodPhase === 'error'
                      ? (moodError || 'I couldn’t load your quote right now, but you’ve still got this today.')
                      : 'How are you today on a 1–10 scale?'}
              </div>
            </div>

            {(moodPhase === 'input' || moodPhase === 'error') && (
              <div className="mood-slider-wrap">
                <div className="mood-slider-labels">
                  <span>0</span>
                  <span className="mood-slider-value">{moodScore}</span>
                  <span>10</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={moodScore}
                  onChange={e => setMoodScore(Number(e.target.value))}
                  className="mood-slider"
                />
                <div className="mood-actions">
                  <button className="mood-submit" onClick={submitMoodScore}>
                    Submit
                  </button>
                </div>
              </div>
            )}

            {moodPhase === 'response' && (
              <div className="mood-actions">
                <button className="mood-submit" onClick={closeMoodModal}>Close</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Favorited Recipes Modal */}
      {favoriteRecipesOpen && (
        <div className="favrec-backdrop" onClick={e => { if (e.target === e.currentTarget) closeFavoriteRecipesModal() }}>
          <div className="favrec-modal">
            <button className="favrec-close" onClick={closeFavoriteRecipesModal} aria-label="Close favorited recipes">
              <X size={20} />
            </button>

            <h2 className="favrec-title">Favorited Recipes</h2>
            <p className="favrec-subtitle">Your saved PerishThreat recipes</p>

            {favoriteRecipesLoading && <p className="favrec-state">Loading favorites…</p>}
            {!favoriteRecipesLoading && favoriteRecipesError && <p className="favrec-state favrec-state--error">{favoriteRecipesError}</p>}
            {!favoriteRecipesLoading && !favoriteRecipesError && favoriteRecipes.length === 0 && (
              <p className="favrec-state">No favorited recipes yet.</p>
            )}

            {!favoriteRecipesLoading && !favoriteRecipesError && favoriteRecipes.length > 0 && (
              <div className="favrec-list">
                {favoriteRecipes.map((recipe, i) => {
                  const embedUrl = recipe.youtube_url ? getYouTubeEmbedUrl(recipe.youtube_url) : null
                  const collapsed = collapsedFavoriteRecipes.has(recipe.favorite_id)
                  return (
                    <div key={recipe.favorite_id || `fav-${i}`} className={`pt-threat-card${collapsed ? ' pt-threat-card--collapsed' : ''}`}>
                      <button className="pt-threat-header" onClick={() => toggleFavoriteRecipeCollapse(recipe.favorite_id)}>
                        <span className="pt-threat-meal-type">{recipe.meal_type ?? 'Meal Suggestion'}</span>
                        {recipe.description && !collapsed && (
                          <span className="pt-threat-desc">{recipe.description}</span>
                        )}
                        <span className="pt-favorite-star pt-favorite-star--active" title="Favorited">⭐</span>
                        <span className="pt-threat-chevron">{collapsed ? '▸' : '▾'}</span>
                      </button>

                      {!collapsed && <div className="pt-threat-body">
                        <div className="pt-threat-img-col">
                          {recipe.image_url
                            ? <img src={recipe.image_url} alt={recipe.meal_type} className="pt-threat-img" />
                            : <div className="pt-threat-img-placeholder">No Image</div>}
                        </div>

                        <div className="pt-threat-video-col">
                          {embedUrl
                            ? (
                              <iframe
                                className="pt-threat-video"
                                src={embedUrl}
                                title={recipe.meal_type}
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                allowFullScreen
                              />
                            ) : (
                              <div className="pt-threat-video-placeholder">
                                <span>No video available</span>
                              </div>
                            )}
                        </div>

                        <div className="pt-threat-ing-col">
                          <p className="pt-threat-ing-title">Ingredients</p>
                          <ul className="pt-threat-ing-list">
                            {(recipe.ingredients ?? []).map((ing, j) => {
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
                          <button
                            className="pt-defeat-btn"
                            onClick={e => { e.stopPropagation(); handleDevourRecipe(recipe) }}
                          >
                            ⚔ Defeat!
                          </button>
                        </div>
                      </div>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* History Modal */}
      {historyOpen && (
        <div className="history-backdrop" onClick={e => { if (e.target === e.currentTarget) closeHistoryModal() }}>
          <div className="history-modal">
            <button className="history-close" onClick={closeHistoryModal} aria-label="Close history">
              <X size={20} />
            </button>
            <h2 className="history-title">History</h2>
            <p className="history-subtitle">Consumed and trashed items</p>

            {historyLoading && <p className="history-state">Loading history…</p>}
            {!historyLoading && historyError && <p className="history-state history-state--error">{historyError}</p>}
            {!historyLoading && !historyError && historyItems.length === 0 && (
              <p className="history-state">No history yet.</p>
            )}

            {!historyLoading && !historyError && historyItems.length > 0 && (
              <div className="history-table-wrap">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Status</th>
                      <th>When</th>
                      <th>Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyItems.map((item, i) => {
                      const action = String(item.history_action ?? 'consumed')
                      const tsRaw = item.history_at ?? item.consumed_at ?? item.trashed_at
                      const tsDate = new Date(
                        typeof tsRaw === 'object' && tsRaw && '_seconds' in (tsRaw as Record<string, unknown>)
                          ? Number((tsRaw as Record<string, unknown>)._seconds) * 1000
                          : String(tsRaw ?? '')
                      )
                      const when = isNaN(tsDate.getTime()) ? '—' : tsDate.toLocaleString()
                      const category = item.category && item.category !== 'Unknown' ? String(item.category) : '—'
                      return (
                        <tr key={`${String(item.item_id ?? i)}-${i}`}>
                          <td className="history-name-cell">
                            {item.image_url
                              ? <img src={String(item.image_url)} alt={String(item.name ?? '')} className="history-thumb" />
                              : <div className="history-thumb history-thumb--placeholder"><Package size={14} /></div>}
                            <span>{String(item.name ?? 'Unknown Item')}</span>
                          </td>
                          <td>
                            <span className={`history-action-badge ${action === 'trashed' ? 'history-action-badge--trashed' : 'history-action-badge--consumed'}`}>
                              {action === 'trashed' ? 'Trashed' : 'Consumed'}
                            </span>
                          </td>
                          <td>{when}</td>
                          <td>{category}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Devour full-screen overlay */}
      {devourOverlay && (
        <div
          className="recipe-devour-overlay"
          onAnimationEnd={() => setDevourOverlay(false)}
        >
          <div className="recipe-devour-content">
            <span className="recipe-devour-icon">⚔</span>
            <h2 className="recipe-devour-title">{devourMeal}</h2>
            <p className="recipe-devour-sub">PerishThreat Defeated!</p>
          </div>
        </div>
      )}

      {/* Throw Away full-screen overlay */}
      {throwAwayOverlay && (
        <div
          className="throw-away-overlay"
          onAnimationEnd={() => setThrowAwayOverlay(false)}
        >
          <div className="throw-away-content">
            <span className="throw-away-icon">😢</span>
            <h2 className="throw-away-title">{throwAwayMeal}</h2>
            <p className="throw-away-sub">Thrown Away&hellip;</p>
          </div>
        </div>
      )}

      {/* Pantry item hover tooltip */}
      {hoveredItem && (() => {
        const item = hoveredItem
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
            {renderPantryDetailContent(item)}
          </div>
        )
      })()}

      {defeatSuccessMessage && (
        <div className="defeat-success-toast" role="status" aria-live="polite">
          {defeatSuccessMessage}
        </div>
      )}
    </div>
  )
}

export default Home

