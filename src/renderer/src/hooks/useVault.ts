import { useCallback, useEffect, useState } from 'react'
import type { NoteMeta } from '../types'

export interface VaultState {
  vaultPath: string | null
  notes: NoteMeta[]
  loading: boolean
  openVault: () => Promise<void>
  refresh: () => Promise<void>
  createNote: (name: string) => Promise<NoteMeta | null>
  renameNote: (notePath: string, newName: string) => Promise<NoteMeta | null>
  deleteNote: (notePath: string) => Promise<void>
}

export function useVault(): VaultState {
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [notes, setNotes] = useState<NoteMeta[]>([])
  const [loading, setLoading] = useState(false)

  const loadNotes = useCallback(async (p: string | null) => {
    if (!p) {
      setNotes([])
      return
    }
    setLoading(true)
    try {
      setNotes(await window.api.listNotes(p))
    } catch {
      setNotes([])
    } finally {
      setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => loadNotes(vaultPath), [loadNotes, vaultPath])

  const openVault = useCallback(async () => {
    const picked = await window.api.selectVault()
    if (picked) {
      setVaultPath(picked)
      await window.api.watchVault(picked)
      await loadNotes(picked)
    }
  }, [loadNotes])

  const createNote = useCallback(
    async (name: string) => {
      if (!vaultPath) return null
      const note = await window.api.createNote(vaultPath, name)
      await loadNotes(vaultPath)
      return note
    },
    [loadNotes, vaultPath]
  )

  const renameNote = useCallback(
    async (notePath: string, newName: string) => {
      // IPC now returns a discriminated result; we branch on `code` instead of
      // grepping the localized error message (which used to break whenever the
      // wording changed).
      const result = await window.api.renameNote(notePath, newName)
      await loadNotes(vaultPath)
      return result.ok ? result.note : null
    },
    [loadNotes, vaultPath]
  )

  const deleteNote = useCallback(
    async (notePath: string) => {
      try {
        await window.api.deleteNote(notePath)
      } catch {
        // ignore — it may already be gone externally
      }
      await loadNotes(vaultPath)
    },
    [loadNotes, vaultPath]
  )

  useEffect(() => {
    ;(async () => {
      const last = await window.api.getLastVault()
      if (last) {
        setVaultPath(last)
        await window.api.watchVault(last)
        await loadNotes(last)
      }
    })()
  }, [loadNotes])

  // Listen to external fs changes broadcast from the main process.
  useEffect(() => {
    const unsub = window.api.onVaultChanged(() => {
      void loadNotes(vaultPath)
    })
    return () => {
      unsub()
    }
  }, [loadNotes, vaultPath])

  return {
    vaultPath,
    notes,
    loading,
    openVault,
    refresh,
    createNote,
    renameNote,
    deleteNote
  }
}
