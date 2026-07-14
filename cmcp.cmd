@echo off
setlocal
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tool\cmcp.ps1" %*
exit /b %ERRORLEVEL%
