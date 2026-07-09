type Listener = () => void

const listeners = new Set<Listener>()

/** Subscribe to typing pulses. Returns an unsubscribe function. */
export function subscribeTyping(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Emit a typing pulse (called on each markdown change). */
export function emitTyping(): void {
  listeners.forEach((fn) => fn())
}
