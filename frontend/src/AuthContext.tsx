import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth } from './firebase'

export { auth }

interface AuthContextValue {
  user: User | null
  uuid: string | null
  loading: boolean
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  uuid: null,
  loading: true,
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  return (
    <AuthContext.Provider value={{ user, uuid: user?.uid ?? null, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

/** Synchronously returns the current user's Firebase UID, or null if not signed in. */
export function get_uuid(): string | null {
  return auth.currentUser?.uid ?? null
}
