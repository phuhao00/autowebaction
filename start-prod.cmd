@echo off
setlocal
set MCP_HEADLESS=false
cd /d "%~dp0autotest"
echo [start-prod] Working dir: %CD%
npm run build || goto :eof
node dist/server.js
endlocal


