/** Send / Stop concept lab — concept contract. DEV-ONLY. */

import type { Component } from "solid-js"
import type { LabActions, LabModel } from "./types"

export type LabConceptId = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k"

export type LabConceptProps = {
  model: LabModel
  actions: LabActions
}

export type LabConcept = {
  id: LabConceptId
  name: string
  tagline: string
  /** Rendered into the real `PromptInputV2` `submitControl` slot. */
  Control: Component<LabConceptProps>
  /**
   * Optional composer-level chrome, stretched over the composer form. Only
   * Concept E uses it; it exists because "where does turn state live" is one of
   * the axes the five concepts are supposed to disagree about.
   */
  Overlay?: Component<LabConceptProps>
  /**
   * Rendered into the shell's `revisionControl` slot — the footer's leading
   * cluster, where production already puts the prompt revisor button. Only
   * Concept H uses it, because "is this menu even Send's to own?" is one of the
   * questions the hybrids are meant to disagree about.
   */
  Leading?: Component<LabConceptProps>
  /** The concept absorbs the live-rate readout, so the footer slot stays empty. */
  hidesLiveRate?: boolean
  notes: {
    /** The central interaction idea. */
    idea: string
    /** How Send vs Stop is communicated. */
    signal: string
    /** What makes it meaningfully different from the other four. */
    distinct: string
    /** Primary tradeoff. */
    tradeoff: string
    /**
     * Where the concept deliberately departs from the semantics shipping today
     * (`resolvePromptPrimaryAction` + `stopping = working && blank`). Stated
     * explicitly so nothing here looks like an accidental behaviour change.
     */
    deviation?: string
  }
}
