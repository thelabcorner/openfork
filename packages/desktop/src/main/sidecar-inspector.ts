export function sidecarInspectorExecArgv(packaged: boolean) {
  return packaged ? [] : ["--inspect=127.0.0.1:0"]
}

export function sidecarInspectorURL(stderrLine: string) {
  return stderrLine.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]
}
