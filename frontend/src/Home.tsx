import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Barcode, CircleUser } from 'lucide-react'
import './Home.css'

const API = 'http://localhost:8000'

function Home() {
  const [aiMessage, setAiMessage] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [recipeOutput, setRecipeOutput] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [recipeLoading, setRecipeLoading] = useState(false)

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

  async function handleGenerateRecipes() {
    setRecipeLoading(true)
    try {
      const res = await fetch(`${API}/api/recipe-recommendation`)
      const data = await res.json()
      setRecipeOutput(data.recipes ?? JSON.stringify(data))
    } finally {
      setRecipeLoading(false)
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
        <div className="home-header-user">
          <span className="home-username">username</span>
          <CircleUser className="home-avatar" />
        </div>
      </header>

      {/* Search / action row */}
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

      {/* AI suggestions row */}
      <div className="home-ai-row">
        <div className="home-ai-input">
          <Textarea
            placeholder="AI Suggestions"
            value={aiMessage}
            onChange={e => setAiMessage(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleAiSuggest())}
            rows={2}
            className="bg-[rgba(255,255,255,0.06)] border-2 border-[#4caf50] text-[#f0f7f0] placeholder:text-[#a8c5a8] focus-visible:ring-[#4caf50] resize-none ai-textarea"
          />
          {aiResponse && (
            <p className="home-ai-response">{aiResponse}</p>
          )}
        </div>

        <div className="home-ai-recipe">
          <Button
            onClick={handleGenerateRecipes}
            disabled={recipeLoading}
            className="w-full bg-[#4caf50] hover:bg-[#43a047] hover:border-[#e65100] border-2 border-transparent text-white"
          >
            🐔 {recipeLoading ? 'Generating…' : 'Generate Recipes'}
          </Button>
          {recipeOutput && (
            <p className="home-ai-response">{recipeOutput}</p>
          )}
        </div>
      </div>

      {/* Content area — populated later */}
      <main className="home-main" />
    </div>
  )
}

export default Home
