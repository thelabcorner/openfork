export function sessionPanelLayout(input: {
  review: boolean
  terminal: boolean
  files: boolean
  browser: boolean
}) {
  return {
    visible: input.review || input.terminal || input.files || input.browser,
    stacked: input.review && input.terminal,
  }
}
