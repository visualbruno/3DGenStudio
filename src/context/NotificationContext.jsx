/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const NotificationContext = createContext(null)
const MAX_NOTIFICATIONS = 30

function createNotificationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `app-notification-${Date.now()}-${Math.round(Math.random() * 1e9)}`
}

function normalizeTone(tone) {
  const value = String(tone || '').trim().toLowerCase()
  if (['success', 'warning', 'error', 'neutral'].includes(value)) {
    return value
  }

  return 'neutral'
}

export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([])

  const addNotification = useCallback((notification = {}) => {
    const nextNotification = {
      id: createNotificationId(),
      title: String(notification.title || 'Notification').trim() || 'Notification',
      message: String(notification.message || '').trim(),
      tone: normalizeTone(notification.tone),
      source: String(notification.source || '').trim(),
      // Optional navigation metadata: lets the notifications panel deep-link
      // back to the project and focus the originating card/graph node on click.
      projectId: notification.projectId ?? null,
      targetId: notification.targetId != null ? String(notification.targetId) : null,
      createdAt: Date.now()
    }

    setNotifications(current => [nextNotification, ...current].slice(0, MAX_NOTIFICATIONS))
    return nextNotification.id
  }, [])

  const removeNotification = useCallback((notificationId) => {
    setNotifications(current => current.filter(item => item.id !== notificationId))
  }, [])

  const clearNotifications = useCallback(() => {
    setNotifications([])
  }, [])

  const value = useMemo(() => ({
    notifications,
    addNotification,
    removeNotification,
    clearNotifications
  }), [notifications, addNotification, removeNotification, clearNotifications])

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotifications must be used within NotificationProvider')
  }

  return context
}
