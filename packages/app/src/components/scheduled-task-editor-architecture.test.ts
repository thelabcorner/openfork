import { describe, expect, test } from "bun:test"

describe("scheduled task editor architecture", () => {
  test("D30: the global scheduler editor does not acquire ambient workspace context", async () => {
    const source = await Bun.file(new URL("./scheduled-task-editor.tsx", import.meta.url)).text()
    const selector = await Bun.file(new URL("./dialog-select-model.tsx", import.meta.url)).text()

    expect(source).not.toContain('from "@/context/local"')
    expect(source).not.toContain('from "@/context/sdk"')
    expect(source).not.toContain("useLocal()")
    expect(source).not.toContain("useSDK()")
    expect(source).toContain('from "@/context/server-sdk"')
    expect(source).toContain("location: { directory }")
    expect(selector).not.toContain('from "@/context/sdk"')
    expect(selector).not.toContain("useSDK()")
    expect(selector).toContain('from "@/context/server-sdk"')
  })

  test("D31: the scheduler editor owns one custom-scroll V2 modal surface", async () => {
    const source = await Bun.file(new URL("./scheduled-task-editor.tsx", import.meta.url)).text()

    expect(source).toContain('from "@opencode-ai/ui/scroll-view"')
    expect(source).toContain('from "@opencode-ai/ui/v2/dialog-v2"')
    expect(source).toContain('from "@opencode-ai/ui/v2/button-v2"')
    expect(source).toContain('from "@opencode-ai/ui/v2/text-input-v2"')
    expect(source).toContain('from "@opencode-ai/ui/v2/textarea-v2"')
    expect(source).toContain('from "@opencode-ai/ui/v2/select-v2"')
    expect(source.match(/<ScrollView\b/g)?.length).toBe(1)
    expect(source).toContain("<DialogBody")
    expect(source).toContain("<DialogFooter")
    expect(source).toContain("<AutomationIcon")
    expect(source).toContain('language.t("scheduledTasks.summary.title")')
    expect(source).not.toContain('from "@opencode-ai/ui/dialog"')
    expect(source).not.toContain("overflow-y-auto")
    expect(source).not.toContain("max-h-[82vh]")
  })
})
