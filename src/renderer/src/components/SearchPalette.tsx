import { useEffect, useRef, useState } from 'react'
import type { SearchResult } from '../types'
import type { UseEmbeddings } from '../hooks/useEmbeddings'

type Mode = 'keyword' | 'semantic'

interface SearchPaletteProps {
  vaultPath: string | null
  isOpen: boolean
  onClose: () => void
  onSelectNote: (path: string) => void
  embeddings: UseEmbeddings
}

export function SearchPalette({
  vaultPath,
  isOpen,
  onClose,
  onSelectNote,
  embeddings
}: SearchPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<Mode>('keyword')
  const inputRef = useRef<HTMLInputElement>(null)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setResults([])
      setSelected(0)
      if (searchTimer.current) {
        clearTimeout(searchTimer.current)
        searchTimer.current = null
      }
      return
    }
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || !vaultPath) return
    if (searchTimer.current) clearTimeout(searchTimer.current)

    const q = query.trim()
    if (!q) {
      setResults([])
      setSelected(0)
      setLoading(false)
      return
    }

    setLoading(true)
    // `cancelled` lives in the effect scope so the cleanup below can flip it
    // after the timeout has fired and the in-flight promise is still pending.
    let cancelled = false
    const delay = mode === 'semantic' ? 220 : 120
    searchTimer.current = setTimeout(() => {
      const work =
        mode === 'semantic'
          ? embeddings.search(q, 12).then((hits) =>
              hits.map<SearchResult>((h) => ({
                path: h.path,
                title: h.title,
                snippet: `${Math.round(h.score * 100)}% 相关`
              }))
            )
          : window.api.searchNotes(vaultPath, q, 12)
      work
        .then((list) => {
          if (cancelled) return
          setResults(list)
          setSelected(0)
          setLoading(false)
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
          setLoading(false)
        })
    }, delay)

    return () => {
      cancelled = true
      if (searchTimer.current) {
        clearTimeout(searchTimer.current)
        searchTimer.current = null
      }
    }
  }, [query, vaultPath, isOpen, mode, embeddings])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (results.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelected((i) => (i + 1) % results.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((i) => (i - 1 + results.length) % results.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const r = results[selected]
        if (r) {
          onSelectNote(r.path)
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, onSelectNote, results, selected])

  const highlight = (text: string): JSX.Element => {
    const q = query.trim().toLowerCase()
    if (!q || !text.toLowerCase().includes(q)) return <>{text}</>
    const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, 'gi'))
    return (
      <>
        {parts.map((p, i) =>
          p.toLowerCase() === q ? (
            <mark className="search-palette__mark" key={i}>{p}</mark>
          ) : (
            <span key={i}>{p}</span>
          )
        )}
      </>
    )
  }

  const toggleMode = (): void => {
    setMode((m) => (m === 'keyword' ? 'semantic' : 'keyword'))
    setResults([])
    setSelected(0)
  }

  if (!isOpen) return null

  const modeLabel =
    mode === 'semantic'
      ? embeddings.indexing
        ? `语义 · ${embeddings.status}`
        : `语义 · ${embeddings.indexedCount}篇`
      : '关键词'

  return (
    <div className="search-palette" onClick={onClose}>
      <div className="search-palette__card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-palette__input"
          placeholder={
            !vaultPath
              ? '请先选择文件夹'
              : mode === 'semantic'
                ? '用自然语言描述想找的内容…'
                : '搜索笔记标题或内容…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!vaultPath}
        />
        <div className="search-palette__results">
          {loading && results.length === 0 && (
            <div className="search-palette__empty">
              {mode === 'semantic' ? '正在比对语义…' : '搜索中…'}
            </div>
          )}
          {!loading && query.trim() && results.length === 0 && (
            <div className="search-palette__empty">
              {mode === 'semantic' && embeddings.indexedCount === 0
                ? '语义索引尚未就绪，请稍候'
                : '没有找到相关笔记'}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.path}
              className={`search-palette__item${i === selected ? ' search-palette__item--selected' : ''}`}
              onClick={() => {
                onSelectNote(r.path)
                onClose()
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="search-palette__title">{highlight(r.title || r.path)}</span>
              {r.snippet && (
                <span className="search-palette__snippet">{highlight(r.snippet)}</span>
              )}
            </button>
          ))}
        </div>
        <div className="search-palette__hint">
          <span className="search-palette__hint-text">↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <button
            className={`search-palette__mode${mode === 'semantic' ? ' search-palette__mode--on' : ''}`}
            onClick={toggleMode}
            title="切换 关键词 / 语义 搜索"
          >
            {modeLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
