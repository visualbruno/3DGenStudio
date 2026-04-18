import { Routes, Route, Navigate } from 'react-router-dom'
import { ProjectProvider } from './context/ProjectContext'
import { SettingsProvider } from './context/SettingsContext'
import ProjectsPage from './pages/ProjectsPage'
import ProjectWorkspacePage from './pages/ProjectWorkspacePage'
import AssetsPage from './pages/AssetsPage'

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/new" element={<ProjectsPage />} />
      <Route path="/assets" element={<AssetsPage />} />
      <Route path="/library" element={<Navigate to="/assets" replace />} />
      <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <ProjectProvider>
        <AppRoutes />
      </ProjectProvider>
    </SettingsProvider>
  )
}
