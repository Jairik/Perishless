import { Button } from '@/components/ui/button'
import './App.css'

function App() {
  return (
    <div className="landing">
      <header className="landing-header">
        <img src="perishless-icon.png" alt="Perishless" className="logo-icon" />
        <span className="logo-text">PerishLess</span>
      </header>

      <main className="landing-main">
        <h1 className="landing-title">Stop wasting food.</h1>
        <p className="landing-subtitle">
          Track expiry dates, reduce waste, and save money - all in one place.
        </p>

        <div className="landing-actions">
          <Button
            size="lg"
            className="bg-[#4caf50] hover:bg-[#43a047] hover:border-[#e65100] border-2 border-transparent text-white px-8"
          >
            Sign Up
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="bg-transparent text-[#f0f7f0] border-2 border-transparent hover:bg-[rgba(76,175,80,0.15)] hover:text-[#f0f7f0] hover:border-[#e65100] px-8"
          >
            Log In
          </Button>
        </div>
      </main>
    </div>
  )
}

export default App
