import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Sidebar } from './components/Sidebar'
import { MarkdownEditor } from './components/MarkdownEditor'
import { EditorAiBar } from './components/EditorAiBar'
import { PromptPreviewPanel } from './components/PromptPreviewPanel'
import { SearchPalette } from './components/SearchPalette'
import { SettingsPanel } from './components/SettingsPanel'
import { useVault } from './hooks/useVault'
import { useTheme } from './hooks/useTheme'
import { useAiMode } from './hooks/useAiMode'
import { useEmbeddings } from './hooks/useEmbeddings'
import type { PromptStyle } from './types'
import { hasSemanticChange } from './lib/semanticDiff'

interface PanelBounds {
  left: number
  right: number
  top: number
  bottom: number
}

interface TextWrapExclusion {
  active: boolean
  side: 'left' | 'right'
  top: number
  width: number
  height: number
}

const PANEL_COLLISION_GAP = 24
const MIN_EDITOR_LINE_WIDTH = 320

function intersects(a: DOMRect, b: PanelBounds): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

function inactiveTextWrap(): TextWrapExclusion {
  return { active: false, side: 'right', top: 0, width: 0, height: 0 }
}

function clampTextWrapWidth(value: number, proseWidth: number): number {
  return Math.max(0, Math.min(value, Math.max(0, proseWidth - MIN_EDITOR_LINE_WIDTH)))
}

function SettingsFabIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

export default function App(): JSX.Element {
  const { vaultPath, notes, openVault, createNote, renameNote, deleteNote } = useVault()
  const { theme, toggle } = useTheme()
  const { aiMode, toggleAiMode } = useAiMode()
  const embeddings = useEmbeddings(vaultPath)
  const [activePath, setActivePath] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorContent, setEditorContent] = useState('')
  const [previewOpen, setPreviewOpen] = useState(true)
  const editorStageRef = useRef<HTMLDivElement>(null)
  const [previewBounds, setPreviewBounds] = useState<PanelBounds | null>(null)
  const [resizeTick, setResizeTick] = useState(0)
  const [scrollTick, setScrollTick] = useState(0)
  // True while an EditorAiBar result panel is open — used to hide the
  // real-time PromptPreviewPanel so the two never compete for the same spot.
  const [aiActionActive, setAiActionActive] = useState(false)
  // Project context string fed into AI calls when "参考项目" is on (null = off).
  const [projectContext, setProjectContext] = useState<string | null>(null)
  // Lifted so EditorAiBar / PromptPreviewPanel can push text back into the editor.
  const applyToEditorRef = useRef<((text: string) => void) | null>(null)

  // Per-note prompt cache. Keyed by note path; value holds the content/style/
  // ctx that produced the prompt so a cache hit can be verified. Lives at App
  // level so it survives note switches (which remount the editor stage via
  // key={activePath}). Re-entering a note whose content hasn't changed shows
  // the cached prompt instantly — no loading state, no AI round-trip.
  const promptCacheRef = useRef(new Map<string, { content: string; style: PromptStyle; ctx: string | null; prompt: string }>())

  const textWrapExclusion = useMemo<TextWrapExclusion>(() => {
    const stage = editorStageRef.current
    const prose = stage?.querySelector('.ProseMirror') as HTMLElement | null
    if (!stage || !prose || !previewBounds) return inactiveTextWrap()
    const proseRect = prose.getBoundingClientRect()
    if (!intersects(proseRect, previewBounds)) return inactiveTextWrap()

    const panelCenter = (previewBounds.left + previewBounds.right) / 2
    const proseCenter = (proseRect.left + proseRect.right) / 2
    const side: TextWrapExclusion['side'] = panelCenter >= proseCenter ? 'right' : 'left'
    const top = Math.max(0, previewBounds.top - proseRect.top - PANEL_COLLISION_GAP)
    const bottom = Math.min(proseRect.bottom, previewBounds.bottom + PANEL_COLLISION_GAP)
    const height = Math.max(0, bottom - proseRect.top - top)
    if (height <= 0) return inactiveTextWrap()

    const rawWidth = side === 'right'
      ? proseRect.right - previewBounds.left + PANEL_COLLISION_GAP
      : previewBounds.right - proseRect.left + PANEL_COLLISION_GAP

    return {
      active: true,
      side,
      top,
      width: clampTextWrapWidth(rawWidth, proseRect.width),
      height
    }
    // resizeTick and scrollTick intentionally force recalculation after viewport
    // or editor scroll changes, because the ProseMirror rect is read from the DOM.
  }, [previewBounds, resizeTick, scrollTick])

  const editorStageStyle = useMemo(() => ({
    '--preview-wrap-side': textWrapExclusion.side,
    '--preview-wrap-top': `${textWrapExclusion.top}px`,
    '--preview-wrap-width': `${textWrapExclusion.width}px`,
    '--preview-wrap-height': `${textWrapExclusion.height}px`
  }) as CSSProperties, [textWrapExclusion])

  const handlePreviewBoundsChange = useCallback((rect: DOMRect | null): void => {
    setPreviewBounds(rect
      ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      : null)
  }, [])

  const getCachedPrompt = useCallback(
    (path: string, content: string, style: PromptStyle, ctx: string | null): string | undefined => {
      const c = promptCacheRef.current.get(path)
      // Semantic comparison: trivial edits (whitespace, trailing punctuation,
      // minor typos) don't invalidate the cache. This prevents regeneration
      // when the user just adds a period or fixes a space.
      if (c && c.style === style && c.ctx === ctx && !hasSemanticChange(c.content, content)) return c.prompt
      return undefined
    },
    []
  )

  const onPromptCached = useCallback(
    (path: string, content: string, style: PromptStyle, ctx: string | null, prompt: string): void => {
      promptCacheRef.current.set(path, { content, style, ctx, prompt })
    },
    []
  )

  // Keep the active selection valid when the notes list changes.
  useEffect(() => {
    if (activePath && !notes.some((n) => n.path === activePath)) {
      setActivePath(null)
    }
  }, [notes, activePath])

  // Re-open the preview panel whenever AI mode turns on or a new note is opened.
  useEffect(() => {
    if (aiMode) setPreviewOpen(true)
  }, [aiMode, activePath])

  useEffect(() => {
    const onResize = (): void => setResizeTick((tick) => tick + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!activePath) return
    const stage = editorStageRef.current
    if (!stage) return
    let cleanup: (() => void) | null = null
    let observer: MutationObserver | null = null
    const attach = (): void => {
      if (cleanup) return
      const root = stage.querySelector('.milkdown-root')
      if (!root) return
      const onScroll = (): void => setScrollTick((tick) => tick + 1)
      root.addEventListener('scroll', onScroll, { passive: true })
      cleanup = () => root.removeEventListener('scroll', onScroll)
      observer?.disconnect()
      observer = null
    }
    attach()
    if (!cleanup) {
      observer = new MutationObserver(attach)
      observer.observe(stage, { childList: true, subtree: true })
    }
    return () => {
      cleanup?.()
      observer?.disconnect()
    }
  }, [activePath])

  const handleCreate = async (): Promise<void> => {
    const note = await createNote('未命名')
    if (note) setActivePath(note.path)
  }

  const handleRename = async (path: string, newName: string): Promise<void> => {
    const note = await renameNote(path, newName)
    if (note && activePath === path) setActivePath(note.path)
  }

  const handleDelete = async (path: string): Promise<void> => {
    if (!window.confirm('确定删除这条笔记？将移入系统回收站。')) return
    await deleteNote(path)
    if (activePath === path) setActivePath(null)
  }

  // Application menu shortcuts (Cmd+N / Cmd+O / Cmd+K) are routed from the main
  // process menu via these channels.
  useEffect(() => {
    const unsubs = [
      window.api.onMenuNew(() => {
        void handleCreate()
      }),
      window.api.onMenuOpenVault(() => {
        void openVault()
      }),
      window.api.onMenuSearch(() => {
        setSearchOpen((v) => !v)
      }),
      window.api.onMenuSettings(() => {
        setSettingsOpen(true)
      })
    ]
    return () => unsubs.forEach((u) => u())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openVault])

  return (
    <div className="app">
      <Sidebar
        vaultPath={vaultPath}
        notes={notes}
        activePath={activePath}
        theme={theme}
        onToggleTheme={toggle}
        aiMode={aiMode}
        onToggleAiMode={toggleAiMode}
        onOpenVault={openVault}
        onSelectNote={setActivePath}
        onCreateNote={handleCreate}
        onRenameNote={handleRename}
        onDeleteNote={handleDelete}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SearchPalette
        vaultPath={vaultPath}
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelectNote={setActivePath}
        embeddings={embeddings}
      />

      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <button
        className="settings-fab"
        type="button"
        title="设置 (Cmd+,)"
        aria-label="打开设置"
        onClick={() => setSettingsOpen(true)}
      >
        <SettingsFabIcon />
      </button>

      <main className="editor-pane">
        <section className="editor-glass">
          {activePath ? (
            <div
              className={`editor-stage${textWrapExclusion.active ? ' has-preview-wrap' : ''}`}
              key={activePath}
              ref={editorStageRef}
              style={editorStageStyle}
            >
              {aiMode && (
                <EditorAiBar
                  notePath={activePath}
                  onApply={(text) => applyToEditorRef.current?.(text)}
                  onActiveChange={setAiActionActive}
                  projectContext={projectContext}
                  onProjectContextChange={setProjectContext}
                  previewOpen={previewOpen}
                  onTogglePreview={() => setPreviewOpen((v) => !v)}
                />
              )}
              {aiMode && previewOpen && !aiActionActive && editorContent.trim().length > 0 && (
                <PromptPreviewPanel
                  content={editorContent}
                  notePath={activePath}
                  getCachedPrompt={getCachedPrompt}
                  onPromptCached={onPromptCached}
                  onApply={(text) => applyToEditorRef.current?.(text)}
                  onClose={() => setPreviewOpen(false)}
                  onBoundsChange={handlePreviewBoundsChange}
                  projectContext={projectContext}
                  ragSearch={embeddings.search}
                />
              )}
              <MarkdownEditor
                path={activePath}
                onContentChange={setEditorContent}
                onApplyRef={applyToEditorRef}
              />
            </div>
          ) : (
            <div className="editor-empty">
              {vaultPath ? (
                <div className="editor-empty__inner">
                  <div className="editor-empty__glyph" aria-hidden="true" />
                  <p>从左侧选择或新建一条笔记，开始书写。</p>
                </div>
              ) : (
                <div className="editor-empty__inner editor-empty__cta">
                  <div className="editor-empty__glyph" aria-hidden="true" />
                  <p>选择一个文件夹作为笔记库，笔记会以 .md 文件保存在其中。</p>
                  <button onClick={openVault}>选择文件夹</button>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
