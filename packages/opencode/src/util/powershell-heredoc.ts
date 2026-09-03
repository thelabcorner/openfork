const HEREDOC =
  /(^|(?:&&|\|\||;)\s*)(?<interpreter>(?:&\s*)?(?:['"]?)(?:python(?:3(?:\.\d+)?)?|py)(?:\.exe)?['"]?)\s+-\s+<<(?<stripTabs>-?)(?<quote>['"]?)(?<delimiter>[A-Za-z_][A-Za-z0-9_-]*)\k<quote>[ \t]*\r?\n/gm

const line = (delimiter: string, stripTabs: boolean) =>
  new RegExp(`^${stripTabs ? "\\t*" : ""}${escapeRegExp(delimiter)}\\r?$`, "m")

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function encodedBody(body: string, interpreter: string) {
  const bytes = new TextEncoder().encode(body)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary)
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ${interpreter} -`
}

function hereStringBody(body: string, interpreter: string) {
  if (body.split(/\r?\n/).some((entry) => entry === "'@")) {
    if (!body.split(/\r?\n/).some((entry) => entry === '"@')) {
      return `@"\n${body}"@ | ${interpreter} -`
    }
    return encodedBody(body, interpreter)
  }
  return `@'\n${body}'@ | ${interpreter} -`
}

/**
 * PowerShell has no Bash heredoc operator. Translate the common interpreter
 * form before passing it to PowerShell, while leaving all other shell syntax
 * exactly as supplied.
 */
export function rewriteBashHeredocsForPowerShell(command: string) {
  let output = command
  let searchFrom = 0

  while (true) {
    HEREDOC.lastIndex = searchFrom
    const opening = HEREDOC.exec(output)
    if (!opening || !opening.groups) break

    const delimiter = opening.groups.delimiter
    const terminator = line(delimiter, opening.groups.stripTabs === "-").exec(output.slice(HEREDOC.lastIndex))
    if (!terminator || terminator.index === undefined) break

    const bodyStart = HEREDOC.lastIndex
    const bodyEnd = bodyStart + terminator.index
    let body = output.slice(bodyStart, bodyEnd)
    if (opening.groups.stripTabs === "-") body = body.replace(/^\t/gm, "")

    const prefix = opening[1]
    const interpreter = opening.groups.interpreter
    const replacement = prefix + hereStringBody(body, interpreter)
    const terminatorEnd = bodyEnd + terminator[0].length
    output = output.slice(0, opening.index) + replacement + output.slice(terminatorEnd)
    searchFrom = opening.index + replacement.length
  }

  return output
}
