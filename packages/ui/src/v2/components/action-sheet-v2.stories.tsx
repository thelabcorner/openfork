import { createSignal, For } from "solid-js"
import { ActionSheet, ActionSheetItem } from "./action-sheet-v2"
import { ButtonV2 } from "./button-v2"

const docs = `### Overview
Action sheet: an opinionated bottom sheet for action menus. Replaces
dropdown-menu on coarse pointers (docs/pwa-mobile/02-design-system.md §4 #4,
§5.2). Renders a cancel row automatically; items dismiss the sheet on select.

### API
- \`ActionSheet\`: bottom-sheet root passthrough (\`open\`, \`onOpenChange\`,
  \`snapPoints\`, ...) plus \`title\` and \`description\` slots.
- \`ActionSheetItem\`: \`destructive?\`, \`disabled?\`, \`onSelect?\`.
- \`ActionSheetCancel\`: optional custom label; defaults to the i18n "Cancel".

### Accessibility
- Dialog semantics from corvu drawer; title/description map to
  Label/Description. Destructive rows are color-coded, never color-only
  (pair with copy).

### Theming/tokens
- Uses \`data-component="action-sheet-v2"\` and slot attributes; oc-2/v2 tokens
  only. Destructive rows use the v2 state-danger foreground token.
`

export default {
  title: "UI V2/ActionSheet",
  id: "components-action-sheet-v2",
  component: ActionSheet,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => {
    const [open, setOpen] = createSignal(false)
    const [picked, setPicked] = createSignal("")
    return (
      <>
        <ButtonV2 variant="neutral" onClick={() => setOpen(true)}>
          Open action sheet
        </ButtonV2>
        <span style={{ "margin-left": "12px" }}>{picked()}</span>
        <ActionSheet open={open()} onOpenChange={setOpen} title="Session" description="github.com/anomalyco/opencode">
          <ActionSheetItem onSelect={() => setPicked("Renamed")}>Rename</ActionSheetItem>
          <ActionSheetItem onSelect={() => setPicked("Duplicated")}>Duplicate</ActionSheetItem>
          <ActionSheetItem onSelect={() => setPicked("Archived")}>Archive</ActionSheetItem>
        </ActionSheet>
      </>
    )
  },
}

export const Destructive = {
  render: () => {
    const [open, setOpen] = createSignal(false)
    return (
      <>
        <ButtonV2 variant="neutral" onClick={() => setOpen(true)}>
          Open destructive sheet
        </ButtonV2>
        <ActionSheet
          open={open()}
          onOpenChange={setOpen}
          title="Delete session?"
          description="The transcript and its changes will be removed. This cannot be undone."
        >
          <ActionSheetItem destructive onSelect={() => setOpen(false)}>
            Delete session
          </ActionSheetItem>
        </ActionSheet>
      </>
    )
  },
}

export const ManyItems = {
  render: () => {
    const [open, setOpen] = createSignal(false)
    return (
      <>
        <ButtonV2 variant="neutral" onClick={() => setOpen(true)}>
          Open long action sheet
        </ButtonV2>
        <ActionSheet open={open()} onOpenChange={setOpen} title="Share">
          <For each={["Copy link", "Messages", "Mail", "Notes", "Slack", "Save to files"]}>
            {(label) => <ActionSheetItem onSelect={() => setOpen(false)}>{label}</ActionSheetItem>}
          </For>
        </ActionSheet>
      </>
    )
  },
}
