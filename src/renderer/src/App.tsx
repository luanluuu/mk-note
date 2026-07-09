import { useCallback, useEffect, useRef, useState } from 'react'
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

      <main className="editor-pane">
        <section className="editor-glass">
          {activePath ? (
            <div className="editor-stage" key={activePath}>
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
