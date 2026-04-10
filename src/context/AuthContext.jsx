import { createContext, useContext, useState, useCallback } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('3dgs_user')
    return saved ? JSON.parse(saved) : null
  })

  const login = useCallback((email, password) => {
    // Mock authentication — replace with real API later
    const mockUser = {
      id: '1',
      email,
      name: email.split('@')[0],
      avatar: null,
    }
    setUser(mockUser)
    localStorage.setItem('3dgs_user', JSON.stringify(mockUser))
    return true
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    localStorage.removeItem('3dgs_user')
  }, [])

  return (
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
