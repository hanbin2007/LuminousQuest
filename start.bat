@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0LuminousQuest.exe" (
  "%~dp0LuminousQuest.exe"
  set "LQ_STATUS=%ERRORLEVEL%"
  goto :finished
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [startup] pnpm is required when running from source.
  set "LQ_STATUS=1"
  goto :finished
)

call pnpm start
set "LQ_STATUS=%ERRORLEVEL%"

:finished
if not "%LQ_STATUS%"=="0" (
  echo [startup] LuminousQuest exited with status %LQ_STATUS%.
  pause
)
exit /b %LQ_STATUS%

