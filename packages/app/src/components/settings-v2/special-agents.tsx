import { For, createMemo, createSignal, type Component, type JSX } from "solid-js"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useServerSync } from "@/context/server-sync"
import { DEFAULT_PROMPT as DEFAULT_PROMPT_REVISOR } from "@opencode-ai/core/prompt-revisor-prompt"
import { DEFAULT_PROMPT as DEFAULT_AUDITOR_PROMPT } from "@opencode-ai/core/goal/auditor-prompt"
import { DEFAULT_PROMPT as DEFAULT_TITLE_PROMPT, GENERATED_TITLE_TOOL } from "@opencode-ai/core/session/title-prompt"
import { SettingsListV2 } from "./parts/list"
import { SettingsModelCatalogScope } from "./parts/model-catalog-scope"
import { SettingsModelPickerV2 } from "./parts/model-picker"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"
import "./special-agents.css"

const DEFAULT_COMPACTION_PROMPT = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

type SpecialAgentIcon = "pencil-sparkles" | "edit" | "shield-check" | "warning" | "compact"

const specialAgentTopology = [
  {
    icon: "pencil-sparkles",
    label: "settings.general.section.titleGeneration",
    role: "settings.specialAgents.role.naming",
  },
  {
    icon: "edit",
    label: "settings.general.section.promptRevision",
    role: "settings.specialAgents.role.preflight",
  },
  {
    icon: "shield-check",
    label: "settings.general.section.goalAuditor",
    role: "settings.specialAgents.role.verification",
  },
  {
    icon: "warning",
    label: "settings.general.section.spadAuditor",
    role: "settings.specialAgents.role.guardrail",
  },
  {
    icon: "compact",
    label: "settings.general.section.compaction",
    role: "settings.specialAgents.role.context",
  },
] as const

const SpecialAgentCard: Component<{
  icon: SpecialAgentIcon
  title: string
  role: string
  description: string
  children: JSX.Element
}> = (props) => (
  <section class="settings-v2-special-agent-card">
    <div class="settings-v2-special-agent-card-header">
      <div class="settings-v2-special-agent-card-lead">
        <span class="settings-v2-special-agent-card-mark" aria-hidden="true">
          <Icon name={props.icon} />
        </span>
        <div class="settings-v2-special-agent-card-copy">
          <div class="settings-v2-special-agent-card-kicker">{props.role}</div>
          <h3>{props.title}</h3>
          <p>{props.description}</p>
        </div>
      </div>
    </div>
    {props.children}
  </section>
)

const TitlePromptDialog: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const serverSync = useServerSync()
  const savedPrompt = () => settings.general.titleGeneration()?.prompt?.trim()
  const [prompt, setPrompt] = createSignal(savedPrompt() || DEFAULT_TITLE_PROMPT)
  const usesDefaultPrompt = createMemo(() => prompt().trim() === DEFAULT_TITLE_PROMPT.trim())

  const save = () => {
    const next = settings.general.titleGeneration()
    const value = prompt().trim()
    settings.general.setTitleGeneration({
      ...next,
      prompt: value && value !== DEFAULT_TITLE_PROMPT.trim() ? value : undefined,
    })
    void serverSync().updateConfig({
      title_prompt: value && value !== DEFAULT_TITLE_PROMPT.trim() ? value : undefined,
    })
    props.onClose()
  }

  return (
    <Dialog size="x-large" containerClass="!w-[min(calc(100vw-40px),1040px)] !h-[min(calc(100vh-64px),760px)]">
      <DialogHeader>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{language.t("dialog.titlePrompt.title")}</DialogTitle>
          <p data-slot="dialog-description" class="max-w-[720px]">
            {language.t("dialog.titlePrompt.description")}
          </p>
        </div>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-1 flex-col gap-4 overflow-hidden px-5 pt-5 pb-2">
        <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div class="flex min-h-0 flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="inline-flex h-6 select-none items-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 text-[12px] font-[530] leading-none tracking-normal text-v2-text-text-muted"
                data-current={usesDefaultPrompt() ? "" : undefined}
              >
                {language.t("dialog.titlePrompt.default")}
              </span>
              <span class="text-[12px] font-[440] leading-4 tracking-normal text-v2-text-text-muted">
                {usesDefaultPrompt()
                  ? language.t("dialog.titlePrompt.builtin")
                  : language.t("dialog.titlePrompt.custom")}
              </span>
            </div>

            <TextareaV2
              autofocus
              rows={18}
              class="!min-h-0 !w-full !flex-1"
              value={prompt()}
              placeholder={language.t("dialog.titlePrompt.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.titlePrompt.title")}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </div>

          <aside class="flex min-h-0 flex-col gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
            <div class="select-none text-[12px] font-[530] leading-none text-v2-text-text-base">
              {language.t("dialog.titlePrompt.protocol")}
            </div>
            <div class="text-[12px] leading-5 text-v2-text-text-muted">
              {language.t("dialog.titlePrompt.protocolDescription")}
            </div>
            <DividerV2 />
            <div class="flex flex-wrap gap-1.5">
              <code class="rounded-sm bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 font-mono text-[11px] text-v2-text-text-base">
                {GENERATED_TITLE_TOOL}
              </code>
            </div>
            <div class="mt-auto text-[11px] leading-4 text-v2-text-text-faint">
              {language.t("dialog.titlePrompt.contextNote")}
            </div>
          </aside>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="ghost" class="mr-auto" onClick={() => setPrompt(DEFAULT_TITLE_PROMPT)}>
          {language.t("dialog.titlePrompt.reset")}
        </ButtonV2>
        <ButtonV2 type="button" variant="neutral" onClick={props.onClose}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="contrast" onClick={save}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

const CompactionPromptDialog: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const serverSync = useServerSync()
  const savedPrompt = () => settings.general.compaction()?.prompt?.trim()
  const [prompt, setPrompt] = createSignal(savedPrompt() || DEFAULT_COMPACTION_PROMPT)
  const usesDefaultPrompt = createMemo(() => prompt().trim() === DEFAULT_COMPACTION_PROMPT.trim())

  const save = () => {
    const next = settings.general.compaction() ?? {}
    const value = prompt().trim()
    const promptValue = value && value !== DEFAULT_COMPACTION_PROMPT.trim() ? value : undefined
    const hasModels = next.small || next.medium || next.large
    if (promptValue === undefined && !hasModels) {
      settings.general.setCompaction(undefined)
    } else {
      settings.general.setCompaction({ ...next, prompt: promptValue })
    }
    void serverSync().updateConfig({
      compaction: {
        prompt: promptValue,
      },
    } as unknown as Record<string, unknown>)
    props.onClose()
  }

  return (
    <Dialog size="x-large" containerClass="!w-[min(calc(100vw-40px),1040px)] !h-[min(calc(100vh-64px),760px)]">
      <DialogHeader>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{language.t("dialog.compactionPrompt.title")}</DialogTitle>
          <p data-slot="dialog-description" class="max-w-[720px]">
            {language.t("dialog.compactionPrompt.description")}
          </p>
        </div>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-1 flex-col gap-4 overflow-hidden px-5 pt-5 pb-2">
        <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div class="flex min-h-0 flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="inline-flex h-6 select-none items-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 text-[12px] font-[530] leading-none tracking-normal text-v2-text-text-muted"
                data-current={usesDefaultPrompt() ? "" : undefined}
              >
                {language.t("dialog.compactionPrompt.default")}
              </span>
              <span class="text-[12px] font-[440] leading-4 tracking-normal text-v2-text-text-muted">
                {usesDefaultPrompt() ? language.t("settings.general.row.compactionModel.default") : "Custom"}
              </span>
            </div>

            <TextareaV2
              autofocus
              rows={18}
              class="!min-h-0 !w-full !flex-1"
              value={prompt()}
              placeholder={language.t("dialog.compactionPrompt.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.compactionPrompt.title")}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </div>

          <aside class="flex min-h-0 flex-col gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
            <div class="flex flex-col gap-2">
              <div class="select-none text-[12px] font-[530] leading-none tracking-normal text-v2-text-text-base">
                Tokens
              </div>
              <div class="flex flex-col gap-2 text-[12px] font-[440] leading-4 tracking-normal text-v2-text-text-muted">
                <span class="flex items-start gap-2">
                  <code class="mt-[-1px] rounded-sm bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 font-mono text-[11px] text-v2-text-text-base">
                    {"{conversation}"}
                  </code>
                  <span>{language.t("dialog.compactionPrompt.token.conversation")}</span>
                </span>
                <span class="flex items-start gap-2">
                  <code class="mt-[-1px] rounded-sm bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 font-mono text-[11px] text-v2-text-text-base">
                    {"{previousSummary}"}
                  </code>
                  <span>{language.t("dialog.compactionPrompt.token.previousSummary")}</span>
                </span>
              </div>
            </div>

            <DividerV2 />

            <div class="flex min-h-0 flex-1 flex-col gap-2">
              <div class="select-none text-[12px] font-[530] leading-none tracking-normal text-v2-text-text-base">
                {language.t("dialog.compactionPrompt.default")}
              </div>
              <div class="min-h-0 flex-1 overflow-hidden rounded-md border border-v2-border-border-muted bg-v2-background-bg-base">
                <ScrollView class="h-full">
                  <pre
                    class="whitespace-pre-wrap p-3 font-mono text-[12px] leading-5 tracking-normal text-v2-text-text-muted select-none"
                    aria-label={language.t("dialog.compactionPrompt.default")}
                  >
                    {DEFAULT_COMPACTION_PROMPT}
                  </pre>
                </ScrollView>
              </div>
            </div>
          </aside>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="ghost" class="mr-auto" onClick={() => setPrompt(DEFAULT_COMPACTION_PROMPT)}>
          {language.t("dialog.compactionPrompt.reset")}
        </ButtonV2>
        <ButtonV2 type="button" variant="neutral" onClick={props.onClose}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="contrast" onClick={save}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

const AuditorPromptDialog: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const settings = useSettings()
  const serverSync = useServerSync()
  const savedPrompt = () => settings.general.auditor()?.prompt?.trim()
  const [prompt, setPrompt] = createSignal(savedPrompt() || DEFAULT_AUDITOR_PROMPT)
  const usesDefaultPrompt = createMemo(() => prompt().trim() === DEFAULT_AUDITOR_PROMPT.trim())

  const save = () => {
    const value = prompt().trim()
    const promptValue = value && value !== DEFAULT_AUDITOR_PROMPT.trim() ? value : undefined
    settings.general.setAuditor(promptValue ? { prompt: promptValue } : undefined)
    void serverSync().updateConfig({ auditor_prompt: promptValue })
    props.onClose()
  }

  return (
    <Dialog size="x-large" containerClass="!w-[min(calc(100vw-40px),1040px)] !h-[min(calc(100vh-64px),760px)]">
      <DialogHeader>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{language.t("dialog.auditorPrompt.title")}</DialogTitle>
          <p data-slot="dialog-description" class="max-w-[720px]">
            {language.t("dialog.auditorPrompt.description")}
          </p>
        </div>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-1 flex-col gap-4 overflow-hidden px-5 pt-5 pb-2">
        <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div class="flex min-h-0 flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="inline-flex h-6 select-none items-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 text-[12px] font-[530] leading-none tracking-normal text-v2-text-text-muted"
                data-current={usesDefaultPrompt() ? "" : undefined}
              >
                {language.t("dialog.auditorPrompt.default")}
              </span>
              <span class="text-[12px] font-[440] leading-4 tracking-normal text-v2-text-text-muted">
                {usesDefaultPrompt()
                  ? language.t("dialog.auditorPrompt.builtin")
                  : language.t("dialog.auditorPrompt.custom")}
              </span>
            </div>
            <TextareaV2
              autofocus
              rows={18}
              class="!min-h-0 !w-full !flex-1"
              value={prompt()}
              placeholder={language.t("dialog.auditorPrompt.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.auditorPrompt.title")}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </div>
          <aside class="flex min-h-0 flex-col gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
            <div class="select-none text-[12px] font-[530] leading-none text-v2-text-text-base">
              {language.t("dialog.auditorPrompt.capabilities")}
            </div>
            <div class="text-[12px] leading-5 text-v2-text-text-muted">
              {language.t("dialog.auditorPrompt.capabilitiesDescription")}
            </div>
            <DividerV2 />
            <div class="flex flex-wrap gap-1.5">
              <For each={["read", "grep", "glob", "audit_verdict"]}>
                {(name) => (
                  <code class="rounded-sm bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 font-mono text-[11px] text-v2-text-text-base">
                    {name}
                  </code>
                )}
              </For>
            </div>
            <div class="mt-auto text-[11px] leading-4 text-v2-text-text-faint">
              {language.t("dialog.auditorPrompt.modelNote")}
            </div>
          </aside>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="ghost" class="mr-auto" onClick={() => setPrompt(DEFAULT_AUDITOR_PROMPT)}>
          {language.t("dialog.auditorPrompt.reset")}
        </ButtonV2>
        <ButtonV2 type="button" variant="neutral" onClick={props.onClose}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="contrast" onClick={save}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

const PromptRevisionPromptDialog: Component<{ onClose: () => void }> = (props) => {
  const language = useLanguage()
  const serverSync = useServerSync()
  const savedPrompt = () => serverSync().data.config.prompt_revisor_prompt?.trim()
  const [prompt, setPrompt] = createSignal(savedPrompt() || DEFAULT_PROMPT_REVISOR)
  const usesDefaultPrompt = createMemo(() => prompt().trim() === DEFAULT_PROMPT_REVISOR.trim())

  const save = () => {
    const value = prompt().trim()
    const promptValue = value && value !== DEFAULT_PROMPT_REVISOR.trim() ? value : undefined
    void serverSync().updateConfig({ prompt_revisor_prompt: promptValue })
    props.onClose()
  }

  return (
    <Dialog size="x-large" containerClass="!w-[min(calc(100vw-40px),1040px)] !h-[min(calc(100vh-64px),760px)]">
      <DialogHeader>
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <DialogTitle>{language.t("dialog.promptRevisionPrompt.title")}</DialogTitle>
          <p data-slot="dialog-description" class="max-w-[720px]">
            {language.t("dialog.promptRevisionPrompt.description")}
          </p>
        </div>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full flex-1 flex-col gap-4 overflow-hidden px-5 pt-5 pb-2">
        <div class="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div class="flex min-h-0 flex-col gap-3">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="inline-flex h-6 select-none items-center rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-02 px-2 text-[12px] font-[530] leading-none tracking-normal text-v2-text-text-muted"
                data-current={usesDefaultPrompt() ? "" : undefined}
              >
                {language.t("dialog.promptRevisionPrompt.default")}
              </span>
              <span class="text-[12px] font-[440] leading-4 tracking-normal text-v2-text-text-muted">
                {usesDefaultPrompt()
                  ? language.t("dialog.promptRevisionPrompt.builtin")
                  : language.t("dialog.promptRevisionPrompt.custom")}
              </span>
            </div>
            <TextareaV2
              autofocus
              rows={18}
              class="!min-h-0 !w-full !flex-1"
              value={prompt()}
              placeholder={language.t("dialog.promptRevisionPrompt.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.promptRevisionPrompt.title")}
              onInput={(event) => setPrompt(event.currentTarget.value)}
            />
          </div>
          <aside class="flex min-h-0 flex-col gap-3 rounded-md border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-3">
            <div class="select-none text-[12px] font-[530] leading-none text-v2-text-text-base">
              {language.t("dialog.promptRevisionPrompt.capabilities")}
            </div>
            <div class="text-[12px] leading-5 text-v2-text-text-muted">
              {language.t("dialog.promptRevisionPrompt.capabilitiesDescription")}
            </div>
            <DividerV2 />
            <div class="flex flex-wrap gap-1.5">
              <For each={["read", "grep", "glob", "question", "revised_prompt"]}>
                {(name) => (
                  <code class="rounded-sm bg-v2-overlay-simple-overlay-hover px-1.5 py-0.5 font-mono text-[11px] text-v2-text-text-base">
                    {name}
                  </code>
                )}
              </For>
            </div>
            <div class="mt-auto text-[11px] leading-4 text-v2-text-text-faint">
              {language.t("dialog.promptRevisionPrompt.contextNote")}
            </div>
          </aside>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 type="button" variant="ghost" class="mr-auto" onClick={() => setPrompt(DEFAULT_PROMPT_REVISOR)}>
          {language.t("dialog.promptRevisionPrompt.reset")}
        </ButtonV2>
        <ButtonV2 type="button" variant="neutral" onClick={props.onClose}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 type="button" variant="contrast" onClick={save}>
          {language.t("common.save")}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}

const TitleGenerationSection: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const settings = useSettings()
  const serverSync = useServerSync()
  const selectTitleModel = (model: { providerID: string; modelID: string } | undefined) => {
    const next = settings.general.titleGeneration()
    settings.general.setTitleGeneration({ ...next, model })
    void serverSync().updateConfig({
      small_model: model ? `${model.providerID}/${model.modelID}` : undefined,
    })
  }

  return (
    <SpecialAgentCard
      icon="pencil-sparkles"
      title={language.t("settings.general.section.titleGeneration")}
      role={language.t("settings.specialAgents.role.naming")}
      description={language.t("settings.specialAgents.titleGeneration.description")}
    >
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.titleModel.title")}
          description={language.t("settings.general.row.titleModel.description")}
        >
          <div class="flex items-center gap-1.5">
            <SettingsModelPickerV2
              action="settings-title-model"
              value={settings.general.titleGeneration()?.model}
              defaultLabel={language.t("settings.general.row.titleModel.default")}
              onChange={selectTitleModel}
            />
            <TooltipV2 placement="top" gutter={4} value={language.t("settings.general.row.titlePrompt.edit")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                data-action="settings-title-prompt-edit"
                icon={<Icon name="edit" />}
                aria-label={language.t("settings.general.row.titlePrompt.edit")}
                onClick={() => dialog.show(() => <TitlePromptDialog onClose={() => dialog.close()} />)}
              />
            </TooltipV2>
          </div>
        </SettingsRowV2>
      </SettingsListV2>
    </SpecialAgentCard>
  )
}

const PromptRevisionSection: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const settings = useSettings()
  const serverSync = useServerSync()
  const configuredAgentModel = createMemo(() => {
    const value = serverSync().data.config.agent?.["prompt-revisor"]?.model?.trim()
    if (!value) return undefined
    const [providerID, ...parts] = value.split("/")
    const modelID = parts.join("/")
    return providerID && modelID ? { providerID, modelID } : undefined
  })
  const selectModel = (model: { providerID: string; modelID: string } | undefined) => {
    // Persistent selection belongs to the canonical prompt-revisor agent.
    // Renderer preferences own only composer automation toggles.
    void serverSync().updateConfig({
      agent: {
        "prompt-revisor": {
          model: model ? `${model.providerID}/${model.modelID}` : undefined,
        },
      },
    })
  }
  const setAutoBeforeSend = (autoBeforeSend: boolean) => {
    const next = settings.general.promptRevision() ?? {}
    settings.general.setPromptRevision({
      ...next,
      autoBeforeSend: autoBeforeSend || undefined,
      autoSendAfterRevision: autoBeforeSend ? next.autoSendAfterRevision : undefined,
    })
  }
  const setAutoSendAfterRevision = (autoSendAfterRevision: boolean) => {
    const next = settings.general.promptRevision() ?? {}
    settings.general.setPromptRevision({
      ...next,
      autoSendAfterRevision: next.autoBeforeSend === true && autoSendAfterRevision ? true : undefined,
    })
  }

  return (
    <SpecialAgentCard
      icon="edit"
      title={language.t("settings.general.section.promptRevision")}
      role={language.t("settings.specialAgents.role.preflight")}
      description={language.t("settings.specialAgents.promptRevision.description")}
    >
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.promptRevisionModel.title")}
          description={language.t("settings.general.row.promptRevisionModel.description")}
        >
          <div class="flex items-center gap-1.5">
            <SettingsModelPickerV2
              action="settings-prompt-revision-model"
              value={configuredAgentModel()}
              defaultLabel={language.t("settings.general.row.promptRevisionModel.default")}
              onChange={selectModel}
            />
            <TooltipV2 placement="top" gutter={4} value={language.t("settings.general.row.promptRevisionPrompt.edit")}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                data-action="settings-prompt-revision-prompt-edit"
                icon={<Icon name="edit" />}
                aria-label={language.t("settings.general.row.promptRevisionPrompt.edit")}
                onClick={() => dialog.show(() => <PromptRevisionPromptDialog onClose={() => dialog.close()} />)}
              />
            </TooltipV2>
          </div>
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.promptRevisionAutoRevise.title")}
          description={language.t("settings.general.row.promptRevisionAutoRevise.description")}
        >
          <Switch checked={settings.general.promptRevision()?.autoBeforeSend === true} onChange={setAutoBeforeSend} />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.promptRevisionAutoSendAfterRevision.title")}
          description={language.t("settings.general.row.promptRevisionAutoSendAfterRevision.description")}
        >
          <Switch
            checked={settings.general.promptRevision()?.autoSendAfterRevision === true}
            disabled={settings.general.promptRevision()?.autoBeforeSend !== true}
            onChange={setAutoSendAfterRevision}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </SpecialAgentCard>
  )
}

const AuditorSection: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <SpecialAgentCard
      icon="shield-check"
      title={language.t("settings.general.section.goalAuditor")}
      role={language.t("settings.specialAgents.role.verification")}
      description={language.t("settings.specialAgents.goalAuditor.description")}
    >
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.auditorPrompt.title")}
          description={language.t("settings.general.row.auditorPrompt.description")}
        >
          <TooltipV2 placement="top" gutter={4} value={language.t("settings.general.row.auditorPrompt.edit")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              data-action="settings-auditor-prompt-edit"
              icon={<Icon name="edit" />}
              aria-label={language.t("settings.general.row.auditorPrompt.edit")}
              onClick={() => dialog.show(() => <AuditorPromptDialog onClose={() => dialog.close()} />)}
            />
          </TooltipV2>
        </SettingsRowV2>
      </SettingsListV2>
    </SpecialAgentCard>
  )
}

const SpadAuditorSection: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const serverSync = useServerSync()
  const current = () => settings.general.spadAuditor()
  const enabled = () => current()?.enabled !== false

  const setEnabled = (value: boolean) => {
    const next = current() ?? {}
    settings.general.setSpadAuditor({ ...next, enabled: value ? undefined : false })
    void serverSync().updateConfig({
      experimental: {
        spad_auditor: value,
      },
    } as unknown as Record<string, unknown>)
  }

  const selectModel = (model: { providerID: string; modelID: string } | undefined) => {
    const next = current() ?? {}
    settings.general.setSpadAuditor({ ...next, model })
    void serverSync().updateConfig({
      experimental: {
        spad_auditor: enabled(),
        spad_auditor_model: model ? `${model.providerID}/${model.modelID}` : undefined,
      },
    } as unknown as Record<string, unknown>)
  }

  return (
    <SpecialAgentCard
      icon="warning"
      title={language.t("settings.general.section.spadAuditor")}
      role={language.t("settings.specialAgents.role.guardrail")}
      description={language.t("settings.specialAgents.spadAuditor.description")}
    >
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.spadAuditorEnabled.title")}
          description={language.t("settings.general.row.spadAuditorEnabled.description")}
        >
          <Switch checked={enabled()} onChange={setEnabled} />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.spadAuditorModel.title")}
          description={language.t("settings.general.row.spadAuditorModel.description")}
        >
          <SettingsModelPickerV2
            action="settings-spad-auditor-model"
            value={current()?.model}
            defaultLabel={language.t("settings.general.row.spadAuditorModel.default")}
            onChange={selectModel}
          />
        </SettingsRowV2>
      </SettingsListV2>
    </SpecialAgentCard>
  )
}

const CompactionSection: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const settings = useSettings()
  const serverSync = useServerSync()
  const selectCompactionModel =
    (tier: "small" | "medium" | "large") => (model: { providerID: string; modelID: string } | undefined) => {
      const next = settings.general.compaction() ?? {}
      const updated = { ...next, [tier]: model }
      if (!updated.small && !updated.medium && !updated.large && !updated.prompt) {
        settings.general.setCompaction(undefined)
      } else {
        settings.general.setCompaction(updated as typeof next)
      }
      void serverSync().updateConfig({
        compaction: {
          models: {
            small: updated.small ? `${updated.small.providerID}/${updated.small.modelID}` : undefined,
            medium: updated.medium ? `${updated.medium.providerID}/${updated.medium.modelID}` : undefined,
            large: updated.large ? `${updated.large.providerID}/${updated.large.modelID}` : undefined,
          },
        },
      } as unknown as Record<string, unknown>)
    }
  const defaultCompactionLabel = () => language.t("settings.general.row.compactionModel.default")

  return (
    <SpecialAgentCard
      icon="compact"
      title={language.t("settings.general.section.compaction")}
      role={language.t("settings.specialAgents.role.context")}
      description={language.t("settings.specialAgents.compaction.description")}
    >
      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.general.row.compactionModel.small.title")}
          description={language.t("settings.general.row.compactionModel.small.description")}
        >
          <SettingsModelPickerV2
            action="settings-compaction-model-small"
            value={settings.general.compaction()?.small}
            defaultLabel={defaultCompactionLabel()}
            onChange={selectCompactionModel("small")}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.compactionModel.medium.title")}
          description={language.t("settings.general.row.compactionModel.medium.description")}
        >
          <SettingsModelPickerV2
            action="settings-compaction-model-medium"
            value={settings.general.compaction()?.medium}
            defaultLabel={defaultCompactionLabel()}
            onChange={selectCompactionModel("medium")}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.compactionModel.large.title")}
          description={language.t("settings.general.row.compactionModel.large.description")}
        >
          <SettingsModelPickerV2
            action="settings-compaction-model-large"
            value={settings.general.compaction()?.large}
            defaultLabel={defaultCompactionLabel()}
            onChange={selectCompactionModel("large")}
          />
        </SettingsRowV2>
        <SettingsRowV2
          title={language.t("settings.general.row.compactionPrompt.title")}
          description={language.t("settings.general.row.compactionPrompt.description")}
        >
          <TooltipV2 placement="top" gutter={4} value={language.t("settings.general.row.compactionPrompt.edit")}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              data-action="settings-compaction-prompt-edit"
              icon={<Icon name="edit" />}
              aria-label={language.t("settings.general.row.compactionPrompt.edit")}
              onClick={() => dialog.show(() => <CompactionPromptDialog onClose={() => dialog.close()} />)}
            />
          </TooltipV2>
        </SettingsRowV2>
      </SettingsListV2>
    </SpecialAgentCard>
  )
}

export const SettingsSpecialAgentsV2: Component = () => {
  const language = useLanguage()

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-special-agents-header">
        <div class="settings-v2-special-agents-title-group">
          <h2 class="settings-v2-tab-title">{language.t("settings.specialAgents.title")}</h2>
          <Tag variant="accent">{language.t("settings.specialAgents.badge")}</Tag>
        </div>
        <p class="settings-v2-special-agents-intro">{language.t("settings.specialAgents.description")}</p>
      </div>

      <div class="settings-v2-tab-body settings-v2-special-agents">
        <section class="settings-v2-special-agents-hero">
          <div class="settings-v2-special-agents-hero-main">
            <span class="settings-v2-special-agents-hero-mark" aria-hidden="true">
              <Icon name="layers" size="large" />
            </span>
            <div class="settings-v2-special-agents-hero-copy">
              <div class="settings-v2-special-agents-hero-eyebrow">
                {language.t("settings.specialAgents.hero.eyebrow")}
              </div>
              <div class="settings-v2-special-agents-hero-title">
                {language.t("settings.specialAgents.hero.title")}
              </div>
              <p>{language.t("settings.specialAgents.hero.description")}</p>
            </div>
          </div>

          <div class="settings-v2-special-agents-topology">
            <For each={specialAgentTopology}>
              {(agent) => (
                <div class="settings-v2-special-agents-topology-node">
                  <span class="settings-v2-special-agents-topology-icon" aria-hidden="true">
                    <Icon name={agent.icon} />
                  </span>
                  <span class="settings-v2-special-agents-topology-copy">
                    <strong>{language.t(agent.label)}</strong>
                    <span>{language.t(agent.role)}</span>
                  </span>
                </div>
              )}
            </For>
          </div>
        </section>

        <SettingsModelCatalogScope>
          <div class="settings-v2-special-agents-stack">
            <TitleGenerationSection />
            <PromptRevisionSection />
            <AuditorSection />
            <SpadAuditorSection />
            <CompactionSection />
          </div>
        </SettingsModelCatalogScope>
      </div>
    </>
  )
}

export default SettingsSpecialAgentsV2
