import { join, dirname, resolve, relative, isAbsolute } from 'node:path'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { app, shell, BrowserWindow, ipcMain, dialog, Menu, type MenuItemConstructorOptions, type WebContents } from 'electron'

interface NoteMeta {
  path: string
  name: string
  title: string
  mtime: number
}

type Theme = 'light' | 'dark'

interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

interface AppSettings {
  lastVault?: string
  theme?: Theme
  lastBounds?: WindowBounds
  maximized?: boolean
  aiConfig?: AiConfig
  updateFeedUrl?: string
  projectPath?: string
  /** Max chars of user content fed to the model. Long-context models
   *  (deepseek-v3, qwen2.5-128k) can handle 32k-128k; small local models
   *  should stay at ~8k to avoid OOM. 0 = use default. */
  maxContextChars?: number
}

type AiProvider = 'ollama' | 'openai'
interface AiConfig {
  provider: AiProvider
  baseUrl: string
  apiKey: string
  model: string
}

interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string | null
  hasUpdate: boolean
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  notes?: string
  error?: string
}

const DEFAULT_AI_CONFIG: AiConfig = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  apiKey: '',
  model: 'qwen2.5:7b-instruct'
}
const DEFAULT_UPDATE_FEED_URL = 'luanluuu/mk-note'

let mainWindow: BrowserWindow | null = null
let currentVault: string | null = null

// ---------- settings persistence ----------

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

async function readSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf-8')
    return JSON.parse(raw) as AppSettings
  } catch {
    return {}
  }
}

async function writeSettings(settings: AppSettings): Promise<void> {
  await fs.writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8')
}

// ---------- fs helpers ----------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').trim() || 'Untitled'
}

/**
 * Ensure a note path the renderer asks us to touch is actually inside the
 * currently-opened vault. Without this, any compromise of the renderer (e.g.
 * an XSS via rich-text content) could read/write arbitrary files on disk.
 */
function isInsideVault(notePath: string): boolean {
  if (!currentVault) return false
  const rel = relative(currentVault, resolve(notePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function isCurrentVault(vaultPath: string): boolean {
  return !!currentVault && resolve(vaultPath) === currentVault
}

function assertCurrentVault(vaultPath: string): string {
  if (!isCurrentVault(vaultPath)) throw new Error('PATH_OUTSIDE_VAULT')
  return currentVault as string
}

async function listNotes(vaultPath: string): Promise<NoteMeta[]> {
  const entries = await fs.readdir(vaultPath, { withFileTypes: true })
  const notes: NoteMeta[] = []
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const full = join(vaultPath, entry.name)
      const stat = await fs.stat(full)
      notes.push({
        path: full,
        name: entry.name,
        title: entry.name.replace(/\.md$/i, ''),
        mtime: stat.mtimeMs
      })
    }
  }
  notes.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
  return notes
}

interface SearchResult {
  path: string
  title: string
  snippet: string
}

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[#*_`\[\]()\-{}>\|]/g, ' ')
    .trim()
}

function snippetAround(content: string, term: string, radius = 36): string {
  const text = normalize(content)
  const idx = text.indexOf(term)
  if (idx === -1) return content.slice(0, radius * 2).replace(/\s+/g, ' ')
  const start = Math.max(0, idx - radius)
  const end = Math.min(text.length, idx + term.length + radius)
  let out = (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
  return out
}

async function searchNotes(
  vaultPath: string,
  query: string,
  limit: number
): Promise<SearchResult[]> {
  if (!query) return []
  const term = normalize(query)
  if (!term) return []
  const notes = await listNotes(vaultPath)
  const scored: Array<SearchResult & { score: number }> = []
  for (const note of notes) {
    const titleNorm = normalize(note.title)
    let score = 0
    if (titleNorm === term) score += 100
    else if (titleNorm.startsWith(term)) score += 80
    else if (titleNorm.includes(term)) score += 60
    if (score === 0) {
      try {
        const content = await fs.readFile(note.path, 'utf-8')
        const text = normalize(content)
        if (text.includes(term)) {
          score += 40
          const matches = (text.match(new RegExp(escapeRegExp(term), 'g')) || []).length
          score += Math.min(20, matches * 2)
          scored.push({
            path: note.path,
            title: note.title,
            snippet: snippetAround(content, term),
            score
          })
        }
      } catch {
        // ignore unreadable files
      }
    } else {
      scored.push({ path: note.path, title: note.title, snippet: '', score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ path, title, snippet }) => ({ path, title, snippet }))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------- vault directory watching ----------
// Watch the current vault folder so external changes (create / delete / rename
// in Finder or another editor) are reflected in the app instead of leaving the
// sidebar pointing at stale paths.

let vaultWatcher: FSWatcher | null = null
let watchTimer: ReturnType<typeof setTimeout> | null = null

function stopVaultWatch(): void {
  if (vaultWatcher) {
    vaultWatcher.close()
    vaultWatcher = null
  }
  if (watchTimer) {
    clearTimeout(watchTimer)
    watchTimer = null
  }
}

function startVaultWatch(vaultPath: string): void {
  stopVaultWatch()
  try {
    vaultWatcher = watch(vaultPath, { persistent: false }, () => {
      // debounce bursts of fs events into a single refresh notification
      if (watchTimer) clearTimeout(watchTimer)
      watchTimer = setTimeout(() => {
        mainWindow?.webContents.send('vault:changed')
      }, 150)
    })
  } catch {
    // directory may be unavailable; ignore
  }
}

// ---------- theme ----------

async function getTheme(): Promise<Theme> {
  const settings = await readSettings()
  return settings.theme ?? 'light'
}

async function setTheme(theme: Theme): Promise<void> {
  const settings = await readSettings()
  settings.theme = theme
  await writeSettings(settings)
  mainWindow?.webContents.send('theme:changed', theme)
}

async function toggleTheme(): Promise<void> {
  const next: Theme = (await getTheme()) === 'dark' ? 'light' : 'dark'
  await setTheme(next)
}

// ---------- updates ----------

async function getUpdateFeedUrl(): Promise<string> {
  const settings = await readSettings()
  return settings.updateFeedUrl?.trim() || DEFAULT_UPDATE_FEED_URL
}

async function setUpdateFeedUrl(updateFeedUrl: string): Promise<string> {
  const settings = await readSettings()
  settings.updateFeedUrl = updateFeedUrl.trim()
  await writeSettings(settings)
  return settings.updateFeedUrl
}

function normalizeVersion(version: string): number[] {
  const clean = version.trim().replace(/^v/i, '').split(/[+-]/)[0]
  return clean.split('.').map((part) => {
    const n = Number.parseInt(part.replace(/\D.*$/, ''), 10)
    return Number.isFinite(n) ? n : 0
  })
}

function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a)
  const right = normalizeVersion(b)
  const len = Math.max(left.length, right.length, 3)
  for (let i = 0; i < len; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function githubApiUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  const shorthand = raw.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (shorthand) return `https://api.github.com/repos/${shorthand[1]}/${shorthand[2]}/releases/latest`

  try {
    const url = new URL(raw)
    if (url.hostname === 'api.github.com' && /\/repos\/[^/]+\/[^/]+\/releases\/latest\/?$/.test(url.pathname)) {
      return url.toString()
    }
    if (url.hostname === 'github.com') {
      const [, owner, repo] = url.pathname.split('/')
      if (owner && repo) return `https://api.github.com/repos/${owner}/${repo}/releases/latest`
    }
  } catch {
    return null
  }
  return raw
}

async function checkForUpdates(feedUrl?: string): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const apiUrl = githubApiUrl(feedUrl?.trim() || await getUpdateFeedUrl())
  if (!apiUrl) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      error: 'UPDATE_FEED_NOT_CONFIGURED'
    }
  }

  try {
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Markdown-Notes' },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) {
      return {
        currentVersion,
        latestVersion: null,
        hasUpdate: false,
        error: `UPDATE_CHECK_FAILED (${res.status} ${res.statusText})`
      }
    }
    const data = (await res.json()) as {
      tag_name?: string
      name?: string
      html_url?: string
      published_at?: string
      body?: string
    }
    const latestVersion = data.tag_name ?? null
    return {
      currentVersion,
      latestVersion,
      hasUpdate: !!latestVersion && compareVersions(latestVersion, currentVersion) > 0,
      releaseName: data.name,
      releaseUrl: data.html_url,
      publishedAt: data.published_at,
      notes: data.body ? data.body.slice(0, 1200) : undefined
    }
  } catch (err) {
    return {
      currentVersion,
      latestVersion: null,
      hasUpdate: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

// ---------- AI (Ollama or any OpenAI-compatible endpoint) ----------

interface AiStatus {
  available: boolean
  models: string[]
}

async function getAiConfig(): Promise<AiConfig> {
  const settings = await readSettings()
  return { ...DEFAULT_AI_CONFIG, ...(settings.aiConfig ?? {}) }
}

/** Default max chars of user content fed to the model. 32k chars ≈ 16k
 *  tokens — fits most modern models (deepseek-v3, qwen2.5, gpt-4o) with
 *  room for the system prompt. Users with long-context models (128k) can
 *  raise this in settings; users with small local models can lower it. */
const DEFAULT_MAX_CONTEXT_CHARS = 32768

async function getMaxContextChars(): Promise<number> {
  const settings = await readSettings()
  const v = settings.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS
  return v > 0 ? v : DEFAULT_MAX_CONTEXT_CHARS
}

async function setAiConfig(config: AiConfig): Promise<AiConfig> {
  const settings = await readSettings()
  settings.aiConfig = config
  await writeSettings(settings)
  return config
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/**
 * Normalize a base URL to its bare origin so that appending `/v1/...` always
 * produces the correct path. Tolerates common user mistakes:
 *   https://api.deepseek.com
 *   https://api.deepseek.com/
 *   https://api.deepseek.com/v1
 *   https://api.deepseek.com/v1/
 *   https://api.deepseek.com/v1/chat/completions   ← 用户把完整端点粘进来了
 * All resolve to https://api.deepseek.com
 */
function normalizeBase(raw: string): string {
  return trimSlash(raw).replace(/\/v1(\/chat\/completions)?$/i, '')
}

async function aiStatus(cfg: AiConfig): Promise<AiStatus> {
  const base = normalizeBase(cfg.baseUrl)
  try {
    if (cfg.provider === 'ollama') {
      const res = await fetch(`${base}/api/tags`, {
        signal: AbortSignal.timeout(1500)
      })
      if (!res.ok) return { available: false, models: [] }
      const data = (await res.json()) as { models?: Array<{ name: string }> }
      return { available: true, models: (data.models ?? []).map((m) => m.name) }
    }
    // OpenAI-compatible: GET /v1/models with Bearer auth
    const res = await fetch(`${base}/v1/models`, {
      headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return { available: false, models: [] }
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    return { available: true, models: (data.data ?? []).map((m) => m.id) }
  } catch {
    return { available: false, models: [] }
  }
}

interface ChatMessageDto {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Generic chat completion. Both Ollama and OpenAI-compatible providers route
 * through here. Ollama's /api/chat accepts the same {role, content} shape,
 * so we only need to swap the endpoint and response key.
 */
async function aiComplete(
  messages: ChatMessageDto[],
  cfg: AiConfig,
  modelOverride?: string,
  temperature = 0.4,
  signal?: AbortSignal
): Promise<string> {
  const model = modelOverride || cfg.model
  if (!model) throw new Error('AI_NO_MODEL')
  const base = normalizeBase(cfg.baseUrl)
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
    : AbortSignal.timeout(90000)

  if (cfg.provider === 'ollama') {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options: { temperature } }),
      signal: requestSignal
    })
    if (!res.ok) throw new Error(`AI_FAILED (${res.status} ${res.statusText})`)
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content ?? ''
  }

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify({ model, messages, temperature, stream: false }),
    signal: requestSignal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`AI_FAILED (${res.status} ${res.statusText})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return data.choices?.[0]?.message?.content ?? ''
}

async function aiSummarize(content: string, cfg: AiConfig, modelOverride?: string): Promise<string> {
  const prompt = `请用简洁的中文总结以下笔记的要点，不超过 5 条，每条一句话：\n\n${content.slice(0, 6000)}`
  return aiComplete(
    [
      { role: 'system', content: '你是一个笔记摘要助手，用简洁的中文回答。' },
      { role: 'user', content: prompt }
    ],
    cfg,
    modelOverride,
    0.3
  )
}

// ---------- project context ----------

interface ProjectFile {
  /** Path relative to project root, using forward slashes. */
  path: string
  /** Absolute path on disk. */
  abs: string
  size: number
  mtime: number
}

interface ProjectSummaryEntry {
  summary: string
  mtime: number
}

type ProjectCache = Record<string, ProjectSummaryEntry>

/** Directories that are never useful as AI context. */
const IGNORED_DIRS = new Set([
  // JS/TS ecosystem
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next',
  '.nuxt', '.turbo', '.cache', 'coverage', '.vercel', '.idea', '.vscode',
  '.parcel-cache', '.svelte-kit', '.astro', '.vite',
  'bower_components', 'jspm_packages', '.pnpm-store',
  // Python
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'venv', '.venv', 'site-packages', 'eggs',
  // JVM
  'target', 'build/classes', 'build/libs', '.gradle', 'gradle',
  // Go
  'vendor',
  // Rust
  // (target already in JS list)
  // .NET
  'bin', 'obj', 'packages',
  // iOS / macOS
  'Pods', 'Carthage', 'DerivedData', '.build',
  // Dart / Flutter
  '.dart_tool', '.flutter-plugins',
  // Ruby
  '.bundle', 'vendor/bundle',
  // PHP
  'vendor',
  // Misc
  '.aws', '.terraform', '.serverless'
])

/**
 * File-name patterns that indicate build artifacts / generated files / lock
 * files. These are skipped even when their extension is in SOURCE_EXTS, because
 * their content is machine-generated, huge, and carries no useful structural
 * information for prompt engineering.
 */
const IGNORED_FILE_RE = /^(?:.*\.)?(?:min|bundle|chunk|vendor)\.(?:js|css|mjs|cjs)(?:\.map)?$|\.map$|-lock\.(?:json|yaml|yml)$|^yarn\.lock$|^pnpm-lock\.yaml$|^Cargo\.lock$|^go\.sum$|^composer\.lock$|^Gemfile\.lock$|^poetry\.lock$|^Pipfile\.lock$|^\.gitmodules$/

/** Extensions worth indexing for prompt context. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go',
  '.rs', '.rb', '.php', '.c', '.cpp', '.cc', '.h', '.hpp', '.cs', '.swift',
  '.vue', '.svelte', '.astro', '.md', '.mdx', '.json', '.yaml', '.yml',
  '.toml', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.sh', '.bash',
  '.sql', '.graphql', '.gql', '.proto'
])

const MAX_PROJECT_FILES = 600
// Files larger than this are summarized via structural sampling (extract
// import/export/function/class/type signature lines) instead of reading the
// full content and slicing. Raised to 256KB to cover larger source files
// (e.g. bundled JS, large markdown docs like tender documents / 标书).
const LARGE_FILE_BYTES = 256 * 1024
// For normally-sized files, read this many chars for summarization. Raised
// from 1500 → 4000: 1500 chars (~30 lines) was too short to capture real
// structure (exports, type defs, function signatures).
const MAX_FILE_CONTENT_CHARS = 4000
// For large files, cap the sampled structural lines at this many chars so
// the summary prompt doesn't blow up. Raised to 12000 so big files (标书,
// bundled code) get enough structural coverage.
const MAX_SAMPLED_CHARS = 12000
// Raised from 5 → 8: fewer serial round-trips → faster summarization.
const SUMMARY_BATCH_SIZE = 8
// How many batches to process in parallel. AI calls are I/O-bound (network
// wait), so concurrent batches dramatically speed up summarization without
// taxing the CPU. Kept at 3 to avoid hitting API rate limits.
const SUMMARIZE_CONCURRENCY = 3
// Memoize the last scan so project:getContext doesn't re-walk the filesystem
// on every toggle. Invalidated when the project path changes or after a
// re-summarize run (which already re-scans).
let cachedScan: { path: string; files: ProjectFile[] } | null = null

/**
 * Extract structural key lines from a source file: imports, exports,
 * function/class/interface/type/const declarations, and JSX component
 * signatures. Used for large files where reading + slicing the full content
 * would be slow and miss the key exports buried deeper in the file.
 *
 * This is a heuristic line-filter, not a real parser — it will miss logic
 * inside function bodies, but for summarization purposes the public surface
 * (what's exported, what signatures exist) is what matters.
 */
function sampleStructuralLines(src: string): string {
  const out: string[] = []
  // Patterns that indicate a structurally important line. We match on the
  // line start to avoid catching these keywords inside comments/strings.
  const re = /^\s*(?:import\s|export\s|from\s|export\sdefault\s|function\s|async\sfunction\s|class\s|interface\s|type\s|const\s|let\s|var\s|public\s|private\s|protected\s|static\s|def\s|func\s|fn\s|impl\s|struct\s|enum\s|trait\s|module\s|package\s|@component|@injectable|@Controller|@Service|@Module|@Get|@Post|@Put|@Delete|route\(|app\.(get|post|put|delete|use)\(|router\.(get|post|put|delete|use)\()/
  for (const line of src.split('\n')) {
    if (re.test(line)) out.push(line)
    if (out.length >= 200) break // hard cap on sampled lines
  }
  let joined = out.join('\n')
  if (joined.length > MAX_SAMPLED_CHARS) joined = joined.slice(0, MAX_SAMPLED_CHARS)
  return joined
}

/**
 * Read a file for summarization. For files under LARGE_FILE_BYTES, returns
 * the first MAX_FILE_CONTENT_CHARS chars. For larger files, returns sampled
 * structural lines (imports, exports, signatures) so key definitions aren't
 * missed — this is the fix for "重点都在大文件里" concern.
 */
async function readFileForSummary(abs: string, size: number): Promise<string> {
  let content: string
  try {
    content = await fs.readFile(abs, 'utf-8')
  } catch {
    return '(无法读取)'
  }
  if (size <= LARGE_FILE_BYTES) {
    return content.slice(0, MAX_FILE_CONTENT_CHARS)
  }
  // Large file: sample structural lines instead of slicing the prefix.
  const sampled = sampleStructuralLines(content)
  return sampled || content.slice(0, MAX_FILE_CONTENT_CHARS)
}

function projectCachePath(): string {
  return join(app.getPath('userData'), 'project-cache.json')
}

async function readProjectCache(): Promise<ProjectCache> {
  try {
    const raw = await fs.readFile(projectCachePath(), 'utf-8')
    return JSON.parse(raw) as ProjectCache
  } catch {
    return {}
  }
}

async function writeProjectCache(cache: ProjectCache): Promise<void> {
  await fs.writeFile(projectCachePath(), JSON.stringify(cache), 'utf-8')
}

/** Parse a root .gitignore and return a list of simple ignore patterns. */
async function readGitignore(rootDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(rootDir, '.gitignore'), 'utf-8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  } catch {
    return []
  }
}

/** Simplified gitignore match: handles exact names, name/, and * wildcards. */
function gitignoreMatch(relPath: string, patterns: string[]): boolean {
  const parts = relPath.split('/')
  for (const pat of patterns) {
    if (!pat) continue
    // Directory anchor: "foo/" matches any path under foo
    if (pat.endsWith('/')) {
      const dir = pat.slice(0, -1)
      if (parts.includes(dir)) return true
      continue
    }
    // Wildcard
    if (pat.includes('*')) {
      const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
      if (parts.some((p) => re.test(p))) return true
      continue
    }
    // Exact name match on any segment or the full path
    if (parts.includes(pat) || relPath === pat) return true
  }
  return false
}

async function scanProject(rootDir: string): Promise<ProjectFile[]> {
  // Return memoized result if the path matches — scanning walks the entire
  // filesystem tree and is the main bottleneck when toggling the reference
  // switch or re-fetching context after summarize. The cache is invalidated
  // on project:select (new path) and project:clear.
  if (cachedScan && cachedScan.path === rootDir) return cachedScan.files

  const gitignore = await readGitignore(rootDir)
  const out: ProjectFile[] = []

  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_PROJECT_FILES) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_PROJECT_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        if (gitignoreMatch(relative(rootDir, full), gitignore)) continue
        await walk(full)
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase()
        if (!SOURCE_EXTS.has(ext)) continue
        // Skip build artifacts, minified bundles, source maps, and lock files.
        // These are machine-generated, often huge, and carry no useful
        // structural information for prompt engineering.
        if (IGNORED_FILE_RE.test(entry.name)) continue
        const rel = relative(rootDir, full).split(/[\\/]/).join('/')
        if (gitignoreMatch(rel, gitignore)) continue
        try {
          const stat = await fs.stat(full)
          out.push({ path: rel, abs: full, size: stat.size, mtime: stat.mtimeMs })
        } catch {
          // skip unreadable
        }
      }
    }
  }

  await walk(rootDir)
  out.sort((a, b) => a.path.localeCompare(b.path))
  cachedScan = { path: rootDir, files: out }
  return out
}

/**
 * Generate one-line summaries for project files. Uses the AI to summarize
 * batches of files; caches results keyed by absolute path + mtime so only
 * changed/new files are re-summarized on subsequent scans.
 *
 * Sends `project:progress` events to the sender for UI feedback.
 */
async function summarizeProject(
  files: ProjectFile[],
  cfg: AiConfig,
  sender: WebContents
): Promise<ProjectCache> {
  const cache = await readProjectCache()
  // Only summarize files that are new or changed since last cache.
  const todo = files.filter((f) => {
    const hit = cache[f.abs]
    return !hit || hit.mtime !== f.mtime
  })

  if (todo.length === 0) return cache

  // Adaptive batching by file size — gives the model more attention budget
  // per file for large files, keeps small files efficient in bigger batches.
  // Files are processed in path order so the model sees the project in a
  // logical sequence (entry/config/types before deep implementations).
  const sortedTodo = [...todo].sort((a, b) => a.path.localeCompare(b.path))
  const batches: ProjectFile[][] = []
  let currentBatch: ProjectFile[] = []
  let currentBatchBytes = 0
  // Soft caps: a batch is "full" when it hits either the file count or the
  // total bytes ceiling, whichever comes first.
  const SMALL_BATCH_FILES = 8    // for files under 50KB
  const BATCH_BYTES_CAP = 200 * 1024  // 200KB total content per batch

  for (const f of sortedTodo) {
    // Large files (>256KB) go in their own batch — they need the model's
    // full attention and their sampled content can be up to 12KB.
    if (f.size > LARGE_FILE_BYTES) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch)
        currentBatch = []
        currentBatchBytes = 0
      }
      batches.push([f])
      continue
    }
    // Medium files (50KB-256KB): smaller batches so the model can go deeper.
    const estimatedBytes = Math.min(f.size, MAX_FILE_CONTENT_CHARS * 2)
    if (currentBatch.length >= SMALL_BATCH_FILES || currentBatchBytes + estimatedBytes > BATCH_BYTES_CAP) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch)
        currentBatch = []
        currentBatchBytes = 0
      }
    }
    currentBatch.push(f)
    currentBatchBytes += estimatedBytes
  }
  if (currentBatch.length > 0) batches.push(currentBatch)

  let completedFiles = 0
  let batchIdx = 0

  const processBatch = async (): Promise<void> => {
    while (batchIdx < batches.length) {
      if (sender.isDestroyed()) throw new Error('AI_CANCELLED')
      const myIdx = batchIdx++
      const batch = batches[myIdx]

      // Build a prompt with each file's content. Large files are sampled to
      // their structural lines (imports/exports/signatures) so key definitions
      // aren't missed even when the file is too big to read in full.
      let body = '请为以下每个文件生成结构化摘要，用于让另一个 AI 理解项目结构。\n'
      body += '摘要要求（控制在 2-3 句）：\n'
      body += '- 这个文件是做什么的（核心职责）\n'
      body += '- 导出了哪些关键的函数/类/类型/组件/常量（列出名称）\n'
      body += '- 如果是配置/类型/接口文件，说明它定义了哪些关键约束或数据结构\n'
      body += '- 如果是入口/路由文件，说明它接入了哪些模块或端点\n\n'
      body += '严格按如下格式输出，每行一个，不要额外解释：\n文件路径||摘要\n\n'
      for (let j = 0; j < batch.length; j++) {
        const f = batch[j]
        const content = await readFileForSummary(f.abs, f.size)
        const note = f.size > LARGE_FILE_BYTES
          ? '\n(注：文件较大，已提取结构性声明行而非全文)'
          : ''
        body += `### 文件${j + 1}: ${f.path}${note}\n${content}\n\n`
      }

      sender.send('project:progress', {
        phase: 'summarizing',
        current: completedFiles,
        total: todo.length,
        file: batch[0]?.path ?? ''
      })

      try {
        const out = await aiComplete(
          [
            { role: 'system', content: '你是一个资深代码分析助手。你的摘要会被另一个 AI 用来理解项目结构并生成贴合项目的 prompt，所以必须包含具体的导出名称、关键类型、核心 API，不要只给笼统的"这是一个 xxx 工具"——要能让读摘要的 AI 知道这个文件提供了什么可用的能力。' },
            { role: 'user', content: body }
          ],
          cfg,
          undefined,
          0.2
        )
        // Parse "path||summary" lines.
        const lines = out.split('\n')
        for (const line of lines) {
          const sep = line.indexOf('||')
          if (sep < 0) continue
          const p = line.slice(0, sep).trim()
          const s = line.slice(sep + 2).trim()
          if (!s) continue
          // Match back to a file in the batch by suffix (path in output may omit
          // the leading dir or carry extra markup; match by tail).
          const match = batch.find((f) => f.path === p || f.path.endsWith(p) || p.endsWith(f.path))
          if (match) {
            cache[match.abs] = { summary: s, mtime: match.mtime }
          }
        }
      } catch (err) {
        // If the batch fails (e.g. AI error), keep going — partial cache is fine.
        const msg = err instanceof Error ? err.message : String(err)
        console.warn('project summary batch failed:', msg)
      }

      completedFiles += batch.length
      // Persist incrementally so progress isn't lost on cancel. Safe in
      // concurrent context because Node.js is single-threaded — the cache
      // object mutations between awaits are atomic.
      await writeProjectCache(cache)
    }
  }

  // Launch CONCURRENCY workers that pull from the shared batch queue.
  await Promise.all(
    Array.from({ length: Math.min(SUMMARIZE_CONCURRENCY, batches.length) }, () => processBatch())
  )

  // --- Stage 2: global synthesis ---
  // After all per-file summaries are done, ask the AI to read them all and
  // produce a holistic understanding of the project: what it is, how it's
  // structured, what the key modules are, how they relate. This gives the
  // downstream prompt-engineering AI a high-level map instead of just a flat
  // list of file summaries.
  const GLOBAL_KEY = '__global__'
  // Only re-synthesize if any file changed (todo.length > 0 means something
  // was re-summarized this run).
  if (todo.length > 0) {
    sender.send('project:progress', { phase: 'summarizing', current: todo.length, total: todo.length, file: '(生成项目总览)' })
    try {
      const allSummaries = files
        .map((f) => {
          const entry = cache[f.abs]
          return entry ? `- ${f.path} — ${entry.summary}` : null
        })
        .filter((s): s is string => s !== null)
        .join('\n')

      const globalOut = await aiComplete(
        [
          { role: 'system', content: '你是一个资深架构分析助手。你会收到一个项目所有文件的摘要列表，请综合分析后给出对整个项目的全局理解，用于帮助另一个 AI 快速理解这个项目。' },
          { role: 'user', content: `以下是项目的文件摘要列表：\n\n${allSummaries}\n\n请给出对这个项目的全局理解，包括：\n1. 这是一个什么项目（一句话）\n2. 技术栈和核心依赖\n3. 整体架构和模块划分（哪些模块负责什么，模块间如何协作）\n4. 关键的扩展点和自定义机制（如果有）\n\n控制在 300 字以内，用结构化的 Markdown 输出。` }
        ],
        cfg,
        undefined,
        0.3
      )
      cache[GLOBAL_KEY] = { summary: globalOut, mtime: Date.now() }
      await writeProjectCache(cache)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('project global synthesis failed:', msg)
    }
  }

  sender.send('project:progress', { phase: 'done', current: todo.length, total: todo.length, file: '' })
  return cache
}

/**
 * Build a compact context string (file tree + summaries) to prepend to AI
 * system prompts. Truncated to stay within a reasonable token budget.
 *
 * Files are sorted by priority rather than pure alphabetical order so the
 * most informative files survive the truncation:
 *   1. Entry points / config / type definition files (index.ts, main.ts,
 *      package.json, types.ts, .d.ts, router, app entry) — these define the
 *      project's shape and are most useful for understanding context.
 *   2. Files that have been successfully summarized (have a cache entry).
 *   3. Larger files (more code → more likely to carry real logic).
 */
function buildProjectContext(files: ProjectFile[], cache: ProjectCache, maxChars = 32768): string {
  const MAX_CHARS = maxChars
  const GLOBAL_KEY = '__global__'

  // Priority names — files matching these get sorted first.
  const priorityRe = /(^|\/)(index|main|app|server|entry|router|routes|types?|interfaces?|schema|config|package\.json|\.d\.ts)\.[a-z]+$|package\.json$|tsconfig\.json$/i

  const sorted = [...files].sort((a, b) => {
    const aPri = priorityRe.test(a.path) ? 0 : 1
    const bPri = priorityRe.test(b.path) ? 0 : 1
    if (aPri !== bPri) return aPri - bPri
    // Within the same priority bucket, prefer summarized over unsummarized...
    const aHas = cache[a.abs]?.summary ? 0 : 1
    const bHas = cache[b.abs]?.summary ? 0 : 1
    if (aHas !== bHas) return aHas - bHas
    // ...then larger files first (more logic).
    return b.size - a.size
  })

  let ctx = '# 项目上下文\n\n'

  // Section 1: global project overview (if available). This gives the
  // downstream AI a high-level map before diving into per-file details.
  const globalEntry = cache[GLOBAL_KEY]
  if (globalEntry?.summary) {
    ctx += '## 项目总览\n'
    ctx += globalEntry.summary
    ctx += '\n\n## 文件明细\n'
  } else {
    ctx += '以下是项目中的文件及其职责摘要，按重要性排序。请基于这些信息理解项目结构，以便生成贴合项目实际的 prompt：\n\n'
  }

  // Section 2: per-file summaries.
  let omitted = 0
  for (const f of sorted) {
    const entry = cache[f.abs]
    const summary = entry?.summary ?? '(未摘要)'
    const line = `- ${f.path} — ${summary}\n`
    if (ctx.length + line.length > MAX_CHARS) {
      omitted++
      continue
    }
    ctx += line
  }
  if (omitted > 0) {
    ctx += `\n(另有 ${omitted} 个文件因篇幅省略)\n`
  }
  return ctx
}

// ---------- prompt engineering ----------

type AiAction = 'optimize' | 'variant' | 'compress' | 'translate'
type PromptStyle = 'concise' | 'detailed' | 'cot' | 'fewshot'

// --- Analysis-phase types (mirrored in renderer types.ts) ---

interface RelevantFile {
  path: string
  reason: string
}

interface ProjectAnalysis {
  hasProject: boolean
  relevantFiles?: RelevantFile[]
  techStack?: string
  insight?: string
}

interface IntentAnalysis {
  surface: string
  inferred: string
  reasoning: string
}

interface Ambiguity {
  id: string
  question: string
  options: string[]
  defaultIndex: number
  reason: string
}

interface UserProfile {
  domain: string
  roleLabel: string
  expertise: string
  reasoning: string
}

interface WebSearchQuery {
  query: string
  reason: string
}

interface WebSearchResult {
  query: string
  title: string
  snippet: string
  url: string
}

interface AnalysisResult {
  projectAnalysis: ProjectAnalysis
  intentAnalysis: IntentAnalysis
  userProfile: UserProfile
  searchQueries: WebSearchQuery[]
  searchResults: WebSearchResult[]
  ambiguities: Ambiguity[]
  assumptions: string[]
}

interface ClarificationAnswer {
  id: string
  answer: string
}

// --- Multi-round generation context (per-note memory) ---
// Prevents the model from "drifting" across regenerations by feeding the
// full conversation history (original intent + analysis + each prior round's
// output + user feedback) back into the generation prompt.

interface GenerationRound {
  /** The prompt the model produced in this round. */
  output: string
  /** User's natural-language feedback on this round (why it wasn't good
   *  enough). Drives the NEXT round's improvements. Undefined for the
   *  latest round (no feedback yet). */
  feedback?: string
}

interface NoteGenerationContext {
  /** The original plain-language input from the first round. Anchors the
   *  user's TRUE intent so later rounds can't drift away from it. */
  originalIntent: string
  /** Analysis result from phase 1 of the first round. Reused across all
   *  subsequent rounds so the model remembers its own reasoning. */
  analysis: AnalysisResult | null
  /** Clarification answers from phase 2 of the first round. */
  answers: ClarificationAnswer[]
  /** Each generation round's output + optional user feedback. */
  rounds: GenerationRound[]
}

// Per-note generation context. Keyed by notePath. Cleared when the user
// switches notes or starts a brand-new generation (content changed).
const generationContexts = new Map<string, NoteGenerationContext>()

/** Strip common wrappers model tend to add: ```markdown fences, conversational
 *  prefixes ("好的，这是..."), and trailing explanations.
 *  When `streaming` is true, also handles a partial opening fence that hasn't
 *  been closed yet (mid-stream) so the raw ``` line doesn't flicker in the
 *  preview; the full-fence strip takes over once the closing ``` arrives. */
function cleanAiOutput(raw: string, streaming = false): string {
  let s = raw.trim()
  // Remove a single outer ```markdown / ``` fence if it wraps the whole output.
  const fence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fence) {
    s = fence[1].trim()
  } else if (streaming) {
    // Mid-stream: opening ``` arrived but closing hasn't. Strip just the
    // opening line so it doesn't flicker. Only when the body has no further
    // ``` (otherwise the body contains a legit code block — leave untouched).
    const openFence = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*)$/)
    if (openFence && !openFence[1].includes('```')) {
      s = openFence[1]
    }
  }
  // Strip conversational prefixes before the first markdown heading / list.
  s = s.replace(/^(?:好的[，,。!！]?|这是|以下是|当然[，,]?|没问题[，,]?)[^#\n]*\n+/i, '')
  // Strip trailing conversational tail after the last useful line (heuristic:
  // anything after a blank line that starts with 希望/如果/你可以/注意).
  s = s.replace(/\n\s*\n(?:希望|如果|你可以|注意|备注|说明)[\s\S]*$/i, '')
  return s.trim()
}

const ACTION_SYSTEM_PROMPTS: Record<AiAction, string> = {
  optimize:
    '你是一位资深 prompt 工程师。用户会给你一段 prompt 草稿，请重写得更清晰、更结构化，但保留所有原意。\n' +
    '使用 Markdown 标题分节（# 角色 / # 任务 / # 约束 / # 输出格式 等），只保留与任务相关的章节，简单任务不要硬塞全部章节。\n' +
    '只输出重写后的 prompt，不要解释，不要加```包裹。',
  variant:
    '你是一位资深 prompt 工程师。请为用户的 prompt 生成 3 个风格迥异的变体，用 `---` 分隔，不要编号，不要解释：\n' +
    '1. 简洁版：只保留核心指令，极致压缩，适合 token 敏感场景\n' +
    '2. 结构化版：用 # 角色/# 任务/# 约束/# 输出格式 分节，最完整\n' +
    '3. 思维链版：在 prompt 中引导 AI 分步推理（加入"请按以下步骤思考："段落）',
  compress:
    '你是一位资深 prompt 工程师。请精简用户的 prompt，去除冗余表达，保留所有关键指令和约束。' +
    '目标是减少 token 占用，但不丢失任何信息。只输出精简后的 prompt，不要解释，不要加```包裹。',
  translate:
    '你是一位 prompt 翻译专家。如果用户输入是中文，翻译成英文；如果是英文，翻译成中文。' +
    '保持 prompt 的结构和语义不变，只翻译语言。只输出翻译后的 prompt，不要解释，不要加```包裹。'
}

interface AiActionResultDto {
  kind: 'single' | 'multi'
  text?: string
  texts?: string[]
}

async function aiChatAction(
  action: AiAction,
  content: string,
  cfg: AiConfig,
  projectContext?: string,
  maxChars = DEFAULT_MAX_CONTEXT_CHARS
): Promise<AiActionResultDto> {
  const sys = projectContext
    ? `${ACTION_SYSTEM_PROMPTS[action]}\n\n${projectContext}\n\n请结合上述项目上下文来优化用户的 prompt，使其贴合该项目的实际情况。`
    : ACTION_SYSTEM_PROMPTS[action]
  const user = content.slice(0, maxChars)
  const out = cleanAiOutput(await aiComplete(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    cfg,
    undefined,
    action === 'variant' ? 0.7 : 0.3
  ))
  if (action === 'variant') {
    // Tolerate --- / ---- / # --- etc. as separators.
    const texts = out
      .split(/^#{0,3}\s*-{3,}\s*$/m)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    return { kind: 'multi', texts: texts.length > 0 ? texts : [out] }
  }
  return { kind: 'single', text: out }
}

const STRUCTURE_SYSTEM_PROMPT_BASE =
  '你是一位世界顶级的提示词架构师，擅长通过深度追问和分析来理解用户的真实意图，并设计出能精准执行任务的提示词。\n\n' +
  '## 核心职责\n' +
  '当你接收到用户以大白话描述的需求时，你的目标是生成一个结构化的、高质量的提示词，该提示词能让其他 AI 完美地完成用户所描述的任务。你需要：\n' +
  '- 首先，仔细解读用户话语背后的真实需求、目标和上下文，而不是只停留在文字表面\n' +
  '- 然后，将需求拆解为明确的步骤和要素\n' +
  '- 最后，输出一个包含意图解读和完整提示词的结构化结果\n\n' +
  '## 输出格式\n' +
  '你的输出必须包含两部分，用 --- 分隔：\n\n' +
  '第一部分：意图解读（放在最前面，用引用块格式）\n' +
  '> **意图解读**\n' +
  '> （简要说明你对用户意图的解读过程：你捕捉到了什么潜在需求、做了哪些合理补全、哪些地方用户可能需要调整。2-4 句话即可。）\n\n' +
  '---\n\n' +
  '第二部分：生成的提示词（直接可用的 Markdown 格式，用 # 标题组织章节）\n\n' +
  '## 可选章节（只保留与任务相关的，简单任务不要硬塞全部）\n' +
  '# 背景（仅当需要上下文时：业务背景、技术栈、项目情况）\n' +
  '# 角色（仅当需要特定身份时：如"你是资深 PHP 工程师"）\n' +
  '# 任务（必填。复杂任务用编号步骤拆解）\n' +
  '# 输入（仅当有明确输入数据时，用 ### 或代码块包裹说明数据结构）\n' +
  '# 输出格式（仅当需要结构化输出时，优先用 JSON 代码块并给出字段说明）\n' +
  '# 约束（仅当有限制条件时：字数、语言、边界情况、安全考量）\n' +
  '# 受众（仅当输出面向特定群体时：如"面向技术评审"或"面向小白用户"）\n' +
  '# 示例（仅当示例能显著提升效果时，给出 input → output 样例）\n\n' +
  '## 关键原则\n' +
  '- **深度理解**：从用户叙述中提取核心意图，不只停留在文字表面。用户说"别太复杂"往往意味着他是新手，需要简洁可操作的结论而非专业模型\n' +
  '- **避免简单化**：不要生成仅重复用户原话的提示词，而要将其转化为具体的、有上下文的目标。"写诗"需指定风格、主题、情感等约束\n' +
  '- **区分用户意图和执行细节**：\n' +
  '  · 用户意图（产品类型、目标受众、业务场景）——不能臆造\n' +
  '  · 执行细节（输出格式、光照参数、技术参数、代码风格）——应主动基于常识/项目上下文/最佳实践给出合理默认值\n' +
  '- **模糊处理原则**：\n' +
  '  · 执行细节模糊时，主动补全合理默认值并标注"（可调整）"，不要留空白占位符\n' +
  '  · 用户核心意图模糊且完全无法推断时，可用"（待补充：选项A / 选项B / 选项C）"形式给出 2-3 个具体选项让用户选\n' +
  '  · 整个提示词中的待补充项不超过 2 处\n' +
  '  · 在意图解读部分说明你做了哪些补全，提示用户哪些地方可以调整\n' +
  '- **完整性**：最终产物应该是用户复制走就能直接用的完整提示词，而不是还需要填空的模板\n' +
  '- 用中文输出，不要加```包裹整个输出'

const STYLE_HINTS: Record<PromptStyle, string> = {
  concise:
    '\n\n风格要求：简洁。每个章节用一两句话，约束用短列表，不要长篇大论。整体控制在 200 字以内。',
  detailed:
    '\n\n风格要求：详尽。每个章节充分展开，约束具体可执行，输出格式给出完整字段说明。',
  cot:
    '\n\n风格要求：思维链。在 # 任务 章节加入"请按以下步骤思考："并编号列出推理步骤，引导 AI 分步推理后再给结论。',
  fewshot:
    '\n\n风格要求：少样本。在 # 示例 章节必须给出 2 个 input/output 示例，示例要具体且覆盖典型情况。'
}

function buildStructurePrompt(style: PromptStyle, projectContext?: string): string {
  let sys = STRUCTURE_SYSTEM_PROMPT_BASE + STYLE_HINTS[style]
  if (projectContext) {
    // Teach the model HOW to use the project context — not just "结合一下".
    // The previous instruction was too vague and the model often ignored the
    // context or only superficially referenced it. This explicit workflow
    // forces the model to: (1) understand the project structure, (2) locate
    // the relevant files/APIs/types for the user's task, (3) reference them
    // concretely in the generated prompt so the downstream AI has actionable
    // anchors instead of generic instructions.
    sys += `\n\n${projectContext}\n\n## 如何使用上述项目上下文\n` +
      '当用户的大白话描述涉及这个项目时，请按以下步骤思考（在意图解读部分体现你的分析即可）：\n' +
      '1. 先从项目上下文里找出与用户任务相关的文件、模块、类型或 API\n' +
      '2. 在生成的 prompt 中具体引用它们（写明文件路径、函数名、类型名），而不是泛泛地说"参考项目代码"\n' +
      '3. 如果用户的描述与项目里的某个已有能力高度吻合，直接在 # 任务 里指明用哪个文件/函数实现\n' +
      '4. 如果用户描述的需求项目里还没有，但在上下文里能看到相关的扩展点（比如已有的接口、配置项、插件机制），在 # 约束 里提示 AI 基于这些扩展点来做\n' +
      '5. 只引用真实存在于上下文里的东西，不要臆造文件名或 API\n' +
      '6. 如果项目上下文与用户任务无关（比如用户写的是与项目无关的通用需求），就正常生成 prompt，不要硬套项目上下文'
  }
  return sys
}

async function aiStructure(
  content: string,
  cfg: AiConfig,
  projectContext?: string,
  style: PromptStyle = 'detailed',
  maxChars = DEFAULT_MAX_CONTEXT_CHARS
): Promise<string> {
  return cleanAiOutput(await aiComplete(
    [
      { role: 'system', content: buildStructurePrompt(style, projectContext) },
      { role: 'user', content: content.slice(0, maxChars) }
    ],
    cfg,
    undefined,
    0.2
  ))
}

// ---------------------------------------------------------------------------
// Phase 1: Analysis — infer the user's REAL intent + identify ambiguities.
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT =
  '你是一位世界顶级的提示词架构师。你的唯一任务是：深度分析用户的输入和项目上下文，推断用户的真实意图，并识别需要澄清的模糊点。\n\n' +
  '## 输出格式\n' +
  '输出严格的 JSON（不要加```包裹，不要有任何额外文本）。Schema：\n' +
  '{\n' +
  '  "projectAnalysis": {\n' +
  '    "hasProject": true,\n' +
  '    "relevantFiles": [{"path": "src/foo.ts", "reason": "为什么相关"}],\n' +
  '    "techStack": "技术栈摘要",\n' +
  '    "insight": "对项目架构/关键能力的理解"\n' +
  '  },\n' +
  '  "intentAnalysis": {\n' +
  '    "surface": "用户字面表达的需求",\n' +
  '    "inferred": "推断出的真实意图（深度理解，不只重复表面文字）",\n' +
  '    "reasoning": "推断依据：从哪些线索（措辞/上下文/项目情况）推断出真实意图"\n' +
  '  },\n' +
  '  "userProfile": {\n' +
  '    "domain": "programmer|admin|sales|marketing|finance|legal|education|design|healthcare|other",\n' +
  '    "roleLabel": "人类可读的角色标签，如\"程序员（后端）\"/\"行政专员\"/\"销售经理\"",\n' +
  '    "expertise": "junior|mid|senior|expert",\n' +
  '    "reasoning": "推断依据：从措辞/术语/需求深度判断用户在哪个领域、什么水平"\n' +
  '  },\n' +
  '  "searchQueries": [\n' +
  '    {\n' +
  '      "query": "检索关键词（用户语言）",\n' +
  '      "reason": "为什么需要检索这个——能为生成补充什么资料"\n' +
  '    }\n' +
  '  ],\n' +
  '  "ambiguities": [\n' +
  '    {\n' +
  '      "id": "q1",\n' +
  '      "question": "具体的问题",\n' +
  '      "options": ["选项A", "选项B", "选项C"],\n' +
  '      "defaultIndex": 0,\n' +
  '      "reason": "为什么这个问题重要/为什么模糊"\n' +
  '    }\n' +
  '  ],\n' +
  '  "assumptions": ["已做的合理假设1", "已做的合理假设2"]\n' +
  '}\n\n' +
  '## 分析规则\n' +
  '- **推断真实意图**：用户说"写诗"可能需要指定风格/情感；说"别太复杂"可能意味着是新手。从措辞、上下文、项目情况推断表层文字背后的真实需求\n' +
  '- **项目分析**：如果有项目上下文，必须具体引用真实存在的文件/模块/API，说明它们与用户任务的关系。不要臆造文件名\n' +
  '- **用户领域推断（重要）**：从用户的"大白话"和上传文件推断用户是哪类角色——程序员、行政、销售、市场、财务、法务、教育、设计、医疗等。不同领域的 prompt 术语/深度/参考资料完全不同：\n' +
  '  - 程序员：使用代码术语，提到 API/框架/性能优化，上传代码或技术文档\n' +
  '  - 行政：提到流程/制度/会议/报告，措辞偏公文风格，上传模板或制度文件\n' +
  '  - 销售：提到客户/报价/合同/方案，关注转化和客户沟通，上传报价单或方案模板\n' +
  '  - 市场：提到活动/文案/品牌/投放，关注传播效果，上传营销素材\n' +
  '  - 财务：提到预算/报表/成本/审计，使用财务术语，上传财务模板\n' +
  '  - 法务：提到合同/条款/合规/风险，使用法律术语，上传合同模板\n' +
  '  - 教育：提到课程/教学/学生/教案，关注知识传递，上传教学材料\n' +
  '  - 设计：提到视觉/UI/品牌/原型，使用设计术语，上传设计稿\n' +
  '  如果无法确定，domain 填 "other"，roleLabel 填通用描述。expertise 从措辞专业度判断\n' +
  '- **检索关键词生成（重要）**：基于推断的用户领域和真实意图，生成 1-3 个检索关键词，用于联网检索专业资料补充生成上下文。原则：\n' +
  '  - 检索词应聚焦"能补充模型不知道的资料"（最新行业规范/标准术语/专业模板/领域最佳实践），不要检索模型已知的通用知识\n' +
  '  - 例如程序员问"设计一个 React 状态管理方案"，检索 "React state management 2026 best practices"\n' +
  '  - 例如行政问"写一份会议纪要模板"，检索 "会议纪要标准格式 公文写作规范"\n' +
  '  - 例如标书场景，检索 "标书响应偏离表格式 评分点对应模板"\n' +
  '  - 如果用户意图非常明确且不需要外部资料（如"写一首关于春天的诗"），返回空数组 []\n' +
  '- **模糊点识别**：只识别真正影响生成结果的模糊点。ambiguities 最多 3 个。如果意图清晰，返回空数组 []\n' +
  '- **选项设计**：每个 ambiguity 必须给出 2-4 个具体选项（不要开放式提问），defaultIndex 指向最合理的默认值\n' +
  '- **假设说明**：列出你基于常识/项目上下文做出的合理假设，让用户知道你补全了什么\n' +
  '- **简洁输出（重要）**：每个字段尽量用一两句话概括，不要长篇大论。reasoning/reason 限一句话。assumptions 最多 3 条。简短的 JSON 生成更快，用户体验更好\n' +
  '- 如果没有项目上下文，projectAnalysis.hasProject 设为 false，其他字段留空\n' +
  '- 严格输出 JSON，不要加 markdown 代码块包裹\n\n' +
  '## 标书场景专项规则（当用户输入涉及招标/投标/标书/采购/响应文件时启用）\n' +
  '标书场景的意图推断与通用任务差异很大，必须走更专业的分析路径：\n' +
  '- **识别招标要素**：从用户输入里提取项目名称、采购方式（公开招标/邀请招标/竞争性谈判/询价/单一来源）、预算、工期、资质要求\n' +
  '- **评分点抽取**：标书的核心是逐条对应评分标准。如果用户贴了招标需求片段，必须识别出明确的评分项（技术评分、商务评分、价格评分）并列入 intentAnalysis.inferred\n' +
  '- **合规条款识别**：招标文件里的"必须/不得/应/应满足"条款是硬约束。在 assumptions 里列出已识别的合规要求，在 ambiguities 里询问用户是否有未提供的合规材料\n' +
  '- **标书类型判断**：区分技术标、商务标、资格标、价格标——不同类型的 prompt 结构完全不同。如果无法判断，作为第一优先级的 ambiguity 询问\n' +
  '- **素材缺口识别**：标书生成工具需要素材输入（公司资质、历史案例、技术方案、设备清单、人员配置、报价表）。在 ambiguities 里询问用户能提供哪些素材——这是标书 prompt 质量的关键\n' +
  '- **标书场景的 ambiguities 上限提升到 5 个**（通用场景仍保持 3 个），因为标书决策点更多：标书类型、采购方式、行业、报价策略、技术路线、合作方、资质复用\n' +
  '- **选项设计要专业**：例如询价"标书类型"应给 ["技术标", "商务标", "技术+商务合订", "资格标"]；询价"采购方式"应给 ["公开招标", "竞争性谈判", "询价", "单一来源"]。不要给"选项A/选项B"这种无意义选项'

function buildAnalysisPrompt(projectContext?: string): string {
  let prompt = ANALYSIS_SYSTEM_PROMPT
  if (projectContext) {
    prompt += '\n\n## 项目上下文\n' + projectContext +
      '\n\n请基于上述项目上下文分析：哪些文件/模块/API 与用户的任务相关，项目的技术栈和架构特点是什么。'
  }
  return prompt
}

/**
 * Retrieve search results from DuckDuckGo Instant Answer API (free, no key).
 * Returns up to 3 results per query. Silently returns [] on any error so
 * analysis never blocks on network failure.
 */
async function searchWeb(queries: string[]): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = []
  for (const q of queries.slice(0, 3)) {
    try {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1&t=promptforge`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Accept': 'application/json' }
      })
      if (!res.ok) continue
      const data = await res.json() as {
        AbstractText?: string
        AbstractSource?: string
        AbstractURL?: string
        Heading?: string
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>
      }
      // Top-level abstract (most relevant result).
      if (data.AbstractText && data.AbstractURL) {
        results.push({
          query: q,
          title: data.Heading || data.AbstractSource || q,
          snippet: data.AbstractText.slice(0, 300),
          url: data.AbstractURL
        })
      }
      // Related topics (secondary results).
      const topics = data.RelatedTopics || []
      for (const t of topics) {
        if (results.length >= 9) break // 3 queries × 3 results max
        // RelatedTopics can contain nested topic groups.
        if (t.Text && t.FirstURL) {
          results.push({
            query: q,
            title: t.Text.split(' - ')[0]?.slice(0, 80) || q,
            snippet: t.Text.slice(0, 300),
            url: t.FirstURL
          })
        } else if (t.Topics && t.Topics.length > 0) {
          for (const nt of t.Topics) {
            if (results.length >= 9) break
            if (nt.Text && nt.FirstURL) {
              results.push({
                query: q,
                title: nt.Text.split(' - ')[0]?.slice(0, 80) || q,
                snippet: nt.Text.slice(0, 300),
                url: nt.FirstURL
              })
            }
          }
        }
      }
    } catch {
      // Network error / timeout / parse error — skip this query.
    }
  }
  return results
}

/**
 * Parse the analysis JSON from the model's response. Strips code fences and
 * leading/trailing non-JSON text before parsing. Returns null on failure so
 * the caller can fall back to direct generation without analysis.
 */
function parseAnalysis(raw: string): AnalysisResult | null {
  let text = raw.trim()
  // Strip ```json ... ``` fences if the model added them despite instructions.
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  // Find the first { and last } — tolerates leading/trailing chatter.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    // Validate minimum structure.
    if (!obj.intentAnalysis || typeof obj.intentAnalysis.inferred !== 'string') return null
    return {
      projectAnalysis: obj.projectAnalysis ?? { hasProject: false },
      intentAnalysis: obj.intentAnalysis,
      userProfile: obj.userProfile ?? {
        domain: 'other',
        roleLabel: '通用用户',
        expertise: 'mid',
        reasoning: '无法明确推断用户领域'
      },
      searchQueries: Array.isArray(obj.searchQueries) ? obj.searchQueries : [],
      searchResults: [], // populated by the handler after parsing
      ambiguities: Array.isArray(obj.ambiguities) ? obj.ambiguities : [],
      assumptions: Array.isArray(obj.assumptions) ? obj.assumptions : []
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Generation — produce the final prompt using analysis + answers.
// ---------------------------------------------------------------------------

const GENERATION_SYSTEM_PROMPT =
  '你是一位世界顶级的提示词架构师。基于前置分析结果和用户澄清，生成一个结构化的、高质量的提示词，该提示词能让其他 AI 完美地完成用户所描述的任务。\n\n' +
  '## 生成原则\n' +
  '- **基于真实意图**：以分析中推断的真实意图（而非表面文字）为核心构建提示词\n' +
  '- **具体引用项目**：如果分析中有项目相关文件/API，在提示词中具体引用（写明文件路径、函数名、类型名）\n' +
  '- **执行细节补全**：执行细节（输出格式、技术参数、代码风格）应主动给出合理默认值并标注"（可调整）"，不留空白占位符\n' +
  '- **用户意图不臆造**：用户意图（产品类型、目标受众、业务场景）基于分析和澄清结果，不臆造\n' +
  '- **完整性**：最终产物是用户复制走就能直接用的完整提示词\n' +
  '- **利用检索资料**：如果前置分析结果里有 searchResults（联网检索到的专业资料），在生成时参考这些资料的术语/规范/最佳实践，让提示词更专业。不要在提示词里直接复制检索内容，而是吸收其专业性\n\n' +
  '## 输出格式\n' +
  '直接输出 Markdown 格式的提示词（用 # 标题组织章节）。不要输出意图解读/分析——分析已经在前面展示过了。不要加```包裹整个输出。\n\n' +
  '## 可选章节（只保留与任务相关的）\n' +
  '# 背景（仅当需要上下文时）\n' +
  '# 角色（仅当需要特定身份时）\n' +
  '# 任务（必填。复杂任务用编号步骤拆解）\n' +
  '# 输入（仅当有明确输入数据时）\n' +
  '# 输出格式（仅当需要结构化输出时）\n' +
  '# 约束（仅当有限制条件时）\n' +
  '# 受众（仅当输出面向特定群体时）\n' +
  '# 示例（仅当示例能显著提升效果时）\n\n' +
  '## 标书场景专项生成规则（当分析结果涉及招标/投标/标书/采购/响应文件时启用）\n' +
  '标书 prompt 的目标读者是另一个标书生成工具/AI，不是直接生成标书的人。生成的 prompt 必须让下游 AI 能产出专业标书：\n\n' +
  '- **结构对标评分项**：在 # 任务 章节必须明确"逐条对应招标文件的评分标准"，并给出对应表结构：| 评分项 | 分值 | 响应内容 | 证明材料 |\n' +
  '- **强制响应偏离表**：标书必须有响应偏离表。在 # 输出格式 章节要求下游 AI 输出"技术响应偏离表"和"商务响应偏离表"，列结构：| 序号 | 招标要求 | 响应内容 | 偏离说明 |\n' +
  '- **合规性硬约束**：在 # 约束 章节必须列出"必须满足/不得违反"的硬条款（来自分析中识别的合规要求），并要求下游 AI 在生成后自检每一条是否响应\n' +
  '- **素材占位规范**：标书生成需要素材输入。在 # 输入 章节用明确的占位符列出下游 AI 需要的素材：{{公司资质}}、{{历史案例}}、{{技术方案}}、{{设备清单}}、{{人员配置}}、{{报价表}}。占位符用双花括号，便于程序替换\n' +
  '- **标书类型适配**：根据澄清结果调整 prompt 结构——技术标重技术方案和实施细节；商务标重商务条款和报价；资格标重资质和业绩；价格标重报价策略\n' +
  '- **评分最大化策略**：在 # 任务 末尾要求下游 AI "对每个评分点都给出充分响应，确保不丢分"，并在 # 约束 里要求"响应内容必须覆盖所有评分项，不得遗漏"\n' +
  '- **格式约束**：标书有严格的格式要求。在 # 输出格式 里要求使用正式公文体（不口语化）、章节编号规范（一、(一)、1.）、表格用 markdown 表格、关键条款用加粗\n' +
  '- **自检环节**：在 prompt 末尾增加 # 自检 章节，要求下游 AI 生成后逐项检查：评分项是否全覆盖、合规条款是否全响应、偏离表是否完整、素材占位符是否全部填充'

function buildGenerationPrompt(
  style: PromptStyle,
  analysis: AnalysisResult,
  answers: ClarificationAnswer[],
  projectContext?: string,
  /** Multi-round context. When provided with ≥1 prior round, the prompt
   *  includes the full iteration history so the model improves on the last
   *  output instead of generating from scratch. */
  ctx?: NoteGenerationContext
): string {
  let prompt = GENERATION_SYSTEM_PROMPT + STYLE_HINTS[style]
  // Feed the analysis back to the model so it remembers its own reasoning.
  prompt += '\n\n## 前置分析结果\n' + JSON.stringify(analysis, null, 2)
  // Feed the user's clarification answers.
  if (answers.length > 0) {
    prompt += '\n\n## 用户澄清\n' + answers.map(a => `- ${a.id}: ${a.answer}`).join('\n')
  } else {
    prompt += '\n\n## 用户澄清\n用户未提供额外澄清，使用分析中的默认假设。'
  }
  if (projectContext) {
    prompt += '\n\n## 项目上下文\n' + projectContext
  }
  // Multi-round iteration history. This is the KEY anti-drift mechanism:
  // the model sees the original intent + every prior output + user feedback,
  // so it can improve incrementally rather than randomly re-rolling.
  if (ctx && ctx.rounds.length > 0) {
    prompt += '\n\n## 原始意图（锚定，不要偏离）\n' + ctx.originalIntent
    prompt += '\n\n## 迭代历史（共 ' + ctx.rounds.length + ' 轮）\n'
    ctx.rounds.forEach((r, i) => {
      prompt += `\n### 第 ${i + 1} 轮\n`
      prompt += '#### 生成结果\n' + r.output + '\n'
      if (r.feedback) {
        prompt += `#### 用户反馈\n${r.feedback}\n`
      }
    })
    prompt += '\n## 本轮生成指令\n' +
      '基于上述迭代历史生成**新一轮**的提示词。核心规则：\n' +
      '- **锚定原始意图**：不要偏离"原始意图"章节里记录的用户最初诉求\n' +
      '- **针对反馈改进**：如果用户给了反馈，本轮必须针对性解决反馈中指出的问题\n' +
      '- **保留优点**：上一轮里用户没抱怨的部分，保持不变；不要为了改而改\n' +
      '- **修复缺点**：上一轮里用户不满意的点，必须实质性调整\n' +
      '- **不要从零重写**：在上一轮基础上迭代，保持整体结构稳定，只调整有问题的部分\n' +
      '- **完整输出**：仍然输出完整的提示词（不要只输出 diff）'
  }
  return prompt
}

/**
 * Streaming variant of aiComplete. Calls onChunk with the *accumulated* full
 * content + reasoning each time a delta arrives, so the renderer can render
 * progressively. Uses SSE for OpenAI-compatible providers and NDJSON for
 * Ollama. Pass an AbortSignal to cancel an in-flight stream.
 *
 * Reasoning support: DeepSeek-R1 / o1-style models emit a separate
 * `reasoning_content` (or `reasoning`) field alongside `content`. We split
 * the two streams so the UI can show the thinking process in a collapsible
 * block without polluting the final prompt.
 */
async function aiCompleteStream(
  messages: ChatMessageDto[],
  cfg: AiConfig,
  onChunk: (content: string, reasoning: string) => void,
  signal: AbortSignal,
  modelOverride?: string,
  temperature = 0.4
): Promise<{ content: string; reasoning: string }> {
  const model = modelOverride || cfg.model
  if (!model) throw new Error('AI_NO_MODEL')
  const base = normalizeBase(cfg.baseUrl)

  if (cfg.provider === 'ollama') {
    // Ollama streams NDJSON: one JSON object per line, each with .message.content.
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: { temperature } }),
      signal
    })
    if (!res.ok) throw new Error(`AI_FAILED (${res.status} ${res.statusText})`)
    return readJsonLines(res, (obj) => {
      const msg = (obj as { message?: { content?: string; reasoning?: string; thinking?: string } })?.message
      return {
        content: msg?.content ?? '',
        reasoning: msg?.reasoning ?? msg?.thinking ?? ''
      }
    }, onChunk, signal)
  }

  // OpenAI-compatible: SSE lines starting with "data: ", terminated by "[DONE]".
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
    signal
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`AI_FAILED (${res.status} ${res.statusText})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
  return readSse(res, (data) => {
    try {
      // DeepSeek-R1: delta.reasoning_content. OpenAI o1: delta.reasoning.
      // Some providers nest under message instead of delta for reasoning.
      const obj = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }> }
      const d = obj?.choices?.[0]?.delta
      return {
        content: d?.content ?? '',
        reasoning: d?.reasoning_content ?? d?.reasoning ?? ''
      }
    } catch {
      return { content: '', reasoning: '' }
    }
  }, onChunk, signal)
}

/** Shared line reader: splits the byte stream on newlines, buffering the tail. */
async function readStreamLines(
  res: Response,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('AI_FAILED (no response body)')
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      onLine(line)
    }
  }
  if (buf.length > 0) onLine(buf)
}

/** Ollama NDJSON: each non-empty line is a JSON object with .message.content. */
async function readJsonLines(
  res: Response,
  extract: (obj: unknown) => { content?: string; reasoning?: string },
  onChunk: (content: string, reasoning: string) => void,
  signal: AbortSignal
): Promise<{ content: string; reasoning: string }> {
  let content = ''
  let reasoning = ''
  await readStreamLines(res, (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const obj = JSON.parse(trimmed)
      const delta = extract(obj)
      if (delta.content) content += delta.content
      if (delta.reasoning) reasoning += delta.reasoning
      if (delta.content || delta.reasoning) onChunk(content, reasoning)
    } catch {
      // skip malformed line
    }
  }, signal)
  return { content, reasoning }
}

/** OpenAI SSE: lines start with "data: "; "data: [DONE]" ends the stream. */
async function readSse(
  res: Response,
  extract: (data: string) => { content?: string; reasoning?: string },
  onChunk: (content: string, reasoning: string) => void,
  signal: AbortSignal
): Promise<{ content: string; reasoning: string }> {
  let content = ''
  let reasoning = ''
  await readStreamLines(res, (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    const delta = extract(data)
    if (delta.content) content += delta.content
    if (delta.reasoning) reasoning += delta.reasoning
    if (delta.content || delta.reasoning) onChunk(content, reasoning)
  }, signal)
  return { content, reasoning }
}

// In-flight streaming requests, keyed by requestId — supports cancellation.
const activeStreams = new Map<string, AbortController>()
const activeAnalyses = new Map<string, AbortController>()

// ---------- ipc ----------

function registerIpc(): void {
  ipcMain.handle('vault:select', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择笔记文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const vaultPath = resolve(result.filePaths[0])
    currentVault = vaultPath
    const settings = await readSettings()
    settings.lastVault = vaultPath
    await writeSettings(settings)
    return vaultPath
  })

  ipcMain.handle('vault:getLast', async () => {
    const settings = await readSettings()
    if (settings.lastVault && (await pathExists(settings.lastVault))) {
      currentVault = resolve(settings.lastVault)
      return settings.lastVault
    }
    return null
  })

  ipcMain.handle('vault:list', async (_event, vaultPath: string) => {
    return listNotes(assertCurrentVault(vaultPath))
  })

  ipcMain.handle('vault:search', async (_event, vaultPath: string, query: string, limit = 20) => {
    return searchNotes(assertCurrentVault(vaultPath), query.trim(), limit)
  })

  // Bulk-read every note in the vault so the renderer can build a semantic
  // embedding index in one pass (via transformers.js in a worker).
  ipcMain.handle('vault:readAll', async (_event, vaultPath: string) => {
    const vault = assertCurrentVault(vaultPath)
    const notes = await listNotes(vault)
    const out: Array<{ path: string; title: string; content: string; mtime: number }> = []
    for (const n of notes) {
      try {
        const content = await fs.readFile(n.path, 'utf-8')
        out.push({ path: n.path, title: n.title, content, mtime: n.mtime })
      } catch {
        // skip unreadable
      }
    }
    return out
  })

  ipcMain.handle('vault:watch', async (_event, vaultPath: string) => {
    startVaultWatch(assertCurrentVault(vaultPath))
  })

  ipcMain.handle('note:read', async (_event, notePath: string) => {
    if (!isInsideVault(notePath)) throw new Error('PATH_OUTSIDE_VAULT')
    return fs.readFile(notePath, 'utf-8')
  })

  ipcMain.handle('note:write', async (_event, notePath: string, content: string) => {
    if (!isInsideVault(notePath)) return
    // Only update a note that still exists. If the file was just renamed or
    // trashed, a late unmount-flush from the editor must NOT recreate it under
    // the old path (that would resurrect the pre-rename file / undo a delete).
    if (!(await pathExists(notePath))) return
    await fs.writeFile(notePath, content, 'utf-8')
  })

  ipcMain.handle('note:create', async (_event, vaultPath: string, name: string) => {
    const vault = assertCurrentVault(vaultPath)
    const base = sanitizeName(name)
    let filename = `${base}.md`
    let full = join(vault, filename)
    let i = 1
    while (await pathExists(full)) {
      filename = `${base} ${i}.md`
      full = join(vault, filename)
      i++
    }
    await fs.writeFile(full, `# ${base}\n\n`, 'utf-8')
    const stat = await fs.stat(full)
    const note: NoteMeta = {
      path: full,
      name: filename,
      title: filename.replace(/\.md$/i, ''),
      mtime: stat.mtimeMs
    }
    return note
  })

  // Structured result so the renderer can branch on a stable `code` instead of
  // grepping the (localized) error message.
  ipcMain.handle('note:rename', async (_event, notePath: string, newName: string) => {
    if (!isInsideVault(notePath)) return { ok: false as const, code: 'PATH_OUTSIDE_VAULT' as const }
    if (!(await pathExists(notePath))) {
      return { ok: false as const, code: 'SOURCE_NOT_FOUND' as const }
    }
    const base = sanitizeName(newName)
    const target = join(dirname(notePath), `${base}.md`)
    if (target !== notePath && (await pathExists(target))) {
      return { ok: false as const, code: 'TARGET_EXISTS' as const }
    }
    await fs.rename(notePath, target)
    const stat = await fs.stat(target)
    const note: NoteMeta = {
      path: target,
      name: `${base}.md`,
      title: base,
      mtime: stat.mtimeMs
    }
    return { ok: true as const, note }
  })

  ipcMain.handle('note:delete', async (_event, notePath: string) => {
    if (!isInsideVault(notePath)) return
    if (!(await pathExists(notePath))) return
    await shell.trashItem(notePath)
  })

  // ---------- theme ----------
  ipcMain.handle('theme:get', async () => getTheme())
  ipcMain.handle('theme:set', async (_event, theme: Theme) => {
    await setTheme(theme)
    return theme
  })

  // ---------- updates ----------
  ipcMain.handle('update:feed:get', async () => getUpdateFeedUrl())
  ipcMain.handle('update:feed:set', async (_event, updateFeedUrl: string) => setUpdateFeedUrl(updateFeedUrl))
  ipcMain.handle('update:check', async (_event, updateFeedUrl?: string) => checkForUpdates(updateFeedUrl))
  ipcMain.handle('update:open', async (_event, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        await shell.openExternal(url)
      }
    } catch {
      // ignore invalid or unsupported external URLs
    }
  })

  // ---------- ai (configurable provider) ----------
  ipcMain.handle('ai:config:get', async () => getAiConfig())
  ipcMain.handle('ai:config:set', async (_event, config: AiConfig) => setAiConfig(config))
  ipcMain.handle('ai:status', async () => aiStatus(await getAiConfig()))
  ipcMain.handle('ai:maxContextChars:get', async () => getMaxContextChars())
  ipcMain.handle('ai:maxContextChars:set', async (_event, v: number) => {
    const settings = await readSettings()
    settings.maxContextChars = v > 0 ? v : DEFAULT_MAX_CONTEXT_CHARS
    await writeSettings(settings)
    return settings.maxContextChars
  })
  ipcMain.handle('ai:summarize', async (_event, content: string, model?: string) =>
    aiSummarize(content, await getAiConfig(), model)
  )
  ipcMain.handle('ai:chat', async (_event, action: AiAction, content: string, projectContext?: string) =>
    aiChatAction(action, content, await getAiConfig(), projectContext, await getMaxContextChars())
  )
  ipcMain.handle('ai:structure', async (_event, content: string, projectContext?: string, style?: PromptStyle) =>
    aiStructure(content, await getAiConfig(), projectContext, style ?? 'detailed', await getMaxContextChars())
  )
  // Phase 1: Analyze user input + project context → structured JSON.
  // Non-streaming (the JSON is short and needs to be complete before
  // rendering cards). Returns null if the model's output can't be parsed —
  // the renderer falls back to direct generation in that case.
  ipcMain.handle('ai:analyze', async (_event, content: string, projectContext?: string, ragContext?: string, reqId?: string) => {
    const cfg = await getAiConfig()
    const maxChars = await getMaxContextChars()
    const sysPrompt = buildAnalysisPrompt(projectContext) + (ragContext ?? '')
    const ctrl = reqId ? new AbortController() : null
    if (reqId && ctrl) activeAnalyses.set(reqId, ctrl)
    let raw: string
    try {
      raw = await aiComplete(
        [
          { role: 'system', content: sysPrompt },
          // Long-context models (128k) can analyze full tender documents;
          // small local models should keep this low to avoid OOM. The limit
          // is user-configurable in settings.
          { role: 'user', content: content.slice(0, maxChars) }
        ],
        cfg,
        undefined,
        0.2,
        ctrl?.signal
      )
    } catch (err) {
      if (ctrl?.signal.aborted) return null
      throw err
    } finally {
      if (reqId) activeAnalyses.delete(reqId)
    }
    const result = parseAnalysis(raw)
    if (!result) {
      // Return a minimal valid result so the renderer can proceed to
      // direct generation without crashing.
      return null
    }
    // Phase 1.5: Retrieve web resources based on the analysis-suggested
    // queries. Non-blocking on failure — empty results are fine. This runs
    // AFTER analysis (so we know the domain + intent) and BEFORE returning
    // to the renderer (so results show up in the clarification cards).
    if (result.searchQueries.length > 0) {
      const queries = result.searchQueries.map(q => q.query).filter(q => q.trim().length > 0)
      if (queries.length > 0) {
        result.searchResults = await searchWeb(queries)
      }
    }
    return result
  })
  ipcMain.handle('ai:analyze:cancel', (_event, reqId: string) => {
    const ctrl = activeAnalyses.get(reqId)
    if (ctrl) {
      ctrl.abort()
      activeAnalyses.delete(reqId)
    }
  })

  // Phase 3: Generate the final prompt. When `analysis` + `answers` are
  // provided, uses the generation system prompt (which is aware of the
  // inferred intent and clarification answers). When not provided, falls
  // back to the legacy one-shot `buildStructurePrompt` for backward compat.
  //
  // Multi-round context (anti-drift): when `notePath` is provided, the
  // handler reads/writes a per-note context Map. On regeneration, the prior
  // round's output + user feedback are fed back so the model iterates on
  // the previous output instead of re-rolling from scratch.
  ipcMain.handle('ai:structure:stream', async (event, content: string, reqId: string, projectContext?: string, style?: PromptStyle, regenerate?: boolean, analysis?: AnalysisResult | null, answers?: ClarificationAnswer[], notePath?: string, feedback?: string, ragContext?: string) => {
    const cfg = await getAiConfig()
    const ctrl = new AbortController()
    activeStreams.set(reqId, ctrl)

    // --- Multi-round context management ---
    // On the FIRST generation for a note, we create a new context recording
    // the original intent + analysis + answers. On SUBSEQUENT regenerations,
    // we read the existing context, attach the user's feedback to the last
    // round, and pass the full history to buildGenerationPrompt.
    let ctx: NoteGenerationContext | undefined
    if (notePath) {
      ctx = generationContexts.get(notePath)
      if (ctx) {
        // Subsequent round: attach feedback to the previous round so the
        // model knows what to fix. Only set feedback if there was a prior
        // round AND the user provided feedback text.
        if (ctx.rounds.length > 0 && feedback && feedback.trim()) {
          ctx.rounds[ctx.rounds.length - 1].feedback = feedback.trim()
        }
      } else if (analysis) {
        // First round for this note: anchor the original intent.
        ctx = {
          originalIntent: content.slice(0, 2000),
          analysis,
          answers: answers ?? [],
          rounds: []
        }
        generationContexts.set(notePath, ctx)
      }
    }

    // Build the system prompt: generation prompt if analysis is available,
    // otherwise the legacy one-shot structure prompt.
    let sys: string
    if (analysis) {
      sys = buildGenerationPrompt(style ?? 'detailed', analysis, answers ?? [], projectContext, ctx)
    } else {
      sys = buildStructurePrompt(style ?? 'detailed', projectContext)
    }
    // RAG context: cross-note reference material retrieved from the vault
    // embedding index. Appended to the system prompt so the model has the
    // same reference snippets the analysis phase saw (consistency).
    if (ragContext) sys += ragContext

    // When the user explicitly clicks "重新生成", raise the temperature
    // slightly so the model has room to adjust — but not so high that it
    // drifts. With multi-round context, the iteration history already
    // guides variation; without it (legacy path), inject a nudge.
    const temperature = regenerate ? 0.5 : 0.2
    if (regenerate && (!ctx || ctx.rounds.length === 0)) {
      sys += '\n\n## 重新生成指令\n' +
        '用户对上一次的结果不满意，请生成一个**不同版本**的提示词。具体要求：\n' +
        '- 尝试不同的切入点或结构组织方式\n' +
        '- 调整章节的详略\n' +
        '- 如果上次用了列表，这次尝试用段落；反之亦然\n' +
        '- 核心意图保持不变，但表达方式和侧重点要有明显区别'
    }
    try {
      const maxChars = await getMaxContextChars()
      let lastReasoning = ''
      const result = await aiCompleteStream(
        [
          { role: 'system', content: sys },
          // Match the analysis phase's char limit so generation sees the
          // same scope the analysis did (consistency prevents the model
          // from contradicting its own earlier reasoning).
          { role: 'user', content: content.slice(0, maxChars) }
        ],
        cfg,
        (text, reasoning) => {
          event.sender.send('ai:structure:chunk', reqId, cleanAiOutput(text, true))
          // Only forward reasoning deltas to avoid flooding IPC with
          // unchanged payloads on every content chunk.
          if (reasoning !== lastReasoning) {
            lastReasoning = reasoning
            event.sender.send('ai:structure:reasoning', reqId, reasoning)
          }
        },
        ctrl.signal,
        undefined,
        temperature
      )
      const cleaned = cleanAiOutput(result.content)
      // Record this round in the per-note context so the next regeneration
      // can iterate on it.
      if (ctx) {
        ctx.rounds.push({ output: cleaned })
      }
      event.sender.send('ai:structure:done', reqId, cleaned, result.reasoning)
      return cleaned
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (ctrl.signal.aborted) {
        return ''
      }
      event.sender.send('ai:structure:error', reqId, msg)
      throw err
    } finally {
      activeStreams.delete(reqId)
    }
  })
  // Clear the multi-round generation context for a note. Called when the
  // user switches notes or when the editor content changes so drastically
  // that the previous context is no longer relevant.
  ipcMain.handle('ai:structure:resetContext', (_event, notePath?: string) => {
    if (notePath) {
      generationContexts.delete(notePath)
    } else {
      generationContexts.clear()
    }
  })
  ipcMain.handle('ai:structure:cancel', (_event, reqId: string) => {
    const ctrl = activeStreams.get(reqId)
    if (ctrl) {
      ctrl.abort()
      activeStreams.delete(reqId)
    }
  })
  ipcMain.handle('ai:complete', async (_event, messages: ChatMessageDto[]) =>
    aiComplete(messages, await getAiConfig())
  )

  // ---------- project context ----------
  ipcMain.handle('project:select', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const projectPath = resolve(result.filePaths[0])
    const settings = await readSettings()
    settings.projectPath = projectPath
    await writeSettings(settings)
    // Invalidate the scan cache — new project, different file tree.
    cachedScan = null
    return projectPath
  })
  ipcMain.handle('project:get', async () => {
    const settings = await readSettings()
    return settings.projectPath ?? null
  })
  ipcMain.handle('project:clear', async () => {
    const settings = await readSettings()
    delete settings.projectPath
    await writeSettings(settings)
    cachedScan = null
  })
  ipcMain.handle('project:scan', async (event) => {
    const settings = await readSettings()
    if (!settings.projectPath) return { files: [], cache: {} }
    event.sender.send('project:progress', { phase: 'scanning', current: 0, total: 0, file: '' })
    const files = await scanProject(settings.projectPath)
    return { files, projectPath: settings.projectPath }
  })
  ipcMain.handle('project:summarize', async (event) => {
    const settings = await readSettings()
    if (!settings.projectPath) return { files: [], cache: {} }
    const cfg = await getAiConfig()
    // Invalidate the scan cache before summarizing — the user explicitly
    // asked to re-summarize, which usually means files may have changed.
    cachedScan = null
    const files = await scanProject(settings.projectPath)
    const cache = await summarizeProject(files, cfg, event.sender)
    return { files, cache }
  })
  ipcMain.handle('project:getCache', async () => {
    return readProjectCache()
  })
  ipcMain.handle('project:getContext', async () => {
    const settings = await readSettings()
    if (!settings.projectPath) return null
    const files = await scanProject(settings.projectPath)
    const cache = await readProjectCache()
    return buildProjectContext(files, cache, await getMaxContextChars())
  })

  // ---------- embedding index persistence ----------
  ipcMain.handle('index:save', async (_event, data: unknown) => {
    const file = join(app.getPath('userData'), 'embeddings.json')
    await fs.writeFile(file, JSON.stringify(data), 'utf-8')
  })
  ipcMain.handle('index:load', async () => {
    try {
      const raw = await fs.readFile(join(app.getPath('userData'), 'embeddings.json'), 'utf-8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  })
}

// ---------- application menu ----------

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const send = (channel: string): void => {
    mainWindow?.webContents.send(channel)
  }

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: '文件',
    submenu: [
      { label: '新建笔记', accelerator: 'CmdOrCtrl+N', click: () => send('menu:new') },
      { label: '打开笔记库…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-vault') },
      { type: 'separator' },
      { label: '搜索笔记', accelerator: 'CmdOrCtrl+K', click: () => send('menu:search') },
      ...(isMac ? [] : ([{ type: 'separator' as const }, { role: 'quit' as const }]))
    ]
  })

  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  })

  template.push({
    label: '视图',
    submenu: [
      { label: '切换深色模式', accelerator: 'CmdOrCtrl+Shift+D', click: () => void toggleTheme() },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: '窗口',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- window ----------

let boundsTimer: ReturnType<typeof setTimeout> | null = null

function trackBounds(win: BrowserWindow): void {
  const save = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(async () => {
      const settings = await readSettings()
      settings.maximized = win.isMaximized()
      if (!win.isMaximized()) {
        const b = win.getNormalBounds()
        settings.lastBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
      }
      await writeSettings(settings)
    }, 400)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
}

async function createWindow(theme: Theme): Promise<void> {
  const settings = await readSettings()
  const win = new BrowserWindow({
    width: settings.lastBounds?.width ?? 1200,
    height: settings.lastBounds?.height ?? 800,
    x: settings.lastBounds?.x,
    y: settings.lastBounds?.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Markdown Notes',
    backgroundColor: theme === 'dark' ? '#070b12' : '#e2eef8',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win

  if (settings.maximized) win.maximize()
  trackBounds(win)

  win.on('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        void shell.openExternal(details.url)
      }
    } catch {
      // ignore invalid or unsupported external URLs
    }
    return { action: 'deny' }
  })

  const themeHash = `theme=${theme}`
  if (process.env['ELECTRON_RENDERER_URL']) {
    await win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${themeHash}`)
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: themeHash })
  }
}

app.whenReady().then(async () => {
  registerIpc()
  buildMenu()
  await createWindow(await getTheme())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow('light')
    }
  })
})

app.on('before-quit', () => {
  stopVaultWatch()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
