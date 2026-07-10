import { useEffect, useState } from 'react'
import type { AiConfig, AiProvider, AiStatus, UpdateCheckResult, UpdateDownloadProgress } from '../types'

interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
}

const PRESETS: Record<AiProvider, { baseUrl: string; model: string; label: string; hint: string; examples: string[] }> = {
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:7b-instruct',
    label: 'Ollama（本地）',
    hint: '本地运行的 LLM，无需 API Key。先安装 ollama 并拉取模型。',
    examples: ['qwen2.5:7b-instruct', 'llama3.1:8b', 'phi3:mini']
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    label: 'OpenAI 兼容 API',
    hint: '支持 OpenAI、DeepSeek、Moonshot、Together 等兼容 /v1/chat/completions 的服务。Base URL 只填到域名即可，无需带 /v1。',
    examples: ['gpt-4o-mini', 'deepseek-chat', 'deepseek-reasoner', 'moonshot-v1-8k']
  }
}

const CONTEXT_PRESETS = [
  { value: 8000, label: '8K（小模型）' },
  { value: 32768, label: '32K（默认）' },
  { value: 65536, label: '64K（长文本）' },
  { value: 131072, label: '128K（超长上下文）' }
]

function fuzzyScoreModel(model: string, query: string): number {
  const target = model.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return 1
  if (target === normalizedQuery) return 1000
  if (target.includes(normalizedQuery)) return 800 - target.indexOf(normalizedQuery)

  const tokens = normalizedQuery.split(/[\s:/_.-]+/).filter(Boolean)
  if (tokens.length === 0) return 1

  let score = 0
  for (const token of tokens) {
    const idx = target.indexOf(token)
    if (idx >= 0) {
      score += 120 - idx
      continue
    }
    let cursor = 0
    let tokenScore = 0
    for (const ch of token) {
      const found = target.indexOf(ch, cursor)
      if (found < 0) {
        tokenScore = 0
        break
      }
      tokenScore += Math.max(1, 18 - (found - cursor))
      cursor = found + 1
    }
    if (tokenScore === 0) return 0
    score += tokenScore
  }
  return score
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function SettingsPanel({ isOpen, onClose }: SettingsPanelProps): JSX.Element | null {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [maxCtx, setMaxCtx] = useState<number>(32768)
  const [ctxDirty, setCtxDirty] = useState(false)
  const [updateFeedUrl, setUpdateFeedUrl] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [downloadingUpdate, setDownloadingUpdate] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  const [downloadResult, setDownloadResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [downloadProgress, setDownloadProgress] = useState<UpdateDownloadProgress | null>(null)
  const [modelSearch, setModelSearch] = useState('')

  useEffect(() => {
    if (!isOpen) return
    setTestResult(null)
    setModels([])
    setModelSearch('')
    setCtxDirty(false)
    setUpdateResult(null)
    setDownloadResult(null)
    setDownloadProgress(null)
    void window.api.getAiConfig().then((c) => setConfig(c))
    void window.api.getMaxContextChars().then((v) => setMaxCtx(v))
    void window.api.getUpdateFeedUrl().then((url) => setUpdateFeedUrl(url))
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return undefined
    return window.api.onUpdateDownloadProgress((progress) => {
      setDownloadProgress(progress)
    })
  }, [isOpen])

  if (!isOpen || !config) return null

  const update = (patch: Partial<AiConfig>): void => {
    setConfig({ ...config, ...patch })
    setTestResult(null)
  }

  const switchProvider = (provider: AiProvider): void => {
    const preset = PRESETS[provider]
    setConfig({ ...config, provider, baseUrl: preset.baseUrl, model: preset.model })
    setTestResult(null)
    setModels([])
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      await window.api.setAiConfig(config)
      const status: AiStatus = await window.api.aiStatus()
      setModels(status.models)
      if (status.available) {
        setTestResult({ ok: true, message: `连接成功，共 ${status.models.length} 个模型可用` })
      } else {
        setTestResult({ ok: false, message: '无法连接，请检查地址和服务状态' })
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    await window.api.setAiConfig(config)
    if (ctxDirty) {
      await window.api.setMaxContextChars(maxCtx)
    }
    await window.api.setUpdateFeedUrl(updateFeedUrl)
    onClose()
  }

  const checkUpdate = async (): Promise<void> => {
    setCheckingUpdate(true)
    setUpdateResult(null)
    try {
      const trimmed = updateFeedUrl.trim()
      await window.api.setUpdateFeedUrl(trimmed)
      const result = await window.api.checkForUpdates(trimmed)
      setUpdateResult(result)
      setDownloadResult(null)
      setDownloadProgress(null)
    } catch (err) {
      setUpdateResult({
        currentVersion: '',
        latestVersion: null,
        hasUpdate: false,
        error: err instanceof Error ? err.message : String(err)
      })
    } finally {
      setCheckingUpdate(false)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    if (!updateResult?.assetUrl || !updateResult.assetName) return
    setDownloadingUpdate(true)
    setDownloadResult(null)
    setDownloadProgress({
      phase: 'downloading',
      received: 0,
      total: updateResult.assetSize ?? null,
      percent: updateResult.assetSize ? 0 : null
    })
    try {
      const result = await window.api.downloadUpdate(updateResult.assetUrl, updateResult.assetName)
      if (result.error) {
        setDownloadResult({ ok: false, message: `下载失败：${result.error}` })
      } else {
        setDownloadResult({ ok: true, message: '安装包已下载并打开，应用即将退出以便完成安装。' })
      }
    } catch (err) {
      setDownloadResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setDownloadingUpdate(false)
    }
  }

  const preset = PRESETS[config.provider]
  const modelQuery = modelSearch.trim().toLowerCase()
  const filteredModels = modelQuery
    ? models
      .map((model) => ({ model, score: fuzzyScoreModel(model, modelQuery) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))
      .map((item) => item.model)
    : models
  const downloadPercent = downloadProgress?.percent ?? null
  const downloadProgressLabel = downloadProgress
    ? downloadProgress.phase === 'opening'
      ? '正在打开安装包…'
      : downloadProgress.phase === 'done'
        ? '安装包已打开'
        : downloadPercent !== null
          ? `下载中 ${downloadPercent}%`
          : `下载中 ${formatBytes(downloadProgress.received)}`
    : null

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-panel__head">
          <span className="settings-panel__title">设置</span>
          <button className="settings-panel__close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="settings-panel__body">
          <section className="settings-section">
            <h3 className="settings-section__title">AI 服务</h3>

            <div className="settings-field">
              <label className="settings-field__label">服务类型</label>
              <div className="settings-field__radios">
                {(Object.keys(PRESETS) as AiProvider[]).map((p) => (
                  <label key={p} className="settings-radio">
                    <input
                      type="radio"
                      name="provider"
                      checked={config.provider === p}
                      onChange={() => switchProvider(p)}
                    />
                    <span>{PRESETS[p].label}</span>
                  </label>
                ))}
              </div>
              <p className="settings-field__hint">{preset.hint}</p>
            </div>

            <div className="settings-field">
              <label className="settings-field__label">服务地址 (Base URL)</label>
              <input
                className="settings-input"
                type="text"
                value={config.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder={preset.baseUrl}
              />
              <p className="settings-field__hint">
                只填到域名即可，例如 <code>https://api.deepseek.com</code>。
                无需带 <code>/v1</code> 或 <code>/chat/completions</code>。
              </p>
            </div>

            {config.provider === 'openai' && (
              <div className="settings-field">
                <label className="settings-field__label">API Key</label>
                <input
                  className="settings-input"
                  type="password"
                  value={config.apiKey}
                  onChange={(e) => update({ apiKey: e.target.value })}
                  placeholder="sk-..."
                  autoComplete="off"
                />
                <p className="settings-field__hint">密钥仅保存在本地 settings.json，不会上传。</p>
              </div>
            )}

            <div className="settings-field">
              <label className="settings-field__label">模型</label>
              <input
                className="settings-input"
                type="text"
                value={config.model}
                onChange={(e) => update({ model: e.target.value })}
                placeholder={preset.model}
              />
              {models.length > 0 && (
                <div className="settings-model-list">
                  <div className="settings-model-list__head">
                    <span className="settings-model-list__label">服务端可用模型：{models.length} 个</span>
                    {modelSearch && <span className="settings-model-list__count">匹配 {filteredModels.length} 个</span>}
                  </div>
                  {models.length > 8 && (
                    <input
                      className="settings-input settings-input--compact"
                      type="search"
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      placeholder="搜索模型，例如 qwen / gpt / reasoner"
                    />
                  )}
                  <div className="settings-model-list__scroll">
                    {filteredModels.length > 0 ? (
                      filteredModels.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`settings-model-chip${config.model === m ? ' settings-model-chip--active' : ''}`}
                          onClick={() => update({ model: m })}
                        >
                          {m}
                        </button>
                      ))
                    ) : (
                      <span className="settings-model-list__empty">没有匹配的模型</span>
                    )}
                  </div>
                </div>
              )}
              <p className="settings-field__hint">
                常用模型：
                {preset.examples.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="settings-model-chip"
                    onClick={() => update({ model: m })}
                  >
                    {m}
                  </button>
                ))}
              </p>
            </div>

            <div className="settings-field">
              <label className="settings-field__label">长上下文上限（字符数）</label>
              <div className="settings-field__radios">
                {CONTEXT_PRESETS.map((p) => (
                  <label key={p.value} className="settings-radio">
                    <input
                      type="radio"
                      name="maxCtx"
                      checked={maxCtx === p.value}
                      onChange={() => { setMaxCtx(p.value); setCtxDirty(true) }}
                    />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
              <p className="settings-field__hint">
                控制喂给模型的用户内容长度上限。标书等长文档建议 64K+；小本地模型（如 7B）建议 8K-32K 避免显存溢出。
                长上下文模型（deepseek-v3、qwen2.5-128k、gpt-4o）可设到 128K 以分析整本标书。
              </p>
            </div>

            <div className="settings-actions">
              <button
                className="settings-actions__btn"
                onClick={() => void test()}
                disabled={testing}
              >
                {testing ? '测试中…' : '测试连接'}
              </button>
              <button
                className="settings-actions__btn settings-actions__btn--primary"
                onClick={() => void save()}
              >
                保存
              </button>
            </div>

            {testResult && (
              <p className={`settings-test${testResult.ok ? ' settings-test--ok' : ' settings-test--fail'}`}>
                {testResult.message}
              </p>
            )}
          </section>

          <section className="settings-section settings-section--split">
            <h3 className="settings-section__title">应用更新</h3>

            <div className="settings-field">
              <label className="settings-field__label">发布源（默认已配置）</label>
              <input
                className="settings-input"
                type="text"
                value={updateFeedUrl}
                onChange={(e) => {
                  setUpdateFeedUrl(e.target.value)
                  setUpdateResult(null)
                  setDownloadResult(null)
                  setDownloadProgress(null)
                }}
                placeholder="luanluuu/mk-note"
              />
              <p className="settings-field__hint">
                默认使用本项目的 GitHub Release。也支持 GitHub 仓库地址、<code>owner/repo</code>，或 <code>https://api.github.com/repos/owner/repo/releases/latest</code>。
                发布新版本时用 <code>v0.2.0</code> 这类 release tag。
              </p>
            </div>

            <div className="settings-actions settings-actions--compact">
              <button
                className="settings-actions__btn"
                onClick={() => void checkUpdate()}
                disabled={checkingUpdate || downloadingUpdate}
              >
                {checkingUpdate ? '检查中…' : '检查更新'}
              </button>
              {updateResult?.hasUpdate && updateResult.assetUrl && updateResult.assetName && (
                <button
                  className="settings-actions__btn settings-actions__btn--primary"
                  onClick={() => void downloadUpdate()}
                  disabled={downloadingUpdate}
                >
                  {downloadingUpdate ? (downloadProgressLabel ?? '下载中…') : '下载并安装'}
                </button>
              )}
              {updateResult?.releaseUrl && (!updateResult.hasUpdate || !updateResult.assetUrl) && (
                <button
                  className="settings-actions__btn"
                  onClick={() => void window.api.openUpdateUrl(updateResult.releaseUrl as string)}
                >
                  打开发布页
                </button>
              )}
            </div>

            {downloadProgress && (
              <div className="settings-update-progress" role="status" aria-live="polite">
                <div className="settings-update-progress__meta">
                  <span>{downloadProgressLabel}</span>
                  <span>
                    {downloadProgress.total
                      ? `${formatBytes(downloadProgress.received)} / ${formatBytes(downloadProgress.total)}`
                      : `${formatBytes(downloadProgress.received)} 已下载`}
                  </span>
                </div>
                <div
                  className={`settings-update-progress__bar${downloadProgress.percent === null ? ' settings-update-progress__bar--indeterminate' : ''}`}
                >
                  <div
                    className="settings-update-progress__fill"
                    style={{ width: `${downloadProgress.percent ?? 35}%` }}
                  />
                </div>
                {downloadProgress.phase === 'opening' && (
                  <div className="settings-update-progress__hint">安装包打开后，当前应用会自动退出，安装器即可替换应用文件。</div>
                )}
              </div>
            )}

            {updateResult && (
              <div className={`settings-update-result${updateResult.hasUpdate ? ' settings-update-result--new' : ''}${updateResult.error ? ' settings-update-result--fail' : ''}`}>
                {updateResult.error ? (
                  <div>检查失败：{updateResult.error === 'UPDATE_FEED_NOT_CONFIGURED' ? '请先填写发布源' : updateResult.error}</div>
                ) : (
                  <>
                    <div className="settings-update-result__line">
                      当前版本 <code>{updateResult.currentVersion}</code>
                      {updateResult.latestVersion && <> · 最新版本 <code>{updateResult.latestVersion}</code></>}
                    </div>
                    <div className="settings-update-result__line">
                      {updateResult.hasUpdate
                        ? (updateResult.assetName ? `发现新版本：${updateResult.assetName}` : '发现新版本，但没有找到适合当前系统的安装包。')
                        : '当前已经是最新版本。'}
                    </div>
                    {updateResult.releaseName && (
                      <div className="settings-update-result__title">{updateResult.releaseName}</div>
                    )}
                    {updateResult.notes && (
                      <pre className="settings-update-result__notes">{updateResult.notes}</pre>
                    )}
                  </>
                )}
              </div>
            )}
            {downloadResult && (
              <p className={`settings-test${downloadResult.ok ? ' settings-test--ok' : ' settings-test--fail'}`}>
                {downloadResult.message}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
