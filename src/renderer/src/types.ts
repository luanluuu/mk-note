export type Theme = 'light' | 'dark'

export interface NoteMeta {
  path: string
  name: string
  title: string
  mtime: number
}

export type RenameResult =
  | { ok: true; note: NoteMeta }
  | { ok: false; code: 'SOURCE_NOT_FOUND' | 'TARGET_EXISTS' | 'PATH_OUTSIDE_VAULT' }

export interface NoteDoc {
  path: string
  title: string
  content: string
  mtime: number
}

/** 'ollama' uses its native /api/* endpoints (no auth);
 *  'openai' uses any OpenAI-compatible /v1/chat/completions + /v1/models. */
export type AiProvider = 'ollama' | 'openai'

export interface AiConfig {
  provider: AiProvider
  baseUrl: string
  apiKey: string
  model: string
}

export interface AiStatus {
  available: boolean
  models: string[]
}

/** Prompt engineering actions triggered from the editor toolbar. */
export type AiAction = 'optimize' | 'variant' | 'compress' | 'translate'

/** Prompt structuring style — controls how the plain-language input is
 *  rewritten into a structured prompt. */
export type PromptStyle = 'concise' | 'detailed' | 'cot' | 'fewshot'

// --- Analysis-phase types (mirrored in main/index.ts) ---

export interface RelevantFile {
  path: string
  reason: string
}

export interface ProjectAnalysis {
  hasProject: boolean
  relevantFiles?: RelevantFile[]
  techStack?: string
  insight?: string
}

export interface IntentAnalysis {
  surface: string
  inferred: string
  reasoning: string
}

export interface Ambiguity {
  id: string
  question: string
  options: string[]
  defaultIndex: number
  reason: string
}

/** User domain profile — infers the user's professional context so the
 *  generated prompt can use domain-appropriate terminology, depth, and
 *  reference material. */
export interface UserProfile {
  /** Primary domain: programmer, admin, sales, marketing, finance, legal,
   *  education, design, healthcare, other. */
  domain: string
  /** Human-readable label, e.g. "程序员（后端）" / "行政专员". */
  roleLabel: string
  /** Estimated expertise level in this domain: junior / mid / senior / expert. */
  expertise: string
  /** Why this profile was inferred — one sentence citing evidence from input. */
  reasoning: string
}

/** A search query the analysis suggests retrieving for context. */
export interface WebSearchQuery {
  /** The search keyword/phrase, in the user's language. */
  query: string
  /** Why this query is relevant — one sentence. */
  reason: string
}

/** A retrieved web search result item. */
export interface WebSearchResult {
  query: string
  title: string
  snippet: string
  url: string
}

export interface AnalysisResult {
  projectAnalysis: ProjectAnalysis
  intentAnalysis: IntentAnalysis
  userProfile: UserProfile
  searchQueries: WebSearchQuery[]
  /** Search results retrieved after analysis (populated by the backend).
   *  Empty array if no queries or retrieval failed. */
  searchResults: WebSearchResult[]
  ambiguities: Ambiguity[]
  assumptions: string[]
}

export interface ClarificationAnswer {
  id: string
  answer: string
}

/** A single chat-completion style message. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Result of a prompt-engineering action — variant returns multiple. */
export type AiActionResult =
  | { kind: 'single'; text: string }
  | { kind: 'multi'; texts: string[] }

/** A file in an indexed project. */
export interface ProjectFile {
  path: string
  abs: string
  size: number
  mtime: number
}

/** Result of scanning/summarizing a project. */
export interface ProjectScanResult {
  files: ProjectFile[]
  projectPath?: string
}

/** Cached file summary: absolute path → { summary, mtime }. */
export type ProjectCache = Record<string, { summary: string; mtime: number }>

/** Progress event emitted during project scan/summarize. */
export interface ProjectProgress {
  phase: 'scanning' | 'summarizing' | 'done'
  current: number
  total: number
  file: string
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
}

export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  mode?: 'native' | 'manual'
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  notes?: string
  assetName?: string
  assetUrl?: string
  assetSize?: number
  error?: string
}

export interface UpdateDownloadResult {
  filePath?: string
  mode?: 'native' | 'manual'
  error?: string
}

export interface UpdateDownloadProgress {
  phase: 'downloading' | 'opening' | 'done'
  received: number
  total: number | null
  percent: number | null
}

export interface Api {
  selectVault: () => Promise<string | null>
  getLastVault: () => Promise<string | null>
  listNotes: (vaultPath: string) => Promise<NoteMeta[]>
  readAllNotes: (vaultPath: string) => Promise<NoteDoc[]>
  readNote: (notePath: string) => Promise<string>
  writeNote: (notePath: string, content: string) => Promise<void>
  createNote: (vaultPath: string, name: string) => Promise<NoteMeta>
  renameNote: (notePath: string, newName: string) => Promise<RenameResult>
  deleteNote: (notePath: string) => Promise<void>
  searchNotes: (vaultPath: string, query: string, limit?: number) => Promise<SearchResult[]>
  watchVault: (vaultPath: string) => Promise<void>
  onVaultChanged: (cb: () => void) => () => void

  getTheme: () => Promise<Theme>
  setTheme: (theme: Theme) => Promise<Theme>
  onThemeChanged: (cb: (theme: Theme) => void) => () => void

  getUpdateFeedUrl: () => Promise<string>
  setUpdateFeedUrl: (url: string) => Promise<string>
  checkForUpdates: (url?: string) => Promise<UpdateCheckResult>
  getAutoUpdateCheckResult: () => Promise<UpdateCheckResult | null>
  downloadUpdate: (assetUrl: string, assetName: string) => Promise<UpdateDownloadResult>
  downloadNativeUpdate: () => Promise<UpdateDownloadResult>
  onUpdateDownloadProgress: (cb: (progress: UpdateDownloadProgress) => void) => () => void
  onAutoUpdateCheckResult: (cb: (result: UpdateCheckResult) => void) => () => void
  openUpdateUrl: (url: string) => Promise<void>

  getAiConfig: () => Promise<AiConfig>
  setAiConfig: (config: AiConfig) => Promise<AiConfig>
  aiStatus: () => Promise<AiStatus>
  /** Max chars of user content fed to the model (long-context config). */
  getMaxContextChars: () => Promise<number>
  setMaxContextChars: (v: number) => Promise<number>
  aiSummarize: (content: string, model?: string) => Promise<string>
  /** Prompt-engineering action (optimize / variant / compress / translate). */
  aiChat: (action: AiAction, content: string, projectContext?: string) => Promise<AiActionResult>
  /** Real-time structured-prompt preview of plain-language input. */
  aiStructure: (content: string, projectContext?: string) => Promise<string>
  /** Phase 1: Analyze user input + project context → structured JSON.
   *  Returns null if the model output can't be parsed (renderer falls back
   *  to direct generation). */
  aiAnalyze: (content: string, projectContext?: string, ragContext?: string, reqId?: string) => Promise<AnalysisResult | null>
  aiCancelAnalyze: (reqId: string) => Promise<void>
  /** Streaming version of aiStructure — calls onChunk with accumulated text
   *  as tokens arrive, then onDone/onError. Returns a cancel function.
   *  When `analysis` + `answers` are provided, uses the generation system
   *  prompt (aware of inferred intent + clarification). */
  aiStructureStream: (
    content: string,
    handlers: {
      onChunk: (text: string) => void
      onDone: (text: string, reasoning: string) => void
      onError: (msg: string) => void
      /** Reasoning stream (DeepSeek-R1 / o1 thinking tokens). Optional —
       *  only called for models that emit `reasoning_content`. */
      onReasoning?: (text: string) => void
    },
    projectContext?: string,
    style?: PromptStyle,
    regenerate?: boolean,
    analysis?: AnalysisResult | null,
    answers?: ClarificationAnswer[],
    /** Note path — used as the key for per-note multi-round generation
     *  context. When provided, regenerations carry prior output + user
     *  feedback so the model iterates instead of re-rolling. */
    notePath?: string,
    /** User's natural-language feedback on the previous round (e.g.
     *  "太笼统，技术方案要更具体"). Attached to the last round in context. */
    feedback?: string,
    /** RAG context: semantically-retrieved note snippets from the vault
     *  embedding index. Injected into the generation system prompt so the
     *  model has cross-note reference material. */
    ragContext?: string
  ) => () => void
  /** Clear the multi-round generation context for a note. Call when the
   *  user switches notes or starts a brand-new generation. */
  aiStructureResetContext: (notePath?: string) => Promise<void>
  /** Generic chat completion (system + user messages). */
  aiComplete: (messages: ChatMessage[]) => Promise<string>

  // project context
  selectProject: () => Promise<string | null>
  selectProjectFile: () => Promise<string | null>
  getProject: () => Promise<string | null>
  clearProject: () => Promise<void>
  scanProject: () => Promise<ProjectScanResult>
  summarizeProject: () => Promise<{ files: ProjectFile[]; cache: ProjectCache }>
  getProjectCache: () => Promise<ProjectCache>
  getProjectContext: () => Promise<string | null>
  onProjectProgress: (cb: (p: ProjectProgress) => void) => () => void

  saveIndex: (data: unknown) => Promise<void>
  loadIndex: () => Promise<unknown>

  onMenuNew: (cb: () => void) => () => void
  onMenuOpenVault: (cb: () => void) => () => void
  onMenuSearch: (cb: () => void) => () => void
  onMenuSettings: (cb: () => void) => () => void
}

declare global {
  interface Window {
    api: Api
  }
}
