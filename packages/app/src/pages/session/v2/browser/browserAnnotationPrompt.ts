// Compiles a structured BrowserAnnotationResult into a provider-neutral text
// block — the composer sends this as plain text, so no provider needs
// T3-specific binary annotation awareness to benefit from a human's pick.
// Keep internal structured state, but compile to a portable prompt string at
// exactly this boundary (matches the porting handoff's explicit guidance).

import type { BrowserAnnotationElementContext, BrowserAnnotationResult } from "./browserHostClient"

function elementLabel(element: BrowserAnnotationElementContext): string {
  const name = element.componentName ?? element.tagName
  if (element.source) {
    const at = element.source.line != null ? `${element.source.file}:${element.source.line}` : element.source.file
    return `<${name}> (${at})`
  }
  return `<${name}>`
}

function elementBlock(element: BrowserAnnotationElementContext): string {
  const lines = [`- ${elementLabel(element)}:`]
  if (element.selector) lines.push(`  selector: ${element.selector}`)
  if (element.source) {
    const at = element.source.column != null
      ? `${element.source.file}:${element.source.line}:${element.source.column}`
      : element.source.file
    lines.push(`  source: ${at}`)
  }
  lines.push(`  html:`, `    ${element.htmlPreview}`)
  if (element.styles) lines.push(`  styles:`, `    ${element.styles}`)
  return lines.join("\n")
}

function targetsSummary(annotation: BrowserAnnotationResult): string {
  const parts: string[] = []
  if (annotation.elements.length > 0) parts.push(`${annotation.elements.length} selected element${annotation.elements.length === 1 ? "" : "s"}`)
  if (annotation.regions.length > 0) parts.push(`${annotation.regions.length} marked region${annotation.regions.length === 1 ? "" : "s"}`)
  if (annotation.strokes.length > 0) parts.push(`${annotation.strokes.length} drawing${annotation.strokes.length === 1 ? "" : "s"}`)
  return parts.length > 0 ? parts.join(", ") + "." : "no targets selected."
}

/** Builds the `<browser_annotation>` text block. Pure — no DOM, no I/O. */
export function buildBrowserAnnotationPrompt(annotation: BrowserAnnotationResult): string {
  const lines: string[] = ["<browser_annotation>", "Browser annotation:"]
  lines.push(`Id: ${annotation.id}`)
  lines.push(`Page: ${annotation.pageUrl}${annotation.pageTitle ? ` (${annotation.pageTitle})` : ""}`)
  if (annotation.comment) lines.push(`Comment: ${annotation.comment}`)
  lines.push(`Targets: ${targetsSummary(annotation)}`)

  if (annotation.styleChanges.length > 0) {
    lines.push("Requested visual changes:")
    for (const change of annotation.styleChanges) {
      lines.push(`- ${change.property}: ${change.previousValue ?? "(default)"} → ${change.value}`)
    }
  }

  if (annotation.screenshot) lines.push("The attached screenshot is the annotated preview crop.")

  if (annotation.elements.length > 0) {
    lines.push("<element_context>")
    for (const element of annotation.elements) lines.push(elementBlock(element))
    lines.push("</element_context>")
  }

  lines.push("</browser_annotation>")
  return lines.join("\n")
}
