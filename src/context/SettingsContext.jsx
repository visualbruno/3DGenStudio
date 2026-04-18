import { useState, useEffect, useCallback } from 'react'
import { SettingsContext } from './SettingsContext.shared'

const API_BASE = 'http://localhost:3001/api'
const DEFAULT_CUSTOM_API_TYPE = 'image-generation'

function normalizeCustomApiType(type) {
  return ['image-generation', 'image-edit', 'mesh-generation', 'mesh-edit'].includes(type)
    ? type
    : DEFAULT_CUSTOM_API_TYPE
}

function normalizeSettings(settings) {
  return {
    ...settings,
    apis: {
      ...settings?.apis,
      custom: (settings?.apis?.custom || []).map(api => ({
        ...api,
        type: normalizeCustomApiType(api?.type)
      }))
    }
  }
}

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
      openai: {
        apiKey: '',
        imageGeneration: {
          url: 'https://api.openai.com/v1/images/generations',
          headers: {
            Authorization: 'Bearer {apiKey}'
          },
          payloadTemplate: {
            model: 'gpt-image-1.5',
            prompt: '{prompt}',
            n: 1,
            size: '1024x1024'
          },
          models: {
            openai_gpt_image_1: {
              name: 'gpt-image-1',
              model: 'gpt-image-1'
            },
            openai_gpt_image_1_5: {
              name: 'gpt-image-1.5',
              model: 'gpt-image-1.5'
            }
          },
          responseMapping: {
            imageBase64Field: 'data[0].b64_json',
            createdField: 'created',
            usageField: 'usage'
          }
        },
        imageEdit: {
          url: 'https://api.openai.com/v1/images/edits',
          headers: {
            Authorization: 'Bearer {apiKey}'
          },
          payloadTemplate: {
            model: 'gpt-image-1.5',
            prompt: '{prompt}',
            size: '1024x1024'
          },
          models: {
            openai_gpt_image_1: {
              name: 'gpt-image-1',
              model: 'gpt-image-1'
            },
            openai_gpt_image_1_5: {
              name: 'gpt-image-1.5',
              model: 'gpt-image-1.5'
            }
          },
          responseMapping: {
            imageBase64Field: 'data[0].b64_json',
            createdField: 'created',
            usageField: 'usage'
          }
        }
      },
      comfyui: {
        path: '',
        url: 'http://127.0.0.1',
        port: '8188'
      },
      custom: []
    }
  })
  const [loading, setLoading] = useState(true)

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/settings`)
      if (res.ok) {
        const data = await res.json()
        setSettings(normalizeSettings(data))
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
      const normalizedSettings = normalizeSettings(newSettings)
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(normalizedSettings)
      })
      const data = await res.json()
      const normalizedData = normalizeSettings(data)
      setSettings(normalizedData)
      return normalizedData
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
        custom: [...(settings.apis.custom || []), { ...api, id: Date.now(), type: normalizeCustomApiType(api?.type) }]
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

