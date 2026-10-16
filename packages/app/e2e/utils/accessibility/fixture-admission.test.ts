import { describe, expect, test } from "bun:test"
import {
  assertInertFixtureText,
  assertInertFixtureTree,
  isInertFixtureText,
  UnsafeFixturePayloadError,
  type UnsafeFixtureRuleId,
} from "./fixture-admission"

describe("inert accessibility fixture admission", () => {
  test("admits realistic inert fixture text", () => {
    const inert = [
      "Audit complete — 2 findings reviewed.",
      "bun install",
      "sleep 10 && echo done",
      "https://example.com/one",
      "@@ -1 +1 @@\n-export const retry = false\n+export const retry = true",
      "Deploy to Staging first",
      "still running",
      "Which environment should ship first?",
      "100% complete (3/3)",
      "path=C:/Users/dev/project",
      "list -la --color=never",
      "Tom & Jerry finished",
    ]
    for (const value of inert) {
      expect(isInertFixtureText(value)).toBe(true)
      expect(assertInertFixtureText(value, "probe")).toBe(value)
    }
  })

  const hostile: { rule: UnsafeFixtureRuleId; value: string }[] = [
    { rule: "markup-delimiter", value: "<script>alert(1)</script>" },
    // Attribution follows provenance: the raw `<` is what injects markup, so it
    // outranks the inline handler it happens to carry.
    { rule: "markup-delimiter", value: "<img src=x onerror=alert(1)>" },
    { rule: "markup-delimiter", value: "3 < 5" },
    { rule: "html-comment", value: "<!-- comment -->" },
    { rule: "html-comment", value: "<![CDATA[ payload ]]>" },
    { rule: "event-handler-attribute", value: "onerror = alert(1)" },
    { rule: "script-url-scheme", value: "javascript:alert(1)" },
    { rule: "script-url-scheme", value: "data:text/html;base64,PHNjcmlwdD4=" },
    { rule: "script-url-scheme", value: "width: expression(alert(1))" },
    { rule: "entity-encoded-markup", value: "&lt;script&gt;alert(1)&lt;/script&gt;" },
    { rule: "entity-encoded-markup", value: "&#60;script&#62;" },
    { rule: "entity-encoded-markup", value: "&#x3C;svg onload=alert(1)&#x3E;" },
    { rule: "template-interpolation", value: "${globalThis.process}" },
    { rule: "template-interpolation", value: "{{constructor}}" },
    { rule: "control-character", value: "audit\u0000gate" },
  ]

  test("rejects executable payloads instead of stripping them", () => {
    for (const entry of hostile) {
      expect(isInertFixtureText(entry.value)).toBe(false)
      let thrown: unknown
      try {
        assertInertFixtureText(entry.value, "probe")
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(UnsafeFixturePayloadError)
      expect((thrown as UnsafeFixturePayloadError).rule).toBe(entry.rule)
      // The refusal names the field and shows the bytes JSON-encoded, so the
      // rejected markup is never re-emitted as live markup.
      expect((thrown as UnsafeFixturePayloadError).field).toBe("probe")
      expect((thrown as UnsafeFixturePayloadError).excerpt.startsWith('"')).toBe(true)
    }
  })

test("attributes a hazard to its provenance, not to a decoded red herring", () => {
    // The literal text `onload=` is inert until the entity references decode,
    // so the refusal must name the entity provenance rather than reclassifying
    // the payload as a raw event handler.
    const encoded = "&#x3C;svg onload=alert(1)&#x3E;"
    let thrown: unknown
    try {
      assertInertFixtureText(encoded, "probe")
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UnsafeFixturePayloadError)
    expect((thrown as UnsafeFixturePayloadError).rule).toBe("entity-encoded-markup")

    // Same payload with raw markup present: the raw delimiter is the real
    // provenance, because it is what creates the element.
    let raw: unknown
    try {
      assertInertFixtureText("<svg onload=alert(1)>", "probe")
    } catch (error) {
      raw = error
    }
    expect((raw as UnsafeFixturePayloadError).rule).toBe("markup-delimiter")

    // A bare handler attribute with no markup at all is still refused, as the
    // handler itself.
    let bare: unknown
    try {
      assertInertFixtureText("onload=alert(1)", "probe")
    } catch (error) {
      bare = error
    }
    expect((bare as UnsafeFixturePayloadError).rule).toBe("event-handler-attribute")
  })

  test("leaves ordinary ampersand text and unknown entities alone", () => {
    // `&` only matters when it opens a reference that decodes to a delimiter;
    // shell output and prose ampersands are common and inert.
    expect(isInertFixtureText("sleep 10 && echo done")).toBe(true)
    expect(isInertFixtureText("r&d ratio &times; 3")).toBe(true)
    expect(isInertFixtureText("Tom & Jerry &notarealentity; done")).toBe(true)
  })

  test("never returns a modified string", () => {
    const safe = "  Deploy to Staging first  "
    expect(assertInertFixtureText(safe, "probe")).toBe(safe)
  })

  test("rejects non-string values instead of coercing them", () => {
    for (const value of [undefined, null, 7, {}, []]) {
      let thrown: unknown
      try {
        assertInertFixtureText(value, "probe")
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(UnsafeFixturePayloadError)
    }
  })

  test("reports the failing path inside a fixture tree", () => {
    expect(() =>
      assertInertFixtureTree({
        questions: [{ header: "Deploy", question: "Where first?", options: [{ label: "Staging" }] }],
        output: "safe",
      }),
    ).not.toThrow()

    let thrown: unknown
    try {
      assertInertFixtureTree({
        questions: [{ header: "Deploy", options: [{ label: "<script>x</script>" }] }],
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UnsafeFixturePayloadError)
    expect((thrown as UnsafeFixturePayloadError).field).toBe("fixture.questions[0].options[0].label")
  })

  test("refuses cyclic fixture payloads rather than looping forever", () => {
    const cyclic: Record<string, unknown> = { label: "safe" }
    cyclic.self = cyclic
    let thrown: unknown
    try {
      assertInertFixtureTree(cyclic)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(UnsafeFixturePayloadError)
    expect((thrown as UnsafeFixturePayloadError).field).toBe("fixture.self")
  })
})