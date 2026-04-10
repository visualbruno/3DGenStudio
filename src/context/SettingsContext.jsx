import { createContext, useContext, useState, useEffect, useCallback } from 'react'

const SettingsContext = createContext(null)
const API_BASE = 'http://localhost:3001/api'

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState({
    profile: { name: 'User', avatar: null },
    apis: {
      google: {
        apiKey: '',
        imageGeneration: {
          headerName: 'x-goog-api-key',
          payloadTemplate: {
            contents: [
              {
                parts: [
                  { text: '{prompt}' }
                ]
              }
            ]
          },
          models: {
            nanobana: {
              name: 'Nanobanana',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent'
            },
            nanobana_pro: {
              name: 'Nanobanana Pro',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent'
            },
            nanobana_2: {
              name: 'Nanobanana 2',
              url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent'
            }
          }
        }
      },
      openai: { apiKey: '' },
      custom: []
    }
  })
  const [loading, setLoading] = useState(true)

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`)
      if (res.ok) {
        const data = await res.json()
        setSettings(data)
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const updateSettings = async (newSettings) => {
    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      })
      const data = await res.json()
      setSettings(data)
      return data
    } catch (err) {
      console.error('Failed to update settings:', err)
      throw err
    }
  }

  const addCustomApi = async (api) => {
    const newSettings = {
      ...settings,
      apis: {
        ...settings.apis,
        custom: [...(settings.apis.custom || []), { ...api, id: Date.now() }]
      }
    }
    return await updateSettings(newSettings)
  }

  return (
    <SettingsContext.Provider value={{ 
      settings, 
      loading, 
      updateSettings,
      addCustomApi,
      refreshSettings: fetchSettings
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}
