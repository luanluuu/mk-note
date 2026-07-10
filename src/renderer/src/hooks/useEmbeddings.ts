import { useCallback, useEffect, useRef, useState } from 'react'
import type { NoteDoc } from '../types'

/**
 * Semantic index for the current vault. Each note is keyed by its path; we
 * keep the mtime so we can skip re-embedding notes that haven't changed.
 */
interface IndexEntry {
  path: string
  title: string
  mtime: number
  embedding: number[]
}

interface EmbedResponse {
  id: number
  ok: boolean
  embeddings?: number[][]
  error?: string
}

export interface SemanticHit {
  path: string
  title: string
  score: number
}

export interface UseEmbeddings {
  /** true while the model is being loaded or notes are being indexed */
  indexing: boolean
  /** number of notes currently in the index */
  indexedCount: number
  /** human-readable status for the search palette footer */
  status: string
  /** embed a free-text query into the same vector space as the notes */
  embed: (query: string) => Promise<number[] | null>
  /** top-k cosine-similarity hits for a query */
  search: (query: string, k?: number) => Promise<SemanticHit[]>
}

const CHUNK = 16

function cosine(a: number[], b: number[]): number {
  // Embeddings are already L2-normalized (the worker uses normalize:true), so
  // the cosine similarity collapses to a plain dot product.
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) sum += a[i] * b[i]
  return sum
}

export function useEmbeddings(vaultPath: string | null): UseEmbeddings {
  const workerRef = useRef<Worker | null>(null)
  const reqId = useRef(0)
  const rebuildRunId = useRef(0)
  const pending = useRef<Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>>(new Map())
  const indexRef = useRef<Map<string, IndexEntry>>(new Map())
  const [indexing, setIndexing] = useState(false)
  const [indexedCount, setIndexedCount] = useState(0)
  const [status, setStatus] = useState('未加载')

  // Spawn the worker once. Using `new URL(..., import.meta.url)` lets Vite
  // bundle the worker as a separate chunk automatically.
  useEffect(() => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/embed.worker.ts', import.meta.url), { type: 'module' })
    } catch (err) {
      console.error('embed worker spawn failed:', err)
      setStatus('语义搜索不可用')
      return
    }
    workerRef.current = worker
    worker.onmessage = (e: MessageEvent<EmbedResponse>) => {
      const { id, ok, embeddings, error } = e.data
      const slot = pending.current.get(id)
      if (!slot) return
      pending.current.delete(id)
      if (ok && embeddings) slot.resolve(embeddings)
      else slot.reject(new Error(error ?? 'embed failed'))
    }
    return () => {
      worker.terminate()
      workerRef.current = null
      pending.current.clear()
    }
  }, [])

  const embedBatch = useCallback((texts: string[]): Promise<number[][]> => {
    const worker = workerRef.current
    if (!worker) return Promise.reject(new Error('worker unavailable'))
    const id = ++reqId.current
    return new Promise((resolve, reject) => {
      pending.current.set(id, { resolve, reject })
      worker.postMessage({ id, type: 'embed', texts })
    })
  }, [])

  const embed = useCallback(
    async (query: string): Promise<number[] | null> => {
      if (!workerRef.current) return null
      try {
        const out = await embedBatch([query])
        return out[0] ?? null
      } catch (err) {
        console.error('query embed failed:', err)
        return null
      }
    },
    [embedBatch]
  )

  const search = useCallback(
    async (query: string, k = 12): Promise<SemanticHit[]> => {
      const q = await embed(query)
      if (!q) return []
      const hits: SemanticHit[] = []
      for (const entry of indexRef.current.values()) {
        hits.push({ path: entry.path, title: entry.title, score: cosine(q, entry.embedding) })
      }
      hits.sort((a, b) => b.score - a.score)
      return hits.slice(0, k)
    },
    [embed]
  )

  const rebuild = useCallback(
    async (vp: string) => {
      if (!workerRef.current) return
      const runId = ++rebuildRunId.current
      const isStale = (): boolean => runId !== rebuildRunId.current
      setIndexing(true)
      try {
        // Load any previously persisted index so we only re-embed changed notes.
        const stored = (await window.api.loadIndex()) as
          | { vaultPath?: string; entries?: IndexEntry[] }
          | null
        if (isStale()) return
        if (stored?.vaultPath === vp && Array.isArray(stored.entries)) {
          indexRef.current = new Map(stored.entries.map((e) => [e.path, e]))
          setIndexedCount(indexRef.current.size)
        } else {
          indexRef.current.clear()
          setIndexedCount(0)
        }

        const notes: NoteDoc[] = await window.api.readAllNotes(vp)
        if (isStale()) return
        const stale = notes.filter((n) => {
          const prev = indexRef.current.get(n.path)
          return !prev || prev.mtime !== n.mtime
        })

        // Drop index entries for notes that no longer exist.
        const live = new Set(notes.map((n) => n.path))
        for (const key of Array.from(indexRef.current.keys())) {
          if (!live.has(key)) indexRef.current.delete(key)
        }

        if (stale.length === 0) {
          setStatus(`已索引 ${indexRef.current.size} 篇`)
          setIndexing(false)
          return
        }

        setStatus(`加载模型中…`)
        for (let i = 0; i < stale.length; i += CHUNK) {
          const slice = stale.slice(i, i + CHUNK)
          const texts = slice.map((n) => truncate(`${n.title}\n${n.content}`))
          let embeddings: number[][]
          try {
            embeddings = await embedBatch(texts)
          } catch (err) {
            if (isStale()) return
            setStatus(`语义索引失败: ${err instanceof Error ? err.message : String(err)}`)
            setIndexing(false)
            return
          }
          if (isStale()) return
          slice.forEach((n, j) => {
            const emb = embeddings[j]
            if (emb) indexRef.current.set(n.path, { path: n.path, title: n.title, mtime: n.mtime, embedding: emb })
          })
          setIndexedCount(indexRef.current.size)
          setStatus(`索引中 ${Math.min(i + CHUNK, stale.length)}/${stale.length}`)
        }

        // Persist the fresh index for next launch.
        try {
          await window.api.saveIndex({
            vaultPath: vp,
            entries: Array.from(indexRef.current.values())
          })
        } catch {
          // persistence is best-effort; in-memory index still works
        }
        if (isStale()) return
        setStatus(`已索引 ${indexRef.current.size} 篇`)
      } catch (err) {
        if (isStale()) return
        setStatus(`索引失败: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (!isStale()) setIndexing(false)
      }
    },
    [embedBatch]
  )

  // Rebuild whenever the vault changes, or when the fs watcher signals a change.
  useEffect(() => {
    if (!vaultPath) {
      rebuildRunId.current++
      indexRef.current.clear()
      setIndexedCount(0)
      setStatus('未加载')
      setIndexing(false)
      return
    }
    void rebuild(vaultPath)
  }, [vaultPath, rebuild])

  useEffect(() => {
    if (!vaultPath) return
    const unsub = window.api.onVaultChanged(() => {
      void rebuild(vaultPath)
    })
    return () => unsub()
  }, [vaultPath, rebuild])

  return { indexing, indexedCount, status, embed, search }
}

// Cap the text fed to the embedder. all-MiniLM-L6-v2 has a 256-token context;
// long notes would otherwise be silently truncated by the tokenizer anyway,
// and we'd rather bound the wall-clock cost of indexing.
function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) : s
}
