import { useEffect, useRef, useState } from 'react'
import type { AiAction, AiActionResult, AiStatus, ProjectProgress } from '../types'

interface EditorAiBarProps {
  notePath: string
  /** Apply AI-generated text back into the editor (replaces current content). */
  onApply: (text: string) => void
  /** Notifies parent when an AI action panel is open (for mutual exclusion). */
  onActiveChange?: (active: boolean) => void
  /** Current project context string (null = reference off). Lifted so the
   *  PromptPreviewPanel can share the same context. */
  projectContext: string | null
  /** Parent installs/updates the project context (used by the 参考项目 toggle). */
  onProjectContextChange: (ctx: string | null) => void
  /** Whether the real-time preview panel is currently shown. */
  previewOpen: boolean
  /** Toggle the real-time preview panel open/closed. */
  onTogglePreview: () => void
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading'; action: AiAction }
  | { kind: 'done'; action: AiAction; result: AiActionResult }
  | { kind: 'error'; message: string }

const ACTION_LABELS: Record<AiAction, string> = {
  optimize: '✨ 优化',
  variant: '🔄 变体',
  compress: '📝 精简',
  translate: '🌐 翻译'
}

const ACTION_HINTS: Record<AiAction, string> = {
  optimize: '重写得更清晰、更结构化',
  variant: '生成 3 个不同写法的变体',
  compress: '去冗余，压缩 token',
  translate: '中英互译'
}

export function EditorAiBar({ notePath, onApply, onActiveChange, projectContext, onProjectContextChange, previewOpen, onTogglePreview }: EditorAiBarProps): JSX.Element {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [progress, setProgress] = useState<ProjectProgress | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'idle' })
    setMenuOpen(false)
    void window.api.aiStatus().then((s) => {
      if (!cancelled) setStatus(s)
    })
    void window.api.getProject().then((p) => {
      if (!cancelled) setProjectPath(p)
    })
    return () => {
      cancelled = true
    }
  }, [notePath])

  // Notify parent whenever the result panel opens/closes for mutual exclusion.
  useEffect(() => {
    onActiveChange?.(state.kind !== 'idle')
  }, [state.kind, onActiveChange])

  // Subscribe to project scan/summarize progress events.
  useEffect(() => {
    const unsub = window.api.onProjectProgress((p) => {
      setProgress(p)
      if (p.phase === 'done') {
        // Brief delay then clear the progress indicator.
        setTimeout(() => setProgress(null), 800)
        // Refresh context now that summaries are updated.
        if (projectContext !== null) {
          void window.api.getProjectContext().then((ctx) => onProjectContextChange(ctx))
        }
      }
    })
    return unsub
  }, [projectContext, onProjectContextChange])

  // Click outside closes dropdown menus.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) setProjectMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const available = !!status?.available

  const run = async (action: AiAction): Promise<void> => {
    setMenuOpen(false)
    setState({ kind: 'loading', action })
    try {
      const content = await window.api.readNote(notePath)
      const result = await window.api.aiChat(action, content, projectContext ?? undefined)
      setState({ kind: 'done', action, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setState({
        kind: 'error',
        message: msg.startsWith('AI_') ? `AI 服务异常：${msg}` : `执行失败：${msg}`
      })
    }
  }

  const close = (): void => setState({ kind: 'idle' })

  const handleSelectProject = async (): Promise<void> => {
    setProjectMenuOpen(false)
    const p = await window.api.selectProject()
    if (p) {
      setProjectPath(p)
      // Auto-summarize on first selection.
      void runSummarize()
    }
  }

  const handleSelectProjectFile = async (): Promise<void> => {
    setProjectMenuOpen(false)
    const p = await window.api.selectProjectFile()
    if (p) {
      setProjectPath(p)
      // Auto-summarize on first selection.
      void runSummarize()
    }
  }

  const runSummarize = async (): Promise<void> => {
    setProjectMenuOpen(false)
    setProgress({ phase: 'scanning', current: 0, total: 0, file: '' })
    try {
      await window.api.summarizeProject()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setProgress(null)
      console.warn('summarize failed:', msg)
    }
  }

  const handleClearProject = async (): Promise<void> => {
    setProjectMenuOpen(false)
    await window.api.clearProject()
    setProjectPath(null)
    onProjectContextChange(null)
    setProgress(null)
  }

  const toggleReference = async (): Promise<void> => {
    if (projectContext !== null) {
      onProjectContextChange(null)
    } else {
      const ctx = await window.api.getProjectContext()
      onProjectContextChange(ctx)
    }
  }

  const refOn = projectContext !== null
  const busy = progress !== null && progress.phase !== 'done'

  const projectName = projectPath ? projectPath.split(/[\\/]/).pop() : null

  return (
    <>
      <div className="editor-toolbar">
        <span className="editor-toolbar__status">
          {status ? (available ? `${status.models.length}个模型` : 'AI 离线') : ''}
        </span>

        {/* Project button + menu */}
        <div className="editor-toolbar__menu" ref={projectMenuRef}>
          <button
            className="editor-toolbar__btn editor-toolbar__btn--project"
            onClick={() => projectPath && setProjectMenuOpen((v) => !v)}
            disabled={!projectPath}
            title={projectPath ? `参考资料：${projectPath}` : '选择项目目录或资料文件'}
          >
            {busy ? '⏳' : '📁'} {projectName ?? '资料'}
          </button>
          {!projectPath && (
            <>
              <button
                className="editor-toolbar__btn editor-toolbar__btn--select"
                onClick={() => void handleSelectProject()}
                title="选择项目目录"
              >
                目录
              </button>
              <button
                className="editor-toolbar__btn editor-toolbar__btn--select"
                onClick={() => void handleSelectProjectFile()}
                title="选择 PDF / Word / Markdown / 代码文件"
              >
                文件
              </button>
            </>
          )}
          {projectMenuOpen && projectPath && (
            <div className="editor-toolbar__dropdown">
              <div className="editor-toolbar__dropdown-item editor-toolbar__dropdown-item--static">
                <span className="editor-toolbar__dropdown-label" title={projectPath}>{projectName}</span>
              </div>
              <button className="editor-toolbar__dropdown-item" onClick={() => void handleSelectProject()} disabled={busy}>
                <span className="editor-toolbar__dropdown-icon">📁</span>
                <span className="editor-toolbar__dropdown-label">更换目录</span>
              </button>
              <button className="editor-toolbar__dropdown-item" onClick={() => void handleSelectProjectFile()} disabled={busy}>
                <span className="editor-toolbar__dropdown-icon">📄</span>
                <span className="editor-toolbar__dropdown-label">更换文件</span>
              </button>
              <button className="editor-toolbar__dropdown-item" onClick={() => void runSummarize()} disabled={busy}>
                <span className="editor-toolbar__dropdown-icon">🔄</span>
                <span className="editor-toolbar__dropdown-label">重新摘要</span>
              </button>
              <button className="editor-toolbar__dropdown-item" onClick={() => void handleClearProject()}>
                <span className="editor-toolbar__dropdown-icon">✕</span>
                <span className="editor-toolbar__dropdown-label">关闭资料</span>
              </button>
            </div>
          )}
        </div>

        {/* Reference toggle — only when a project is set */}
        {projectPath && (
          <button
            className={`editor-toolbar__btn editor-toolbar__btn--toggle${refOn ? ' is-on' : ''}`}
            onClick={() => void toggleReference()}
            disabled={busy}
            title={refOn ? '参考资料：已开启' : '参考资料：已关闭'}
          >
            🔗 参考{refOn ? ' ✓' : ''}
          </button>
        )}

        {/* Real-time preview toggle */}
        <button
          className={`editor-toolbar__btn editor-toolbar__btn--toggle${previewOpen ? ' is-on' : ''}`}
          onClick={onTogglePreview}
          title={previewOpen ? '实时预览：已开启' : '实时预览：已关闭'}
        >
          👁 预览{previewOpen ? ' ✓' : ''}
        </button>

        {/* AI actions menu */}
        <div className="editor-toolbar__menu" ref={menuRef}>
          <button
            className="editor-toolbar__btn"
            onClick={() => available && setMenuOpen((v) => !v)}
            disabled={!available || state.kind !== 'idle'}
            title={available ? (state.kind !== 'idle' ? '请先关闭当前结果' : 'AI 动作') : 'AI 不可用，请检查设置'}
          >
            {state.kind === 'loading' ? '处理中…' : 'AI ▾'}
          </button>
          {menuOpen && (
            <div className="editor-toolbar__dropdown">
              {(Object.keys(ACTION_LABELS) as AiAction[]).map((a) => (
                <button
                  key={a}
                  className="editor-toolbar__dropdown-item"
                  onClick={() => void run(a)}
                  title={ACTION_HINTS[a]}
                >
                  <span className="editor-toolbar__dropdown-icon">{ACTION_LABELS[a].split(' ')[0]}</span>
                  <span className="editor-toolbar__dropdown-label">{ACTION_LABELS[a].split(' ')[1]}</span>
                  <span className="editor-toolbar__dropdown-hint">{ACTION_HINTS[a]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {progress && progress.phase !== 'done' && (
        <div className="project-progress">
          <div className="project-progress__label">
            {progress.phase === 'scanning' ? '扫描资料文件…' : `摘要中 (${progress.current}/${progress.total || '?'})`}
          </div>
          {progress.total > 0 && (
            <div className="project-progress__bar">
              <div
                className="project-progress__fill"
                style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
              />
            </div>
          )}
          {progress.file && <div className="project-progress__file">{progress.file}</div>}
        </div>
      )}

      {state.kind !== 'idle' && (
        <div className="summary-panel">
          <div className="summary-panel__head">
            <span className="summary-panel__title">
              {state.kind === 'loading' && `${ACTION_LABELS[state.action]} 处理中…`}
              {state.kind === 'done' && `${ACTION_LABELS[state.action]} 结果`}
              {state.kind === 'error' && '出错了'}
            </span>
            <button className="summary-panel__close" onClick={close} aria-label="关闭">✕</button>
          </div>
          {state.kind === 'loading' && (
            <div className="summary-panel__muted">正在调用模型，请稍候…</div>
          )}
          {state.kind === 'error' && (
            <div className="summary-panel__error">{state.message}</div>
          )}
          {state.kind === 'done' && state.result.kind === 'single' && (() => {
            const text = state.result.text
            return (
              <>
                <div className="summary-panel__body">{text}</div>
                <div className="summary-panel__actions">
                  <button onClick={() => void navigator.clipboard?.writeText(text)}>复制</button>
                  <button className="button--primary" onClick={() => { onApply(text); close() }}>
                    应用到笔记
                  </button>
                </div>
              </>
            )
          })()}
          {state.kind === 'done' && state.result.kind === 'multi' && (() => {
            const texts = state.result.texts
            return (
              <div className="summary-panel__body summary-panel__variants">
                {texts.map((t, i) => (
                  <div key={i} className="summary-panel__variant">
                    <div className="summary-panel__variant-head">
                      <span>变体 {i + 1}</span>
                      <div className="summary-panel__variant-actions">
                        <button onClick={() => void navigator.clipboard?.writeText(t)}>复制</button>
                        <button className="button--primary" onClick={() => { onApply(t); close() }}>
                          应用
                        </button>
                      </div>
                    </div>
                    <pre className="summary-panel__variant-text">{t}</pre>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}
    </>
  )
}
