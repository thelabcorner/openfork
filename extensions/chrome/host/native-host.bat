@echo off
REM Native messaging host wrapper for com.opencode.desktop (Windows)
REM Chrome launches this .bat; it forwards stdio to the Bun host script with 4-byte LE framing.
setlocal
where bun >nul 2>&1
if %ERRORLEVEL%==0 (
  bun run "%~dp0native-host.ts" %*
) else (
  where node >nul 2>&1
  if %ERRORLEVEL%==0 (
    node --loader ts-node/esm "%~dp0native-host.ts" %*
  ) else (
    echo Native host requires bun or node not found in PATH >&2
    exit /b 1
  )
)
