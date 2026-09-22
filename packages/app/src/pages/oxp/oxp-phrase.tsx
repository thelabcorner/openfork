import { useLanguage } from "@/context/language"
import type { Phrase } from "./oxp-presentation"

export type Language = ReturnType<typeof useLanguage>

/** Resolves a presentation `Phrase` against the active locale. */
export function say(language: Language, phrase: Phrase): string {
  switch (phrase.kind) {
    case "text":
      return phrase.value
    case "t":
      return language.t(phrase.key, phrase.params)
    case "plural":
      return language.plural(phrase.key, phrase.count)
  }
}
