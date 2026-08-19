export function sessionPanelLayout(input: {
  terminal: boolean
  files: boolean
  context: boolean
  usage?: boolean
  models?: boolean
}) {
  return {
    visible: input.terminal || input.files || input.context || input.usage === true || input.models === true,
    stacked: false,
  }
}
