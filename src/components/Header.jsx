import { Link, useLocation } from 'react-router-dom'
import './Header.css'

export default function Header({ showSearch = false, showCreateNew = false, onSettingsClick }) {
  const location = useLocation()

  const isActive = (path) => location.pathname.startsWith(path)

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

      <div className="header__right">
        {showSearch && (
          <button className="header__search-btn" id="search-assets-btn">
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>search</span>
            <span className="header__search-text">Search Assets</span>
          </button>
        )}

        <div className="header__actions">
          <button className="header__icon-btn" id="notifications-btn" title="Notifications">
            <span className="material-symbols-outlined">notifications</span>
          </button>
          <button className="header__icon-btn" id="settings-btn" title="Settings" onClick={onSettingsClick}>
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>

        {showCreateNew && (
          <Link to="/projects/new" className="header__create-btn" id="create-new-btn">
            Create New
          </Link>
        )}
      </div>
    </header>
  )
}
