import { useState, useEffect } from 'react'
import './Footer.css'

export default function Footer({ variant = 'default', onChangeLogClick }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/system/stats');
        const data = await response.json();
        setStats(data);
      } catch (err) {
        console.error('Failed to fetch system stats:', err);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 3000); // Update every 3 seconds
    return () => clearInterval(interval);
  }, []);

  // Helper to render the metrics block
  const renderMetrics = () => {
    if (!stats) return <span>Loading Metrics...</span>;
    return (
      <>
        <span>CPU: {stats.cpu}%</span>
				<span>GPU: {stats.gpu.name}</span>
        <span>{stats.gpu.utilization}%</span>
        <span>VRAM: {stats.gpu.vramUsed} / {stats.gpu.vramTotal} GB</span>
        <span>RAM: {stats.ram.used} / {stats.ram.total} GB</span>
      </>
    );
  };

  if (variant === 'kanban') {
    return (
      <footer className="footer footer--kanban" id="status-bar">
        <div className="footer__left">
          <div className="footer__status">
            <div className="footer__status-dot footer__status-dot--online" />
            <span className="footer__status-text">System Online</span>
          </div>
          <div className="footer__metrics">
            {renderMetrics()}
          </div>
        </div>
        {/* custom */}
      </footer>
    );
  }

  return (
    <footer className="footer" id="main-footer">
      <div className="footer__left">
        <span className="footer__text">
          Server Status: <span className="footer__text--success">Optimal</span>
        </span>
        <div className="footer__metrics" style={{ marginLeft: '1rem' }}>
          {renderMetrics()}
        </div>
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
  );
}