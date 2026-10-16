import { describe, expect, test } from "bun:test"
import { ProjectInspection } from "@/project/inspection"

describe("shared native/OXP project XML projection", () => {
  test("escapes hostile attribute text without double escaping entities", () => {
    const output = ProjectInspection.escapeXml('x" invalid="true" <tag> & it\'s')
    expect(output).toBe("x&quot; invalid=&quot;true&quot; &lt;tag&gt; &amp; it&apos;s")
    expect(output).not.toContain('invalid="true"')
  })

  test("uses XML 1.0-valid scalars, preserving supplementary characters", () => {
    const malicious = "\u0000\u0001\u0008\u000b\u000c\u001f\ud800\udc00"
    const orphanHigh = "\ud800x"
    const orphanLow = "x\udc00"
    const output = ProjectInspection.escapeXml("🎨" + malicious + orphanHigh + orphanLow)
    // The adjacent D800/DC00 pair is a valid U+10000 scalar, not two orphans.
    expect(output).toBe("🎨𐀀xx")
    expect(output).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/)
  })

  test("quotes XML attribute whitespace to prevent newline/attribute injection", () => {
    expect(ProjectInspection.escapeXml("first\nsecond\rthird\tlast")).toBe("first&#xA;second&#xD;third&#x9;last")
  })
})
