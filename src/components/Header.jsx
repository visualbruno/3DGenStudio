import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import './Header.css'
import localVersionInfo from '../../version.json'

const GITHUB_VERSION_URL = 'https://github.com/visualbruno/3DGenStudio/blob/main/version.json'
const GITHUB_RAW_VERSION_URL = GITHUB_VERSION_URL
  .replace('https://github.com/', 'https://raw.githubusercontent.com/')
  .replace('/blob/', '/')

let cachedVersionCheck = null
let versionCheckPromise = null

async function checkForAppUpdate() {
  if (cachedVersionCheck) return cachedVersionCheck
  if (!versionCheckPromise) {
    versionCheckPromise = (async () => {
      const localVersion = String(localVersionInfo?.version || '').trim()
      const response = await fetch(GITHUB_RAW_VERSION_URL, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`Failed to fetch remote version: ${response.status}`)
      }

      const remoteData = await response.json()
      const remoteVersion = String(remoteData?.version || '').trim()
      const result = {
        hasUpdate: Boolean(localVersion && remoteVersion && localVersion !== remoteVersion),
        localVersion,
        remoteVersion,
      }
      cachedVersionCheck = result
      return result
    })()
  }

  try {
    return await versionCheckPromise
  } finally {
    versionCheckPromise = null
  }
}

export default function Header({ showSearch = false, showCreateNew = false, onSettingsClick, title = '', centerTitle = false, searchValue = '', onSearchChange, searchPlaceholder = 'Search Assets' }) {
  const location = useLocation()
  const [showNotifications, setShowNotifications] = useState(false)
  const [isCheckingVersion, setIsCheckingVersion] = useState(true)
  const [versionCheckError, setVersionCheckError] = useState('')
  const [versionStatus, setVersionStatus] = useState({
    hasUpdate: false,
    localVersion: String(localVersionInfo?.version || '').trim(),
    remoteVersion: ''
  })
  const notificationRef = useRef(null)

  const isActive = (path) => location.pathname.startsWith(path)

  useEffect(() => {
    let active = true

    const runVersionCheck = async () => {
      setIsCheckingVersion(true)
      setVersionCheckError('')
      try {
        const result = await checkForAppUpdate()
        if (active) setVersionStatus(result)
      } catch (error) {
        if (active) {
          console.error('Version check failed:', error)
          setVersionCheckError('Could not check for updates right now.')
        }
      } finally {
        if (active) setIsCheckingVersion(false)
      }
    }

    runVersionCheck()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!showNotifications) return undefined

    const onPointerDown = (event) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        setShowNotifications(false)
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [showNotifications])

  return (
    <header className="header" id="main-header">
      <div className="header__left">
        <Link to="/projects" className="header__logo">
          3D Gen Studio
        </Link>
        <nav className="header__nav">
          <Link
            to="/projects"
            className={`header__nav-link ${isActive('/projects') ? 'header__nav-link--active' : ''}`}
          >
            Projects
          </Link>
          <Link to="/assets" className={`header__nav-link ${isActive('/assets') ? 'header__nav-link--active' : ''}`}>Assets</Link>
        </nav>
      </div>

      {centerTitle && title && (
        <div className="header__title-wrap">
          <h1 className="header__title">{title}</h1>
        </div>
      )}

      <div className="header__right">
        {showSearch && (
          onSearchChange ? (
            <div className="header__search-btn header__search-field">
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>search</span>
              <input
                type="text"
                className="header__search-input"
                value={searchValue}
                onChange={event => onSearchChange(event.target.value)}
                placeholder={searchPlaceholder}
                id="search-assets-input"
              />
              {searchValue && (
                <button
                  type="button"
                  className="header__search-clear"
                  onClick={() => onSearchChange('')}
                  title="Clear search"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                </button>
              )}
            </div>
          ) : (
            <button className="header__search-btn" id="search-assets-btn">
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>search</span>
              <span className="header__search-text">Search Assets</span>
            </button>
          )
        )}

        <div className="header__actions">
          <button
            className={`header__icon-btn ${versionStatus.hasUpdate ? 'header__icon-btn--update' : ''}`}
            id="notifications-btn"
            title={versionStatus.hasUpdate ? 'A new version is available' : 'Notifications'}
            onClick={() => setShowNotifications(open => !open)}
            aria-label="Open notifications"
            aria-expanded={showNotifications}
          >
            <span className="material-symbols-outlined">notifications</span>
            {versionStatus.hasUpdate && <span className="header__notif-dot" aria-hidden="true" />}
          </button>
          <button className="header__icon-btn" id="settings-btn" title="Settings" onClick={onSettingsClick}>
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>

        {showNotifications && (
          <div className="header__notifications-pop" ref={notificationRef} role="dialog" aria-label="Notifications">
            <div className="header__notifications-head">
              <p className="header__notifications-title">App Notifications</p>
              <button
                type="button"
                className="header__notifications-close"
                onClick={() => setShowNotifications(false)}
                aria-label="Close notifications"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
              </button>
            </div>

            {isCheckingVersion && (
              <div className="header__notifications-card header__notifications-card--neutral">
                <span className="material-symbols-outlined">sync</span>
                <div>
                  <p className="header__notifications-card-title">Checking for updates...</p>
                  <p className="header__notifications-card-text">Contacting GitHub to compare versions.</p>
                </div>
              </div>
            )}

            {!isCheckingVersion && versionCheckError && (
              <div className="header__notifications-card header__notifications-card--warning">
                <span className="material-symbols-outlined">error</span>
                <div>
                  <p className="header__notifications-card-title">Update check unavailable</p>
                  <p className="header__notifications-card-text">{versionCheckError}</p>
                </div>
              </div>
            )}

            {!isCheckingVersion && !versionCheckError && versionStatus.hasUpdate && (
              <div className="header__notifications-card header__notifications-card--success">
                <span className="material-symbols-outlined">new_releases</span>
                <div>
                  <p className="header__notifications-card-title">New version available: v{versionStatus.remoteVersion}</p>
                  <p className="header__notifications-card-text">You are currently on v{versionStatus.localVersion}.</p>
                </div>
              </div>
            )}

            {!isCheckingVersion && !versionCheckError && !versionStatus.hasUpdate && (
              <div className="header__notifications-card header__notifications-card--neutral">
                <span className="material-symbols-outlined">check_circle</span>
                <div>
                  <p className="header__notifications-card-title">You are up to date</p>
                  <p className="header__notifications-card-text">Current version: v{versionStatus.localVersion}</p>
                </div>
              </div>
            )}


          </div>
        )}

        {showCreateNew && (
          <Link to="/projects/new" className="header__create-btn" id="create-new-btn">
            Create New
          </Link>
        )}
      </div>
    </header>
  )
}
