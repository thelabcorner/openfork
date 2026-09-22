import { createMemo, Show, type JSX } from "solid-js"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { relativizeProjectPath } from "./search-results"

export interface ToolFileAccordionProps {
  path: string
  /** Project root to strip from the displayed directory. Omit to show it verbatim. */
  directory?: string
  actions?: JSX.Element
  children: JSX.Element
}

/**
 * One file's header inside a tool expansion, pinned under the tool row.
 *
 * Kept out of `message-part.tsx` so renderers that only need the file header —
 * git, patch, the OXP activity transcript — do not have to import the whole
 * timeline module (and with it markdown, shiki and the diff virtualizer) to draw
 * one accordion. `message-part` re-exports a wrapper that binds the session's
 * project directory; consumers without that context pass paths already relative.
 */
export function ToolFileAccordion(props: ToolFileAccordionProps) {
  const value = createMemo(() => props.path || "tool-file")
  const directory = createMemo(() => relativizeProjectPath(getDirectory(props.path), props.directory))

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      // Pins directly beneath the tool row, which pins at --sticky-accordion-top.
      style={{ "--sticky-accordion-offset": "var(--tool-sticky-row-height, 30px)" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`‪${directory()}‬`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}
