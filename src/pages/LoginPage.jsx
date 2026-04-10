import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import './LoginPage.css'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    if (!email || !password) {
      setError('Please enter both email and password.')
      return
    }

    setIsLoading(true)

    // Simulate network delay
    await new Promise(r => setTimeout(r, 800))

    const success = login(email, password)
    if (success) {
      navigate('/projects')
    } else {
      setError('Invalid credentials.')
    }
    setIsLoading(false)
  }

  return (
    <div className="login-page">
      {/* Animated background orbs */}
      <div className="login-page__bg">
        <div className="login-page__orb login-page__orb--1" />
        <div className="login-page__orb login-page__orb--2" />
        <div className="login-page__orb login-page__orb--3" />
      </div>

      <div className="login-page__content">
        {/* Logo & Tagline */}
        <div className="login-page__brand">
          <div className="login-page__logo-icon">
            <span className="material-symbols-outlined filled" style={{ fontSize: '32px', color: 'var(--primary)' }}>
              deployed_code
            </span>
          </div>
          <h1 className="login-page__title">3D Gen Studio</h1>
          <p className="login-page__subtitle">AI-Powered 3D Mesh Generation Pipeline</p>
        </div>

        {/* Login Card */}
        <div className="login-page__card">
          <div className="login-page__card-header">
            <h2 className="login-page__card-title">Sign In</h2>
            <p className="login-page__card-desc">Access your workspace and generation pipeline.</p>
          </div>

          <form className="login-page__form" onSubmit={handleSubmit} id="login-form">
            {error && (
              <div className="login-page__error" id="login-error">
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>error</span>
                {error}
              </div>
            )}

            <div className="login-page__field">
              <label className="login-page__label" htmlFor="login-email">Email Address</label>
              <div className="login-page__input-wrap">
                <span className="material-symbols-outlined login-page__input-icon">mail</span>
                <input
                  id="login-email"
                  type="email"
                  className="login-page__input"
                  placeholder="architect@studio.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
                <div className="login-page__input-glow" />
              </div>
            </div>

            <div className="login-page__field">
              <label className="login-page__label" htmlFor="login-password">Password</label>
              <div className="login-page__input-wrap">
                <span className="material-symbols-outlined login-page__input-icon">lock</span>
                <input
                  id="login-password"
                  type="password"
                  className="login-page__input"
                  placeholder="••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <div className="login-page__input-glow" />
              </div>
            </div>

            <div className="login-page__options">
              <label className="login-page__remember">
                <input type="checkbox" className="login-page__checkbox" />
                <span>Remember this device</span>
              </label>
              <a href="#" className="login-page__forgot">Forgot password?</a>
            </div>

            <button
              type="submit"
              className={`login-page__submit ${isLoading ? 'login-page__submit--loading' : ''}`}
              id="login-submit-btn"
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <span className="material-symbols-outlined login-page__spinner">progress_activity</span>
                  Authenticating...
                </>
              ) : (
                <>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>login</span>
                  Sign In
                </>
              )}
            </button>
          </form>

          <div className="login-page__divider">
            <span>or</span>
          </div>

          <button className="login-page__alt-btn" id="demo-access-btn" onClick={() => {
            setEmail('demo@3dgenstudio.io')
            setPassword('demo')
          }}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>science</span>
            Try Demo Access
          </button>
        </div>

        {/* System Info */}
        <div className="login-page__sys-info">
          <div className="login-page__sys-item">
            <div className="login-page__sys-icon login-page__sys-icon--secondary">
              <span className="material-symbols-outlined filled" style={{ fontSize: '16px' }}>deployed_code</span>
            </div>
            <div>
              <span className="login-page__sys-label">Engine</span>
              <span className="login-page__sys-value">Synthesis V4.2</span>
            </div>
          </div>
          <div className="login-page__sys-item">
            <div className="login-page__sys-icon login-page__sys-icon--tertiary">
              <span className="material-symbols-outlined filled" style={{ fontSize: '16px' }}>memory</span>
            </div>
            <div>
              <span className="login-page__sys-label">Allocated GPU</span>
              <span className="login-page__sys-value">24GB VRAM</span>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="login-page__footer">
        <div className="login-page__footer-left">
          <span>Server Status: <span className="login-page__footer-status">Optimal</span></span>
          <span>Latency: 14ms</span>
        </div>
        <div className="login-page__footer-right">
          <a href="#">Documentation</a>
          <a href="#">Terms of Service</a>
        </div>
      </footer>
    </div>
  )
}
