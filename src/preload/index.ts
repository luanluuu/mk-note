import { contextBridge, ipcRenderer } from 'electron'

const api = {
  selectVault: (): Promise<string | null> => ipcRenderer.invoke('vault:select'),
  getLastVault: (): Promise<string | null> => ipcRenderer.invoke('vault:getLast'),
  listNotes: (vaultPath: string) => ipcRenderer.invoke('vault:list', vaultPath),
  readAllNotes: (vaultPath: string) => ipcRenderer.invoke('vault:readAll', vaultPath),
  readNote: (notePath: string): Promise<string> => ipcRenderer.invoke('note:read', notePath),
  writeNote: (notePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke('note:write', notePath, content),
  createNote: (vaultPath: string, name: string) =>
    ipcRenderer.invoke('note:create', vaultPath, name),
  renameNote: (notePath: string, newName: string) =>
    ipcRenderer.invoke('note:rename', notePath, newName),
  deleteNote: (notePath: string): Promise<void> => ipcRenderer.invoke('note:delete', notePath),
  searchNotes: (vaultPath: string, query: string, limit?: number) =>
    ipcRenderer.invoke('vault:search', vaultPath, query, limit),
  watchVault: (vaultPath: string): Promise<void> => ipcRenderer.invoke('vault:watch', vaultPath),

  // theme
  getTheme: (): Promise<'light' | 'dark'> => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: 'light' | 'dark'): Promise<'light' | 'dark'> =>
    ipcRenderer.invoke('theme:set', theme),
  onThemeChanged: (cb: (theme: 'light' | 'dark') => void): (() => void) => {
    const listener = (_e: unknown, theme: 'light' | 'dark'): void => cb(theme)
    ipcRenderer.on('theme:changed', listener)
    return () => ipcRenderer.removeListener('theme:changed', listener)
  },

  // updates
  getUpdateFeedUrl: (): Promise<string> => ipcRenderer.invoke('update:feed:get'),
  setUpdateFeedUrl: (url: string): Promise<string> => ipcRenderer.invoke('update:feed:set', url),
  checkForUpdates: (url?: string): Promise<{
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
  }> => ipcRenderer.invoke('update:check', url),
  getAutoUpdateCheckResult: (): Promise<{
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
  } | null> => ipcRenderer.invoke('update:auto-check:get'),
  downloadUpdate: (assetUrl: string, assetName: string): Promise<{ filePath?: string; error?: string }> =>
    ipcRenderer.invoke('update:download', assetUrl, assetName),
  downloadNativeUpdate: (): Promise<{ mode?: 'native' | 'manual'; error?: string }> =>
    ipcRenderer.invoke('update:download-native'),
  onUpdateDownloadProgress: (cb: (progress: {
    phase: 'downloading' | 'opening' | 'done'
    received: number
    total: number | null
    percent: number | null
  }) => void): (() => void) => {
    const listener = (_e: unknown, progress: {
      phase: 'downloading' | 'opening' | 'done'
      received: number
      total: number | null
      percent: number | null
    }): void => cb(progress)
    ipcRenderer.on('update:download:progress', listener)
    return () => ipcRenderer.removeListener('update:download:progress', listener)
  },
  onAutoUpdateCheckResult: (cb: (result: {
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
  }) => void): (() => void) => {
    const listener = (_e: unknown, result: {
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
    }): void => cb(result)
    ipcRenderer.on('update:auto-check:result', listener)
    return () => ipcRenderer.removeListener('update:auto-check:result', listener)
  },
  openUpdateUrl: (url: string): Promise<void> => ipcRenderer.invoke('update:open', url),

  // ai (configurable: Ollama or any OpenAI-compatible endpoint)
  getAiConfig: (): Promise<{ provider: 'ollama' | 'openai'; baseUrl: string; apiKey: string; model: string }> =>
    ipcRenderer.invoke('ai:config:get'),
  setAiConfig: (config: { provider: 'ollama' | 'openai'; baseUrl: string; apiKey: string; model: string }) =>
    ipcRenderer.invoke('ai:config:set', config),
  aiStatus: (): Promise<{ available: boolean; models: string[] }> =>
    ipcRenderer.invoke('ai:status'),
  /** Max chars of user content fed to the model (long-context config). */
  getMaxContextChars: (): Promise<number> =>
    ipcRenderer.invoke('ai:maxContextChars:get'),
  setMaxContextChars: (v: number): Promise<number> =>
    ipcRenderer.invoke('ai:maxContextChars:set', v),
  aiSummarize: (content: string, model?: string): Promise<string> =>
    ipcRenderer.invoke('ai:summarize', content, model),
  aiChat: (action: 'optimize' | 'variant' | 'compress' | 'translate', content: string, projectContext?: string) =>
    ipcRenderer.invoke('ai:chat', action, content, projectContext),
  aiStructure: (content: string, projectContext?: string, style?: 'concise' | 'detailed' | 'cot' | 'fewshot'): Promise<string> =>
    ipcRenderer.invoke('ai:structure', content, projectContext, style),
  /** Phase 1: Analyze user input + project context → structured JSON.
   *  Optional ragContext carries semantically-retrieved note snippets. */
  aiAnalyze: (content: string, projectContext?: string, ragContext?: string, reqId?: string) =>
    ipcRenderer.invoke('ai:analyze', content, projectContext, ragContext, reqId),
  aiCancelAnalyze: (reqId: string): Promise<void> =>
    ipcRenderer.invoke('ai:analyze:cancel', reqId),
  /** Streaming version of aiStructure. Calls onChunk with the accumulated
   *  text as tokens arrive, then onDone (or onError). Returns a cancel
   *  function that aborts the in-flight request and removes listeners.
   *  When `analysis` + `answers` are provided, uses the generation system
   *  prompt (aware of inferred intent + clarification).
   *
   *  Reasoning support: when the model emits a `reasoning_content` field
   *  (DeepSeek-R1 / o1-style), onReasoning is called with the accumulated
   *  thinking text so the UI can show it in a collapsible block. */
  aiStructureStream: (
    content: string,
    handlers: {
      onChunk: (text: string) => void
      onDone: (text: string, reasoning: string) => void
      onError: (msg: string) => void
      onReasoning?: (text: string) => void
    },
    projectContext?: string,
    style?: 'concise' | 'detailed' | 'cot' | 'fewshot',
    regenerate?: boolean,
    analysis?: unknown,
    answers?: Array<{ id: string; answer: string }>,
    notePath?: string,
    feedback?: string,
    ragContext?: string
  ): (() => void) => {
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { onChunk, onDone, onError, onReasoning } = handlers

    const chunkListener = (_e: unknown, id: string, text: string): void => {
      if (id === reqId) onChunk(text)
    }
    const reasoningListener = (_e: unknown, id: string, text: string): void => {
      if (id === reqId && onReasoning) onReasoning(text)
    }
    const doneListener = (_e: unknown, id: string, text: string, reasoning: string): void => {
      if (id !== reqId) return
      cleanup()
      onDone(text, reasoning)
    }
    const errorListener = (_e: unknown, id: string, msg: string): void => {
      if (id !== reqId) return
      cleanup()
      onError(msg)
    }
    const cleanup = (): void => {
      ipcRenderer.removeListener('ai:structure:chunk', chunkListener)
      ipcRenderer.removeListener('ai:structure:reasoning', reasoningListener)
      ipcRenderer.removeListener('ai:structure:done', doneListener)
      ipcRenderer.removeListener('ai:structure:error', errorListener)
    }

    ipcRenderer.on('ai:structure:chunk', chunkListener)
    ipcRenderer.on('ai:structure:reasoning', reasoningListener)
    ipcRenderer.on('ai:structure:done', doneListener)
    ipcRenderer.on('ai:structure:error', errorListener)
    void ipcRenderer.invoke('ai:structure:stream', content, reqId, projectContext, style, regenerate, analysis, answers, notePath, feedback, ragContext).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      cleanup()
      onError(msg)
    })

    return (): void => {
      cleanup()
      void ipcRenderer.invoke('ai:structure:cancel', reqId)
    }
  },
  aiStructureResetContext: (notePath?: string): Promise<void> =>
    ipcRenderer.invoke('ai:structure:resetContext', notePath),
  aiComplete: (messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>) =>
    ipcRenderer.invoke('ai:complete', messages),

  // project context
  selectProject: (): Promise<string | null> => ipcRenderer.invoke('project:select'),
  selectProjectFile: (): Promise<string | null> => ipcRenderer.invoke('project:selectFile'),
  getProject: (): Promise<string | null> => ipcRenderer.invoke('project:get'),
  clearProject: (): Promise<void> => ipcRenderer.invoke('project:clear'),
  scanProject: () => ipcRenderer.invoke('project:scan'),
  summarizeProject: () => ipcRenderer.invoke('project:summarize'),
  getProjectCache: () => ipcRenderer.invoke('project:getCache'),
  getProjectContext: (): Promise<string | null> => ipcRenderer.invoke('project:getContext'),
  onProjectProgress: (cb: (p: { phase: string; current: number; total: number; file: string }) => void): (() => void) => {
    const listener = (_e: unknown, p: { phase: string; current: number; total: number; file: string }): void => cb(p)
    ipcRenderer.on('project:progress', listener)
    return () => ipcRenderer.removeListener('project:progress', listener)
  },

  // embedding index persistence
  saveIndex: (data: unknown): Promise<void> => ipcRenderer.invoke('index:save', data),
  loadIndex: (): Promise<unknown> => ipcRenderer.invoke('index:load'),

  // vault fs changes
  onVaultChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('vault:changed', listener)
    return () => ipcRenderer.removeListener('vault:changed', listener)
  },

  // application menu → renderer
  onMenuNew: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:new', listener)
    return () => ipcRenderer.removeListener('menu:new', listener)
  },
  onMenuOpenVault: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:open-vault', listener)
    return () => ipcRenderer.removeListener('menu:open-vault', listener)
  },
  onMenuSearch: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:search', listener)
    return () => ipcRenderer.removeListener('menu:search', listener)
  },
  onMenuSettings: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu:settings', listener)
    return () => ipcRenderer.removeListener('menu:settings', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
