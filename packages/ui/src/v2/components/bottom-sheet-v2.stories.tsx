import { createSignal } from "solid-js"
import { BottomSheet, BottomSheetBody, BottomSheetDescription, BottomSheetFooter, BottomSheetHeader, BottomSheetTitle } from "./bottom-sheet-v2"
import { ButtonV2 } from "./button-v2"

const docs = `### Overview
Mobile bottom sheet built on @corvu/drawer with bottom-side styling: grabber,
rounded top corners, drag-to-dismiss with snap points (detents).

The visual-viewport max-height clamp is built into the primitive
(docs/pwa-mobile/06-pwa-platform.md §2.4): the sheet never extends under the
software keyboard and no consumer needs to read visualViewport.

### API
- \`BottomSheet\`: corvu drawer root passthrough (\`open\`, \`onOpenChange\`,
  \`snapPoints\`, \`defaultSnapPoint\`, \`activeSnapPoint\`,
  \`onActiveSnapPointChange\`, ...), \`clampToVisualViewport\` (default true),
  \`class\`, \`overlayClass\`.
- \`BottomSheetHeader\`, \`BottomSheetTitle\`, \`BottomSheetDescription\`,
  \`BottomSheetBody\` (scrollable), \`BottomSheetFooter\` (safe-area padded).

### Accessibility
- Dialog semantics, focus trapping, Escape/outside-click closing provided by
  corvu drawer. Title/description map to drawer Label/Description.

### Theming/tokens
- Uses \`data-component="bottom-sheet-v2"\`, \`data-component="bottom-sheet-overlay-v2"\`
  and slot attributes; oc-2/v2 tokens only.
`

export default {
  title: "UI V2/BottomSheet",
  id: "components-bottom-sheet-v2",
  component: BottomSheet,
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
    return (
      <>
        <ButtonV2 variant="neutral" onClick={() => setOpen(true)}>
          Open bottom sheet
        </ButtonV2>
        <BottomSheet open={open()} onOpenChange={setOpen}>
          <BottomSheetHeader>
            <BottomSheetTitle>Session options</BottomSheetTitle>
            <BottomSheetDescription>Choose an action for this session.</BottomSheetDescription>
          </BottomSheetHeader>
          <BottomSheetBody>
            <div style={{ padding: "16px" }}>Sheet body content scrolls independently.</div>
          </BottomSheetBody>
          <BottomSheetFooter>
            <ButtonV2 variant="contrast" onClick={() => setOpen(false)}>
              Done
            </ButtonV2>
          </BottomSheetFooter>
        </BottomSheet>
      </>
    )
  },
}

export const Detents = {
  render: () => {
    const [open, setOpen] = createSignal(false)
    return (
      <>
        <ButtonV2 variant="neutral" onClick={() => setOpen(true)}>
          Open sheet with detents
        </ButtonV2>
        <BottomSheet open={open()} onOpenChange={setOpen} snapPoints={[0.35, 0.7, 1]} defaultSnapPoint={1}>
          <BottomSheetHeader>
            <BottomSheetTitle>Draggable sheet</BottomSheetTitle>
            <BottomSheetDescription>Drag the grabber to snap between peek, half, and full.</BottomSheetDescription>
          </BottomSheetHeader>
          <BottomSheetBody>
            <div style={{ padding: "16px" }}>Peek / half / full detents.</div>
          </BottomSheetBody>
        </BottomSheet>
      </>
    )
  },
}

export const LongContent = {
  render: () => {
    const [open, setOpen] = createSignal(false)
    return (
      <>
        <ButtonV2 variant="neutral" onClick={() => setOpen(true)}>
          Open sheet with long content
        </ButtonV2>
        <BottomSheet open={open()} onOpenChange={setOpen}>
          <BottomSheetHeader>
            <BottomSheetTitle>Long content</BottomSheetTitle>
            <BottomSheetDescription>The body clamps to the viewport and scrolls.</BottomSheetDescription>
          </BottomSheetHeader>
          <BottomSheetBody>
            <div style={{ padding: "16px", display: "grid", gap: "8px" }}>
              {Array.from({ length: 40 }, (_, index) => (
                <div style={{ padding: "8px", background: "var(--v2-background-bg-layer-02)", "border-radius": "6px" }}>
                  Row {index + 1}
                </div>
              ))}
            </div>
          </BottomSheetBody>
        </BottomSheet>
      </>
    )
  },
}
