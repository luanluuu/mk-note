import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { Crepe } from '@milkdown/crepe'
import { replaceAll } from '@milkdown/utils'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { emitTyping } from '../lib/typingBus'

interface MarkdownEditorProps {
  path: string
  /** Fired (debounced) with the latest markdown so parents can react to it. */
  onContentChange?: (markdown: string) => void
  /** Parent installs a function here that overwrites the editor's content. */
  onApplyRef?: MutableRefObject<((text: string) => void) | null>
}

const SAVE_DEBOUNCE_MS = 500

export function MarkdownEditor({ path, onContentChange, onApplyRef }: MarkdownEditorProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  // Keep a live handle to the editor instance so the apply() closure can reach it.
  const crepeRef = useRef<Crepe | null>(null)

  useEffect(() => {
    let destroyed = false
    let crepe: Crepe | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleSave = (markdown: string): void => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        void window.api.writeNote(path, markdown)
      }, SAVE_DEBOUNCE_MS)
    }

    ;(async () => {
      let content: string
      try {
        content = await window.api.readNote(path)
      } catch {
        // File no longer exists (moved/deleted externally). Bail out without
        // creating an editor so we never flush empty content back over it.
        return
      }
      if (destroyed || !rootRef.current) return

      const instance = new Crepe({
        root: rootRef.current,
        defaultValue: content
      })

      let initialized = false
      instance.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          // Skip the first event fired during initialization.
          if (!initialized) return
          emitTyping()
          scheduleSave(markdown)
          onContentChange?.(markdown)
        })
      })

      await instance.create()
      if (destroyed) {
        void instance.destroy()
        return
      }
      initialized = true
      crepe = instance
      crepeRef.current = instance
      // Notify parent of the initial content so the preview panel can run.
      onContentChange?.(content)
    })()

    return () => {
      destroyed = true
      crepeRef.current = null
      if (saveTimer) clearTimeout(saveTimer)
      if (crepe) {
        // Flush the latest content before tearing the editor down.
        const instance = crepe
        crepe = null
        let current: string | null = null
        try {
          current = instance.getMarkdown()
        } catch {
          // getMarkdown can throw on some edge cases (e.g. a code block with
          // no language). Fall back to whatever the debounce already saved.
          current = null
        }
        const done = current !== null ? window.api.writeNote(path, current) : Promise.resolve()
        void done.finally(() => {
          void instance.destroy()
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  // Install the apply() function on the parent-supplied ref. When the parent
  // calls it (from AI panels), we replace the entire editor document.
  useEffect(() => {
    if (!onApplyRef) return
    onApplyRef.current = (text: string): void => {
      const instance = crepeRef.current
      if (!instance) return
      try {
        instance.editor.action(replaceAll(text))
        // Persist immediately so the file matches what the user sees.
        void window.api.writeNote(path, text)
        onContentChange?.(text)
      } catch (err) {
        console.error('Failed to apply AI text to editor:', err)
      }
    }
    return () => {
      if (onApplyRef) onApplyRef.current = null
    }
  }, [path, onContentChange, onApplyRef])

  return <div className="milkdown-root" ref={rootRef} />
}
