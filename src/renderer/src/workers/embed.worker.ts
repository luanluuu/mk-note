/**
 * Web Worker that runs the sentence-embedding model (all-MiniLM-L6-v2 via
 * transformers.js) off the main thread so indexing a vault doesn't freeze the
 * editor. The model (~23MB) is downloaded from the HF hub on first use and
 * cached in the browser cache; subsequent loads are local.
 */
import { pipeline, env } from '@xenova/transformers'

// We only ever fetch the model from the hub (no local ./models dir).
env.allowLocalModels = false

// The library's `pipeline` return type is a huge union over every task kind.
// We only ever use feature-extraction with mean pooling, so narrow it to a
// minimal callable shape to keep the compiler happy.
interface FeatureExtractionOutput {
  tolist: () => number[][]
}
interface FeatureExtractor {
  (texts: string[], options: { pooling: 'mean'; normalize: true }): Promise<FeatureExtractionOutput>
}

let extractorPromise: Promise<FeatureExtractor> | null = null

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') as Promise<FeatureExtractor>
  }
  return extractorPromise
}

interface EmbedRequest {
  id: number
  type: 'embed'
  texts: string[]
}

interface EmbedResponse {
  id: number
  ok: boolean
  embeddings?: number[][]
  error?: string
}

async function embed(texts: string[]): Promise<number[][]> {
  const extractor = await getExtractor()
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}

self.onmessage = async (e: MessageEvent<EmbedRequest>): Promise<void> => {
  const { id, type, texts } = e.data
  if (type !== 'embed') return
  try {
    const embeddings = await embed(texts)
    const res: EmbedResponse = { id, ok: true, embeddings }
    ;(self as unknown as Worker).postMessage(res)
  } catch (err) {
    const res: EmbedResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
    ;(self as unknown as Worker).postMessage(res)
  }
}
