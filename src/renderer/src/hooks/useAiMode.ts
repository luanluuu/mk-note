import { useEffect, useState } from 'react'

const STORAGE_KEY = 'ai-mode-enabled'

/**
 * 全局 AI 模式开关。开启时编辑器显示 AI 工具栏和实时预览浮层，
 * 关闭时是纯净的文档编辑器。状态持久化到 localStorage。
 */
export function useAiMode(): { aiMode: boolean; toggleAiMode: () => void; setAiMode: (v: boolean) => void } {
  const [aiMode, setAiModeState] = useState<boolean>(() => {
    return localStorage.getItem(STORAGE_KEY) === '1'
  })

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, aiMode ? '1' : '0')
  }, [aiMode])

  const setAiMode = (v: boolean): void => setAiModeState(v)
  const toggleAiMode = (): void => setAiModeState((v) => !v)

  return { aiMode, toggleAiMode, setAiMode }
}
