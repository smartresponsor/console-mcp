@echo off
chcp 65001 >nul
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0cmcp.ps1" %*
