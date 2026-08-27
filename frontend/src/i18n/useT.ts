import { useTarangStore } from '../state/store'
import { translations, TranslationKey } from './translations'

/**
 * useT() — returns a t(key, vars?) function bound to the current store language.
 * Falls back to English if a key/language combo is somehow missing (should never
 * happen since translations.ts is typed to require every language per key).
 */
export function useT() {
  const language = useTarangStore(s => s.language)
  return function t(key: TranslationKey, vars?: Record<string, string>): string {
    let str = translations[key]?.[language] ?? translations[key]?.en ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) str = str.replace(`{${k}}`, v)
    }
    return str
  }
}
