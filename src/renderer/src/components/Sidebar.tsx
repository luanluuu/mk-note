import { useEffect, useRef, useState } from 'react'
import type { NoteMeta, Theme } from '../types'

interface SidebarProps {
  vaultPath: string | null
  notes: NoteMeta[]
  activePath: string | null
  theme: Theme
  aiMode: boolean
  onToggleTheme: () => void
  onToggleAiMode: () => void
  onOpenVault: () => void
  onSelectNote: (path: string) => void
  onCreateNote: () => void
  onRenameNote: (path: string, newName: string) => void
  onDeleteNote: (path: string) => void
  onOpenSearch: () => void
  onOpenSettings: () => void
}

function vaultName(vaultPath: string): string {
  const parts = vaultPath.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || vaultPath
}

function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" strokeLinejoin="round" />
    </svg>
  )
}

function PlusIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

function SunIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.6 12a2 2 0 0 1-2 1.9H7.6a2 2 0 0 1-2-1.9L5 7" />
    </svg>
  )
}

function SettingsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function SparklesIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" fill="currentColor" fillOpacity="0.18" />
      <path d="M5 16l.7 2.1L8 19l-2.3.9L5 22l-.7-2.1L2 19l2.3-.9z" fill="currentColor" fillOpacity="0.12" />
      <path d="M19 14l.6 1.8L21.5 17l-1.9.7L19 19.5l-.6-1.8L16.5 17l1.9-.7z" fill="currentColor" fillOpacity="0.12" />
    </svg>
  )
}

export function Sidebar({
  vaultPath,
  notes,
  activePath,
  theme,
  aiMode,
  onToggleTheme,
  onToggleAiMode,
  onOpenVault,
  onSelectNote,
  onCreateNote,
  onRenameNote,
  onDeleteNote,
  onOpenSearch,
  onOpenSettings
}: SidebarProps): JSX.Element {
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingPath && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingPath])

  const startEditing = (note: NoteMeta): void => {
    setEditingPath(note.path)
    setEditValue(note.title)
  }

  const commitEditing = (note: NoteMeta): void => {
    const next = editValue.trim()
    if (next && next !== note.title) {
      onRenameNote(note.path, next)
    }
    setEditingPath(null)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__brand-mark" aria-hidden="true" />
        <span className="sidebar__brand">Lumen</span>
        <button
          className="sidebar__icon-btn"
          title={theme === 'dark' ? '切换到浅色模式 (Cmd+Shift+D)' : '切换到深色模式 (Cmd+Shift+D)'}
          onClick={onToggleTheme}
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          className={`sidebar__icon-btn${aiMode ? ' sidebar__icon-btn--on' : ''}`}
          title={aiMode ? '关闭 AI 模式' : '开启 AI 模式'}
          onClick={onToggleAiMode}
        >
          <SparklesIcon />
        </button>
        <button className="sidebar__icon-btn" title="搜索 (Cmd+K)" onClick={onOpenSearch}>
          <SearchIcon />
        </button>
        <button className="sidebar__icon-btn" title="选择文件夹" onClick={onOpenVault}>
          <FolderIcon />
        </button>
      </div>

      <div className="sidebar__vault" title={vaultPath ?? ''}>
        {vaultPath ? vaultName(vaultPath) : '未选择文件夹'}
      </div>

      <div className="sidebar__toolbar">
        <button className="sidebar__new-btn" onClick={onCreateNote} disabled={!vaultPath}>
          <PlusIcon />
          <span>新建笔记</span>
        </button>
      </div>

      <ul className="note-list">
        {notes.length === 0 && (
          <li className="note-list__empty">
            {vaultPath ? '还没有笔记，点击上方新建。' : '请先选择一个文件夹。'}
          </li>
        )}
        {notes.map((note, index) => {
          const isActive = note.path === activePath
          const isEditing = note.path === editingPath
          return (
            <li
              key={note.path}
              className={`note-item${isActive ? ' note-item--active' : ''}`}
              style={{ ['--i' as string]: index }}
              onClick={() => !isEditing && onSelectNote(note.path)}
              onDoubleClick={() => startEditing(note)}
            >
              <span className="note-item__dot" aria-hidden="true" />
              {isEditing ? (
                <input
                  ref={inputRef}
                  className="note-item__input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => commitEditing(note)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEditing(note)
                    if (e.key === 'Escape') setEditingPath(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <span className="note-item__title">{note.title}</span>
                  <button
                    className="note-item__delete"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteNote(note.path)
                    }}
                  >
                    <TrashIcon />
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
