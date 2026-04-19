import './Footer.css'

export default function Footer({ variant = 'default', onChangeLogClick }) {
  if (variant === 'kanban') {
    return (
      <footer className="footer footer--kanban" id="status-bar">
        <div className="footer__left">
          <div className="footer__status">
            <div className="footer__status-dot footer__status-dot--online" />
            <span className="footer__status-text">System Online</span>
          </div>
          <div className="footer__metrics">
            <span>GPU: RTX 4090 (82%)</span>
            <span>MEM: 14.2 GB / 24 GB</span>
            <span>LATENCY: 42ms</span>
          </div>
        </div>
        <div className="footer__right">
          <button className="footer__action-btn" id="action-log-btn">
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>history</span>
            ACTION LOG
          </button>
          <button className="footer__action-btn" id="export-queue-btn">
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>layers</span>
            EXPORT QUEUE (2)
          </button>
        </div>
      </footer>
    )
  }

  return (
    <footer className="footer" id="main-footer">
      <div className="footer__left">
        <span className="footer__text">
          Server Status: <span className="footer__text--success">Optimal</span>
        </span>
        <span className="footer__text">Latency: 14ms</span>
      </div>
      <div className="footer__right">
        {onChangeLogClick && (
          <button type="button" className="footer__link footer__link-btn" onClick={onChangeLogClick}>
            Change Log
          </button>
        )}
        <a href="https://github.com/visualbruno/3DGenStudio/tree/main/docs" target="_blank" className="footer__link">Documentation</a>
        <a href="https://www.3dgenstudio.com/terms-and-conditions.html" target="_blank" className="footer__link">Terms of Service</a>
      </div>
    </footer>
  )
}
