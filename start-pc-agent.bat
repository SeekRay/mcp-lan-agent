@echo off
rem ---------------------------------------------------------------
rem  pc-agent launcher  (interactive / troubleshooting only)
rem
rem  Config lives in .env next to this file -- edit that, not this.
rem
rem  KEEP THIS FILE ASCII-ONLY.
rem  cmd.exe parses .bat files using the OEM code page (GBK/936 on
rem  zh-CN Windows). A UTF-8 Chinese byte sequence gets mis-decoded
rem  and can turn into bogus "commands" such as 'delims' or 'rem'.
rem  English-only text here is intentional.
rem ---------------------------------------------------------------
setlocal
cd /d "%~dp0"

rem Switch the console to UTF-8 so node's Chinese log output renders
rem correctly. Safe because everything above and below is ASCII.
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node.exe not found.
  echo         Install Node.js LTS from https://nodejs.org/ and reopen this window.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
echo Using Node %NODEV%
echo Starting pc-agent ... keep this window open, press Ctrl+C to stop.
echo.
node server.mjs
echo.
echo [pc-agent exited] code=%errorlevel%
pause
