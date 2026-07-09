import { useCallback, useEffect, useState } from 'react'
import type { Theme } from '../types'

/**
 * Theme is owned by the main process (persisted in settings.json) so the app
 * menu and the renderer stay in sync. To avoid a flash on startup the main
 * process injects the current theme via the URL hash (`#theme=dark`); we read
 * that synchronously for the very first paint, then confirm via IPC.
 */
function readHashTheme(): Theme {
  const m = location.hash.match(/theme=(light|dark)/)
  return m ? (m[1] as Theme) : 'light'
}

export function useTheme(): {
  theme: Theme
  toggle: () => void
} {
  const [theme, setThemeState] = useState<Theme>(readHashTheme)

  // Apply the attribute whenever theme changes.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Confirm the initial theme with the main process (in case the hash was
  // stale, e.g. theme changed from the menu while the window was closed).
  useEffect(() => {
    void window.api.getTheme().then(setThemeState)
    const unsub = window.api.onThemeChanged((t) => setThemeState(t))
    return unsub
  }, [])

  const toggle = useCallback((): void => {
    // Optimistically flip the local state; the IPC round-trip will broadcast
    // the authoritative value back via onThemeChanged.
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      void window.api.setTheme(next)
      return next
    })
  }, [])

  return { theme, toggle }
}
