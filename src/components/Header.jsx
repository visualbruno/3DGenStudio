import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import './Header.css'

export default function Header({ showSearch = false, showCreateNew = false }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()

  const isActive = (path) => location.pathname.startsWith(path)

  const handleLogout = () => {
    logout()
    navigate('/')
  }

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
          <a href="#" className="header__nav-link">Assets</a>
          <a href="#" className="header__nav-link">Library</a>
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
          <button className="header__icon-btn" id="settings-btn" title="Settings">
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>

        <button className="header__avatar" onClick={handleLogout} title="Logout">
          <span className="header__avatar-letter">
            {user?.name?.charAt(0)?.toUpperCase() || 'U'}
          </span>
        </button>

        {showCreateNew && (
          <Link to="/projects/new" className="header__create-btn" id="create-new-btn">
            Create New
          </Link>
        )}
      </div>
    </header>
  )
}
