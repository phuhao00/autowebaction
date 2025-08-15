@echo off
setlocal
set MCP_HEADLESS=false
cd /d "%~dp0autotest"
echo [start-dev] Working dir: %CD%
npm run dev
endlocal


