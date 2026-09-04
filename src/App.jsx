import { Routes, Route, Navigate } from 'react-router-dom'
import { ProjectProvider } from './context/ProjectContext'
import { SettingsProvider } from './context/SettingsContext'
import { NotificationProvider } from './context/NotificationContext'
import { RemoteProvider } from './context/RemoteContext'
import { ServerSessionProvider } from './context/ServerSessionContext'
import ServerLoginPage from './components/ServerLoginPage'
import { WorkflowJobsProvider } from './context/WorkflowJobsContext'
import { BatchRunProvider } from './context/BatchRunContext'
import ProjectsPage from './pages/ProjectsPage'
import ProjectWorkspacePage from './pages/ProjectWorkspacePage'
import AssetsPage from './pages/AssetsPage'
import MeshEditorPage from './pages/MeshEditorPage'
import ImageEditorPage from './pages/ImageEditorPage'
import BoardPage from './pages/BoardPage'
import AssemblyPage from './pages/AssemblyPage'
import WikiPage from './pages/WikiPage'

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route path="/projects" element={<ProjectsPage />} />
      <Route path="/projects/new" element={<ProjectsPage />} />
      <Route path="/assets" element={<AssetsPage />} />
      <Route path="/mesh-editor" element={<MeshEditorPage />} />
      <Route path="/image-editor" element={<ImageEditorPage />} />
      <Route path="/board" element={<BoardPage />} />
      <Route path="/assembly" element={<AssemblyPage />} />
      <Route path="/wiki" element={<WikiPage />} />
      <Route path="/wiki/:pageId" element={<WikiPage />} />
      <Route path="/library" element={<Navigate to="/assets" replace />} />
      <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <NotificationProvider>
      {/* Outermost of the data-aware providers, because when this build is being
          served BY a shared server nothing below it may run until someone has
          signed in — every provider under it would otherwise open with a round
          of 401s. Inert on a desktop install: it asks /api/health once, sees
          mode 'local', and renders its children unchanged. */}
      <ServerSessionProvider renderLogin={({ signIn }) => <ServerLoginPage signIn={signIn} />}>
        {/* Pure connection status with no dependencies, and both the banner and
            the Server settings tab read it. */}
        <RemoteProvider>
          <SettingsProvider>
            <ProjectProvider>
              <WorkflowJobsProvider>
                <BatchRunProvider>
                  <AppRoutes />
                </BatchRunProvider>
              </WorkflowJobsProvider>
            </ProjectProvider>
          </SettingsProvider>
        </RemoteProvider>
      </ServerSessionProvider>
    </NotificationProvider>
  )
}
