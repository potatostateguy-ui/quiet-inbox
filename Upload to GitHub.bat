@echo off
rem Double-click to upload Quiet Inbox to your GitHub account (creates a private repository the first time).
title Quiet Inbox - upload to GitHub
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-github.ps1"
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
