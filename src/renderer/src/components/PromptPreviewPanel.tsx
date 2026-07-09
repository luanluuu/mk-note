import { useEffect, useRef, useState } from 'react'
import type { PromptStyle, AnalysisResult, Ambiguity, ClarificationAnswer } from '../types'
import { hasSemanticChange } from '../lib/semanticDiff'

/** A semantic search hit from the vault embedding index. */
interface RagHit {
  path: string
  title: string
  score: number
}

interface PromptPreviewPanelProps {
  /** Current editor content (markdown source). */
  content: string
  /** Active note path — used as the cache key so re-entering a note feels instant. */
  notePath: string | null
  /** Look up a cached prompt for this note+content+style+ctx. Returns undefined if miss. */
  getCachedPrompt: (path: string, content: string, style: PromptStyle, ctx: string | null) => string | undefined
  /** Store a freshly generated prompt so it can be replayed on re-entry. */
  onPromptCached: (path: string, content: string, style: PromptStyle, ctx: string | null, prompt: string) => void
  /** Apply AI-generated structured prompt back into the editor. */
  onApply: (text: string) => void
  /** Called when user dismisses the panel. */
  onClose: () => void
  /** Optional project context string (null/undefined = reference off). */
  projectContext?: string | null
  /** Semantic search over the vault's embedding index. When provided,
   *  top-k related notes are retrieved and injected into the analysis +
   *  generation system prompt as RAG context (cross-note reference). */
  ragSearch?: (query: string, k?: number) => Promise<RagHit[]>
}

type State =
  | { kind: 'idle' }
  | { kind: 'analyzing' }
  | { kind: 'awaiting-clarification'; analysis: AnalysisResult; answers: Record<string, string> }
  | { kind: 'generating' }
  | { kind: 'streaming'; text: string; analysis: AnalysisResult | null; reasoning: string }
  | { kind: 'done'; text: string; analysis: AnalysisResult | null; reasoning: string }
  | { kind: 'error'; message: string }

const DEBOUNCE_MS = 600
const MIN_LENGTH = 15
// Analysis-phase progress stages. Each shows for STAGE_MS before rotating,
// giving the user a sense that the model is working through distinct steps
// rather than hanging on a frozen spinner.
const STAGE_MS = 2000
// Threshold (ms) after which we show a "skip analysis" escape hatch — the
// user shouldn't be trapped waiting if the model is slow.
const SLOW_ANALYSIS_MS = 8000
const ANALYZE_STAGES = [
  { title: '正在理解输入', sub: '解析用户描述的关键信息' },
  { title: '正在分析项目', sub: '关联相关文件与技术栈' },
  { title: '正在推断意图', sub: '挖掘表层文字背后的真实需求' },
  { title: '正在识别用户领域', sub: '判断专业背景与资料需求' },
  { title: '正在联网检索', sub: '获取专业资料补充上下文' },
  { title: '正在识别模糊点', sub: '确定需要澄清的关键决策' }
]

const STYLE_OPTIONS: { value: PromptStyle; label: string; title: string }[] = [
  { value: 'concise', label: '简洁', title: '极致压缩，每节一两句话' },
  { value: 'detailed', label: '详尽', title: '充分展开，约束具体可执行' },
  { value: 'cot', label: '思维链', title: '引导 AI 分步推理' },
  { value: 'fewshot', label: '少样本', title: '给出 2 个 input/output 示例' }
]

/** Escape HTML special chars to prevent injection from model output. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Apply inline markdown: **bold** and `code`. Input must already be escaped. */
function applyInline(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/** Minimal markdown → HTML for the preview body. Supports headings (h1-h3),
 *  bold, inline code, fenced code blocks, unordered lists, and hr. */
function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split('\n')
  const out: string[] = []
  let inCode = false
  let inList = false
  let codeBuf: string[] = []

  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const line of lines) {
    // Fenced code block toggle.
    if (/^```/.test(line)) {
      if (!inCode) {
        closeList()
        inCode = true
        codeBuf = []
      } else {
        out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
        inCode = false
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    // Horizontal rule (--- / ---- / etc.).
    if (/^\s*-{3,}\s*$/.test(line)) {
      closeList()
      out.push('<hr />')
      continue
    }
    // Headings.
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length
      out.push(`<h${level}>${applyInline(h[2])}</h${level}>`)
      continue
    }
    // Unordered list item.
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${applyInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    // Blank line ends a list/paragraph.
    if (line.trim() === '') {
      closeList()
      continue
    }
    // Plain paragraph.
    closeList()
    out.push(`<p>${applyInline(line)}</p>`)
  }
  closeList()
  if (inCode) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`)
  return out.join('')
}

/** Rough token estimate: CJK chars ≈ 1.5 tokens, other chars ≈ 0.25 tokens. */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u30ff]/g) || []).length
  const other = text.length - cjk
  return Math.round(cjk * 1.5 + other / 4)
}

/**
 * Floating panel that converts plain-language input into a structured prompt
 * in real time. Streams the model's output token-by-token so the user sees
 * text appear immediately rather than waiting for the full response. Cancels
 * in-flight requests when new input arrives.
 */
export function PromptPreviewPanel({ content, notePath, getCachedPrompt, onPromptCached, onApply, onClose, projectContext, ragSearch }: PromptPreviewPanelProps): JSX.Element {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [collapsed, setCollapsed] = useState(false)
  const [style, setStyle] = useState<PromptStyle>('detailed')
  // User's natural-language feedback on the current round ("太笼统，技术方
  // 案要更具体"). Sent with the next regeneration so the model can fix the
  // specific issues rather than randomly re-rolling.
  const [feedback, setFeedback] = useState('')
  // Analysis-phase progress stage (0-3). Rotates on a timer so the user
  // sees the model "working through" the analysis instead of a static
  // spinner that feels frozen. Reset to 0 whenever analysis starts.
  const [analyzeStage, setAnalyzeStage] = useState(0)
  // True when analysis has taken longer than SLOW_ANALYSIS_MS, showing a
  // "skip analysis" escape hatch so the user isn't trapped waiting.
  const [analyzeSlow, setAnalyzeSlow] = useState(false)
  // Timer IDs for the analysis-phase progress rotation + slow detection.
  // Cleared when analysis completes/fails/aborts so they don't leak.
  const analyzeStageTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const analyzeSlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)
  const lastInputRef = useRef('')
  const lastCtxRef = useRef<string | null>(null)
  const lastStyleRef = useRef<PromptStyle>('detailed')
  // Cancel function for the currently in-flight stream (if any).
  const cancelRef = useRef<(() => void) | null>(null)
  // Set true when the user manually clicks "重新生成" / "开始生成". While
  // true, the auto-run useEffect skips its cache-hit and skip-duplicate
  // short-circuits so they don't clobber the manual regeneration. Cleared
  // after the run completes (onDone/onError).
  const manualGenRef = useRef(false)
  // Remember the last notePath so we can detect note switches and clear the
  // backend's multi-round context + local feedback when the user moves to a
  // different note.
  const lastNotePathRef = useRef<string | null>(null)
  // Cached RAG context for the current analysis round. Built once in
  // analyze() and reused by run() so the generation phase sees the same
  // reference material the analysis did (consistency). Cleared on note
  // switch. Regenerated on manual retry (content may have changed).
  const ragContextRef = useRef('')

  // Set true after the entrance animation finishes, so subsequent className
  // changes (e.g. toggling is-dragging) don't replay the stageIn animation.
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setEntered(true), 280)
    return (): void => clearTimeout(t)
  }, [])

  // Clear multi-round context when switching to a different note. The backend
  // keeps a per-notePath context Map; without this cleanup, regenerating in
  // note B would incorrectly inherit note A's iteration history.
  useEffect(() => {
    if (lastNotePathRef.current !== null && lastNotePathRef.current !== notePath) {
      void window.api.aiStructureResetContext(lastNotePathRef.current)
      setFeedback('')
      ragContextRef.current = ''
    }
    lastNotePathRef.current = notePath
  }, [notePath])

  // After the user applies a result to the note, switch to "manual" mode:
  // stop auto-previewing (the editor now holds the generated prompt, so
  // re-structuring it would be pointless) and show a "开始生成" button that
  // manually triggers a new round based on the current prompt + project.
  const [applied, setApplied] = useState(false)

  // Drag-to-move. We mutate transform directly on the DOM node during the
  // drag (no React state round-trip → no jitter), then commit the final
  // position to state on mouseup.
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragInfoRef = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null)

  const onHeadMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Ignore drags starting on a button (collapse/close).
    if ((e.target as HTMLElement).closest('button')) return
    const panel = panelRef.current
    if (!panel) return
    // Use offsetLeft/offsetTop (relative to offsetParent, same coord system as
    // CSS left/top) — NOT getBoundingClientRect (relative to viewport). Using
    // viewport coords for style.left would offset the panel by the positioned
    // ancestor's offset, causing a jump on the very first click.
    const origLeft = panel.offsetLeft
    const origTop = panel.offsetTop
    dragInfoRef.current = { startX: e.clientX, startY: e.clientY, origLeft, origTop }
    // Pin to current pixel position SYNCHRONOUSLY on the DOM so the panel
    // detaches from the CSS right-anchor without waiting for React to re-render.
    panel.style.left = `${origLeft}px`
    panel.style.top = `${origTop}px`
    panel.style.right = 'auto'
    // Also commit to React state so the position persists across re-renders
    // (e.g. when streaming chunks arrive and the panel re-renders).
    setPos({ left: origLeft, top: origTop })
    setDragging(true)
    e.preventDefault()
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (ev: MouseEvent): void => {
      const info = dragInfoRef.current
      if (!info) return
      const dx = ev.clientX - info.startX
      const dy = ev.clientY - info.startY
      const panel = panelRef.current
      if (!panel) return
      const w = panel.offsetWidth
      const parent = panel.offsetParent as HTMLElement | null
      // Clamp within the offsetParent's coordinate space (fallback to viewport).
      const boundW = parent?.clientWidth ?? window.innerWidth
      const boundH = parent?.clientHeight ?? window.innerHeight
      let left = Math.max(0, Math.min(info.origLeft + dx, boundW - w))
      let top = Math.max(0, Math.min(info.origTop + dy, boundH - 40))
      // Mutate the DOM directly during the drag for zero-latency feedback.
      panel.style.left = `${left}px`
      panel.style.top = `${top}px`
      panel.style.right = 'auto'
    }
    const onUp = (): void => {
      // Commit the final position to React state.
      const panel = panelRef.current
      if (panel) {
        const left = parseFloat(panel.style.left) || 0
        const top = parseFloat(panel.style.top) || 0
        setPos({ left, top })
      }
      setDragging(false)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  useEffect(() => {
    // Manual mode (after applying): don't auto-trigger, wait for the user
    // to press "开始生成".
    if (applied) return
    // Skip if content too short — no point structuring a half-sentence.
    if (content.trim().length < MIN_LENGTH) {
      setState({ kind: 'idle' })
      lastInputRef.current = ''
      return
    }
    const ctx = projectContext ?? null

    // If the user manually clicked "重新生成" / "开始生成", the in-flight run
    // owns the state — don't let the auto-run effect clobber it.
    if (manualGenRef.current) return

    // Cache hit: if we already generated a prompt for this note and the
    // content/style/ctx all match, show it instantly — no loading state,
    // no AI round-trip. This is what makes re-entering a note feel instant.
    if (notePath) {
      const cached = getCachedPrompt(notePath, content, style, ctx)
      if (cached !== undefined) {
        setState({ kind: 'done', text: cached, analysis: null, reasoning: '' })
        lastInputRef.current = content
        lastCtxRef.current = ctx
        lastStyleRef.current = style
        return
      }
    }

    // Skip if neither content, context, nor style changed since last run.
    // Semantic comparison: trivial edits (whitespace, trailing punctuation)
    // don't trigger regeneration. This prevents re-analysis when the user
    // just adds a period or fixes a space.
    if (
      ctx === lastCtxRef.current &&
      style === lastStyleRef.current &&
      !hasSemanticChange(lastInputRef.current, content)
    ) return

    setState({ kind: 'analyzing' })
    const mySeq = ++seqRef.current
    const timer = setTimeout(() => {
      void analyze(content, mySeq, ctx, style)
    }, DEBOUNCE_MS)

    return (): void => {
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, projectContext, applied, style, notePath, getCachedPrompt])

  // Cancel any in-flight stream + clear analysis timers on unmount.
  useEffect(() => {
    return (): void => {
      cancelRef.current?.()
      cancelRef.current = null
      if (analyzeStageTimerRef.current) clearInterval(analyzeStageTimerRef.current)
      if (analyzeSlowTimerRef.current) clearTimeout(analyzeSlowTimerRef.current)
    }
  }, [])

  // Start the analysis-phase progress rotation + slow-detection timer.
  // Called right before invoking aiAnalyze. The progress stage rotates every
  // STAGE_MS so the user sees distinct "working" steps; the slow timer
  // arms the "skip analysis" escape hatch after SLOW_ANALYSIS_MS.
  const startAnalyzeTimers = (): void => {
    setAnalyzeStage(0)
    setAnalyzeSlow(false)
    if (analyzeStageTimerRef.current) clearInterval(analyzeStageTimerRef.current)
    if (analyzeSlowTimerRef.current) clearTimeout(analyzeSlowTimerRef.current)
    analyzeStageTimerRef.current = setInterval(() => {
      setAnalyzeStage((s) => (s + 1) % ANALYZE_STAGES.length)
    }, STAGE_MS)
    analyzeSlowTimerRef.current = setTimeout(() => {
      setAnalyzeSlow(true)
    }, SLOW_ANALYSIS_MS)
  }

  // Clear analysis timers. Called when analysis completes, fails, or is
  // skipped by the user.
  const clearAnalyzeTimers = (): void => {
    if (analyzeStageTimerRef.current) {
      clearInterval(analyzeStageTimerRef.current)
      analyzeStageTimerRef.current = null
    }
    if (analyzeSlowTimerRef.current) {
      clearTimeout(analyzeSlowTimerRef.current)
      analyzeSlowTimerRef.current = null
    }
    setAnalyzeSlow(false)
  }

  // Phase 1: Analyze user input + project context → structured JSON.
  // If analysis succeeds and has ambiguities → awaiting-clarification.
  // If analysis succeeds with no ambiguities → auto-proceed to generation.
  // If analysis fails (null) → fall back to direct generation (legacy).
  //
  // RAG: before calling aiAnalyze, run a semantic search over the vault
  // embedding index using the user's input as query. The top-k related
  // notes (excluding the current one) are read and concatenated into a
  // ragContext string, which is passed to the backend and injected into
  // the system prompt. This gives the model cross-note reference material
  // (e.g. when writing a tender prompt, related tender templates in the
  // vault become available as context).
  const buildRagContext = async (query: string): Promise<string> => {
    if (!ragSearch || query.trim().length < 10) return ''
    try {
      const hits = await ragSearch(query, 6)
      // Exclude the current note — it's already in the user content.
      const filtered = hits.filter((h) => h.path !== notePath && h.score > 0.3)
      if (filtered.length === 0) return ''
      const top = filtered.slice(0, 4)
      const snippets: string[] = []
      for (const h of top) {
        try {
          const body = await window.api.readNote(h.path)
          // Cap each note at 1500 chars to keep the RAG context bounded;
          // 4 notes × 1500 chars = 6000 chars ≈ 3000 tokens of RAG.
          const trimmed = body.length > 1500 ? body.slice(0, 1500) + '\n…（截断）' : body
          snippets.push(`### ${h.title}\n（相似度 ${(h.score * 100).toFixed(0)}%）\n${trimmed}`)
        } catch {
          // skip unreadable notes
        }
      }
      if (snippets.length === 0) return ''
      return `\n\n## 相关笔记素材（RAG 检索）\n以下是从笔记库中检索到的与用户输入语义相关的笔记片段，可在分析意图和生成提示词时作为参考素材：\n\n${snippets.join('\n\n---\n\n')}`
    } catch {
      // RAG is best-effort; silently skip on failure.
      return ''
    }
  }

  const analyze = async (text: string, seq: number, ctx: string | null, st: PromptStyle): Promise<void> => {
    startAnalyzeTimers()
    try {
      const ragCtx = await buildRagContext(text)
      ragContextRef.current = ragCtx
      const result = await window.api.aiAnalyze(text, ctx ?? undefined, ragCtx || undefined)
      clearAnalyzeTimers()
      if (seqRef.current !== seq) return
      if (!result) {
        // Analysis parse failed — fall back to direct generation.
        run(text, seq, ctx, st, false, null, [])
        return
      }
      if (result.ambiguities.length > 0) {
        // Has ambiguities — show Q&A cards, wait for user.
        const defaultAnswers: Record<string, string> = {}
        for (const a of result.ambiguities) {
          defaultAnswers[a.id] = a.options[a.defaultIndex] ?? a.options[0] ?? ''
        }
        setState({ kind: 'awaiting-clarification', analysis: result, answers: defaultAnswers })
      } else {
        // No ambiguities — auto-proceed to generation.
        run(text, seq, ctx, st, false, result, [])
      }
    } catch (err) {
      clearAnalyzeTimers()
      if (seqRef.current !== seq) return
      const msg = err instanceof Error ? err.message : String(err)
      setState({ kind: 'error', message: msg.startsWith('AI_') ? `AI 服务异常：${msg}` : `分析失败：${msg}` })
      manualGenRef.current = false
    }
  }

  // Skip the analysis phase and jump straight to generation. Called when
  // the user clicks "跳过分析" after the slow timer fires, or as an escape
  // hatch if analysis is taking too long.
  const skipAnalysis = (): void => {
    clearAnalyzeTimers()
    const mySeq = ++seqRef.current
    const ctx = projectContext ?? null
    // Direct generation without analysis — uses the legacy one-shot prompt.
    run(content, mySeq, ctx, style, false, null, [])
  }

  // Phase 3: Generate the final prompt. Streams token-by-token. When
  // `analysis` + `answers` are provided, the backend uses the generation
  // system prompt (aware of inferred intent + clarification).
  // `notePath` + `feedback` enable multi-round iteration: the backend keeps
  // a per-note context Map, and on regeneration feeds prior output + user
  // feedback back so the model iterates instead of re-rolling.
  const run = (
    text: string,
    seq: number,
    ctx: string | null,
    st: PromptStyle,
    regenerate = false,
    analysis: AnalysisResult | null = null,
    answers: ClarificationAnswer[] = [],
    feedback?: string
  ): void => {
    cancelRef.current?.()
    cancelRef.current = null

    // Immediately enter the generating state as a transitional loading
    // indicator. Without this, the UI stays on the previous screen (e.g.
    // the clarification Q&A cards) until the first stream chunk arrives —
    // which can take 3-8s, making the user think the click did nothing.
    // The generating state shows a "正在生成提示词" spinner, distinct from
    // the analyzing state's staged progress (analysis is already done).
    // When the first chunk arrives, applyChunk() flips to 'streaming'.
    setState({ kind: 'generating' })

    const startTime = performance.now()
    const MIN_LOADING_MS = regenerate ? 180 : 500
    let firstChunkApplied = false
    // Accumulated reasoning text (DeepSeek-R1 / o1 thinking tokens). Kept in
    // a ref so applyChunk + onDone can both read it without prop-drilling.
    let reasoningText = ''

    const applyChunk = (full: string): void => {
      if (seqRef.current !== seq) return
      if (firstChunkApplied) {
        setState({ kind: 'streaming', text: full, analysis, reasoning: reasoningText })
        return
      }
      const elapsed = performance.now() - startTime
      if (elapsed >= MIN_LOADING_MS) {
        firstChunkApplied = true
        setState({ kind: 'streaming', text: full, analysis, reasoning: reasoningText })
      } else {
        setTimeout(() => {
          if (seqRef.current !== seq) return
          firstChunkApplied = true
          setState({ kind: 'streaming', text: full, analysis, reasoning: reasoningText })
        }, MIN_LOADING_MS - elapsed)
      }
    }

    const cancel = window.api.aiStructureStream(
      text,
      {
        onChunk: (full) => applyChunk(full),
        onReasoning: (r) => {
          if (seqRef.current !== seq) return
          reasoningText = r
          // If we're already streaming, update the reasoning block live so
          // the user sees the thinking process unfold in real time.
          setState((prev) =>
            prev.kind === 'streaming' ? { ...prev, reasoning: r } : prev
          )
        },
        onDone: (full, reasoning) => {
          if (seqRef.current !== seq) return
          lastInputRef.current = text
          lastCtxRef.current = ctx
          lastStyleRef.current = st
          const finalReasoning = reasoning || reasoningText
          const finish = (): void => {
            setState({ kind: 'done', text: full || '（模型未返回内容）', analysis, reasoning: finalReasoning })
            if (notePath) {
              onPromptCached(notePath, text, st, ctx, full || '')
            }
            cancelRef.current = null
            manualGenRef.current = false
          }
          if (!firstChunkApplied) {
            const elapsed = performance.now() - startTime
            if (elapsed < MIN_LOADING_MS) {
              setTimeout(() => { if (seqRef.current === seq) finish() }, MIN_LOADING_MS - elapsed)
              return
            }
          }
          finish()
        },
        onError: (msg) => {
          if (seqRef.current !== seq) return
          setState({
            kind: 'error',
            message: msg.startsWith('AI_') ? `AI 服务异常：${msg}` : `转换失败：${msg}`
          })
          cancelRef.current = null
          manualGenRef.current = false
        }
      },
      ctx ?? undefined,
      st,
      regenerate,
      analysis,
      answers,
      notePath ?? undefined,
      feedback,
      ragContextRef.current || undefined
    )
    cancelRef.current = cancel
  }

  // User confirmed clarification answers → proceed to generation.
  const confirmClarification = (): void => {
    if (state.kind !== 'awaiting-clarification') return
    const mySeq = ++seqRef.current
    const ctx = projectContext ?? null
    const answers: ClarificationAnswer[] = state.analysis.ambiguities.map(
      (a) => ({ id: a.id, answer: state.answers[a.id] ?? '' })
    )
    run(content, mySeq, ctx, style, false, state.analysis, answers)
  }

  const manualRetry = (feedback?: string): void => {
    // Mark this as a manual regeneration so the auto-run useEffect doesn't
    // clobber the loading/streaming state with a cache hit.
    manualGenRef.current = true
    const mySeq = ++seqRef.current
    const ctx = projectContext ?? null
    // Re-use the existing analysis (if any) so we don't re-run the full
    // analyze → clarify flow. Just re-generate with higher temperature so
    // the output is genuinely different from the last attempt.
    const existingAnalysis = state.kind === 'done' || state.kind === 'streaming' ? state.analysis : null
    if (existingAnalysis) {
      // Skip analysis — regenerate directly with the existing understanding.
      const answers: ClarificationAnswer[] = existingAnalysis.ambiguities.map(
        (a) => ({ id: a.id, answer: a.options[a.defaultIndex] ?? a.options[0] ?? '' })
      )
      // run() immediately enters the 'analyzing' state as a transitional
      // loading indicator, so no need to setState here.
      // Pass feedback so the backend can attach it to the prior round and
      // feed it into the next generation as an improvement directive.
      run(content, mySeq, ctx, style, true, existingAnalysis, answers, feedback)
    } else {
      // No existing analysis — run the full flow.
      setState({ kind: 'analyzing' })
      void analyze(content, mySeq, ctx, style)
    }
  }

  // Manual trigger from the "开始生成" button (post-apply mode). Runs the
  // full analyze → clarify → generate flow on the current content.
  const startGenerate = (): void => {
    manualGenRef.current = true
    setApplied(false)
    const mySeq = ++seqRef.current
    const ctx = projectContext ?? null
    setState({ kind: 'analyzing' })
    void analyze(content, mySeq, ctx, style)
  }

  const handleApply = (text: string): void => {
    onApply(text)
    // Enter manual mode: show "开始生成" instead of auto-previewing.
    setApplied(true)
    setState({ kind: 'idle' })
    cancelRef.current?.()
    cancelRef.current = null
  }

  return (
    <div
      ref={panelRef}
      className={`prompt-preview${entered ? ' has-entered' : ''}${dragging ? ' is-dragging' : ''}`}
      style={pos ? { left: pos.left, top: pos.top, right: 'auto' } : undefined}
    >
      <div className="prompt-preview__head" onMouseDown={onHeadMouseDown}>
        <span className="prompt-preview__title">
          <span className="prompt-preview__title-dot" />
          {collapsed ? '结构化预览' : '✨ 结构化 Prompt 预览'}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className="prompt-preview__close"
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开' : '收起'}
            aria-label={collapsed ? '展开' : '收起'}
          >
            {collapsed ? '▾' : '▴'}
          </button>
          <button className="prompt-preview__close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
      </div>

      {!collapsed && (
        <div className="prompt-preview__styles">
          {STYLE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`prompt-preview__style-chip${style === opt.value ? ' is-active' : ''}`}
              onClick={() => setStyle(opt.value)}
              title={opt.title}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {!collapsed && (
        <div className="prompt-preview__scroll">
          {state.kind === 'idle' && !applied && (
            <div className="prompt-preview__hint">
              继续输入…（{MIN_LENGTH} 字以上自动分析）
            </div>
          )}
          {state.kind === 'idle' && applied && (
            <div className="prompt-preview__applied">
              <div className="prompt-preview__applied-hint">✓ 已应用到笔记</div>
              <button className="prompt-preview__start" onClick={startGenerate}>
                <span className="prompt-preview__start-glyph" aria-hidden>✦</span>
                <span>开始生成</span>
              </button>
              <div className="prompt-preview__applied-sub">
                基于当前 prompt{projectContext ? ' + 项目上下文' : ''}迭代优化
              </div>
            </div>
          )}
          {state.kind === 'analyzing' && (
            <div className="prompt-preview__analyzing">
              <div className="prompt-preview__analyzing-spinner" aria-hidden />
              <div className="prompt-preview__analyzing-text">
                <div className="prompt-preview__analyzing-title">
                  {ANALYZE_STAGES[analyzeStage].title}
                </div>
                <div className="prompt-preview__analyzing-sub">
                  {ANALYZE_STAGES[analyzeStage].sub}
                </div>
              </div>
              {analyzeSlow && (
                <button
                  className="prompt-preview__skip-btn"
                  onClick={skipAnalysis}
                  title="跳过分析阶段，直接开始生成"
                >
                  跳过分析，直接生成
                </button>
              )}
            </div>
          )}
          {state.kind === 'generating' && (
            <div className="prompt-preview__analyzing">
              <div className="prompt-preview__analyzing-spinner" aria-hidden />
              <div className="prompt-preview__analyzing-text">
                <div className="prompt-preview__analyzing-title">正在生成提示词</div>
                <div className="prompt-preview__analyzing-sub">基于分析与澄清结果输出</div>
              </div>
            </div>
          )}
          {state.kind === 'awaiting-clarification' && (
            <div className="prompt-preview__clarify">
              {/* Analysis cards: project understanding + intent inference */}
              {state.analysis.projectAnalysis.hasProject && (
                <div className="prompt-preview__card">
                  <div className="prompt-preview__card-title">项目理解</div>
                  {state.analysis.projectAnalysis.techStack && (
                    <div className="prompt-preview__card-row">
                      <span className="prompt-preview__card-label">技术栈</span>
                      <span>{state.analysis.projectAnalysis.techStack}</span>
                    </div>
                  )}
                  {state.analysis.projectAnalysis.insight && (
                    <div className="prompt-preview__card-row">
                      <span className="prompt-preview__card-label">架构理解</span>
                      <span>{state.analysis.projectAnalysis.insight}</span>
                    </div>
                  )}
                  {state.analysis.projectAnalysis.relevantFiles && state.analysis.projectAnalysis.relevantFiles.length > 0 && (
                    <div className="prompt-preview__card-row">
                      <span className="prompt-preview__card-label">相关文件</span>
                      <div className="prompt-preview__card-files">
                        {state.analysis.projectAnalysis.relevantFiles.map((f, i) => (
                          <div key={i} className="prompt-preview__card-file">
                            <code>{f.path}</code>
                            <span className="prompt-preview__card-file-reason">{f.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="prompt-preview__card">
                <div className="prompt-preview__card-title">意图解读</div>
                <div className="prompt-preview__card-row">
                  <span className="prompt-preview__card-label">字面需求</span>
                  <span>{state.analysis.intentAnalysis.surface}</span>
                </div>
                <div className="prompt-preview__card-row prompt-preview__card-row--highlight">
                  <span className="prompt-preview__card-label">推断意图</span>
                  <span>{state.analysis.intentAnalysis.inferred}</span>
                </div>
                <div className="prompt-preview__card-row">
                  <span className="prompt-preview__card-label">推理依据</span>
                  <span className="prompt-preview__card-reasoning">{state.analysis.intentAnalysis.reasoning}</span>
                </div>
              </div>
              {/* User domain profile — shows the inferred professional context */}
              <div className="prompt-preview__card">
                <div className="prompt-preview__card-title">用户画像</div>
                <div className="prompt-preview__card-row">
                  <span className="prompt-preview__card-label">领域</span>
                  <span>{state.analysis.userProfile.roleLabel}</span>
                </div>
                <div className="prompt-preview__card-row">
                  <span className="prompt-preview__card-label">专业度</span>
                  <span>{state.analysis.userProfile.expertise}</span>
                </div>
                <div className="prompt-preview__card-row">
                  <span className="prompt-preview__card-label">推断依据</span>
                  <span className="prompt-preview__card-reasoning">{state.analysis.userProfile.reasoning}</span>
                </div>
              </div>
              {/* Retrieved web resources — shows what was found online */}
              {state.analysis.searchResults.length > 0 && (
                <div className="prompt-preview__card">
                  <div className="prompt-preview__card-title">联网检索资料（{state.analysis.searchResults.length} 条）</div>
                  {state.analysis.searchResults.map((r, i) => (
                    <a key={i} className="prompt-preview__search-item" href={r.url} target="_blank" rel="noopener noreferrer" title={r.url}>
                      <div className="prompt-preview__search-title">{r.title}</div>
                      <div className="prompt-preview__search-snippet">{r.snippet}</div>
                      <div className="prompt-preview__search-query">检索词：{r.query}</div>
                    </a>
                  ))}
                </div>
              )}
              {state.analysis.assumptions.length > 0 && (
                <div className="prompt-preview__card">
                  <div className="prompt-preview__card-title">已做假设</div>
                  <ul className="prompt-preview__card-list">
                    {state.analysis.assumptions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {/* Clarification Q&A */}
              <div className="prompt-preview__card prompt-preview__card--clarify">
                <div className="prompt-preview__card-title">需要确认{state.analysis.ambiguities.length > 1 ? `（${state.analysis.ambiguities.length} 个问题）` : ''}</div>
                {state.analysis.ambiguities.map((amb) => (
                  <div key={amb.id} className="prompt-preview__qa">
                    <div className="prompt-preview__qa-question">{amb.question}</div>
                    <div className="prompt-preview__qa-reason">{amb.reason}</div>
                    <div className="prompt-preview__qa-options">
                      {amb.options.map((opt, i) => (
                        <button
                          key={i}
                          className={`prompt-preview__qa-chip${state.answers[amb.id] === opt ? ' is-selected' : ''}`}
                          onClick={() => {
                            if (state.kind !== 'awaiting-clarification') return
                            setState({ ...state, answers: { ...state.answers, [amb.id]: opt } })
                          }}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                    <input
                      className="prompt-preview__qa-input"
                      placeholder="或自定义…"
                      value={state.answers[amb.id]?.startsWith('__custom:') ? state.answers[amb.id].slice(9) : ''}
                      onChange={(e) => {
                        if (state.kind !== 'awaiting-clarification') return
                        setState({ ...state, answers: { ...state.answers, [amb.id]: e.target.value ? `__custom:${e.target.value}` : amb.options[amb.defaultIndex] } })
                      }}
                    />
                  </div>
                ))}
                <button className="prompt-preview__confirm" onClick={confirmClarification}>
                  确认生成
                </button>
              </div>
            </div>
          )}
          {(state.kind === 'streaming' || state.kind === 'done') && (
            <>
              {/* Analysis cards (collapsed) shown above the prompt body so the
                  user can see the reasoning that led to this prompt. */}
              {state.analysis && (
                <details className="prompt-preview__analysis-summary">
                  <summary>意图解读：{state.analysis.intentAnalysis.inferred.slice(0, 60)}{state.analysis.intentAnalysis.inferred.length > 60 ? '…' : ''}</summary>
                  <div className="prompt-preview__card prompt-preview__card--inline">
                    {state.analysis.intentAnalysis.surface && (
                      <div className="prompt-preview__card-row">
                        <span className="prompt-preview__card-label">字面需求</span>
                        <span>{state.analysis.intentAnalysis.surface}</span>
                      </div>
                    )}
                    <div className="prompt-preview__card-row prompt-preview__card-row--highlight">
                      <span className="prompt-preview__card-label">推断意图</span>
                      <span>{state.analysis.intentAnalysis.inferred}</span>
                    </div>
                    <div className="prompt-preview__card-row">
                      <span className="prompt-preview__card-label">推理依据</span>
                      <span className="prompt-preview__card-reasoning">{state.analysis.intentAnalysis.reasoning}</span>
                    </div>
                    <div className="prompt-preview__card-row">
                      <span className="prompt-preview__card-label">用户画像</span>
                      <span>{state.analysis.userProfile.roleLabel} · {state.analysis.userProfile.expertise}</span>
                    </div>
                    {state.analysis.searchResults.length > 0 && (
                      <div className="prompt-preview__card-row">
                        <span className="prompt-preview__card-label">检索资料</span>
                        <span>{state.analysis.searchResults.length} 条联网资料已作为生成上下文</span>
                      </div>
                    )}
                  </div>
                </details>
              )}
              {/* Reasoning block (DeepSeek-R1 / o1 thinking tokens). Collapsed
                  by default so it doesn't distract from the prompt body, but
                  openable to inspect the model's reasoning process — useful
                  for judging whether the analysis was on the right track.
                  Only shown when the model actually emitted reasoning. */}
              {state.reasoning.trim().length > 0 && (
                <details className="prompt-preview__reasoning">
                  <summary>思考过程 · {state.reasoning.length} 字 {state.kind === 'streaming' ? '（生成中…）' : ''}</summary>
                  <div className="prompt-preview__reasoning-body">{state.reasoning}</div>
                </details>
              )}
              <div
                className="prompt-preview__body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(state.text) }}
              />
              {state.kind === 'streaming' && (
                <span className="prompt-preview__cursor" aria-hidden>▋</span>
              )}
              {state.kind === 'done' && (
                <>
                  <div className="prompt-preview__meta">
                    {state.text.length} 字 · ~{estimateTokens(state.text)} tokens
                  </div>
                  {/* Feedback input for multi-round iteration. The user writes
                      what's wrong with this round; the next regeneration
                      carries this feedback so the model fixes the specific
                      issues instead of re-rolling randomly. */}
                  <div className="prompt-preview__feedback">
                    <input
                      type="text"
                      className="prompt-preview__feedback-input"
                      placeholder="告诉 AI 这一轮哪里不满意（可选，留空则随机变体）"
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          const fb = feedback.trim()
                          setFeedback('')
                          manualRetry(fb)
                        }
                      }}
                    />
                  </div>
                  <div className="prompt-preview__actions">
                    <button onClick={() => void navigator.clipboard?.writeText(state.text)}>复制</button>
                    <button
                      title="重新基于当前内容生成（会带上左侧反馈）"
                      onClick={(): void => {
                        const fb = feedback.trim()
                        setFeedback('')
                        manualRetry(fb)
                      }}
                    >
                      重新生成
                    </button>
                    <button className="button--primary" onClick={() => handleApply(state.text)}>
                      应用到笔记
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {state.kind === 'error' && (
            <div className="prompt-preview__error">
              {state.message}
              <div style={{ marginTop: 8 }}>
                <button
                  className="prompt-preview__close"
                  style={{ border: '2px solid var(--black)', padding: '3px 10px' }}
                  onClick={(): void => manualRetry()}
                >
                  重试
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
